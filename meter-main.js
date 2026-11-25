'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch { }
const {
  collect,
  collectTurnState,
  collectTokenHistory,
  getTokenHistoryResponse,
  collectSessionTimelineAsync,
  recordModelCalls,
  recordModelCallsAsync,
  getPluginSettings,
  savePluginSettings,
  launchCliSession,
  checkUpdateAsync,
  applyUpdateAsync,
  resolveNodeRuntime,
  getLiveRuntimeDir,
  getContextUnlockStatus,
  applyContextUnlock,
  applyContextUnlockAsync,
  restoreContextUnlock,
  restoreContextUnlockAsync,
  syncPricingCatalogAsync
} = require('./meter-collector');
const { isValidExternalUrl, compareVersions } = require('./meter-core');

function isHostVersionAtLeast(targetVersion = '2.34.0') {
  try {
    const raw = typeof app?.getVersion === 'function' ? String(app.getVersion() || '').trim() : '';
    if (!raw) return false;
    return compareVersions(raw, targetVersion) >= 0;
  } catch {
    return false;
  }
}
const { PROJECT_VERSION } = require('./modules-config');
const MAIN_STARTED_AT = Date.now();
const MAIN_CAPABILITIES = {
  scan: true,
  tokenHistory: true,
  sessionTimeline: true,
  quota: true,
  recordCalls: true,
  settings: true,
  launchCli: true,
  contextUnlock: true,
  enhance: true,
  rehydrate: true,
  modules: true,
  accounts: true,
  checkUpdate: true,
  applyUpdate: true,
  restartHost: true,
  hotReload: true,
  syncPricing: true
};

const {
  applyProxyEnvironment,
  detectProxyConfig,
  normalizeProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl,
  redactProxyUrl
} = require('./meter-proxy');
const { getStateDir } = require('./asar-engine');

function resolveBootProxySnapshot() {
  const bootInfo = (typeof globalThis !== 'undefined' && globalThis.__AG_PROXY_BOOT_INFO__ && globalThis.__AG_PROXY_BOOT_INFO__.injectedAtStartup)
    ? globalThis.__AG_PROXY_BOOT_INFO__
    : null;
  if (bootInfo) {
    return {
      injectedAtStartup: true,
      enabled: Boolean(bootInfo.active && bootInfo.proxyUrl),
      proxyUrl: bootInfo.proxyUrl || null,
      bypassList: typeof bootInfo.bypassList === 'string' ? bootInfo.bypassList : null
    };
  }
  const envProxy = normalizeProxyUrl(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '');
  const envBypass = String(process.env.NO_PROXY || process.env.no_proxy || '').trim() || null;
  return {
    injectedAtStartup: false,
    enabled: Boolean(envProxy),
    proxyUrl: envProxy || null,
    bypassList: envBypass
  };
}

const bootProxySnapshot = resolveBootProxySnapshot();
let languageServerProxy = null;
const bootChineseSnapshots = new Map();

/**
 * 解析当前进程启动瞬间的宿主汉化状态快照（同一 stateDir 与目标 ASAR 生命周期内保持不变，防止受隔离上下文或用户项目名误判）
 */
function resolveBootChineseSnapshot(customAsarPath = null) {
  const rawAsarTarget = customAsarPath || process.env.AG_METER_TEST_HOST_ASAR || null;
  const asarKey = rawAsarTarget
    ? (process.platform === 'win32' ? path.resolve(String(rawAsarTarget)).toLowerCase() : path.resolve(String(rawAsarTarget)))
    : '__default_asar__';
  const key = `${String(process.env.AG_METER_STATE_DIR || '__default__')}::${asarKey}`;
  if (bootChineseSnapshots.has(key)) return bootChineseSnapshots.get(key);
  let snap = { enabled: false, language: 'en' };
  try {
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules(rawAsarTarget);
    const ch = cfg?.modules?.chinese || {};
    const diskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
    const active = Boolean(ch.enabled && String(ch.language || '').toLowerCase() !== 'en' && diskReady);
    snap = {
      enabled: active,
      language: String(ch.language || (ch.enabled ? 'zh-CN' : 'en'))
    };
  } catch { }
  bootChineseSnapshots.set(key, snap);
  return snap;
}
try { resolveBootChineseSnapshot(); } catch { }

function buildRuntimeModulesMeta(cfg, customAsarPath = null) {
  const diskProxy = cfg?.modules?.proxy || {};
  const diskEnabled = Boolean(diskProxy.enabled);
  const diskUrl = normalizeProxyUrl(diskProxy.proxyUrl || '');
  const diskBypass = normalizeBypassListForCompare(diskProxy.bypassList || '');
  const runtimeEnabled = Boolean(bootProxySnapshot.enabled);
  const runtimeUrl = normalizeProxyUrl(bootProxySnapshot.proxyUrl || '');
  const runtimeBypass = normalizeBypassListForCompare(bootProxySnapshot.bypassList || '');
  const proxyNeedsRestart = runtimeEnabled !== diskEnabled ||
    (diskEnabled && runtimeEnabled && (diskUrl !== runtimeUrl || diskBypass !== runtimeBypass));
  const bootZh = resolveBootChineseSnapshot(customAsarPath);
  const diskCh = cfg?.modules?.chinese || {};
  const diskZhActive = Boolean(diskCh.enabled && String(diskCh.language || '').toLowerCase() !== 'en');
  return {
    injectedAtStartup: Boolean(bootProxySnapshot.injectedAtStartup),
    proxyActive: runtimeEnabled,
    runtimeProxyUrl: redactProxyUrl(runtimeUrl) || null,
    runtimeBypassList: typeof bootProxySnapshot.bypassList === 'string' ? bootProxySnapshot.bypassList : null,
    proxyNeedsRestart,
    languageServerProxy,
    chineseActive: Boolean(bootZh.enabled),
    chineseBootLanguage: bootZh.language,
    chineseNeedsRestart: diskZhActive !== Boolean(bootZh.enabled)
  };
}

function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    const env = applyProxyEnvironment(targetEnv, { overrideExisting: true });
    if (targetEnv !== process.env) {
      const url = env.HTTPS_PROXY;
      const httpConsistent = Boolean(url && ['HTTP_PROXY', 'http_proxy', 'https_proxy'].every(key => env[key] === url));
      const allConsistent = Boolean(env.ALL_PROXY && env.all_proxy === env.ALL_PROXY);
      languageServerProxy = {
        endpoint: redactProxyUrl(url),
        configured: httpConsistent && allConsistent && env.NODE_USE_ENV_PROXY === '1',
        bypassConsistent: (env.NO_PROXY || '') === (env.no_proxy || '')
      };
    }
    return env;
  } catch {
    return targetEnv;
  }
}
ensureProxyEnvironment(process.env);
exports.ensureProxyEnvironment = ensureProxyEnvironment;

function buildBootBackendPayload() {
  return {
    backendVersion: PROJECT_VERSION,
    backendSource: 'electron-ipc',
    pid: process.pid,
    startedAt: MAIN_STARTED_AT,
    capabilities: { ...MAIN_CAPABILITIES }
  };
}

const DIAGNOSTIC_LOG_MAX_BYTES = 512 * 1024;
const DIAGNOSTIC_LOG_KEEP_BYTES = 128 * 1024;
const DIAGNOSTIC_LOG_MAX_QUEUE = 200;
const diagnosticLogQueue = [];
let diagnosticFlushPromise = null;
let diagnosticDirReadyFor = null;
const meterSourceFileCache = new Map();

async function trimDiagnosticLogIfNeeded(logFile) {
  try {
    const st = await fs.promises.stat(logFile).catch(() => null);
    if (!st || !st.isFile() || st.size <= DIAGNOSTIC_LOG_MAX_BYTES) return;
    const keepBytes = Math.min(DIAGNOSTIC_LOG_KEEP_BYTES, st.size);
    const startOffset = Math.max(0, st.size - keepBytes);
    const handle = await fs.promises.open(logFile, 'r');
    try {
      const buf = Buffer.allocUnsafe(keepBytes);
      const { bytesRead } = await handle.read(buf, 0, keepBytes, startOffset);
      let tail = buf.subarray(0, bytesRead).toString('utf8');
      if (startOffset > 0) {
        const nlIdx = tail.indexOf('\n');
        if (nlIdx >= 0 && nlIdx + 1 < tail.length) {
          tail = tail.slice(nlIdx + 1);
        }
      }
      await fs.promises.writeFile(logFile, tail, 'utf8');
    } finally {
      await handle.close().catch(() => { });
    }
  } catch { }
}

async function flushDiagnosticLogQueue() {
  while (diagnosticLogQueue.length > 0) {
    const first = diagnosticLogQueue[0];
    const targetDir = first.logDir;
    const targetFile = first.logFile;
    let batch = '';
    while (diagnosticLogQueue.length > 0 && diagnosticLogQueue[0].logFile === targetFile) {
      batch += diagnosticLogQueue.shift().line;
    }
    try {
      if (diagnosticDirReadyFor !== targetDir) {
        await fs.promises.mkdir(targetDir, { recursive: true });
        diagnosticDirReadyFor = targetDir;
      }
      await fs.promises.appendFile(targetFile, batch, 'utf8');
      await trimDiagnosticLogIfNeeded(targetFile);
    } catch {
      diagnosticDirReadyFor = null;
    }
  }
}

