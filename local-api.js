'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { getAppDataDir, isIsolatedTestPath } = require('./asar-engine');

const LOOPBACK_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;

/**
 * 常用本地调试候选端口（兼容 antigravity-hans / 手动 --remote-debugging-port 启动场景）
 */
const HANS_CANDIDATE_PORTS = [58321, 58322, 58323, 58324, 58325];

function normalizeLoopbackOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const parsed = new URL(rawOrigin.trim());
    const origin = parsed.origin;
    const m = origin.match(LOOPBACK_ORIGIN_RE);
    if (!m) return null;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return origin;
  } catch {
    return null;
  }
}

function parseExplicitPort(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function inspectDevToolsActivePort(options = {}) {
  const portFile = path.join(getAppDataDir(options), 'Antigravity', 'DevToolsActivePort');
  try {
    const raw = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { exists: true, valid: false, port: null, error: null };
    }
    return { exists: true, valid: true, port, error: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, valid: false, port: null, error: null };
    }
    return { exists: false, valid: false, port: null, error };
  }
}

function getDevToolsActivePort(options = {}) {
  const info = inspectDevToolsActivePort(options);
  return info.valid ? info.port : null;
}

/**
 * 按优先级生成候选 CDP 端口列表：
 * 1. 显式传入的 options.port 或环境变量 AG_CDP_PORT
 * 2. 候选回环端口 (58321..58325，仅在非隔离生产环境启用)
 * 3. DevToolsActivePort 文件记录的端口
 */
