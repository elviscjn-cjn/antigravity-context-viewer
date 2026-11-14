'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getAppDataDir, isIsolatedTestPath } = require('./asar-engine');

const HANS_CANDIDATE_PORTS = [58321, 58322, 58323, 58324, 58325];
const ANTIGRAVITY_PAGE_URL_RE = /^https:\/\/127\.0\.0\.1:\d+\//;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B00'.replace(/00$/, '11'); // 258EAFA5-E914-47DA-95CA-C5AB0DC85B11

function isTestModeActive(options = {}) {
  if (typeof options.testMode === 'boolean') return options.testMode;
  return process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function parseExplicitPort(options = {}) {
  if (options && options.port !== undefined && options.port !== null && options.port !== '') {
    const p = Number(options.port);
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
  }
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const portIdx = argv.indexOf('--port');
  if (portIdx >= 0 && argv[portIdx + 1]) {
    const p = Number(argv[portIdx + 1]);
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
  }
  const envPort = options.env?.AG_CDP_PORT ?? process.env.AG_CDP_PORT;
  if (envPort !== undefined && envPort !== null && String(envPort).trim() !== '') {
    const p = Number(String(envPort).trim());
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
  }
  return null;
}

function getDevToolsActivePort(options = {}) {
  const testMode = isTestModeActive(options);
  const appData = getAppDataDir(options);
  if (testMode && !options._allowRealAppDataInTest && !isIsolatedTestPath(appData)) {
    return null;
  }
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
  try {
    if (!fs.existsSync(portFile)) return null;
    const raw = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 构建有序去重的 CDP 候选端口列表：
 * (a) 显式 --port <port> / AG_CDP_PORT
 * (b) Antigravity-Hans 候选回环端口 58321..58325
 * (c) DevToolsActivePort (macOS: ~/Library/Application Support/Antigravity/DevToolsActivePort)
 *
 * 在 AG_METER_TEST_MODE=1 / NODE_ENV=test 下严格隔离，绝不探测宿主机真实 58321..58325 或真实 AppData。
 */
function getCandidateCdpPorts(options = {}) {
  const ports = [];
  const addPort = p => {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n <= 65535 && !ports.includes(n)) {
      ports.push(n);
    }
  };

  // (a) 显式端口优先
  const explicitPort = parseExplicitPort(options);
  if (explicitPort) addPort(explicitPort);

  // (b) Antigravity-Hans 回环调试端口 58321..58325
  const testMode = isTestModeActive(options);
  const envCandStr = options.env?.AG_CDP_CANDIDATE_PORTS ?? process.env.AG_CDP_CANDIDATE_PORTS;
  if (Array.isArray(options.candidatePorts)) {
    for (const p of options.candidatePorts) addPort(p);
  } else if (envCandStr && String(envCandStr).trim()) {
    for (const part of String(envCandStr).split(',')) addPort(part.trim());
  } else if (!testMode || typeof options._httpGetJson === 'function') {
    for (const p of HANS_CANDIDATE_PORTS) addPort(p);
  }

  // (c) DevToolsActivePort 文件
  const activePort = getDevToolsActivePort(options);
  if (activePort) addPort(activePort);

  return ports;
}

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { rejectUnauthorized: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP HTTP timeout')));
    req.on('error', reject);
  });
}

function isAntigravityPageTarget(item, pageUrlRegex = ANTIGRAVITY_PAGE_URL_RE) {
  return Boolean(
    item &&
    item.type === 'page' &&
    typeof item.url === 'string' &&
    pageUrlRegex.test(item.url)
  );
}

/**
 * 按优先级扫描 CDP 候选端口并返回匹配的 Antigravity 页面目标
 */
