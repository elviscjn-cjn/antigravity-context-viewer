'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';

/**
 * 校验并标准化代理 URL（面板 IPC、CLI、更新器与健康检查统一复用）
 * 支持省略端口时按协议使用默认端口：http(80)、https(443)、socks5/socks5h(1080)
 */
function parseAndValidateProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: '代理地址不能为空（示例：http://127.0.0.1:7897）' };
  }
  const trimmed = normalizeProxyUrl(rawUrl);
  try {
    const u = new URL(trimmed);
    const validProto = ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol);
    if (!validProto || !u.hostname) {
      return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与主机名' };
    }
    const afterProto = trimmed.slice(u.protocol.length + 2);
    const authority = afterProto.split(/[/?#]/)[0];
    const hostPort = authority.includes('@') ? authority.split('@').pop() : authority;
    const colonIdx = hostPort.startsWith('[') ? hostPort.indexOf(']:') : hostPort.lastIndexOf(':');
    let portNum;
    if (colonIdx !== -1) {
      const explicitPort = hostPort.startsWith('[') ? hostPort.slice(colonIdx + 2) : hostPort.slice(colonIdx + 1);
      if (!/^\d+$/.test(explicitPort)) {
        return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与端口(1-65535)' };
      }
      portNum = Number(explicitPort);
    } else {
      portNum = u.protocol === 'https:' ? 443 : (u.protocol.startsWith('socks') ? 1080 : 80);
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与端口(1-65535)' };
    }
    return {
      ok: true,
      value: trimmed,
      protocol: u.protocol,
      hostname: u.hostname,
      port: portNum,
      username: u.username || '',
      password: u.password || '',
      isSocks: u.protocol === 'socks5:' || u.protocol === 'socks5h:'
    };
  } catch {
    return { ok: false, error: '代理地址格式错误，请检查协议、主机与端口' };
  }
}

function ipToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    num = ((num << 8) | n) >>> 0;
  }
  return num;
}

/**
 * 判断目标主机是否命中 NO_PROXY / bypassList 绕过规则
 */