function logDiagnostic(stage, details = {}) {
  try {
    const logDir = getStateDir();
    const logFile = path.join(logDir, 'meter-stage-diagnostics.log');
    const time = new Date().toISOString();
    const line = `[${time}] [STAGE:${stage}] ${JSON.stringify(details)}\n`;
    if (diagnosticLogQueue.length >= DIAGNOSTIC_LOG_MAX_QUEUE) {
      diagnosticLogQueue.shift();
    }
    diagnosticLogQueue.push({ logDir, logFile, line });
    if (!diagnosticFlushPromise) {
      const startFlush = () => {
        diagnosticFlushPromise = flushDiagnosticLogQueue()
          .catch(() => { })
          .finally(() => {
            diagnosticFlushPromise = null;
            if (diagnosticLogQueue.length > 0) {
              startFlush();
            }
          });
      };
      startFlush();
    }
  } catch { }
}

async function flushDiagnosticLogsForTest() {
  while (diagnosticFlushPromise || diagnosticLogQueue.length > 0) {
    if (diagnosticFlushPromise) {
      await diagnosticFlushPromise;
    } else {
      await flushDiagnosticLogQueue();
    }
  }
}

function readCachedSourceFile(filePath) {
  const resolved = path.resolve(filePath);
  const st = fs.statSync(resolved);
  const cached = meterSourceFileCache.get(resolved);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(resolved, 'utf8');
  meterSourceFileCache.set(resolved, { size: st.size, mtimeMs: st.mtimeMs, content });
  return content;
}

function clearMeterSourceCacheForTest() {
  meterSourceFileCache.clear();
}