function getCandidateCdpPorts(options = {}) {
  const ports = [];
  const add = p => {
    const valid = parseExplicitPort(p);
    if (valid && !ports.includes(valid)) ports.push(valid);
  };

  const explicit = parseExplicitPort(options.port ?? process.env.AG_CDP_PORT);
  if (explicit) {
    add(explicit);
    if (options.strictPort === true) return ports;
  }

  const inIsolatedTest =
    Boolean(options && (options.appDataDir || options.homeDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR);

  if (!inIsolatedTest && options.includeCandidatePorts !== false) {
    for (const p of HANS_CANDIDATE_PORTS) add(p);
  }

  const activePort = getDevToolsActivePort(options);
  if (activePort) add(activePort);

  return ports;
}

function request(url, body, token, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(
      url,
      {
        agent: false,
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': token
            }
          : {}
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(text)
            : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function fetchJsonList(port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        agent: false
      },
      res => {
        let text = '';
        res.on('data', chunk => (text += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(text);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP port probe timeout')));
    req.on('error', reject);
  });
}

/**
 * 轻量探测本机回环页是否为 Antigravity 宿主窗口，以过滤内置浏览器打开的第三方本地预览页。
 * 返回三态：'antigravity'（含 __APP_CONFIG__）、'other_http'（连上但无 __APP_CONFIG__ 或非 200）、'unreachable'（网络层不可达）
 */
async function probeAntigravityOrigin(origin, timeoutMs = 1200) {
  try {
    const html = await request(origin + '/', null, null, timeoutMs);
    return /window\.__APP_CONFIG__\s*=/.test(String(html || '')) ? 'antigravity' : 'other_http';
  } catch (err) {
    if (String(err?.message || '').startsWith('HTTP ')) {
      return 'other_http';
    }
    return 'unreachable';
  }
}

/**
 * 探测并定位包含 Antigravity 本地主窗口页面的 CDP 端口与页面列表
 */
async function discoverAntigravityCdp(options = {}) {
  const explicit = parseExplicitPort(options.port ?? process.env.AG_CDP_PORT);
  const inIsolatedTest =
    Boolean(options && (options.appDataDir || options.homeDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR);

  const portFileInfo = inspectDevToolsActivePort(options);
  if (portFileInfo.error) {
    throw portFileInfo.error;
  }

  const candidatePorts = [];
  const addPort = p => {
    const valid = parseExplicitPort(p);
    if (valid && !candidatePorts.includes(valid)) candidatePorts.push(valid);
  };

  if (explicit) {
    addPort(explicit);
  }
  if (!explicit || options.strictPort !== true) {
    if (portFileInfo.valid) addPort(portFileInfo.port);
    if (!inIsolatedTest && options.includeCandidatePorts !== false) {
      for (const p of HANS_CANDIDATE_PORTS) addPort(p);
    }
  }

  if (candidatePorts.length === 0) {
    if (portFileInfo.exists && !portFileInfo.valid) {
      throw new Error('Antigravity 本地连接信息无效，请重新打开客户端');
    }
    throw new Error('Antigravity 本地连接尚未就绪，请稍后重试');
  }

  const timeoutMs = options.timeoutMs || 1500;
  let anyPortResponded = false;

  for (const port of candidatePorts) {
    try {
      const allPages = await fetchJsonList(port, timeoutMs);
      anyPortResponded = true;
      const matchedPages = allPages.filter(
        item => item && item.type === 'page' && Boolean(normalizeLoopbackOrigin(item.url))
      );
      if (matchedPages.length > 0) {
        if (matchedPages.length > 1) {
          const uniqueOrigins = Array.from(
            new Set(matchedPages.map(item => normalizeLoopbackOrigin(item?.url)).filter(Boolean))
          );
          const originKinds = new Map();
          const probeTimeoutMs = Math.min(timeoutMs, 1200);
          await Promise.all(
            uniqueOrigins.map(async origin => {
              originKinds.set(origin, await probeAntigravityOrigin(origin, probeTimeoutMs));
            })
          );
          const hasAntigravity = uniqueOrigins.some(origin => originKinds.get(origin) === 'antigravity');
          if (hasAntigravity) {
            const filtered = matchedPages.filter(
              item => originKinds.get(normalizeLoopbackOrigin(item?.url)) !== 'other_http'
            );
            const prioritized = [
              ...filtered.filter(item => originKinds.get(normalizeLoopbackOrigin(item?.url)) === 'antigravity'),
              ...filtered.filter(item => originKinds.get(normalizeLoopbackOrigin(item?.url)) !== 'antigravity')
            ];
            return {
              port,
              page: prioritized[0],
              pages: prioritized,
              allPages
            };
          }
        }
        return {
          port,
          page: matchedPages[0],
          pages: matchedPages,
          allPages
        };
      }
    } catch {
      // 探测下一个候选端口
    }
  }

  if (anyPortResponded) {
    throw new Error('未找到 Antigravity 主窗口，请等待窗口加载后重试');
  }
  if (portFileInfo.exists && !portFileInfo.valid) {
    throw new Error('Antigravity 本地连接信息无效，请重新打开客户端');
  }
  throw new Error('Antigravity 本地连接尚未就绪，请稍后重试');
}

/**
 * 零依赖 RFC 6455 WebSocket 客户端（不发送 Origin 头，仅允许连接本机回环地址，兼容未开启 --remote-allow-origins=* 的 Electron CDP）
 */
function connectCdpWebSocket(wsUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(wsUrl);
    } catch (e) {
      return reject(new Error(`Invalid WebSocket URL: ${wsUrl}`));
    }
    if (parsed.protocol !== 'ws:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
      return reject(new Error('仅允许连接本机回环 CDP WebSocket 地址'));
    }
    const port = Number(parsed.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reject(new Error('无效的本机 CDP 端口'));
    }
    const host = '127.0.0.1';
    const reqPath = (parsed.pathname || '/') + (parsed.search || '');
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const socket = net.connect(port, host);
    const timeoutMs = options.timeoutMs || 5000;
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let closed = false;

    const listeners = {
      message: [],
      close: [],
      error: []
    };

    const emit = (type, arg) => {
      for (const fn of listeners[type] || []) {
        try {
          fn(arg);
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        socket.destroy();
        reject(new Error('CDP WebSocket handshake timeout'));
      }
    }, timeoutMs);

    function sendFrame(opcode, payloadBuf) {
      if (closed || socket.destroyed) return;
      const mask = crypto.randomBytes(4);
      const len = payloadBuf.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | len;
        mask.copy(header, 2);
      } else if (len < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        masked[i] = payloadBuf[i] ^ mask[i & 3];
      }
      socket.write(Buffer.concat([header, masked]));
    }

    let fragmentedOpcode = 0;
    let fragmentedChunks = [];

    function processFrames() {
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const fin = (firstByte & 0x80) !== 0;
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) return;

        let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (isMasked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i & 3];
          }
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x8) {
          // Close frame
          closed = true;
          try {
            sendFrame(0x8, Buffer.alloc(0));
          } catch {}
          socket.end();
          emit('close');
          return;
        } else if (opcode === 0x9) {
          // Ping -> Pong
          sendFrame(0x0a, payload);
        } else if (opcode === 0x0a) {
          // Pong
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            emit('message', { data: payload.toString('utf8') });
          } else {
            fragmentedOpcode = opcode;
            fragmentedChunks = [payload];
          }
        } else if (opcode === 0x0 && fragmentedOpcode !== 0) {
          fragmentedChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(fragmentedChunks);
            fragmentedOpcode = 0;
            fragmentedChunks = [];
            emit('message', { data: full.toString('utf8') });
          }
        }
      }
    }

    const wsClient = {
      send(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        sendFrame(0x1, buf);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          sendFrame(0x8, Buffer.alloc(0));
        } catch {}
        socket.end();
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 100).unref();
      },
      addEventListener(type, fn) {
        if (listeners[type]) listeners[type].push(fn);
      }
    };

    socket.on('connect', () => {
      // 严禁附带 Origin 请求头，防止未加 --remote-allow-origins=* 时被 Chromium 拒绝返回 403
      const reqLines = [
        `GET ${reqPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ];
      socket.write(reqLines.join('\r\n'));
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4);
        clearTimeout(timer);

        const firstLine = headerText.split('\r\n')[0] || '';
        if (!firstLine.includes('101')) {
          socket.destroy();
          return reject(new Error(`CDP WebSocket handshake failed: ${firstLine}`));
        }
        const acceptMatch = headerText.match(/Sec-WebSocket-Accept:\s*([^\r\n]+)/i);
        if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
          socket.destroy();
          return reject(new Error('CDP WebSocket invalid Sec-WebSocket-Accept'));
        }
        handshakeDone = true;
        resolve(wsClient);
        if (buffer.length > 0) processFrames();
      } else {
        processFrames();
      }
    });

    socket.on('error', err => {
      clearTimeout(timer);
      if (!handshakeDone) {
        reject(err);
      } else {
        emit('error', err);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      closed = true;
      if (!handshakeDone) {
        reject(new Error('CDP WebSocket closed before handshake completed'));
      } else {
        emit('close');
      }
    });
  });
}

/**
 * 创建带请求/响应关联的轻量 CDP 会话客户端
 */
async function createCdpClient(wsUrl, options = {}) {
  const ws = await connectCdpWebSocket(wsUrl, options);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', event => {
    try {
      const msg = JSON.parse(event.data);
      if (msg && msg.id && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) {
          item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          item.resolve(msg.result);
        }
      }
    } catch {}
  });

  ws.addEventListener('close', () => {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  });

  return {
    ws,
    call(method, params = {}, callTimeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP call timeout: ${method}`));
          }
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    evaluate(expression, opts = {}) {
      return this.call(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: opts.returnByValue !== false,
          awaitPromise: opts.awaitPromise !== false
        },
        opts.timeoutMs || 8000
      );
    },
    async evaluateValue(expression, opts = {}) {
      const res = await this.evaluate(expression, opts);
      if (res && res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval exception';
        throw new Error(desc);
      }
      return res?.result?.value;
    },
    close() {
      ws.close();
    }
  };
}