async function discoverAntigravityCdp(options = {}) {
  const ports = getCandidateCdpPorts(options);
  if (ports.length === 0) {
    return { running: false, port: null, targets: [], page: null, origin: null };
  }

  const fetchJson = options._httpGetJson || httpGetJson;
  const timeoutMs = options.timeoutMs || 1500;
  const pageUrlRegex = options.pageUrlRegex || ANTIGRAVITY_PAGE_URL_RE;
  let firstOpenPort = null;
  let lastError = null;

  for (const port of ports) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs);
      if (!Array.isArray(pages)) continue;
      if (firstOpenPort === null) firstOpenPort = port;
      const targets = pages.filter(p => isAntigravityPageTarget(p, pageUrlRegex));
      if (targets.length > 0) {
        const page = targets[0];
        const origin = new URL(page.url).origin;
        return {
          running: true,
          pageFound: true,
          port,
          pages,
          targets,
          page,
          origin
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (firstOpenPort !== null) {
    return {
      running: true,
      pageFound: false,
      port: firstOpenPort,
      targets: [],
      page: null,
      origin: null
    };
  }

  return {
    running: false,
    pageFound: false,
    port: null,
    targets: [],
    page: null,
    origin: null,
    error: lastError ? lastError.message : null
  };
}

function encodeClientFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payloadBuf[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * 零外部依赖、不发送 Origin 请求头的 RFC 6455 WebSocket 客户端
 * 解决 Antigravity-Hans 未传 --remote-allow-origins=* 时 Chromium 对带 Origin 握手返回 403 Forbidden 的问题。
 */
function connectCdpWebSocket(wsUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const isSecure = parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
    const transport = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const handshakeTimeoutMs = options.handshakeTimeoutMs || 4000;

    const headers = {
      Host: parsedUrl.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13'
    };
    // 严格确保绝不附带 Origin 请求头（除非单测显式注入 _testOriginHeader 验证服务端 403 拦截行为）
    if (options._testOriginHeader) {
      headers.Origin = options._testOriginHeader;
    }

    let settled = false;
    const settleReject = err => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      reject(err);
    };

    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isSecure ? 443 : 80),
      path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
      method: 'GET',
      headers,
      rejectUnauthorized: false
    });

    const handshakeTimer = setTimeout(() => {
      req.destroy(new Error('CDP WebSocket handshake timeout'));
    }, handshakeTimeoutMs);

    req.on('error', err => {
      settleReject(err);
    });

    req.on('response', res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        settleReject(new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}${body ? ': ' + body.slice(0, 120) : ''}`));
      });
    });

    req.on('upgrade', (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      clearTimeout(handshakeTimer);

      const accept = res.headers['sec-websocket-accept'];
      if (accept && accept !== expectedAccept) {
        socket.destroy();
        settleReject(new Error('Invalid Sec-WebSocket-Accept header'));
        return;
      }

      settled = true;
      socket.setNoDelay(true);

      const emitter = new EventEmitter();
      let closed = false;
      let rxBuf = (head && head.length > 0) ? Buffer.from(head) : Buffer.alloc(0);
      let fragments = [];

      const safeWrite = buf => {
        if (!closed && socket.writable) {
          try { socket.write(buf); } catch {}
        }
      };

      const markClosed = () => {
        if (closed) return;
        closed = true;
        emitter.emit('close');
      };

      const processFrames = () => {
        while (rxBuf.length >= 2) {
          const b0 = rxBuf[0];
          const b1 = rxBuf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let payloadLen = b1 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (rxBuf.length < 4) return;
            payloadLen = rxBuf.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (rxBuf.length < 10) return;
            payloadLen = Number(rxBuf.readBigUInt64BE(2));
            offset = 10;
          }

          let maskKey = null;
          if (masked) {
            if (rxBuf.length < offset + 4) return;
            maskKey = rxBuf.subarray(offset, offset + 4);
            offset += 4;
          }

          if (rxBuf.length < offset + payloadLen) return;

          let framePayload = Buffer.from(rxBuf.subarray(offset, offset + payloadLen));
          rxBuf = rxBuf.subarray(offset + payloadLen);

          if (maskKey) {
            for (let i = 0; i < framePayload.length; i++) {
              framePayload[i] ^= maskKey[i & 3];
            }
          }

          if (opcode === 0x8) {
            safeWrite(encodeClientFrame(0x8, Buffer.alloc(0)));
            try { socket.end(); } catch {}
            markClosed();
            return;
          }
          if (opcode === 0x9) {
            safeWrite(encodeClientFrame(0xA, framePayload));
            continue;
          }
          if (opcode === 0xA) {
            continue;
          }
          if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
            fragments.push(framePayload);
            if (fin) {
              const full = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
              fragments = [];
              const text = full.toString('utf8');
              emitter.emit('message', { data: text });
            }
          }
        }
      };

      socket.on('data', chunk => {
        rxBuf = rxBuf.length === 0 ? chunk : Buffer.concat([rxBuf, chunk]);
        try {
          processFrames();
        } catch (err) {
          emitter.emit('error', err);
          try { socket.destroy(); } catch {}
        }
      });

      socket.on('error', err => {
        emitter.emit('error', err);
        markClosed();
      });

      socket.on('close', () => {
        markClosed();
      });

      socket.on('end', () => {
        markClosed();
      });

      if (rxBuf.length > 0) {
        setImmediate(() => {
          try {
            processFrames();
          } catch (err) {
            emitter.emit('error', err);
            try { socket.destroy(); } catch {}
          }
        });
      }

      const wsApi = {
        send(data) {
          if (closed) throw new Error('CDP WebSocket is closed');
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
          safeWrite(encodeClientFrame(0x1, buf));
        },
        close() {
          if (closed) return;
          safeWrite(encodeClientFrame(0x8, Buffer.alloc(0)));
          closed = true;
          try { socket.end(); } catch {}
          setTimeout(() => {
            try { if (!socket.destroyed) socket.destroy(); } catch {}
          }, 50).unref?.();
          emitter.emit('close');
        },
        on(event, fn) {
          emitter.on(event, fn);
          return wsApi;
        },
        off(event, fn) {
          emitter.off(event, fn);
          return wsApi;
        },
        addEventListener(event, fn, opts) {
          if (opts && opts.once) emitter.once(event, fn);
          else emitter.on(event, fn);
        },
        removeEventListener(event, fn) {
          emitter.off(event, fn);
        },
        get readyState() {
          return closed ? 3 : 1;
        }
      };

      if (head && head.length > 0) {
        rxBuf = Buffer.from(head);
        setImmediate(() => {
          try { processFrames(); } catch (err) { emitter.emit('error', err); }
        });
      }

      resolve(wsApi);
    });

    req.end();
  });
}

async function createCdpClient(wsUrl, options = {}) {
  const ws = await connectCdpWebSocket(wsUrl, options);
  let seq = 0;
  const pending = new Map();

  ws.on('message', ev => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg && msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  });

  const rejectAll = err => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  ws.on('close', () => rejectAll(new Error('CDP WebSocket closed')));
  ws.on('error', err => rejectAll(err));

  function sendCommand(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout calling ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  return {
    ws,
    sendRaw: sendCommand,
    async call(method, params = {}, timeoutMs = 10000) {
      const msg = await sendCommand(method, params, timeoutMs);
      if (msg.error) {
        throw new Error(typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error));
      }
      return msg.result;
    },
    async evaluate(expression, evalOpts = {}) {
      const timeoutMs = evalOpts.timeoutMs || 10000;
      const returnByValue = evalOpts.returnByValue !== false;
      const awaitPromise = evalOpts.awaitPromise !== false;
      return sendCommand('Runtime.evaluate', {
        expression,
        returnByValue,
        awaitPromise
      }, timeoutMs);
    },
    async evaluateValue(expression, evalOpts = {}) {
      const msg = await this.evaluate(expression, evalOpts);
      if (msg.error || msg.result?.exceptionDetails) {
        throw new Error(JSON.stringify(msg.error || msg.result.exceptionDetails));
      }
      return msg.result?.result?.value;
    },
    close() {
      ws.close();
    }
  };
}

function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(
      url,
      {
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
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => (
          response.statusCode === 200
            ? resolve(text)
            : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        ));
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function connect(options = {}) {
  const discovered = await discoverAntigravityCdp(options);
  if (!discovered.running || !discovered.page) {
    throw new Error('Antigravity window not found');
  }
  const page = discovered.page;
  const origin = discovered.origin;
  const html = await request(origin + '/');
  const match = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
  if (!match || !match[1]) {
    throw new Error('Antigravity __APP_CONFIG__ csrfToken not found');
  }
  const token = JSON.parse(match[1]).csrfToken;
  return {
    port: discovered.port,
    origin,
    page,
    call: async (method, body) => JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token))
  };
}

module.exports = {
  HANS_CANDIDATE_PORTS,
  ANTIGRAVITY_PAGE_URL_RE,
  parseExplicitPort,
  getDevToolsActivePort,
  getCandidateCdpPorts,
  discoverAntigravityCdp,
  connectCdpWebSocket,
  createCdpClient,
  connect
};
