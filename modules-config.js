'use strict';
/**
 * Antigravity 统一模块管理与配置中心 (modules-config.js)
 * 职责：
 * 1. 统一管理 ContextMeter、Chinese (汉化)、ProxyNoTun (免 TUN 代理) 三大独立子模块的配置与状态；
 * 2. 提供旧独立版 (AntigravityProxyNoTun, AntigravityChinese) 的平滑识别与迁移合并；
 * 3. 提供跨模块分层网络连通性探测 (配置合法性、本地代理可达、实际外网可用、模型请求通过)；
 * 4. 提供基于文件锁的安装/改写并发互斥机制。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { getStateDir } = require('./asar-engine');

const SCHEMA_VERSION = '0.8.4';
const PROJECT_VERSION = '0.8.4';

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  modules: {
    meter: {
      enabled: true
    },
    chinese: {
      enabled: false,
      language: 'en', // 'zh-CN' | 'en'（zh-TW 因上游词典缺少开源授权暂不内置）
      brandTitle: 'english', // 'english' | 'hidden' | 'translated'
      desktopOnly: true,
      lastUpdated: null
    },
    proxy: {
      enabled: false,
      proxyUrl: 'http://127.0.0.1:7897',
      bypassList: 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<local>',
      lastTestedAt: null
    },
    enhance: {
      promptTier: null,
      chineseTitle: null,
      lastAppliedAt: null,
      targetBuilds: {}
    }
  }
};

function normalizeBrandTitle(val) {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'hidden' || s === 'hide' || s === 'off' || s === 'none') return 'hidden';
  if (s === 'translated' || s === 'zh' || s === 'cn' || s === 'fanzhongli' || s === 'anti-gravity') return 'translated';
  return 'english';
}

function normalizeClientLanguage(val, enabledHint) {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'zh-cn' || s === 'zh' || s === 'zh-hans' || s === 'cn') return 'zh-CN';
  if (s === 'en' || s === 'english' || s === 'en-us') return 'en';
  if (enabledHint === true) return 'zh-CN';
  return 'en';
}

function resolveModulesStateDir(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return path.resolve(options.stateDir.trim());
  }
  return getStateDir();
}

function getModulesConfigPath(options = {}) {
  return path.join(resolveModulesStateDir(options), 'modules.json');
}

/**
 * 迁移旧独立版配置（识别已有独立版的机器状态，避免静默改变用户偏好）
 */