function isIsolatedLocalApiOptions(options = {}) {
  return (
    Boolean(options && (options.appDataDir || options.homeDir || options.daemonDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR)
  );
}

function defaultIsPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 扫描本地 ~/.gemini/antigravity/daemon/hub_*.json，返回存活进程对应的回环原点与 CSRF 凭据（按最新修改时间排序）。
 * 测试隔离环境下除非显式提供 daemonDir / homeDir，否则拒绝读取宿主机真实 daemon 目录。
 */
function discoverLiveDaemonHubs(options = {}) {
  if (options?.allowDaemonFallback === false) return [];
  const inIsolatedTest = isIsolatedLocalApiOptions(options);
  if (inIsolatedTest && !options?.daemonDir && !options?.homeDir) return [];
  const homeDir = options?.homeDir || os.homedir();
  const daemonDir = options?.daemonDir || path.join(homeDir, '.gemini', 'antigravity', 'daemon');
  const isPidAlive = typeof options?.isPidAlive === 'function' ? options.isPidAlive : defaultIsPidAlive;
  const out = [];
  try {
    if (!fs.existsSync(daemonDir)) return out;
    const files = fs.readdirSync(daemonDir);
    for (const name of files) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const filePath = path.join(daemonDir, name);
      try {
        const st = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const pid = Number(raw?.pid);
        const httpsPort = Number(raw?.httpsPort);
        const httpPort = Number(raw?.httpPort);
        const csrfToken = typeof raw?.csrfToken === 'string' ? raw.csrfToken.trim() : '';
        if (!csrfToken || !isPidAlive(pid)) continue;
        const httpsOrigin = Number.isInteger(httpsPort) && httpsPort >= 1 && httpsPort <= 65535
          ? normalizeLoopbackOrigin(`https://127.0.0.1:${httpsPort}`)
          : null;
        const httpOrigin = Number.isInteger(httpPort) && httpPort >= 1 && httpPort <= 65535
          ? normalizeLoopbackOrigin(`http://127.0.0.1:${httpPort}`)
          : null;
        const primaryOrigin = httpsOrigin || httpOrigin;
        if (!primaryOrigin) continue;
        out.push({
          origin: primaryOrigin,
          httpsOrigin,
          httpOrigin,
          httpsPort: httpsOrigin ? httpsPort : null,
          httpPort: httpOrigin ? httpPort : null,
          csrfToken,
          pid,
          mtimeMs: Number(st.mtimeMs) || 0
        });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || ((b.httpsPort || 0) - (a.httpsPort || 0)));
  return out;
}

/**
 * 读取同进程宿主 ./authBootstrap 模块的活动 Language Server 信息（仅存在于 Electron 主进程 dist/ 内或单测显式注入）。
 */
function loadHostAuthBootstrap(options = {}) {
  if (options?.authBootstrap === null) return null;
  const inIsolatedTest = isIsolatedLocalApiOptions(options);
  if (inIsolatedTest && !options?.authBootstrap) return null;
  let mod = options?.authBootstrap || null;
  if (!mod) {
    try {
      mod = require('./authBootstrap');
    } catch {
      return null;
    }
  }
  if (!mod || typeof mod !== 'object') return null;
  let activeOrigin = null;
  try {
    if (typeof mod.getActiveLsBaseUrl === 'function') {
      activeOrigin = normalizeLoopbackOrigin(mod.getActiveLsBaseUrl());
    }
  } catch {}
  if (!activeOrigin) {
    try {
      if (typeof mod.getActiveLsPort === 'function') {
        const port = Number(mod.getActiveLsPort());
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
          activeOrigin = normalizeLoopbackOrigin(`https://127.0.0.1:${port}`);
        }
      }
    } catch {}
  }
  let token = '';
  try {
    if (typeof mod.getActiveLsCsrfToken === 'function') {
      token = String(mod.getActiveLsCsrfToken() || '').trim();
    }
  } catch {}
  if (!activeOrigin || !token) return null;
  return { origin: activeOrigin, csrfToken: token };
}

/**
 * 在请求原点与当前宿主 Language Server 回环原点严格一致时，返回主进程内存中的 CSRF Token。
 * 绝不跨端口或对非回环地址返回凭据，也不落盘或打印日志。
 */
function resolveAuthBootstrapForOrigin(rawOrigin, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(rawOrigin);
  if (!safeOrigin) return null;
  const auth = loadHostAuthBootstrap(options);
  if (!auth || auth.origin !== safeOrigin) return null;
  return auth.csrfToken;
}

/**
 * 从存活的 daemon/hub_*.json 中按精确回环原点匹配 CSRF Token。
 */
function resolveDaemonHubForOrigin(rawOrigin, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(rawOrigin);
  if (!safeOrigin) return null;
  const hubs = discoverLiveDaemonHubs(options);
  for (const hub of hubs) {
    if (hub.httpsOrigin === safeOrigin || hub.httpOrigin === safeOrigin) {
      return hub.csrfToken;
    }
  }
  return null;
}

/**
 * 为指定回环原点解析非 HTML 来源的 Antigravity 2.34.0+ 本地 CSRF Token（优先主进程 authBootstrap，其次精确匹配的存活 daemon/hub_*.json）。
 */
function resolveOriginCsrfToken(rawOrigin, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(rawOrigin);
  if (!safeOrigin) return null;
  return resolveAuthBootstrapForOrigin(safeOrigin, options) || resolveDaemonHubForOrigin(safeOrigin, options) || null;
}

async function extractAppConfigViaCdp(page) {
  if (!page || !page.webSocketDebuggerUrl) return null;
  let client;
  try {
    client = await createCdpClient(page.webSocketDebuggerUrl, { timeoutMs: 3000 });
    const res = await client.call(
      'Runtime.evaluate',
      {
        expression:
          '(() => { try { const cfg = window.__APP_CONFIG__; const direct = typeof cfg?.csrfToken === "string" ? cfg.csrfToken.trim() : ""; let stored = ""; try { stored = String(window.localStorage?.getItem?.("agy_session_csrf_token") || "").trim(); } catch {} if (!cfg && !stored) return null; return { hasConfig: Boolean(cfg || stored), csrfToken: direct || stored }; } catch (e) { return null; } })()',
        returnByValue: true
      },
      3000
    );
    return res?.result?.value || null;
  } catch {
    return null;
  } finally {
    if (client) client.close();
  }
}

/**
 * 解析并缓存或实时提取指定本地页面原点的 CSRF Token 并构造 RPC 客户端。
 * 兼容 Antigravity <= 2.33.0（HTML 内联 csrfToken）与 2.34.0+（空 HTML csrfToken + CDP 会话态 / 主进程 authBootstrap / 存活 daemon hub）。
 */
async function connectOrigin(rawOrigin, page = null, origins = null, extraMeta = {}) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) {
    throw new Error('非法的本机回环页面地址');
  }

  const resolveAuth = async () => {
    let hasConfig = false;
    let token = '';
    let htmlFetchErr = null;
    try {
      const html = await request(origin + '/');
      const config = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
      if (config) {
        hasConfig = true;
        const parsedCfg = JSON.parse(config[1]);
        token = typeof parsedCfg?.csrfToken === 'string' ? parsedCfg.csrfToken.trim() : '';
      }
    } catch (err) {
      htmlFetchErr = err;
    }

    if ((!hasConfig || !token) && page && page.webSocketDebuggerUrl) {
      const cdpCfg = await extractAppConfigViaCdp(page);
      if (cdpCfg && cdpCfg.hasConfig) {
        hasConfig = true;
        const cdpToken = typeof cdpCfg.csrfToken === 'string' ? cdpCfg.csrfToken.trim() : '';
        if (cdpToken) token = cdpToken;
      }
    }

    const canUseHostAuthFallback = !htmlFetchErr || /^HTTP 40[13]\b/.test(String(htmlFetchErr.message || ''));
    if (!token && canUseHostAuthFallback) {
      const bootstrapToken = resolveAuthBootstrapForOrigin(origin, extraMeta);
      if (bootstrapToken) {
        token = bootstrapToken;
        hasConfig = true;
      }
    }
    if (!token && canUseHostAuthFallback) {
      const daemonToken = resolveDaemonHubForOrigin(origin, extraMeta);
      if (daemonToken) {
        token = daemonToken;
        hasConfig = true;
      }
    }

    if (!hasConfig && !token && htmlFetchErr) {
      throw htmlFetchErr;
    }
    if (!hasConfig) {
      throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
    }
    if (!token) {
      throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
    }
    return token;
  };

  let activeToken = await resolveAuth();

  return {
    origin,
    page,
    ...(extraMeta.port ? { port: extraMeta.port } : {}),
    ...(Array.isArray(extraMeta.pages) ? { pages: extraMeta.pages } : {}),
    origins: Array.isArray(origins) && origins.length ? origins : [origin],
    call: async (method, body) => {
      const endpoint = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
      try {
        return JSON.parse(await request(endpoint, body, activeToken));
      } catch (err) {
        if (/^HTTP 40[13]\b/.test(String(err?.message || ''))) {
          let refreshed = '';
          try {
            refreshed = await resolveAuth();
          } catch {}
          if (refreshed && refreshed !== activeToken) {
            activeToken = refreshed;
            return JSON.parse(await request(endpoint, body, activeToken));
          }
        }
        throw err;
      }
    }
  };
}

