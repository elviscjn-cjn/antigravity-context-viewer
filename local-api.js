'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { getAppDataDir, isIsolatedTestPath } = require('./asar-engine');

const LOOPBACK_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;

/**
 * ���ñ��ص��Ժ�ѡ�˿ڣ����� antigravity-hans / �ֶ� --remote-debugging-port ����������
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
 * �����ȼ����ɺ�ѡ CDP �˿��б���
 * 1. ��ʽ����� options.port �򻷾����� AG_CDP_PORT
 * 2. ��ѡ�ػ��˿� (58321..58325�����ڷǸ���������������)
 * 3. DevToolsActivePort �ļ���¼�Ķ˿�
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
 * ̽�Ⲣ��λ���� Antigravity ����������ҳ��� CDP �˿���ҳ���б�
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
      throw new Error('Antigravity ����������Ϣ��Ч�������´򿪿ͻ���');
    }
    throw new Error('Antigravity ����������δ���������Ժ�����');
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
        return {
          port,
          page: matchedPages[0],
          pages: matchedPages,
          allPages
        };
      }
    } catch {
      // ̽����һ����ѡ�˿�
    }
  }

  if (anyPortResponded) {
    throw new Error('δ�ҵ� Antigravity �����ڣ���ȴ����ڼ��غ�����');
  }
  if (portFileInfo.exists && !portFileInfo.valid) {
    throw new Error('Antigravity ����������Ϣ��Ч�������´򿪿ͻ���');
  }
  throw new Error('Antigravity ����������δ���������Ժ�����');
}

/**
 * ������ RFC 6455 WebSocket �ͻ��ˣ������� Origin ͷ�����������ӱ����ػ���ַ������δ���� --remote-allow-origins=* �� Electron CDP��
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
      return reject(new Error('���������ӱ����ػ� CDP WebSocket ��ַ'));
    }
    const port = Number(parsed.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reject(new Error('��Ч�ı��� CDP �˿�'));
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
      // �Ͻ����� Origin ����ͷ����ֹδ�� --remote-allow-origins=* ʱ�� Chromium �ܾ����� 403
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
 * ����������/��Ӧ���������� CDP �Ự�ͻ���
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

async function extractAppConfigViaCdp(page) {
  if (!page || !page.webSocketDebuggerUrl) return null;
  let client;
  try {
    client = await createCdpClient(page.webSocketDebuggerUrl, { timeoutMs: 3000 });
    const res = await client.call(
      'Runtime.evaluate',
      {
        expression:
          '(() => { try { if (!window.__APP_CONFIG__) return null; return { hasConfig: true, csrfToken: window.__APP_CONFIG__.csrfToken || "" }; } catch (e) { return null; } })()',
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
 * �����������ʵʱ��ȡָ������ҳ��ԭ��� CSRF Token ������ RPC �ͻ��ˡ�
 */
function resolveHostAuthToken(origin, auth) {
  const expected = normalizeLoopbackOrigin(origin);
  const active = normalizeLoopbackOrigin(auth?.getActiveLsBaseUrl?.());
  if (!expected || active !== expected) return null;
  const token = auth?.getActiveLsCsrfToken?.();
  return typeof token === 'string' && token.trim() ? token : null;
}

async function connectOrigin(rawOrigin, page = null, origins = null, extraMeta = {}) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) {
    throw new Error('�Ƿ��ı����ػ�ҳ���ַ');
  }
  let hasConfig = false;
  let token = null;
  try {
    const html = await request(origin + '/');
    const config = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (config) {
      hasConfig = true;
      token = JSON.parse(config[1]).csrfToken;
    }
  } catch (err) {
    if (!page || !page.webSocketDebuggerUrl) throw err;
  }

  if (!hasConfig && page && page.webSocketDebuggerUrl) {
    const cdpCfg = await extractAppConfigViaCdp(page);
    if (cdpCfg && cdpCfg.hasConfig) {
      hasConfig = true;
      token = cdpCfg.csrfToken;
    }
  }

  if (!hasConfig) {
    throw new Error('Antigravity ����������Ϣ��δ���������Ժ�����');
  }
  if (!token) {
    // Antigravity 2.34+ keeps the admin token in main-process memory.
    // Only accept credentials for the exact local service being connected.
    try {
      const auth = require('./authBootstrap');
      token = resolveHostAuthToken(origin, auth);
    } catch { }
  }
  if (!token) {
    throw new Error('Antigravity ���ؼ�Ȩ��Ϣ��δ���������Ժ�����');
  }

  return {
    origin,
    page,
    ...(extraMeta.port ? { port: extraMeta.port } : {}),
    ...(Array.isArray(extraMeta.pages) ? { pages: extraMeta.pages } : {}),
    origins: Array.isArray(origins) && origins.length ? origins : [origin],
    call: async (method, body) =>
      JSON.parse(
        await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token)
      )
  };
}

/**
 * ���ӵ����� Antigravity LanguageServerService��
 * ֧��ֱ�Ӵ�����֪ `options.origin` �� CDP/DevToolsActivePort ֱ�������ͨ�� CDP �����������д���ԭ�㡣
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
      throw new Error('�Ƿ��ı����ػ�ҳ���ַ');
    }
    return connectOrigin(explicitOrigin, null, [explicitOrigin]);
  }
  const { port, page, pages } = await discoverAntigravityCdp(options);
  const origins = Array.from(
    new Set((Array.isArray(pages) ? pages : [page]).map(item => normalizeLoopbackOrigin(item?.url)).filter(Boolean))
  );
  const targetOrigin = normalizeLoopbackOrigin(page.url);
  return connectOrigin(targetOrigin, page, origins, { port, pages });
}

module.exports = {
  resolveHostAuthToken,
  connect,
  connectOrigin,
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