function getMeterSource() {
  try {
    const coreCode = readCachedSourceFile(path.join(__dirname, 'meter-core.js'));
    const rendererCode = readCachedSourceFile(path.join(__dirname, 'meter-renderer.js'));
    let bootstrap = `window.__AGContextMeterBootBackend = ${JSON.stringify(buildBootBackendPayload())};\n`;
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        bootstrap += `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
    } catch { }
    try {
      const { loadModulesConfig } = require('./modules-config');
      const mCfg = loadModulesConfig();
      if (mCfg?.modules?.chinese) {
        bootstrap += `window.__AGY_CHINESE_CONFIG__ = ${JSON.stringify(mCfg.modules.chinese)};\n`;
      }
    } catch { }
    return `(() => {
  try {
    ${bootstrap}
    ${coreCode}
    ${rendererCode}
    return true;
  } catch (fatalErr) {
    const msg = String(fatalErr && fatalErr.stack ? fatalErr.stack : fatalErr);
    console.error('[Context Meter Fatal Init Error]:', msg);
    try { window.__AGContextMeterFatalError = msg; } catch {}
    return false;
  }
})();`;
  } catch (e) {
    return '';
  }
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    const portNum = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : (url.protocol === 'http:' ? 80 : 0));
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname !== '127.0.0.1' || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveTargetWindow(sender) {
  try {
    const { BrowserWindow } = require('electron');
    const direct = BrowserWindow.fromWebContents(sender);
    if (direct && !direct.isDestroyed()) return direct;
  } catch { }
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch { }
  return null;
}

let registered = false;
let isAppQuitting = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();
const inFlightInjections = new WeakMap();
const pendingForceInjections = new WeakMap();
const wcProbeTimers = new WeakMap();

function setAppQuitting(val = true) {
  isAppQuitting = Boolean(val);
}

function getAppQuitting() {
  return isAppQuitting;
}

async function handleModulesStatus(event, customAsar = null) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  try {
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    return {
      ok: true,
      data: cfg,
      disk: inspectDiskModules(customAsar),
      runtime: buildRuntimeModulesMeta(cfg, customAsar),
      configCorrupted: Boolean(cfg.__configCorrupted),
      configError: cfg.__configError || null,
      corruptedConfigPath: cfg.__corruptedConfigPath || null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 校验本地代理地址协议与端口范围是否有效（统一委托 parseAndValidateProxyUrl）
 */
function validateProxyUrlInput(proxyUrlStr) {
  return parseAndValidateProxyUrl(proxyUrlStr);
}

function getRecordedInstallerDir() {
  try {
    const manifestPath = path.join(getStateDir(), 'installation.json');
    if (!fs.existsSync(manifestPath)) return null;
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (m && typeof m.installerDir === 'string' && m.installerDir.trim()) {
      return m.installerDir.trim();
    }
  } catch { }
  return null;
}

/**
 * 生成跨平台的命令行安装指引（优先提供已记录的外部安装包路径，防止 macOS/Linux 上误提示 install.bat）
 */
function formatInstallCommandHint(subCommand = 'install', installerDir = getRecordedInstallerDir()) {
  const cmdPart = process.platform === 'win32' && subCommand === 'install'
    ? 'install.bat（或在外部终端运行 node cli.js install）'
    : `node cli.js ${subCommand}`;
  if (installerDir) {
    return process.platform === 'win32'
      ? `在目录「${installerDir}」打开外部终端运行 ${cmdPart}`
      : `在目录「${installerDir}」的终端执行 ${cmdPart}`;
  }
  return `在插件安装包目录打开外部终端运行 ${cmdPart}`;
}

async function handleToggleModule(event, moduleName, enable, extraOpts = {}) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  try {
    const { loadModulesConfig, saveModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    if (!cfg.modules[moduleName]) throw new Error(`未知的模块标识: ${moduleName}`);

    const targetEnable = Boolean(enable);
    const disk = inspectDiskModules(extraOpts?.asarPath || null);

    // 判断磁盘是否已经具备该模块所需脚本、字典及配置读取能力
    const hasDiskCapability = (() => {
      if (moduleName === 'chinese') {
        return Boolean(disk.chineseReady);
      } else if (moduleName === 'proxy') {
        return Boolean(disk.proxyReady);
      } else if (moduleName === 'meter') {
        return Boolean(disk.meterReady);
      }
      return false;
    })();

    // 结果类型 1: 已有完整运行时可通过配置切换 (config_toggled)
    if (hasDiskCapability) {
      // 在任何写盘修改之前先锁定本生命周期的启动汉化快照，防止先 toggle 后读盘自欺
      resolveBootChineseSnapshot(extraOpts?.asarPath);
      const prevChineseEnabled = Boolean(cfg.modules.chinese?.enabled);
      const prevChineseLang = cfg.modules.chinese?.language || (prevChineseEnabled ? 'zh-CN' : 'en');
      if (moduleName === 'proxy' && extraOpts) {
        if (extraOpts.proxyUrl !== undefined) {
          const check = validateProxyUrlInput(extraOpts.proxyUrl);
          if (!check.ok) {
            return {
              ok: false,
              status: 'invalid_config',
              data: cfg,
              disk,
              runtime: buildRuntimeModulesMeta(cfg, extraOpts?.asarPath),
              error: check.error,
              restartRequired: false
            };
          }
          cfg.modules.proxy.proxyUrl = check.value;
        } else if (targetEnable && !cfg.modules.proxy.proxyUrl) {
          return {
            ok: false,
            status: 'invalid_config',
            data: cfg,
            disk,
            runtime: buildRuntimeModulesMeta(cfg, extraOpts?.asarPath),
            error: '开启免 TUN 前请填写有效的本地代理地址',
            restartRequired: false
          };
        }
        if (typeof extraOpts.bypassList === 'string') {
          cfg.modules.proxy.bypassList = extraOpts.bypassList.trim();
        }
        cfg.modules.proxy.lastUpdated = new Date().toISOString();
      }

      if (moduleName === 'chinese') {
        const { normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
        const nextLang = normalizeClientLanguage(extraOpts?.language, targetEnable);
        const nextBrand = extraOpts?.brandTitle !== undefined
          ? normalizeBrandTitle(extraOpts.brandTitle)
          : cfg.modules.chinese.brandTitle;
        cfg.modules.chinese.language = nextLang;
        cfg.modules.chinese.enabled = nextLang === 'zh-CN';
        cfg.modules.chinese.brandTitle = nextBrand;
        cfg.modules.chinese.lastUpdated = new Date().toISOString();
      } else {
        cfg.modules[moduleName].enabled = targetEnable;
      }

      saveModulesConfig(cfg);
      if (moduleName === 'chinese' && extraOpts?.brandTitle !== undefined) {
        try {
          const utils = require('./utils');
          const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
          for (const w of wins) {
            const wc = getWindowWebContents(w);
            if (wc && !wc.isDestroyed()) {
              wc.send('context-meter:brand-title-changed', cfg.modules.chinese.brandTitle);
            }
          }
        } catch { }
      }

      const runtime = buildRuntimeModulesMeta(cfg, extraOpts?.asarPath);
      const langChanged = moduleName === 'chinese' && (
        Boolean(cfg.modules.chinese.enabled) !== prevChineseEnabled ||
        cfg.modules.chinese.language !== prevChineseLang
      );
      const brandOnlyUpdate = moduleName === 'chinese' && extraOpts?.brandTitle !== undefined && !langChanged;
      const restartRequired = moduleName === 'proxy'
        ? Boolean(runtime.proxyNeedsRestart)
        : (brandOnlyUpdate ? false : Boolean(runtime.chineseNeedsRestart));
      const isEnabledNow = cfg.modules[moduleName].enabled;
      const msg = brandOnlyUpdate
        ? '已保存并热同步品牌标题设置'
        : (!restartRequired
          ? '已同步回当前运行状态，无需重启'
          : (isEnabledNow
            ? '已更新并保存设置，重启客户端后生效'
            : (moduleName === 'chinese' && cfg.modules.chinese.brandTitle !== 'english')
              ? '已保存品牌标题设置，重启客户端后生效'
              : '已关闭配置，重启客户端后生效'));
      return {
        ok: true,
        status: 'config_toggled',
        data: cfg,
        disk,
        runtime,
        restartRequired,
        message: msg
      };
    }

    // 若用户是关闭一个原本就未注入的模块，直接同步配置（只改目标语言，绝不覆盖原有品牌选择）
    if (!targetEnable && !(moduleName === 'chinese' && extraOpts?.brandTitle && extraOpts.brandTitle !== 'english')) {
      cfg.modules[moduleName].enabled = false;
      if (moduleName === 'chinese') {
        cfg.modules.chinese.language = 'en';
        if (extraOpts?.brandTitle !== undefined) {
          const { normalizeBrandTitle } = require('./modules-config');
          cfg.modules.chinese.brandTitle = normalizeBrandTitle(extraOpts.brandTitle);
        }
      }
      if (moduleName === 'proxy' && extraOpts) {
        if (typeof extraOpts.proxyUrl === 'string' && extraOpts.proxyUrl.trim()) {
          cfg.modules.proxy.proxyUrl = extraOpts.proxyUrl.trim();
        }
        if (typeof extraOpts.bypassList === 'string') {
          cfg.modules.proxy.bypassList = extraOpts.bypassList.trim();
        }
        cfg.modules.proxy.lastUpdated = new Date().toISOString();
      }
      saveModulesConfig(cfg);
      if (moduleName === 'chinese' && extraOpts?.brandTitle !== undefined) {
        try {
          const utils = require('./utils');
          const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
          for (const w of wins) {
            const wc = getWindowWebContents(w);
            if (wc && !wc.isDestroyed()) {
              wc.send('context-meter:brand-title-changed', cfg.modules.chinese.brandTitle);
            }
          }
        } catch { }
      }
      return {
        ok: true,
        status: 'config_toggled',
        data: cfg,
        disk,
        runtime: buildRuntimeModulesMeta(cfg, extraOpts?.asarPath),
        restartRequired: false,
        message: '模块未注入，配置保持关闭'
      };
    }

    // 首次手动启用时，由独立进程写盘。当前 Electron 窗口继续使用原运行时。
    const installerDir = fs.existsSync(path.join(__dirname, 'package.json')) ? __dirname : getLiveRuntimeDir();
    const installBrandSupport = moduleName === 'chinese' && extraOpts.brandTitle && extraOpts.brandTitle !== 'english';
    if ((targetEnable || installBrandSupport) && disk.meterReady && disk.asarPath && ['proxy', 'chinese'].includes(moduleName)
      && fs.existsSync(path.join(installerDir, 'install.js'))) {
      const patch = { enabled: true };
      if (moduleName === 'proxy') {
        const proxy = validateProxyUrlInput(extraOpts.proxyUrl ?? cfg.modules.proxy.proxyUrl);
        if (!proxy.ok) return { ok: false, status: 'invalid_config', error: proxy.error };
        patch.proxyUrl = proxy.value;
        if (typeof extraOpts.bypassList === 'string') patch.bypassList = extraOpts.bypassList.trim();
      } else {
        const { normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
        patch.language = normalizeClientLanguage(extraOpts.language, targetEnable);
        patch.enabled = patch.language === 'zh-CN';
        if (extraOpts.brandTitle !== undefined) patch.brandTitle = normalizeBrandTitle(extraOpts.brandTitle);
      }
      resolveBootChineseSnapshot(disk.asarPath);
      const rt = resolveNodeRuntime();
      const argv = [
        ...rt.args, '-e',
        'process.noAsar = true; const args = JSON.parse(process.env.AG_OPTIONAL_MODULE_INSTALL); require("./install").install(args).catch(e => { console.error(e.message); process.exitCode = 1; });'
      ];
      try {
        await new Promise((resolve, reject) => {
          execFile(rt.runtime, argv, {
            cwd: installerDir,
            env: {
              ...rt.env, AG_METER_STATE_DIR: getStateDir(), AG_OPTIONAL_MODULE_INSTALL: JSON.stringify({
                path: disk.asarPath, modules: { [moduleName]: patch }, noHotInject: true
              })
            },
            windowsHide: true,
            timeout: 60000
          }, (error, _stdout, stderr) => {
            if (error) reject(new Error(String(stderr || '可选模块安装未完成').trim()));
            else resolve();
          });
        });
        const installed = inspectDiskModules(disk.asarPath, { forceRefresh: true });
        const next = loadModulesConfig();
        const ready = moduleName === 'proxy' ? installed.proxyReady : installed.chineseReady;
        if (!ready) throw new Error('磁盘校验未找到可选模块');
        return {
          ok: true, status: 'config_toggled', data: next, disk: installed,
          runtime: buildRuntimeModulesMeta(next, disk.asarPath), restartRequired: true,
          message: '可选模块已安装，重启客户端后生效'
        };
      } catch (error) {
        return {
          ok: false, status: 'install_failed', data: loadModulesConfig(),
          disk: inspectDiskModules(disk.asarPath, { forceRefresh: true }),
          restartRequired: false, error: error.message
        };
      }
    }

    // 组件缺失且无法在本次启动中写盘时，保留原配置并显示终端入口。
    const modLabel = moduleName === 'chinese' ? '汉化' : (moduleName === 'proxy' ? '免 TUN 代理' : '核心监控');
    const partialReason = moduleName === 'chinese'
      ? (disk.chinese && !disk.chineseReady ? (disk.chineseReason || '汉化资源或门禁不完整') : '')
      : (moduleName === 'proxy'
        ? (disk.proxy && !disk.proxyReady ? (disk.proxyReason || '代理拦截代码不完整') : '')
        : (disk.meter && !disk.meterReady ? (disk.meterReason || '核心监控资源不完整') : ''));
    const subCmd = moduleName === 'proxy' ? 'proxy:enable' : (moduleName === 'chinese' ? 'chinese:enable' : 'install');
    const cmdHint = formatInstallCommandHint(subCmd);
    const detailSuffix = partialReason ? `原因：${partialReason}。` : '';
    return {
      ok: false,
      status: 'install_failed',
      data: cfg,
      disk,
      runtime: buildRuntimeModulesMeta(cfg, extraOpts?.asarPath),
      error: `当前客户端磁盘 ASAR 未注入${modLabel}组件（或组件不完整）。${detailSuffix}请先从系统托盘/菜单彻底退出 Antigravity（仅点关闭按钮可能后台驻留锁定 app.asar），然后${cmdHint} 完成注入后再重启。`,
      restartRequired: false
    };
  } catch (e) {
    console.error(`[AntigravityContextMeter] 切换模块 ${moduleName} 异常:`, e);
    return { ok: false, status: 'error', error: e.message };
  }
}

async function handleRestartHost(event, options = {}) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  const targetApp = options?.appOverride || app;
  if (!targetApp || typeof targetApp.relaunch !== 'function' || typeof targetApp.quit !== 'function') {
    return { ok: true, supported: false };
  }
  const args = Array.isArray(options?.args)
    ? options.args
    : (Array.isArray(process.argv) ? process.argv.slice(1) : []);
  const delayMs = Number.isFinite(Number(options?.delayMs)) ? Number(options.delayMs) : 80;
  try {
    targetApp.relaunch({ args });
  } catch (error) {
    return { ok: false, supported: true, error: error.message };
  }
  const triggerRestart = () => {
    try {
      setAppQuitting(true);
      try {
        const hostUtils = require('./utils');
        if (typeof hostUtils?.setShowQuitConfirmation === 'function') {
          hostUtils.setShowQuitConfirmation(false);
        }
      } catch { }
      targetApp.quit();
    } catch { }
  };
  if (delayMs <= 0) {
    triggerRestart();
  } else {
    setTimeout(triggerRestart, delayMs);
  }
  return { ok: true, supported: true };
}

function registerIpcOnce() {
  if (registered || !ipcMain) return;
  registered = true;
  registerMeterIpcHandlers(ipcMain);
}

/** 注册 Meter 全部 IPC 通道（支持单元测试注入独立 ipcTarget） */
function registerMeterIpcHandlers(ipcMain) {
  if (!ipcMain) return;

  ipcMain.handle('context-meter:runtime-info', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    return {
      ok: true,
      ...buildBootBackendPayload()
    };
  });

  ipcMain.handle('context-meter:scan', async (event, id, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collect(url.origin, id, { force: force === true, supersedePrevious: true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:turn-state', async (event, id) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collectTurnState(url.origin, id) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:record-calls', async (event, calls) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      let recOpts = {};
      try {
        const { getSharedAccountsManager } = require('./meter-accounts');
        const mgr = getSharedAccountsManager({ origin: url.origin, getLiveOrigins: getActiveHubWindowOrigins });
        const ov = mgr.getOverviewState();
        const switchInFlight = Boolean(mgr.isSwitchInFlight?.() || ov?.switchInProgress);
        const activeEmail = !switchInFlight ? (ov?.activeAccountEmail || null) : null;
        const sessions = Array.isArray(ov?.accountSessions) ? ov.accountSessions : [];
        const openSess = activeEmail
          ? sessions.slice().reverse().find(s => String(s.email).toLowerCase() === String(activeEmail).toLowerCase() && s.endAtMs == null)
          : null;
        recOpts = {
          accountSessions: sessions,
          ...(!switchInFlight && activeEmail ? {
            confirmedAccountEmail: activeEmail,
            liveConfirmedAccount: {
              email: activeEmail,
              verifiedAtMs: openSess?.lastVerifiedAtMs || Date.now(),
              sessionStartMs: openSess?.startAtMs || Date.now()
            }
          } : {})
        };
      } catch { }
      const res = typeof recordModelCallsAsync === 'function'
        ? await recordModelCallsAsync(calls, recOpts)
        : recordModelCalls(calls, recOpts);
      if (res && typeof res === 'object') {
        if (res.ok === false) {
          return {
            ok: false,
            error: res.error || '入账失败',
            ...(res.phase ? { phase: res.phase } : {}),
            ...(res.code ? { code: res.code } : {}),
            changed: false
          };
        }
        return { ok: true, changed: !!res.changed };
      }
      return { ok: true, changed: !!res };
    } catch (e) {
      return { ok: false, error: e.message, changed: false };
    }
  });

  ipcMain.handle('context-meter:token-history', async (event, force, knownRevision, knownAccountKey) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return await getTokenHistoryResponse({ force: force === true, knownRevision, knownAccountKey }); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:session-timeline', async (event, id, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const safeOpts = {
        origin: url.origin,
        force: opts.force === true,
        ...(Array.isArray(opts.liveSteps) ? { liveSteps: opts.liveSteps } : {}),
        ...(Array.isArray(opts.liveCalls) ? { liveCalls: opts.liveCalls } : {}),
        ...(Array.isArray(opts.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {}),
        ...(opts.userStatus && typeof opts.userStatus === 'object' ? { userStatus: opts.userStatus } : {})
      };
      const data = await collectSessionTimelineAsync(id, safeOpts);
      return { ok: true, data: { ...(data || {}), backendVersion: PROJECT_VERSION, backendSource: 'electron-ipc' } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:get-quota', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const collector = require('./meter-collector');
      const opts = {
        force: options === true || options?.force === true,
        currentModel: typeof options?.currentModel === 'string' ? options.currentModel : null,
        browsePoolKey: typeof options?.browsePoolKey === 'string' ? options.browsePoolKey : null,
        origin: url.origin,
        backendSource: 'electron-ipc'
      };
      const res = await collector.fetchQuotaSnapshotFromHost(opts);
      const { _raw, ...safePayload } = res || {};
      let accountSyncResult = null;
      try {
        const { getSharedAccountsManager, deriveTrustedAutoSwitchQuotaContext } = require('./meter-accounts');
        const mgr = getSharedAccountsManager({ origin: url.origin, getLiveOrigins: getActiveHubWindowOrigins });
        const switchInFlight = Boolean(mgr.isSwitchInFlight?.());
        const sourceEmail = !switchInFlight
          ? (res?.email || _raw?.planStatus?.email || _raw?.userStatus?.email || _raw?.email || res?.planStatus?.email || null)
          : null;
        const activeDetectedEmail = !switchInFlight
          ? (sourceEmail || (await mgr.detectCurrentActiveAccount())?.email || null)
          : null;
        const trustCtx = deriveTrustedAutoSwitchQuotaContext({
          res,
          raw: _raw,
          activeEmail: activeDetectedEmail
        });
        if (!switchInFlight && trustCtx.trusted && trustCtx.email && res?.snapshot) {
          mgr.syncActiveHostQuotaSnapshot(res, trustCtx.email);
        }
        const ov = mgr.getOverviewState();
        if (!switchInFlight && ov.autoSwitch?.enabled) {
          const requiresClientRestart = isHostVersionAtLeast('2.34.0');
          const openWindowCount = countOpenHostWindows();
          const hasRestartApi = typeof app?.relaunch === 'function' && typeof app?.quit === 'function';
          const isGeneratingNow = options?.isGenerating === true;
          const hasUnsavedDraft = options?.hasUnsavedDraft === true;
          const canRestart = requiresClientRestart
            && !isGeneratingNow
            && !hasUnsavedDraft
            && openWindowCount <= 1
            && hasRestartApi;
          const blockedRestartReason = !canRestart
            ? (isGeneratingNow
              ? 'generation_in_progress'
              : (hasUnsavedDraft
                ? 'unsaved_draft_present'
                : (openWindowCount > 1 ? 'multi_window_open' : 'client_restart_requires_idle_window')))
            : undefined;
          const expectedActiveEmail = (trustCtx.email || activeDetectedEmail)
            ? String(trustCtx.email || activeDetectedEmail).trim().toLowerCase()
            : null;
          const snapshotRuleSig = JSON.stringify({
            poolKey: ov.autoSwitch?.poolKey || '',
            windowKey: ov.autoSwitch?.windowKey || '',
            metricMode: ov.autoSwitch?.metricMode || '',
            thresholdPct: ov.autoSwitch?.thresholdPct ?? null,
            candidates: Array.isArray(ov.autoSwitch?.candidates) ? ov.autoSwitch.candidates : []
          });
          const queryLiveGuardState = async () => {
            if (typeof options?.getLiveGuardState === 'function') {
              try {
                const live = await options.getLiveGuardState();
                if (live && typeof live === 'object') return live;
              } catch { }
            }
            if (event?.sender && !event.sender.isDestroyed?.() && typeof event.sender.executeJavaScript === 'function') {
              try {
                const live = await Promise.race([
                  event.sender.executeJavaScript('window.__AGContextMeter?.getLiveAutoSwitchGuardState?.() || null', true),
                  new Promise(resolve => setTimeout(() => resolve(null), 500))
                ]);
                if (live && typeof live === 'object') return live;
              } catch { }
            }
            return {
              isGenerating: options?.isGenerating === true,
              hasComposerDraft: false,
              hasRuleDraft: options?.hasUnsavedDraft === true
            };
          };
          const evalSyncState = trustCtx.trusted
            ? 'fresh'
            : (trustCtx.syncState && trustCtx.syncState !== 'fresh' ? trustCtx.syncState : 'untrusted');
          accountSyncResult = await mgr.evaluateAutoSwitch({
            activeEmail: expectedActiveEmail,
            activeSnapshot: res?.snapshot || null,
            syncState: evalSyncState,
            allowLiveCandidateRefresh: true,
            isGenerating: isGeneratingNow,
            hasUnsavedDraft,
            openWindowCount,
            requiresClientRestart,
            blockedRestartReason,
            preRestartNoticeDelayMs: Number.isFinite(Number(options?.preRestartNoticeDelayMs))
              ? Number(options.preRestartNoticeDelayMs)
              : (event?.sender && typeof event.sender.executeJavaScript === 'function' ? 2000 : 0),
            onBeforeRestartNotice: async (meta) => {
              if (event?.sender && !event.sender.isDestroyed?.() && typeof event.sender.executeJavaScript === 'function') {
                try {
                  await event.sender.executeJavaScript(
                    `window.__AGContextMeter?.showAutoSwitchPreRestartNotice?.(${JSON.stringify(meta)})`,
                    true
                  );
                } catch { }
              }
            },
            onAbortRestartNotice: async (abortInfo) => {
              if (event?.sender && !event.sender.isDestroyed?.() && typeof event.sender.executeJavaScript === 'function') {
                try {
                  await event.sender.executeJavaScript(
                    `window.__AGContextMeter?.clearAutoSwitchPreRestartNotice?.(${JSON.stringify(abortInfo?.error || '')})`,
                    true
                  );
                } catch { }
              }
            },
            preCommitCheck: async ({ phase } = {}) => {
              const latestOv = mgr.getOverviewState();
              if (!latestOv?.autoSwitch?.enabled) {
                return { ok: false, deferred: true, reason: 'auto_switch_disabled', error: '自动切号已被关闭，取消切换' };
              }
              const latestRuleSig = JSON.stringify({
                poolKey: latestOv.autoSwitch?.poolKey || '',
                windowKey: latestOv.autoSwitch?.windowKey || '',
                metricMode: latestOv.autoSwitch?.metricMode || '',
                thresholdPct: latestOv.autoSwitch?.thresholdPct ?? null,
                candidates: Array.isArray(latestOv.autoSwitch?.candidates) ? latestOv.autoSwitch.candidates : []
              });
              if (latestRuleSig !== snapshotRuleSig) {
                return { ok: false, deferred: true, reason: 'rule_changed_before_commit', error: '自动切号规则已变更，已中止旧切换并回滚' };
              }
              if (expectedActiveEmail && latestOv.activeAccountEmail && String(latestOv.activeAccountEmail).trim().toLowerCase() !== expectedActiveEmail) {
                return { ok: false, deferred: true, reason: 'active_account_changed', error: '当前激活账号已发生变化，取消旧上下文切换' };
              }
              const latestWinCount = countOpenHostWindows();
              if (latestWinCount > 1) {
                return { ok: false, deferred: true, reason: 'multi_window_open', error: '检测到新打开的 Antigravity 窗口，已延后切号与重启' };
              }
              const liveGuard = await queryLiveGuardState();
              if (liveGuard?.isGenerating === true) {
                return { ok: false, deferred: true, reason: 'generation_in_progress', error: phase === 'before_restart' ? '会话开始生成，已中止并回滚本次切换' : '当前有会话正在生成，已延后自动切号' };
              }
              if (liveGuard?.hasComposerDraft === true || liveGuard?.hasRuleDraft === true) {
                return { ok: false, deferred: true, reason: 'unsaved_draft_present', error: '检测到未发送的聊天草稿或未保存规则，已延后自动切号并回滚' };
              }
              return { ok: true };
            },
            restartClient: canRestart ? () => handleRestartHost(event) : undefined
          });
          if (accountSyncResult && typeof accountSyncResult === 'object') {
            accountSyncResult.overview = mgr.getOverviewState();
          }
        }
      } catch { }
      return { ok: true, data: safePayload, accountSyncResult };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:get-settings', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return getPluginSettings(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:save-settings', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return savePluginSettings(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:launch-cli', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const targetWin = resolveTargetWindow(event.sender);
      let ownerHwndStr = '0';
      let hostBounds = null;
      if (targetWin && !targetWin.isDestroyed()) {
        try {
          const buf = targetWin.getNativeWindowHandle();
          if (buf && buf.length >= 8) {
            ownerHwndStr = buf.readBigInt64LE(0).toString();
          } else if (buf && buf.length >= 4) {
            ownerHwndStr = buf.readInt32LE(0).toString();
          }
        } catch { }
        try {
          hostBounds = targetWin.getBounds();
        } catch { }
      }
      const res = await launchCliSession({
        ...options,
        ownerHwnd: ownerHwndStr,
        hostBounds
      }, ownerHwndStr);

      try {
        console.log('[AntigravityContextMeter:CLI] launch-cli result:', JSON.stringify({
          ok: res?.ok,
          terminalSpawned: res?.terminalSpawned,
          cliAlive: res?.cliAlive,
          isCentered: res?.isCentered,
          isForeground: res?.isForeground,
          pid: res?.pid,
          runtimeInfo: res?.runtimeInfo,
          telemetry: res?.telemetry
        }));
      } catch { }

      return res;
    }
    catch (e) {
      console.error('[AntigravityContextMeter:CLI] launch-cli exception:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
    try {
      const targetWin = resolveTargetWindow(event.sender);
      if (!targetWin || targetWin.isDestroyed?.()) return { ok: false };
      if (process.platform === 'win32') {
        try {
          if (typeof targetWin.setMenuBarVisibility === 'function') targetWin.setMenuBarVisibility(false);
          targetWin.autoHideMenuBar = true;
        } catch { }
      }
      if (typeof targetWin.setTitleBarOverlay !== 'function') return { ok: true };
      const patch = {};
      if (options && typeof options.color === 'string') patch.color = options.color;
      if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
      const rawHeight = options?.height ?? options?.heightCssPx;
      if (options && Number.isFinite(Number(rawHeight)) && Number(rawHeight) >= 24) {
        // 严格遵循宿主原生 30px 高度规范，防止 WCO 覆盖会话工具栏行
        patch.height = Math.max(26, Math.min(32, Math.round(Number(rawHeight))));
      } else {
        patch.height = 30;
      }
      targetWin.setTitleBarOverlay(patch);
      return { ok: true, patch };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:check-update', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return await checkUpdateAsync(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:apply-update', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const updateRes = await applyUpdateAsync({
        version: typeof options?.version === 'string' ? options.version : undefined,
        allowBetaUpdates: typeof options?.allowBetaUpdates === 'boolean' ? options.allowBetaUpdates : undefined,
        diskOnly: true
      });
      return updateRes.ok ? { ...updateRes, restartRequired: true } : updateRes;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:open-external', async (event, targetUrl) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (!isValidExternalUrl(targetUrl)) {
      return { ok: false, error: '仅允许打开官方白名单链接（GitHub 仓库或作者署名主页）' };
    }
    try {
      const { shell } = require('electron');
      await shell.openExternal(targetUrl);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:context-unlock-status', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      return { ok: true, data: await getContextUnlockStatus(undefined, options || {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:context-unlock-apply', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const opts = (options && typeof options === 'object') ? { ...options } : {};
      if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
      return await applyContextUnlockAsync(opts);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:context-unlock-restore', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const opts = (options && typeof options === 'object') ? { ...options } : {};
      if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
      return await restoreContextUnlockAsync(opts);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:rehydrate-status', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { getRehydrateStatusAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
      return { ok: true, data: await getRehydrateStatusAsync(sanitizeRehydrateRendererOptions(options, 'status')) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:rehydrate-apply', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { applyRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
      return await applyRehydrateAsync(sanitizeRehydrateRendererOptions(options, 'apply'));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:rehydrate-disable', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { disableRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
      return await disableRehydrateAsync(sanitizeRehydrateRendererOptions(options, 'disable'));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:rehydrate-restore', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { restoreRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
      return await restoreRehydrateAsync(sanitizeRehydrateRendererOptions(options, 'restore'));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:rehydrate-install-python', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { installPythonRuntimeAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
      return await installPythonRuntimeAsync(sanitizeRehydrateRendererOptions(options, 'install-python'));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:restart-host', handleRestartHost);

  if (typeof ipcMain.on === 'function') {
    ipcMain.on('context-meter:get-chinese-config-sync', (event) => {
      const url = isLocalMainFrameSender(event);
      if (!url) {
        event.returnValue = { enabled: false, language: 'en', brandTitle: 'english', resolved: false };
        return;
      }
      try {
        const { loadModulesConfig } = require('./modules-config');
        const cfg = loadModulesConfig();
        const ch = cfg?.modules?.chinese;
        if (ch && typeof ch === 'object') {
          const enabled = ch.enabled === true && ch.language !== 'en';
          const language = ch.language || (enabled ? 'zh-CN' : 'en');
          const brandTitle = ch.brandTitle || 'english';
          event.returnValue = { enabled, language, brandTitle, resolved: true };
          return;
        }
        event.returnValue = { enabled: false, language: 'en', brandTitle: 'english', resolved: false };
      } catch (e) {
        event.returnValue = { enabled: false, language: 'en', brandTitle: 'english', resolved: false };
      }
    });
  }

  ipcMain.handle('context-meter:enhance-status', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { getEnhanceStatusAsync } = require('./meter-enhance');
      return { ok: true, data: await getEnhanceStatusAsync(options && typeof options === 'object' ? options : {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:enhance-apply', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { applyEnhancePatchAsync } = require('./meter-enhance');
      return await applyEnhancePatchAsync(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:enhance-restore', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { restoreAllEnhanceAsync } = require('./meter-enhance');
      return await restoreAllEnhanceAsync(options && typeof options === 'object' ? options : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:restart-language-servers', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { restartLanguageServersAsync } = require('./meter-enhance');
      return await restartLanguageServersAsync();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:modules-status', handleModulesStatus);
  ipcMain.handle('context-meter:toggle-module', (event, name, enable, options) =>
    handleToggleModule(event, name, enable, {
      language: options?.language,
      brandTitle: options?.brandTitle,
      proxyUrl: options?.proxyUrl,
      bypassList: options?.bypassList
    }));

  ipcMain.handle('context-meter:test-proxy', async (event, proxyUrl) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { testProxyHealth } = require('./modules-config');
      const report = await testProxyHealth(proxyUrl);
      return { ok: true, data: report };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-overview', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { getSharedAccountsManager } = require('./meter-accounts');
      const mgr = getSharedAccountsManager({ origin: url.origin, getLiveOrigins: getActiveHubWindowOrigins });
      await mgr.detectCurrentActiveAccount();
      return mgr.getOverviewState();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-action', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { getSharedAccountsManager, dispatchAccountsAction } = require('./meter-accounts');
      const mgr = getSharedAccountsManager({ origin: url.origin, getLiveOrigins: getActiveHubWindowOrigins });
      let restartClient;
      const requiresClientRestart = isHostVersionAtLeast('2.34.0');
      if (payload?.action === 'switch' && requiresClientRestart
        && typeof app?.relaunch === 'function' && typeof app?.quit === 'function') {
        const { dialog } = require('electron');
        const zh = /^zh/i.test(app.getLocale?.() || '');
        const result = await dialog.showMessageBox({
          type: 'question',
          buttons: zh ? ['切换并重启', '取消'] : ['Switch and restart', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: zh ? '切换账号需要重新启动 Antigravity' : 'Restart Antigravity to switch accounts'
        });
        if (result.response !== 0) {
          return { ok: false, cancelled: true, reason: 'user_cancelled_restart', overview: mgr.getOverviewState() };
        }
        restartClient = () => handleRestartHost(event);
      }
      return await dispatchAccountsAction(mgr, payload || {}, {
        restartClient,
        requiresClientRestart,
        allowManualRestartPending: requiresClientRestart && !restartClient
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:sync-pricing', async (event, opts) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      return await syncPricingCatalogAsync({ force: opts?.force !== false });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:open-dashboard-browser', async (event, payload = {}) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { startCliUiServer } = require('./meter-cli-ui');
      const rawSid = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
      const cleanSid = (rawSid && !/[/\\]|\.\./.test(rawSid)) ? rawSid : '';
      const rawSrc = typeof payload?.source === 'string' ? payload.source.trim().toLowerCase() : 'desktop';
      const cleanSrc = (rawSrc === 'cli' || rawSrc === 'desktop') ? rawSrc : 'desktop';
      const shouldOpenExternal = payload?.openExternal === true;
      const srv = await startCliUiServer({
        open: false,
        sessionId: cleanSid || undefined,
        source: cleanSid ? cleanSrc : undefined
      });
      const baseUrl = srv.baseUrl || srv.url || `http://127.0.0.1:${srv.port || 56780}`;
      const dashboardUrl = cleanSid
        ? `${baseUrl}/?sessionId=${encodeURIComponent(cleanSid)}&source=${encodeURIComponent(cleanSrc)}`
        : baseUrl;
      if (shouldOpenExternal) {
        const { shell } = require('electron');
        if (shell && typeof shell.openExternal === 'function') {
          await shell.openExternal(dashboardUrl);
        }
      }
      return {
        ok: true,
        baseUrl,
        url: dashboardUrl,
        port: srv.port,
        pid: srv.pid,
        sessionId: cleanSid || null,
        source: cleanSrc,
        openedExternal: shouldOpenExternal
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:predict-next-prompt', async (event, payload = {}) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const settings = getPluginSettings();
      if (settings.nextPromptEnabled !== true) {
        return { ok: true, abstained: true, suggestion: '', reason: 'feature_disabled', requestCount: 0 };
      }
      const { predictNextPromptAsync } = require('./meter-next-prompt');
      const safeInput = {
        cascadeId: typeof payload?.cascadeId === 'string' ? payload.cascadeId : undefined,
        turnId: typeof payload?.turnId === 'string' ? payload.turnId : undefined,
        language: typeof payload?.language === 'string' ? payload.language : undefined,
        turns: Array.isArray(payload?.turns) ? payload.turns : [],
        preferences: Array.isArray(payload?.preferences) ? payload.preferences : [],
        verificationEvidence: typeof payload?.verificationEvidence === 'string' ? payload.verificationEvidence : undefined,
        taskMarkdown: typeof payload?.taskMarkdown === 'string' ? payload.taskMarkdown : undefined
      };
      return await predictNextPromptAsync(safeInput, {
        origin: url.origin,
        model: typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
        allowGetModelResponseFallback: payload?.allowGetModelResponseFallback === true
      });
    } catch (e) {
      return { ok: false, abstained: true, suggestion: '', error: e.message };
    }
  });
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;

  // 1. 优先使用宿主官方最权威的主会话 WebContents 来源 utils.getHubWebContents(win)
  try {
    const utils = require('./utils');
    if (typeof utils.getHubWebContents === 'function') {
      const wc = utils.getHubWebContents(win);
      if (wc && !wc.isDestroyed?.()) return wc;
    }
  } catch { }

  // 2. 若为标准 BrowserWindow 或已定义 webContents getter
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;

  // 3. 针对 Antigravity 2.x BaseWindow + contentView 架构遍历子 View
  // 严格安全限制：仅选择主会话界面，坚决排除 curtainView（data: 协议）及无关弹窗
  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      // 优先：明确匹配本地主聊天服务地址 (http:// 或 https://127.0.0.1:<port>/)
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) return child.webContents;
        }
      }
      // 次优：若正在加载中尚未完成导航，排除明确的 data: 遮罩页 (curtainView)
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (!url.startsWith('data:')) return child.webContents;
        }
      }
    }
  } catch { }
  return null;
}