/**
 * 连接到本地 Antigravity LanguageServerService。
 * 支持直接传入已知 `options.origin` 免 CDP/DevToolsActivePort 直连；
 * 未传 `origin` 时优先通过 CDP 发现运行窗口，无调试端口时安全回退至同进程 authBootstrap 或存活 daemon/hub_*.json。
 */
async function connect(options = {}) {
  if (
    options &&
    options.origin !== undefined &&
    options.origin !== null &&
    String(options.origin).trim() !== ''
  ) {
    const explicitOrigin = normalizeLoopbackOrigin(options.origin);
    if (!explicitOrigin) {
      throw new Error('非法的本机回环页面地址');
    }
    return connectOrigin(explicitOrigin, null, [explicitOrigin], options);
  }
  let cdpInfo = null;
  let cdpErr = null;
  try {
    cdpInfo = await discoverAntigravityCdp(options);
  } catch (err) {
    cdpErr = err;
  }
  if (cdpInfo) {
    const { port, page, pages } = cdpInfo;
    const candidatePages = Array.isArray(pages) && pages.length ? pages : [page];
    const origins = Array.from(
      new Set(candidatePages.map(item => normalizeLoopbackOrigin(item?.url)).filter(Boolean))
    );
    let lastError = null;
    for (const cand of candidatePages) {
      const targetOrigin = normalizeLoopbackOrigin(cand?.url);
      if (!targetOrigin) continue;
      try {
        return await connectOrigin(targetOrigin, cand, origins, { ...options, port, pages });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
  }

  if (options?.strictPort !== true) {
    const bootstrapAuth = loadHostAuthBootstrap(options);
    if (bootstrapAuth && bootstrapAuth.origin) {
      try {
        return await connectOrigin(bootstrapAuth.origin, null, [bootstrapAuth.origin], options);
      } catch {}
    }
    const liveHubs = discoverLiveDaemonHubs(options);
    if (liveHubs.length > 0) {
      const hubOrigins = Array.from(new Set(liveHubs.map(h => h.origin).filter(Boolean)));
      for (const hub of liveHubs) {
        try {
          return await connectOrigin(hub.origin, null, hubOrigins, options);
        } catch {}
      }
    }
  }

  throw cdpErr || new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
}

module.exports = {
  connect,
  connectOrigin,
  resolveOriginCsrfToken,
  resolveAuthBootstrapForOrigin,
  resolveDaemonHubForOrigin,
  discoverLiveDaemonHubs,
  normalizeLoopbackOrigin,
  parseExplicitPort,
  getAppDataDir,
  getDevToolsActivePort,
  getCandidateCdpPorts,
  discoverAntigravityCdp,
  connectCdpWebSocket,
  createCdpClient,
  HANS_CANDIDATE_PORTS
};