function detectAndMigrateLegacyConfigs(options = {}) {
  const migrations = [];
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const localApp = platform === 'win32'
    ? (options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'));

  // 1. 检查独立版 AntigravityProxyNoTun 配置
  const legacyProxyPaths = [
    path.join(localApp, 'AntigravityProxyNoTun', 'config.json'),
    path.join(resolveModulesStateDir(options), 'proxy.json')
  ];
  let legacyProxyFound = null;
  for (const lp of legacyProxyPaths) {
    if (fs.existsSync(lp)) {
      try {
        const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
        if (raw.proxyUrl || raw.httpProxy) {
          legacyProxyFound = {
            enabled: raw.enabled !== false,
            proxyUrl: raw.proxyUrl || raw.httpProxy || 'http://127.0.0.1:7897',
            bypassList: raw.bypassList || raw.noProxy || DEFAULT_CONFIG.modules.proxy.bypassList,
            source: lp
          };
          break;
        }
      } catch {}
    }
  }

  // 2. 检查独立版 AntigravityChinese 安装痕迹
  const legacyChinesePaths = [
    path.join(localApp, 'AntigravityChinese', 'installation.json'),
    path.join(localApp, 'AntigravityChinese', 'config.json')
  ];
  let legacyChineseFound = null;
  for (const lcp of legacyChinesePaths) {
    if (fs.existsSync(lcp)) {
      legacyChineseFound = {
        detected: true,
        source: lcp
      };
      break;
    }
  }

  return {
    proxy: legacyProxyFound,
    chinese: legacyChineseFound
  };
}

/**
 * 读取统一模块配置，自动合并默认值与旧版迁移记录
 */
function loadModulesConfig(options = {}) {
  const cfgPath = getModulesConfigPath(options);
  let current = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && parsed.modules) {
        current.modules.meter = Object.assign({}, DEFAULT_CONFIG.modules.meter, parsed.modules.meter || {});
        current.modules.chinese = Object.assign({}, DEFAULT_CONFIG.modules.chinese, parsed.modules.chinese || {});
        current.modules.chinese.language = normalizeClientLanguage(
          parsed.modules.chinese?.language,
          current.modules.chinese.enabled === true
        );
        current.modules.chinese.brandTitle = normalizeBrandTitle(parsed.modules.chinese?.brandTitle);
        current.modules.chinese.enabled = current.modules.chinese.language === 'zh-CN';
        current.modules.proxy = Object.assign({}, DEFAULT_CONFIG.modules.proxy, parsed.modules.proxy || {});
        current.modules.enhance = Object.assign(
          {},
          DEFAULT_CONFIG.modules.enhance,
          parsed.modules.enhance || {},
          {
            targetBuilds: Object.assign({}, parsed.modules.enhance?.targetBuilds || {})
          }
        );
        return current;
      }
    } catch {}
  }

  // 若无统一配置，尝试识别旧独立版并平滑继承
  const legacy = detectAndMigrateLegacyConfigs(options);
  if (legacy.proxy) {
    current.modules.proxy.enabled = legacy.proxy.enabled;
    current.modules.proxy.proxyUrl = legacy.proxy.proxyUrl;
    current.modules.proxy.bypassList = legacy.proxy.bypassList;
    current.modules.proxy.migratedFrom = legacy.proxy.source;
  }
  if (legacy.chinese && legacy.chinese.detected) {
    current.modules.chinese.enabled = true;
    current.modules.chinese.language = 'zh-CN';
    current.modules.chinese.migratedFrom = legacy.chinese.source;
  }

  saveModulesConfig(current, options);
  return current;
}

/**
 * 持久化保存统一配置
 */
function saveModulesConfig(cfg, options = {}) {
  const cfgPath = getModulesConfigPath(options);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * 通过 SOCKS5 协议验证代理握手与到目标主机的隧道建立
 */
function testSocks5Proxy(host, port, targetHost = null, targetPort = 80, timeoutMs = 2500) {
  const net = require('net');
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const done = (ok, detail = null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => done(false, 'timeout'), timeoutMs);
    sock.setTimeout(timeoutMs, () => {
      clearTimeout(timer);
      done(false, 'timeout');
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      done(false, e?.code || e?.message || 'socket_error');
    });

    let stage = 'greeting';
    let chunks = [];
    sock.on('connect', () => {
      // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] === 0xff) {
          clearTimeout(timer);
          return done(false, 'socks5_greeting_rejected');
        }
        if (!targetHost) {
          clearTimeout(timer);
          return done(true, null);
        }
        chunks = [buf.subarray(2)];
        stage = 'connect';
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; // VER
        req[1] = 0x01; // CONNECT
        req[2] = 0x00; // RSV
        req[3] = 0x03; // DOMAINNAME
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);
        sock.write(req);
        return;
      }
      if (stage === 'connect') {
        if (buf.length < 4) return;
        if (buf[0] === 0x05 && buf[1] === 0x00) {
          stage = 'http';
          chunks = [];
          sock.write(
            `GET /generate_204 HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`
          );
          return;
        }
        clearTimeout(timer);
        return done(false, `socks5_connect_err_${buf[1]}`);
      }
      if (stage === 'http') {
        const text = buf.toString('latin1');
        const m = text.match(/^HTTP\/\d\.\d\s+(\d{3})/);
        if (m) {
          const code = Number(m[1]);
          clearTimeout(timer);
          done(code >= 200 && code < 400, `http_${code}`);
        }
      }
    });
  });
}