/**
 * 在 Electron 主进程内直读所有活跃 Hub 窗口的本地原点 URL（免 CDP / DevToolsActivePort）
 */
function getActiveHubWindowOrigins() {
  const origins = [];
  const pushUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    try {
      const m = rawUrl.trim().match(/^https?:\/\/127\.0\.0\.1:\d+/i);
      if (!m) return;
      const o = new URL(rawUrl.trim()).origin;
      if (o && !origins.includes(o)) origins.push(o);
    } catch { }
  };
  try {
    const utils = require('./utils');
    const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
    for (const win of wins) {
      const wc = getWindowWebContents(win);
      if (wc && !wc.isDestroyed?.()) pushUrl(wc.getURL?.());
    }
  } catch { }
  try {
    const { BrowserWindow, BaseWindow } = require('electron');
    const seenWins = new Set();
    const allWins = [
      ...(typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []),
      ...(typeof BaseWindow?.getAllWindows === 'function' ? BaseWindow.getAllWindows() : [])
    ];
    for (const win of allWins) {
      if (!win || seenWins.has(win)) continue;
      seenWins.add(win);
      const wc = getWindowWebContents(win);
      if (wc && !wc.isDestroyed?.()) pushUrl(wc.getURL?.());
    }
  } catch { }
  return origins;
}

