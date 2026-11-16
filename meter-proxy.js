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
 * 统一规范化 bypassList / no_proxy 字符串用于运行态与磁盘态等值比较
 */
function normalizeBypassListForCompare(rawVal) {
  return String(rawVal || '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .map(s => (s === '<local>' ? '<-loopback>' : s))
    .filter(Boolean)
    .join(',');
}

module.exports = {
  DEFAULT_NO_PROXY,
  normalizeProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  getProxyCandidatePaths,
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv
};