/**
 * 分层检测代理配置健康状态
 * 分级：
 * 1. configValid: 配置格式合法
 * 2. proxyReachable: 本地代理服务端口 TCP/代理握手可达
 * 3. internetReachable: 实际外网/Google 连通
 * 4. modelCallVerified: 实际模型交互通过 (需真实模型会话，此项由真实请求证明)
 */
async function testProxyHealth(proxyUrlStr) {
  const report = {
    configValid: false,
    proxyReachable: false,
    internetReachable: false,
    modelCallVerified: false,
    error: null,
    testedAt: new Date().toISOString()
  };

  if (!proxyUrlStr || typeof proxyUrlStr !== 'string' || !proxyUrlStr.trim()) {
    report.error = '代理地址为空或格式无效';
    return report;
  }

  let u = null;
  try {
    u = new URL(proxyUrlStr.trim());
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol)) {
      report.error = `不支持的代理协议: ${u.protocol}`;
      return report;
    }
    const portNum = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : (u.protocol.startsWith('socks') ? 1080 : 80));
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      report.error = `代理端口号无效: ${u.port || ''}`;
      return report;
    }
    report.configValid = true;
  } catch (e) {
    report.error = `代理地址格式错误: ${e.message}`;
    return report;
  }

  const isSocks = u.protocol === 'socks5:' || u.protocol === 'socks5h:';
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : (isSocks ? 1080 : 80));

  // 阶段 2: 本地代理端口可达性检测
  try {
    let reachable = false;
    if (isSocks) {
      const sRes = await testSocks5Proxy(u.hostname, port, null, 80, 2500);
      reachable = sRes.ok;
    } else {
      reachable = await new Promise(resolve => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const req = http.request({
          host: u.hostname,
          port: port,
          method: 'CONNECT',
          path: 'www.google.com:443',
          timeout: 2500
        });
        req.on('connect', (_res, socket) => {
          try { socket?.destroy(); } catch {}
          req.destroy();
          finish(true);
        });
        req.on('response', (res) => {
          res.resume();
          req.destroy();
          finish(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => { req.destroy(); finish(false); });
        req.on('timeout', () => { req.destroy(); finish(false); });
        req.end();
      });
    }

    report.proxyReachable = reachable;
    if (!reachable) {
      report.error = `本地代理端口 (${u.hostname}:${port}) 无法连接，请确认代理软件已启动`;
      return report;
    }
  } catch (e) {
    report.error = `本地代理端口检测异常: ${e.message}`;
    return report;
  }

  // 阶段 3: 外网连通性检测 (通过代理探测 Google)
  try {
    let internetOk = false;
    if (isSocks) {
      const netRes = await testSocks5Proxy(u.hostname, port, 'www.google.com', 80, 3500);
      internetOk = netRes.ok;
    } else {
      internetOk = await new Promise(resolve => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const req = http.request({
          host: u.hostname,
          port: port,
          method: 'GET',
          path: 'http://www.google.com/generate_204',
          timeout: 3500,
          headers: { Host: 'www.google.com' }
        }, res => {
          res.resume();
          finish(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => finish(false));
        req.on('timeout', () => { req.destroy(); finish(false); });
        req.end();
      });
    }
    report.internetReachable = internetOk;
    if (!internetOk) {
      report.error = '代理端口可连接，但外网访问无响应，可能节点异常或未接通公网';
    }
  } catch (e) {
    report.error = `外网连通性测试异常: ${e.message}`;
  }

  return report;
}

/**
 * 针对目标文件的跨进程互斥文件锁
 */
function acquireFileLock(targetPath, timeoutMs = 6000) {
  const lockFile = targetPath + '.lock';
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        lockFile,
        release: () => {
          try { fs.unlinkSync(lockFile); } catch {}
        }
      };
    } catch (e) {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`获取目标文件互斥锁超时 (${lockFile})：当前有其他安装或卸载任务正在操作该目标。`);
      }
      // 避免死锁：检查持有者进程是否存活
      try {
        const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        if (pid && !isNaN(pid)) {
          let running = true;
          try { process.kill(pid, 0); } catch { running = false; }
          if (!running) {
            fs.unlinkSync(lockFile);
            continue;
          }
        }
      } catch {}
      const endWait = Date.now() + 50;
      while (Date.now() < endWait) {} // 短暂自旋避让
    }
  }
}