/**
 * 统计当前活跃的 Antigravity 宿主窗口数量（基于 Window 实例与 webContents ID 精确去重，防止多窗口共享原点时误判单窗口）
 */
function countOpenHostWindows() {
  const seenWins = new Set();
  const seenWcIds = new Set();
  let count = 0;
  const collectWin = (win) => {
    if (!win || seenWins.has(win) || win.isDestroyed?.()) return;
    seenWins.add(win);
    try {
      // 跳过宿主内部隐形背景窗口（未最小化且不可见）
      if (typeof win.isVisible === 'function' && !win.isVisible() && !win.isMinimized?.()) return;
      const wc = getWindowWebContents(win);
      if (wc && !wc.isDestroyed?.()) {
        const url = String(wc.getURL?.() || '').trim();
        if (url && !/^https?:\/\/127\.0\.0\.1:\d+/i.test(url)) return;
        const wcId = wc.id;
        if (wcId != null) {
          if (seenWcIds.has(wcId)) return;
          seenWcIds.add(wcId);
        }
      }
    } catch { }
    count += 1;
  };
  try {
    const utils = require('./utils');
    const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
    for (const w of wins) collectWin(w);
  } catch { }
  try {
    const { BrowserWindow, BaseWindow } = require('electron');
    const allWins = [
      ...(typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []),
      ...(typeof BaseWindow?.getAllWindows === 'function' ? BaseWindow.getAllWindows() : [])
    ];
    for (const w of allWins) collectWin(w);
  } catch { }
  if (count > 0) return count;
  return getActiveHubWindowOrigins().length;
}