function matchesNoProxy(hostname, noProxyList) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  const raw = String(noProxyList || '').trim();
  if (!raw) return false;

  const hostIp = ipToUint32(host);
  const tokens = raw.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') return true;
    if (token === '<local>' || token === '<-loopback>') {
      if (!host.includes('.') || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      continue;
    }
    if (token.includes('/')) {
      const [netStr, prefixStr] = token.split('/');
      const netIp = ipToUint32(netStr);
      const prefix = Number(prefixStr);
      if (hostIp !== null && netIp !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if ((hostIp & mask) === (netIp & mask)) return true;
      }
      continue;
    }
    let pattern = token;
    const colonIdx = pattern.lastIndexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(pattern.slice(colonIdx + 1)) && !pattern.startsWith('[')) {
      pattern = pattern.slice(0, colonIdx);
    }
    pattern = pattern.replace(/^\[|\]$/g, '');
    if (pattern.startsWith('*.')) pattern = pattern.slice(1);
    if (pattern.startsWith('.')) {
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith('.' + pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * 获取代理配置文件候选路径列表（动态探测，杜绝任何硬编码的机器私有绝对路径）
 */
function getProxyCandidatePaths(customPath = null, options = {}) {
  const candidates = [];
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();
  if (env.ANTIGRAVITY_PROXY_CONFIG) {
    candidates.push(path.resolve(env.ANTIGRAVITY_PROXY_CONFIG));
  }
  if (customPath && typeof customPath === 'string') {
    candidates.push(path.resolve(customPath));
  }
  if (env.AG_METER_STATE_DIR) {
    const resolvedState = path.resolve(env.AG_METER_STATE_DIR);
    candidates.push(
      path.join(resolvedState, 'modules.json'),
      path.join(resolvedState, 'proxy.json')
    );
  }
  const localBase = env.LOCALAPPDATA || (platform === 'win32'
    ? path.join(home, 'AppData', 'Local')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || path.join(home, '.config')));

  // 统一配置中心 modules.json 优先级高于历史遗留的 proxy.json，避免关闭免 TUN 后被旧文件重新激活
  candidates.push(
    path.join(localBase, 'AntigravityContextMeter', 'modules.json'),
    path.join(localBase, 'AntigravityContextMeter', 'proxy.json'),
    path.join(localBase, 'AntigravityProxyNoTun', 'config.json')
  );

  return candidates;
}

/**
 * 规范化代理 URL（去除空白与无意义的根路径斜杠，避免 Go/Chromium 解析偏差）
 */
function normalizeProxyUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  return s.replace(/^([a-zA-Z0-9+.-]+:\/\/[^/?#]+)\/+$/, '$1');
}

/**
 * 探测并解析代理配置（统一主进程与 CLI 语义，一致处理 enabled:false / 语法错误 / 空配置）
 */
function detectProxyConfig(options = {}) {
  const candidates = options.candidates || getProxyCandidatePaths(options.configPath, options);
  const fsImpl = options.fs || fs;

  for (const cfgPath of candidates) {
    try {
      if (!fsImpl.existsSync(cfgPath)) continue;
      const content = fsImpl.readFileSync(cfgPath, 'utf8');
      if (!content || !content.trim()) {
        // 高优先级统一配置若存在但为空，阻止回落旧配置导致状态错乱
        if (path.basename(cfgPath) === 'modules.json') {
          return { detected: true, enabled: false, configPath: cfgPath, parseError: 'empty_file' };
        }
        continue;
      }
      const cfg = JSON.parse(content);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        if (path.basename(cfgPath) === 'modules.json') {
          return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_schema' };
        }
        continue;
      }
      const isUnified = path.basename(cfgPath) === 'modules.json';
      if (isUnified && (!cfg.modules || typeof cfg.modules !== 'object' || Array.isArray(cfg.modules))) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_modules_schema' };
      }
      const proxyNode = (cfg.modules && cfg.modules.proxy && typeof cfg.modules.proxy === 'object' && !Array.isArray(cfg.modules.proxy))
        ? cfg.modules.proxy
        : (isUnified ? null : cfg);

      if (!proxyNode) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_proxy_schema' };
      }

      // 明确处理 enabled: false：当用户显式禁用代理时停止探测并不应用代理
      if (proxyNode.enabled === false) {
        return {
          detected: true,
          enabled: false,
          configPath: cfgPath
        };
      }

      // 若是统一配置 modules.json，只有显式 enabled === true 时才启用，避免缺字段误激活旧 proxy.json
      if (isUnified && proxyNode.enabled !== true) {
        return {
          detected: true,
          enabled: false,
          configPath: cfgPath
        };
      }

      const httpProxy = normalizeProxyUrl(proxyNode.httpProxy || proxyNode.proxyUrl || '');
      if (!httpProxy) {
        if (isUnified) return { detected: true, enabled: false, configPath: cfgPath, parseError: 'missing_proxy_url' };
        continue;
      }

      const rawNoProxy = proxyNode.noProxy !== undefined ? proxyNode.noProxy : proxyNode.bypassList;
      const noProxy = (rawNoProxy !== undefined && rawNoProxy !== null)
        ? String(rawNoProxy).trim()
        : DEFAULT_NO_PROXY;
      const allProxy = normalizeProxyUrl(proxyNode.allProxy || httpProxy) || httpProxy;

      return {
        detected: true,
        enabled: true,
        configPath: cfgPath,
        httpProxy,
        allProxy,
        noProxy
      };
    } catch (e) {
      // 统一配置 modules.json 存在但损坏时 fail-closed，绝不滑落去加载历史 proxy.json
      if (path.basename(cfgPath) === 'modules.json') {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: e?.message || 'parse_error' };
      }
      continue;
    }
  }

  return {
    detected: false,
    enabled: false,
    configPath: null
  };
}

/**
 * 将探测到的代理配置应用到指定环境变量对象中
 * overrideExisting=true 时用配置值强行覆盖父环境/loginShellEnv 的残留或冲突代理变量
 */