const diskModulesCache = new Map();

function invalidateDiskModulesCache(customPath = null) {
  if (!customPath) {
    diskModulesCache.clear();
    return;
  }
  diskModulesCache.delete(path.resolve(String(customPath)));
}

/**
 * 核实磁盘 ASAR 是否真正具备各模块的代码注入、字典资源及配置读取能力
 */
function inspectDiskModules(customPath = null, options = {}) {
  const { findAsarPath, builtinAsar, loadAsarEngine, getRawFs } = require('./asar-engine');
  const { TAGS } = require('./modular-installer');
  const rawFs = typeof getRawFs === 'function' ? getRawFs() : fs;
  let asarPath = null;
  try { asarPath = findAsarPath(customPath); } catch {}
  if (!asarPath || !rawFs.existsSync(asarPath)) {
    return {
      found: false,
      asarPath: null,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseStatus: 'unknown',
      chineseReason: '未找到 Antigravity 宿主 app.asar',
      proxy: false,
      proxyReady: false,
      proxyStatus: 'unknown',
      proxyReason: '未找到 Antigravity 宿主 app.asar'
    };
  }

  const useCache = !options._asar && !options._builtinAsar && options.forceRefresh !== true;
  const cacheKey = path.resolve(asarPath);
  let statSig = null;
  if (useCache) {
    try {
      const st = rawFs.statSync(asarPath);
      statSig = `${st.size}:${st.mtimeMs}`;
      const hit = diskModulesCache.get(cacheKey);
      if (hit && hit.statSig === statSig) {
        return { ...hit.result };
      }
    } catch {}
  }

  let utilsStr = '';
  let preloadStr = '';
  let entries = [];
  try {
    const asar = options._asar || loadAsarEngine();
    const primaryAsar = options._builtinAsar || builtinAsar;
    try {
      utilsStr = primaryAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    } catch {
      utilsStr = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    }
    try {
      preloadStr = primaryAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    } catch {
      preloadStr = asar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    }
    try {
      entries = primaryAsar.listPackage(asarPath);
    } catch {
      entries = asar.listPackage(asarPath);
    }
  } catch (e) {
    return {
      found: false,
      asarPath,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseStatus: 'unknown',
      chineseReason: '读取或解构 ASAR 归档异常: ' + e.message,
      proxy: false,
      proxyReady: false,
      proxyStatus: 'unknown',
      proxyReason: '读取或解构 ASAR 归档异常: ' + e.message
    };
  }

  // 统一归一化 ASAR 内部路径格式（兼容正反斜杠及无前导斜杠的列表输出）
  const normalizedEntries = new Set(
    (Array.isArray(entries) ? entries : []).map(item => {
      const clean = String(item || '').replace(/\\/g, '/').replace(/^\/+/, '');
      return clean ? '/' + clean : '';
    }).filter(Boolean)
  );

  // 1. 上下文监控模块判定
  const meterInjected = utilsStr.includes(TAGS.METER_UTILS_START) || utilsStr.includes('installContextMeter');
  const meterPreload = preloadStr.includes(TAGS.METER_PRELOAD_START) || preloadStr.includes('contextMeterAPI');
  const meterFilesOk = normalizedEntries.has('/dist/meter-main.js') && normalizedEntries.has('/dist/meter-core.js');
  const meterReady = meterInjected && meterPreload && meterFilesOk;

  // 2. 汉化模块深度判定
  const chineseHasTags = preloadStr.includes(TAGS.CHINESE_START) && preloadStr.includes(TAGS.CHINESE_END);
  let chineseStatus = 'not_injected';
  let chineseReady = false;
  let chineseReason = null;

  if (!chineseHasTags) {
    chineseStatus = 'not_injected';
    chineseReady = false;
    chineseReason = '磁盘尚未注入汉化脚本代码';
  } else {
    // 检查字典与运行时代码完整性
    const hasDictData = preloadStr.includes('__AGY_I18N_DATA__') && preloadStr.includes('_dictData');
    const hasRuntimeEngine = preloadStr.includes('createI18nEngine') || preloadStr.includes('translateSingleUnit') || preloadStr.includes('MutationObserver');
    const hasGateLogic = preloadStr.includes('chinese.enabled === false') && preloadStr.includes('modules.json');

    // 检查字典是否包含有效条目（防止被值内的 `};` 提前截断而误判空字典）
    const dictStartIdx = preloadStr.indexOf('_dictData');
    let dictNonEmpty = false;
    if (dictStartIdx >= 0) {
      const afterDict = preloadStr.slice(dictStartIdx, dictStartIdx + 500000);
      const eqIdx = afterDict.indexOf('{');
      const endWinIdx = afterDict.indexOf('window.__AGY_I18N_CONFIG__');
      const sliceLen = endWinIdx > eqIdx ? (endWinIdx - eqIdx) : (eqIdx >= 0 ? afterDict.length - eqIdx : 0);
      if (eqIdx >= 0 && sliceLen > 500 && afterDict.slice(eqIdx, eqIdx + Math.min(sliceLen, 2000)).includes('"')) {
        dictNonEmpty = true;
      }
    }
    if (!dictNonEmpty && normalizedEntries.has('/dist/i18n/zh-CN.json')) {
      dictNonEmpty = true;
    }

    if (!hasDictData || !dictNonEmpty) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化词库字典数据缺失或为空，无法实际生效';
    } else if (!hasRuntimeEngine) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化运行时引擎核心执行逻辑缺失';
    } else if (!hasGateLogic) {
      chineseStatus = 'missing_gate';
      chineseReady = false;
      chineseReason = '磁盘汉化代码缺少运行时配置门禁或有效配置路径，无法通过配置中心安全动态切换';
    } else {
      chineseStatus = 'ready';
      chineseReady = true;
      chineseReason = null;
    }
  }

  // 3. 免 TUN 代理模块判定
  const proxyHasTags = utilsStr.includes(TAGS.PROXY_START) && utilsStr.includes(TAGS.PROXY_END);
  let proxyStatus = 'not_injected';
  let proxyReady = false;
  let proxyReason = null;

  if (!proxyHasTags) {
    proxyStatus = 'not_injected';
    proxyReady = false;
    proxyReason = '磁盘尚未注入免 TUN 代理拦截代码';
  } else {
    const hasProxyDynamicRead = utilsStr.includes('modules.json') && utilsStr.includes('_cfgCandidates') && utilsStr.includes('_proxyUrl = null');
    const hasProxySet = utilsStr.includes('setProxy') || utilsStr.includes('HTTP_PROXY');
    if (hasProxyDynamicRead && hasProxySet) {
      proxyStatus = 'ready';
      proxyReady = true;
      proxyReason = null;
    } else {
      proxyStatus = 'unknown';
      proxyReady = false;
      proxyReason = '磁盘代理代码不完整，缺少动态配置读取或 Electron session 代理拦截实现';
    }
  }

  const result = {
    found: true,
    asarPath,
    meter: meterInjected,
    meterReady,
    chinese: chineseHasTags,
    chineseReady,
    chineseGate: chineseStatus === 'ready',
    chineseStatus,
    chineseReason,
    proxy: proxyHasTags,
    proxyReady,
    proxyStatus,
    proxyReason
  };
  if (useCache && statSig) {
    diskModulesCache.set(cacheKey, { statSig, result });
  }
  return result;
}

module.exports = {
  SCHEMA_VERSION,
  PROJECT_VERSION,
  DEFAULT_CONFIG,
  normalizeBrandTitle,
  normalizeClientLanguage,
  getModulesConfigPath,
  loadModulesConfig,
  saveModulesConfig,
  detectAndMigrateLegacyConfigs,
  testProxyHealth,
  acquireFileLock,
  inspectDiskModules,
  invalidateDiskModulesCache
};