function syncWindowOverlayHeight(win) {
  try {
    if (!win || process.platform === 'darwin' || win.isDestroyed?.() || typeof win.setTitleBarOverlay !== 'function') return;
    const wc = getWindowWebContents(win);
    const zf = typeof wc?.getZoomFactor === 'function' ? wc.getZoomFactor() : 1;
    // 严格遵循宿主原生 30px 默认高度（DEFAULT_TITLE_BAR_OVERLAY_HEIGHT），避免写死 40px 产生右上角大黑块色差
    const baseH = 30;
    const targetH = Math.max(26, Math.min(48, Math.round(baseH * (Number.isFinite(zf) && zf > 0 ? zf : 1))));
    win.setTitleBarOverlay({ height: targetH });
  } catch { }
}

async function runEnsureMeterInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowWebContents(win);
    if (!wc || wc.isDestroyed?.()) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }
    const url = wc.getURL?.() || '';
    if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }

    syncWindowOverlayHeight(win);

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript(
          'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
        );
        if (alive === true) {
          logDiagnostic('inject:alive_already', { wcId: wc.id, url: url.slice(0, 32) });
          return true;
        }
      } catch { }
    }

    const runtimeSource = getMeterSource();
    if (!runtimeSource) {
      logDiagnostic('inject:empty_source', { wcId: wc.id });
      return false;
    }

    const res = await wc.executeJavaScript(runtimeSource);
    logDiagnostic('inject:executed', { wcId: wc.id, result: res, url: url.slice(0, 32) });
    return res !== false;
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    logDiagnostic('inject:catch_error', { attempt, error: error?.message || String(error) });
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      injectionTimers.set(win, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

async function ensureMeterInjected(win, options = {}) {
  if (!win || win.isDestroyed?.()) return false;
  const existing = inFlightInjections.get(win);
  if (!existing && pendingForceInjections.has(win)) {
    return pendingForceInjections.get(win).promise;
  }
  if (existing) {
    if (options?.force === true && !existing.isForce) {
      let pending = pendingForceInjections.get(win);
      if (!pending) {
        pending = { options: { ...options, attempt: 0 }, promise: null };
        pending.promise = existing.promise.then(() => {
          if (pendingForceInjections.get(win) === pending) {
            pendingForceInjections.delete(win);
          }
          if (!win || win.isDestroyed?.()) return false;
          return ensureMeterInjected(win, pending.options);
        });
        pendingForceInjections.set(win, pending);
      } else {
        pending.options = { ...options, attempt: 0 };
      }
      return pending.promise;
    }
    const pending = pendingForceInjections.get(win);
    return pending ? pending.promise : existing.promise;
  }

  const isForce = options?.force === true;
  const task = (async () => {
    try {
      return await runEnsureMeterInjected(win, options);
    } finally {
      if (inFlightInjections.get(win)?.promise === task) {
        inFlightInjections.delete(win);
      }
    }
  })();
  inFlightInjections.set(win, { promise: task, isForce });
  return task;
}

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  logDiagnostic('install:win_called', { winId: win.id, isDestroyed: win.isDestroyed?.() });

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    if (process.platform === 'win32') {
      try {
        if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
      } catch { }
    }
    const onWinVisibleOrActive = () => {
      if (process.platform === 'win32') {
        try {
          if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
        } catch { }
      }
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onWinVisibleOrActive);
    win.on?.('restore', onWinVisibleOrActive);
    win.on?.('focus', onWinVisibleOrActive);

    // 托盘常驻与会话保持：点击窗口右上角关闭时，若满足后台常驻与主会话条件，隐藏至托盘而非销毁，避免重新打开丢失会话
    try {
      win.on?.('close', (event) => {
        if (shouldInterceptWindowClose(win)) {
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
            if (typeof win.hide === 'function') win.hide();
          }
        }
      });
    } catch { }
  }

  const bindToWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    logDiagnostic('bind:wc_attached', { wcId: wc.id, url: wc.getURL?.()?.slice(0, 32) });

    wc.on('did-finish-load', () => {
      logDiagnostic('event:did-finish-load', { wcId: wc.id });
      void ensureMeterInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      logDiagnostic('event:dom-ready', { wcId: wc.id });
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      logDiagnostic('event:did-navigate', { wcId: wc.id });
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      logDiagnostic('event:did-navigate-in-page', { wcId: wc.id });
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('zoom-changed', () => syncWindowOverlayHeight(win));
    wc.on('console-message', function (event) {
      const isModernEvent = event && typeof event === 'object' && typeof event.message === 'string';
      const level = isModernEvent ? event.level : arguments[1];
      const message = isModernEvent ? event.message : String(arguments[2] ?? '');
      const line = isModernEvent ? event.lineNumber : arguments[3];
      const isWarnOrError = typeof level === 'string'
        ? (level === 'warning' || level === 'error')
        : Number(level) >= 2;
      if (message.includes('Context Meter') || message.includes('ag-context-meter') || isWarnOrError) {
        logDiagnostic('renderer:console', { level, line, message: message.slice(0, 200) });
      }
    });
  };

  const initialWc = getWindowWebContents(win);
  if (initialWc) {
    bindToWc(initialWc);
  } else {
    // 若为 BaseWindow 且尚未挂载 WebContentsView，开启轻量安全探测轮询，并在 WeakMap 中记录定时器
    const prevProbe = wcProbeTimers.get(win);
    if (prevProbe) clearInterval(prevProbe);

    let retries = 0;
    const probeInterval = setInterval(() => {
      retries++;
      const candidateWc = getWindowWebContents(win);
      if (candidateWc) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
        bindToWc(candidateWc);
        void ensureMeterInjected(win, { force: false });
      } else if (retries >= 10 || !win || win.isDestroyed?.()) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
      }
    }, 150);
    wcProbeTimers.set(win, probeInterval);

    win.once?.('closed', () => {
      const activeTimer = wcProbeTimers.get(win);
      if (activeTimer) {
        clearInterval(activeTimer);
        wcProbeTimers.delete(win);
      }
    });
  }
};