function applyProxyEnvironment(targetEnv = process.env, options = {}) {
  const detected = detectProxyConfig(options);
  if (!detected.enabled || !detected.httpProxy) {
    return targetEnv;
  }

  const { httpProxy, allProxy, noProxy } = detected;
  const override = Boolean(options && options.overrideExisting);

  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    if (override || !targetEnv[k]) targetEnv[k] = httpProxy;
  }

  if (allProxy) {
    for (const k of ['ALL_PROXY', 'all_proxy']) {
      if (override || !targetEnv[k]) targetEnv[k] = allProxy;
    }
  }

  if (noProxy !== undefined && noProxy !== null) {
    for (const k of ['NO_PROXY', 'no_proxy']) {
      if (noProxy) {
        if (override || !targetEnv[k]) targetEnv[k] = noProxy;
      } else if (override) {
        delete targetEnv[k];
      }
    }
  }

  if (override) {
    targetEnv.NODE_USE_ENV_PROXY = '1';
  }

  return targetEnv;
}

/**
 * 为 CLI 子进程组装代理环境（剥离 Electron 运行时变量并确保终端色彩）
 */
function buildCliProxyEnv(baseEnv = process.env, options = {}) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;

  applyProxyEnvironment(env, options);

  // 恢复交互式 CLI 子进程环境的原生彩虹渐变 Logo 与颜色能力（跨平台支持 Windows / macOS / Linux）
  delete env.NO_COLOR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  return env;
}

/**
 * 判断主机名是否为本机回环地址，确保本机回调与本地服务绝不误经远端代理。
 */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

/**
 * 通过 SOCKS5 (RFC1928 / RFC1929) 代理建立目标 TCP 隧道。
 * 握手或 CONNECT 失败立即 reject，不静默回落直连。
 */