try {
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      isAppQuitting = true;
    });
    app.on('will-quit', () => {
      isAppQuitting = true;
    });
    const handleCreated = (_event, win) => {
      try {
        exports.installContextMeter(win);
        void ensureMeterInjected(win, { force: false });
      } catch { }
    };
    app.on('browser-window-created', handleCreated);
    app.on('base-window-created', handleCreated);
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          exports.installContextMeter(w);
          void ensureMeterInjected(w, { force: true });
        }
      } catch { }
    });
    app.on('second-instance', () => {
      try {
        const utils = require('./utils');
        setTimeout(() => {
          try {
            const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
            for (const w of wins) {
              exports.installContextMeter(w);
              void ensureMeterInjected(w, { force: true });
            }
          } catch { }
        }, 120);
      } catch { }
    });
  }
} catch { }

function isHostRunInBackgroundEnabled() {
  try {
    if (process.platform === 'darwin') return true;
    let storagePath = null;
    if (app && typeof app.getPath === 'function') {
      try {
        storagePath = path.join(app.getPath('userData'), 'app_storage.json');
      } catch { }
    }
    if (!storagePath) {
      const home = typeof os.homedir === 'function' ? os.homedir() : '';
      const appData = process.env.APPDATA || (process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config'));
      storagePath = path.join(appData, 'Antigravity', 'app_storage.json');
    }
    if (!fs.existsSync(storagePath)) return false;
    const content = fs.readFileSync(storagePath, 'utf8');
    const data = JSON.parse(content);
    return data?.runInBackground === 'true' || data?.runInBackground === true;
  } catch {
    return false;
  }
}

function shouldInterceptWindowClose(win, options = {}) {
  try {
    if (isAppQuitting) return false;

    // 1. 尊重宿主后台常驻设置：若明确未开启或读取设置失败，不得拦截
    const isBgEnabled = typeof options.isBackgroundEnabled === 'function'
      ? options.isBackgroundEnabled()
      : isHostRunInBackgroundEnabled();
    if (!isBgEnabled) return false;

    // 2. 获取宿主主会话窗口列表
    let wins = null;
    if (typeof options.getHubWindows === 'function') {
      wins = options.getHubWindows();
    } else {
      try {
        const utils = require('./utils');
        if (typeof utils.getHubWindows === 'function') wins = utils.getHubWindows();
      } catch { }
    }

    // 获取窗口列表失败或当前窗口非已确认的主会话窗口（避免影响辅助/弹窗窗口），安全放行
    if (!Array.isArray(wins) || !wins.includes(win)) return false;

    // 3. 多窗口关闭路径：若仍有其他可见主窗口在运行，说明当前是关闭辅助多开窗口，放行正常关闭；
    // 仅当当前是最后一个可见主会话窗口时拦截销毁，转为隐藏至托盘
    const remainingVisible = wins.filter(
      w => w !== win && !w.isDestroyed?.() && (typeof w.isVisible === 'function' ? w.isVisible() : true)
    );
    return remainingVisible.length === 0;
  } catch {
    // 发生任何异常时绝不默认隐藏，确保安全放行
    return false;
  }
}

function defaultPostLiveHttpJson(port, token, routePath, origin, body = {}, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const http = require('http');
      const net = require('net');
      const dataStr = JSON.stringify(body || {});
      const numPort = Number(port);
      const req = http.request({
        hostname: '127.0.0.1',
        port: numPort,
        path: routePath,
        method: 'POST',
        agent: false,
        createConnection: () => net.connect(numPort, '127.0.0.1'),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
          'Origin': origin,
          'X-AG-Context-Token': String(token || '')
        }
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, ...JSON.parse(raw || '{}') }); }
          catch { resolve({ ok: false, statusCode: res.statusCode }); }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.end(dataStr);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * 在应用内更新写盘成功后执行免 CDP/多窗口安全热加载：
 * 1. 先从新版 live-runtime 启动独立 live-host 并校验 /runtime-info；
 * 2. 确认新版后台就绪后向全部活跃 Hub 窗口注入新版渲染器并核验额度；
 * 3. 成功后再优雅退出旧版 live-host；任意环节失败则安全保留原连接并准确提示需重启。
 */
async function tryInAppHotReloadAfterUpdate(updateRes, options = {}) {
  if (!updateRes || !updateRes.ok || !updateRes.diskInstalled) {
    return updateRes;
  }
  const targetVer = updateRes.version || updateRes.installedVersion;
  if (updateRes.liveInjected && updateRes.backendHotReloaded && updateRes.backendVersion === targetVer) {
    return updateRes;
  }
  const stateDir = options._stateDir || getStateDir();
  const runtimeDir = updateRes.liveRuntimeDir || getLiveRuntimeDir(stateDir);
  if (
    !runtimeDir ||
    !fs.existsSync(path.join(runtimeDir, 'live-host.js')) ||
    !fs.existsSync(path.join(runtimeDir, 'meter-core.js')) ||
    !fs.existsSync(path.join(runtimeDir, 'meter-renderer.js'))
  ) {
    return {
      ...updateRes,
      liveInjected: false,
      backendHotReloaded: false,
      restartRequired: true,
      hotReloadReason: 'missing_live_runtime'
    };
  }

  let wins = [];
  if (typeof options._getHubWindows === 'function') {
    wins = options._getHubWindows() || [];
  } else {
    try {
      const utils = require('./utils');
      wins = typeof utils.getHubWindows === 'function' ? (utils.getHubWindows() || []) : [];
    } catch { }
  }
  const activeTargets = [];
  for (const w of wins) {
    const wc = getWindowWebContents(w);
    if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') continue;
    const rawUrl = wc.getURL?.() || '';
    if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(rawUrl)) continue;
    try {
      activeTargets.push({ win: w, wc, origin: new URL(rawUrl).origin });
    } catch { }
  }
  if (!activeTargets.length) {
    return {
      ...updateRes,
      liveInjected: false,
      backendHotReloaded: false,
      restartRequired: true,
      hotReloadReason: 'no_active_hub_windows'
    };
  }

  const origins = Array.from(new Set(activeTargets.map(t => t.origin)));
  const liveSessionPath = path.join(stateDir, '.live-session.json');
  let previousLiveInfo = null;
  try {
    if (fs.existsSync(liveSessionPath)) {
      previousLiveInfo = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
    }
  } catch { }

  const probeFn = typeof options._probeLiveHost === 'function'
    ? options._probeLiveHost
    : (info, origin) => defaultPostLiveHttpJson(info.port, info.token, '/runtime-info', origin, {}, 2500);
  const shutdownFn = typeof options._shutdownLiveHost === 'function'
    ? options._shutdownLiveHost
    : async (info) => {
      if (!info) return;
      const o = info.origin || (Array.isArray(info.origins) && info.origins[0]) || origins[0];
      if (info.port && info.token) {
        await defaultPostLiveHttpJson(info.port, info.token, '/shutdown', o, {}, 1200);
      }
      if (info.pid) {
        try { process.kill(info.pid); } catch { }
      }
    };

  let newLiveInfo = null;
  let stagingStamp = null;
  let spawnedChild = null;
  if (typeof options._startLiveHost === 'function') {
    newLiveInfo = await options._startLiveHost({ runtimeDir, origins, targetVer, stateDir });
  } else {
    stagingStamp = path.join(stateDir, `.live-session.inapp.${process.pid}.${Date.now()}.json`);
    const rt = (typeof options._resolveNodeRuntime === 'function' ? options._resolveNodeRuntime() : resolveNodeRuntime());
    const spawner = options._spawn || require('child_process').spawn;
    const childEnv = {
      ...(rt.env || process.env),
      AG_LIVE_STAMP_PATH: stagingStamp,
      AG_LIVE_ORIGINS: JSON.stringify(origins),
      AG_LIVE_HOST_PID: String(process.pid)
    };
    try {
      spawnedChild = spawner(rt.runtime, [...(rt.args || []), path.join(runtimeDir, 'live-host.js')], {
        cwd: runtimeDir,
        env: childEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      spawnedChild.unref?.();
    } catch (e) {
      return {
        ...updateRes,
        liveInjected: false,
        backendHotReloaded: false,
        restartRequired: true,
        hotReloadReason: `spawn_live_host_failed:${e.message}`
      };
    }

    const deadline = Date.now() + (options._probeTimeoutMs || 6000);
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (!fs.existsSync(stagingStamp)) continue;
      try {
        const cand = JSON.parse(fs.readFileSync(stagingStamp, 'utf8'));
        if (cand && cand.port && cand.token) {
          const probe = await probeFn(cand, origins[0]);
          if (probe && probe.ok && (!targetVer || probe.backendVersion === targetVer)) {
            newLiveInfo = {
              ...cand,
              version: probe.backendVersion || cand.version || targetVer,
              backendSource: 'live-host',
              capabilities: probe.capabilities || cand.capabilities || null,
              origins: probe.origins || cand.origins || origins
            };
            break;
          }
        }
      } catch { }
    }
    try { if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp); } catch { }
  }

  if (!newLiveInfo || !newLiveInfo.port || !newLiveInfo.token) {
    if (spawnedChild?.pid) {
      try { process.kill(spawnedChild.pid); } catch { }
    }
    return {
      ...updateRes,
      liveInjected: false,
      backendHotReloaded: false,
      restartRequired: true,
      hotReloadReason: 'live_host_unavailable'
    };
  }

  // 确认新版可用后再原子替换 .live-session.json 并注入所有运行窗口
  try {
    const tmpMain = `${liveSessionPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpMain, JSON.stringify(newLiveInfo, null, 2));
    fs.renameSync(tmpMain, liveSessionPath);
  } catch {
    try { fs.writeFileSync(liveSessionPath, JSON.stringify(newLiveInfo, null, 2)); } catch { }
  }

  let injectedCount = 0;
  let backendVerified = false;
  try {
    const coreCode = fs.readFileSync(path.join(runtimeDir, 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(runtimeDir, 'meter-renderer.js'), 'utf8');
    let settingsBootstrap = '';
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        settingsBootstrap = `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
    } catch { }
    let chineseBootstrap = '';
    try {
      const { loadModulesConfig } = require('./modules-config');
      const mCfg = loadModulesConfig();
      if (mCfg?.modules?.chinese) {
        chineseBootstrap = `window.__AGY_CHINESE_CONFIG__ = ${JSON.stringify(mCfg.modules.chinese)};\n`;
      }
    } catch { }

    for (const target of activeTargets) {
      const liveBridgeObj = {
        port: newLiveInfo.port,
        token: newLiveInfo.token,
        origin: target.origin,
        origins: newLiveInfo.origins || origins,
        version: newLiveInfo.version || targetVer,
        backendSource: 'live-host',
        capabilities: newLiveInfo.capabilities || null,
        verified: true
      };
      const hotCtxObj = {
        expectedVersion: targetVer,
        source: 'in-app-update',
        hotInjectedAt: Date.now(),
        preferLiveHost: true
      };
      const injectScript = `
window.__AGContextMeterLive = ${JSON.stringify(liveBridgeObj)};
window.__AGContextMeterHotReloadContext = ${JSON.stringify(hotCtxObj)};
${settingsBootstrap}${chineseBootstrap}
${coreCode}
${rendererCode}
true;`;
      const resExec = await target.wc.executeJavaScript(injectScript);
      if (resExec !== false) {
        injectedCount++;
        try {
          const verify = await target.wc.executeJavaScript(`(async () => {
            const api = window.__AGContextMeter;
            if (!api) return null;
            if (typeof api.verifyHotReloadAndRefreshQuota === 'function') {
              return await api.verifyHotReloadAndRefreshQuota();
            }
            return { rendererVersion: api.version || null };
          })()`);
          if (verify && (!targetVer || verify.backendVersion === targetVer)) {
            backendVerified = true;
          }
        } catch { }
      }
    }
  } catch (injectErr) {
    if (injectedCount === 0) {
      await shutdownFn(newLiveInfo).catch(() => { });
      if (previousLiveInfo) {
        try { fs.writeFileSync(liveSessionPath, JSON.stringify(previousLiveInfo, null, 2)); } catch { }
      }
      return {
        ...updateRes,
        liveInjected: false,
        backendHotReloaded: false,
        restartRequired: true,
        hotReloadReason: `window_inject_failed:${injectErr.message}`
      };
    }
  }

  if (injectedCount === 0) {
    await shutdownFn(newLiveInfo).catch(() => { });
    if (previousLiveInfo) {
      try { fs.writeFileSync(liveSessionPath, JSON.stringify(previousLiveInfo, null, 2)); } catch { }
    }
    return {
      ...updateRes,
      liveInjected: false,
      backendHotReloaded: false,
      restartRequired: true,
      hotReloadReason: 'no_windows_injected'
    };
  }

  if (previousLiveInfo && (!previousLiveInfo.pid || previousLiveInfo.pid !== newLiveInfo.pid)) {
    await shutdownFn(previousLiveInfo).catch(() => { });
  }

  return {
    ...updateRes,
    liveInjected: true,
    backendHotReloaded: Boolean(backendVerified || newLiveInfo.version === targetVer),
    backendVersion: newLiveInfo.version || targetVer,
    backendSource: 'live-host',
    injectedWindowCount: injectedCount,
    totalWindowCount: activeTargets.length
  };
}

exports.MAIN_CAPABILITIES = MAIN_CAPABILITIES;
exports.tryInAppHotReloadAfterUpdate = tryInAppHotReloadAfterUpdate;
exports.handleModulesStatus = handleModulesStatus;
exports.handleToggleModule = handleToggleModule;
exports.handleRestartHost = handleRestartHost;
exports.registerMeterIpcHandlers = registerMeterIpcHandlers;
exports.setAppQuitting = setAppQuitting;
exports.getAppQuitting = getAppQuitting;
exports.shouldInterceptWindowClose = shouldInterceptWindowClose;
exports.isHostRunInBackgroundEnabled = isHostRunInBackgroundEnabled;
exports.getWindowWebContents = getWindowWebContents;
exports.getActiveHubWindowOrigins = getActiveHubWindowOrigins;
exports.countOpenHostWindows = countOpenHostWindows;
exports.getMeterSource = getMeterSource;
exports.clearMeterSourceCacheForTest = clearMeterSourceCacheForTest;
exports.logDiagnostic = logDiagnostic;
exports.flushDiagnosticLogsForTest = flushDiagnosticLogsForTest;