function openSocks5Tunnel(proxyParsed, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = net.connect({ host: proxyParsed.hostname, port: proxyParsed.port });
    let settled = false;
    let stage = 'greeting';
    let recvBuf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 代理握手超时 (${proxyParsed.hostname}:${proxyParsed.port}, ${timeoutMs}ms)`));
    }, timeoutMs);

    function cleanupListeners() {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { socket.destroy(); } catch { }
      reject(err);
    }

    function succeed(leftover) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      if (leftover && leftover.length > 0) {
        socket.unshift(leftover);
      }
      resolve(socket);
    }

    function sendConnectRequest() {
      stage = 'connect';
      const portBuf = Buffer.allocUnsafe(2);
      portBuf.writeUInt16BE(Number(targetPort) || 443, 0);
      let addrPart;
      if (net.isIPv4(targetHost)) {
        const octets = targetHost.split('.').map(n => Number(n));
        addrPart = Buffer.from([0x01, ...octets]);
      } else {
        const hostBuf = Buffer.from(String(targetHost), 'utf8');
        if (hostBuf.length === 0 || hostBuf.length > 255) {
          return fail(new Error(`SOCKS5 目标主机名长度非法: ${targetHost}`));
        }
        addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
      }
      const reqPacket = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]);
      socket.write(reqPacket);
    }

    function onConnect() {
      const hasAuth = Boolean(proxyParsed.username || proxyParsed.password);
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
      socket.write(greeting);
    }

    function onData(chunk) {
      recvBuf = recvBuf.length ? Buffer.concat([recvBuf, chunk]) : chunk;
      while (!settled) {
        if (stage === 'greeting') {
          if (recvBuf.length < 2) return;
          const ver = recvBuf[0];
          const method = recvBuf[1];
          recvBuf = recvBuf.subarray(2);
          if (ver !== 0x05) {
            return fail(new Error(`SOCKS5 代理版本响应异常: 0x${ver.toString(16)}`));
          }
          if (method === 0x00) {
            sendConnectRequest();
            continue;
          }
          if (method === 0x02) {
            stage = 'auth';
            const uBuf = Buffer.from(decodeURIComponent(proxyParsed.username || ''), 'utf8');
            const pBuf = Buffer.from(decodeURIComponent(proxyParsed.password || ''), 'utf8');
            if (uBuf.length > 255 || pBuf.length > 255) {
              return fail(new Error('SOCKS5 认证用户名或密码过长'));
            }
            const authPacket = Buffer.concat([
              Buffer.from([0x01, uBuf.length]),
              uBuf,
              Buffer.from([pBuf.length]),
              pBuf
            ]);
            socket.write(authPacket);
            continue;
          }
          return fail(new Error(`SOCKS5 代理拒绝认证协商 (method=0x${method.toString(16)})`));
        }

        if (stage === 'auth') {
          if (recvBuf.length < 2) return;
          const authVer = recvBuf[0];
          const status = recvBuf[1];
          recvBuf = recvBuf.subarray(2);
          if (authVer !== 0x01 || status !== 0x00) {
            return fail(new Error(`SOCKS5 代理用户名密码认证失败 (status=${status})`));
          }
          sendConnectRequest();
          continue;
        }

        if (stage === 'connect') {
          if (recvBuf.length < 4) return;
          const ver = recvBuf[0];
          const rep = recvBuf[1];
          const atyp = recvBuf[3];
          if (ver !== 0x05) {
            return fail(new Error(`SOCKS5 响应版本异常: 0x${ver.toString(16)}`));
          }
          if (rep !== 0x00) {
            return fail(new Error(`SOCKS5 代理 CONNECT 失败 (reply=0x${rep.toString(16)})`));
          }
          let totalReplyLen = 0;
          if (atyp === 0x01) totalReplyLen = 4 + 4 + 2;
          else if (atyp === 0x04) totalReplyLen = 4 + 16 + 2;
          else if (atyp === 0x03) {
            if (recvBuf.length < 5) return;
            totalReplyLen = 4 + 1 + recvBuf[4] + 2;
          } else {
            return fail(new Error(`SOCKS5 响应地址类型未知: 0x${atyp.toString(16)}`));
          }
          if (recvBuf.length < totalReplyLen) return;
          const leftover = recvBuf.subarray(totalReplyLen);
          succeed(leftover);
          return;
        }
        return;
      }
    }

    function onError(err) {
      fail(new Error(`SOCKS5 代理连接失败: ${err?.message || String(err)}`));
    }
    function onClose() {
      fail(new Error('SOCKS5 代理连接在握手完成前意外关闭'));
    }

    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * 通过 HTTP / HTTPS 代理 CONNECT 方法建立隧道。
 * CONNECT 失败、返回非 200 或超时均直接 reject，不静默回落直连。
 */
function openHttpConnectTunnel(proxyParsed, targetHost, targetPort, timeoutMs, proxyTlsOpts = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const https = require('https');
    const httpMod = proxyParsed.protocol === 'https:' ? https : http;
    let settled = false;
    const reqHeaders = {};
    if (proxyParsed.username || proxyParsed.password) {
      const cred = `${decodeURIComponent(proxyParsed.username || '')}:${decodeURIComponent(proxyParsed.password || '')}`;
      reqHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;
    }
    const connectOpts = {
      host: proxyParsed.hostname,
      port: proxyParsed.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: reqHeaders
    };
    if (proxyParsed.protocol === 'https:') {
      if (proxyTlsOpts.ca) connectOpts.ca = proxyTlsOpts.ca;
      if (typeof proxyTlsOpts.rejectUnauthorized === 'boolean') {
        connectOpts.rejectUnauthorized = proxyTlsOpts.rejectUnauthorized;
      }
    }

    const connectReq = httpMod.request(connectOpts);
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    connectReq.on('connect', (res, socket) => {
      if (settled) {
        try { socket.destroy(); } catch { }
        return;
      }
      if (res.statusCode === 200) {
        settled = true;
        resolve(socket);
      } else {
        try { socket.destroy(); } catch { }
        finishErr(new Error(`HTTP 代理 CONNECT 失败: HTTP ${res.statusCode}`));
      }
    });
    connectReq.on('error', err => {
      finishErr(new Error(`HTTP 代理连接失败: ${err?.message || String(err)}`));
    });
    connectReq.setTimeout(timeoutMs, () => {
      try { connectReq.destroy(); } catch { }
      finishErr(new Error(`HTTP 代理 CONNECT 超时 (${timeoutMs}ms)`));
    });
    connectReq.end();
  });
}

function classifyRequestTimeoutPhase(err, usedProxyTunnel) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  if (/proxy_tunnel|connect 失败|代理.*超时|socks5/i.test(msg)) {
    return 'proxy_tunnel_connect';
  }
  if (usedProxyTunnel && (/请求超时/.test(msg) || code === 'ETIMEDOUT')) {
    return 'tls_or_response';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || /connect etimedout|connect econnrefused/i.test(msg)) {
    return 'tcp_connect';
  }
  if (/请求超时|timeout|aborted|socket hang up|econnreset/i.test(msg)) {
    return 'tls_or_response';
  }
  return null;
}

/**
 * 脱敏错误文案，移除代理口令及任何 OAuth/Token 凭据片段。
 */
function sanitizeDiagnosticErrorText(err) {
  const msg = String(err?.message || err || '请求失败');
  return msg
    .replace(/([a-zA-Z0-9+.-]+:\/\/)([^/@\s]+@)/g, '$1')
    .replace(/(code|access_token|refresh_token|id_token|client_secret|authorization)=([^&\s"']+)/gi, '$1=<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <REDACTED>');
}

/**
 * 基于插件代理配置发起通用 HTTP/HTTPS 请求（不依赖 Electron C++ 启动期冻结的 NODE_USE_ENV_PROXY）。
 * - 本机回环地址始终直连，绝不误走远端代理；
 * - 外部地址在插件代理启用时严格经由 HTTP CONNECT / SOCKS5 隧道，隧道失败立即报错，绝不静默降级。
 */
function requestWithProxyTunnel(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const http = require('http');
      const https = require('https');
      const tls = require('tls');
      const startMs = Date.now();
      const timeoutMs = Number(options.timeoutMs) || 15000;
      const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : (4 * 1024 * 1024);
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const targetPort = Number(parsedUrl.port) || (isHttps ? 443 : 80);
      const stage = options.stage || 'request';

      const explicitProxy = options.proxyUrl ? normalizeProxyUrl(options.proxyUrl) : '';
      const proxyInfo = options.useProxy === false
        ? null
        : (explicitProxy
          ? { enabled: true, httpProxy: explicitProxy, noProxy: options.noProxy ?? DEFAULT_NO_PROXY }
          : detectProxyConfig(options.proxyConfigOptions || {}));

      const loopback = isLoopbackHost(parsedUrl.hostname);
      const pluginProxyConfigured = Boolean(!loopback && proxyInfo && proxyInfo.enabled && proxyInfo.httpProxy);
      const bypassMatched = loopback
        ? true
        : (pluginProxyConfigured ? Boolean(matchesNoProxy(parsedUrl.hostname, proxyInfo.noProxy)) : false);
      const parsedProxy = pluginProxyConfigured && !bypassMatched
        ? parseAndValidateProxyUrl(proxyInfo.httpProxy)
        : null;
      const willUseProxyTunnel = Boolean(pluginProxyConfigured && !bypassMatched);

      const diag = {
        stage,
        targetHost: parsedUrl.hostname,
        targetPort,
        proxySource: loopback
          ? 'loopback_direct'
          : (willUseProxyTunnel ? (explicitProxy ? 'explicit_proxy' : 'plugin_config') : (bypassMatched ? 'plugin_bypass' : (options.useProxy === false ? 'disabled' : 'direct'))),
        proxyProtocol: parsedProxy?.ok ? parsedProxy.protocol : 'direct',
        proxyEndpoint: (pluginProxyConfigured && !bypassMatched) ? redactProxyUrl(proxyInfo.httpProxy) : null,
        bypassMatched,
        timeoutPhase: null,
        durationMs: 0,
        httpStatus: null,
        errorCode: null
      };

      let settled = false;
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        diag.durationMs = Date.now() - startMs;
        diag.timeoutPhase = diag.timeoutPhase || classifyRequestTimeoutPhase(err, willUseProxyTunnel);
        diag.errorCode = err?.code || diag.timeoutPhase || 'REQUEST_FAILED';
        const wrapped = (err instanceof Error) ? err : new Error(String(err || '请求失败'));
        if (!wrapped.diagnostics) wrapped.diagnostics = { ...diag };
        if (diag.stage && !wrapped.stage) wrapped.stage = diag.stage;
        if (diag.targetHost && !wrapped.targetHost) wrapped.targetHost = diag.targetHost;
        reject(wrapped);
      };

      const doRequest = (tunnelSocket) => {
        let tunnelConsumed = false;
        const releaseUnusedTunnel = () => {
          if (tunnelSocket && !tunnelConsumed && !tunnelSocket.destroyed) {
            try { tunnelSocket.destroy(); } catch { }
          }
        };
        const method = String(options.method || 'GET').toUpperCase();
        const headers = Object.assign({}, options.headers || {});
        const bodyBuf = options.body !== undefined && options.body !== null
          ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8'))
          : null;
        if (bodyBuf && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
          headers['Content-Length'] = bodyBuf.length;
        }

        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: targetPort,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          headers
        };
        if (isHttps) {
          if (options.ca) reqOpts.ca = options.ca;
          if (typeof options.rejectUnauthorized === 'boolean') reqOpts.rejectUnauthorized = options.rejectUnauthorized;
        }
        const transport = isHttps ? https : http;
        if (tunnelSocket) {
          // 严禁与 agent: false 混用 createConnection（Node.js 传入 agent: false 时会构造默认 Agent 从而忽略 options.createConnection 并回退直连 DNS）
          const tunnelAgent = new transport.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => {
            tunnelConsumed = true;
            if (!isHttps) return tunnelSocket;
            const tlsOpts = { socket: tunnelSocket, servername: parsedUrl.hostname };
            if (options.ca) tlsOpts.ca = options.ca;
            if (typeof options.rejectUnauthorized === 'boolean') tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
            return tls.connect(tlsOpts);
          };
          reqOpts.agent = tunnelAgent;
        }
        const req = transport.request(reqOpts, (res) => {
          diag.httpStatus = res.statusCode || null;
          const chunks = [];
          let totalBytes = 0;
          let oversized = false;
          res.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              if (!oversized) {
                oversized = true;
                try { res.destroy(); } catch { }
                releaseUnusedTunnel();
                finishReject(new Error(`响应体超出大小限制 (>${maxBytes} 字节)`));
              }
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled || oversized) return;
            if (res.complete === false || res.aborted) {
              releaseUnusedTunnel();
              return finishReject(new Error('响应流未完整结束'));
            }
            settled = true;
            diag.durationMs = Date.now() - startMs;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { }
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers,
              text,
              json,
              diagnostics: { ...diag }
            });
          });
          res.on('error', (err) => {
            releaseUnusedTunnel();
            finishReject(err);
          });
        });

        req.setTimeout(timeoutMs, () => {
          const timeoutErr = new Error(`请求超时 (${parsedUrl.hostname}, ${timeoutMs}ms)`);
          timeoutErr.code = 'ETIMEDOUT';
          try { req.destroy(timeoutErr); } catch { }
        });
        req.on('error', (err) => {
          releaseUnusedTunnel();
          finishReject(err);
        });
        if (bodyBuf && bodyBuf.length > 0) {
          req.write(bodyBuf);
        }
        req.end();
      };

      if (willUseProxyTunnel) {
        if (!parsedProxy || !parsedProxy.ok) {
          return finishReject(new Error(`代理配置无效: ${parsedProxy?.error || '无法解析代理地址'}`));
        }
        const tunnelPromise = (parsedProxy.protocol === 'socks5:' || parsedProxy.protocol === 'socks5h:')
          ? openSocks5Tunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs)
          : openHttpConnectTunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs, {
            ca: options.proxyCa || options.ca,
            rejectUnauthorized: options.proxyRejectUnauthorized
          });
        tunnelPromise.then(
          (socket) => doRequest(socket),
          (err) => {
            diag.timeoutPhase = 'proxy_tunnel_connect';
            finishReject(err);
          }
        );
        return;
      }

      doRequest(null);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 规范化 bypassList / no_proxy 字符串用于运行态与磁盘态等值比较
 */
function normalizeBypassListForCompare(rawVal) {
  return String(rawVal || '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .map(s => (s === '<local>' ? '<-loopback>' : s))
    .filter(Boolean)
    .join(',');
}

/**
 * 对代理地址进行脱敏，剥离账号及密码凭据仅保留协议与主机端口。
 */
function redactProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(normalizeProxyUrl(rawUrl));
    if (!u.protocol || !u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(rawUrl).replace(/\/\/[^/@\s]+@/, '//') || null;
  }
}

module.exports = {
  DEFAULT_NO_PROXY,
  redactProxyUrl,
  normalizeProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  isLoopbackHost,
  openSocks5Tunnel,
  openHttpConnectTunnel,
  classifyRequestTimeoutPhase,
  sanitizeDiagnosticErrorText,
  requestWithProxyTunnel,
  getProxyCandidatePaths,
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv
};
