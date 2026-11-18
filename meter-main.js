'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch {}
const {
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
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
  restoreContextUnlockAsync
} = require('./meter-collector');
const { isValidExternalUrl } = require('./meter-core');
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
  modules: true,
  accounts: true,
  checkUpdate: true,
  applyUpdate: true,
  restartHost: true,
  hotReload: true
};

const {
  applyProxyEnvironment,
  detectProxyConfig,
  normalizeProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl
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
  } catch {}
  bootChineseSnapshots.set(key, snap);
  return snap;
}
try { resolveBootChineseSnapshot(); } catch {}

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
    runtimeProxyUrl: runtimeUrl || null,
    runtimeBypassList: typeof bootProxySnapshot.bypassList === 'string' ? bootProxySnapshot.bypassList : null,
    proxyNeedsRestart,
    chineseActive: Boolean(bootZh.enabled),
    chineseBootLanguage: bootZh.language,
    chineseNeedsRestart: diskZhActive !== Boolean(bootZh.enabled)
  };
}

function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    return applyProxyEnvironment(targetEnv, { overrideExisting: true });
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

function getMeterSource() {
  try {
    const coreCode = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
    let bootstrap = `window.__AGContextMeterBootBackend = ${JSON.stringify(buildBootBackendPayload())};\n`;
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        bootstrap += `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
    } catch {}
    try {
      const { loadModulesConfig } = require('./modules-config');
      const mCfg = loadModulesConfig();
      if (mCfg?.modules?.chinese) {
        bootstrap += `window.__AGY_CHINESE_CONFIG__ = ${JSON.stringify(mCfg.modules.chinese)};\n`;
      }
    } catch {}
    return `${bootstrap}${coreCode}\n${rendererCode}\ntrue;`;
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
  } catch {}
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch {}
  return null;
}

let registered = false;
let isAppQuitting = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();
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
  } catch {}
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
        } catch {}
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

    // 若用户是关闭一个原本就未注入的模块，直接同步配置
    if (!targetEnable && !(moduleName === 'chinese' && extraOpts?.brandTitle && extraOpts.brandTitle !== 'english')) {
      cfg.modules[moduleName].enabled = false;
      if (moduleName === 'chinese') {
        cfg.modules.chinese.language = 'en';
        cfg.modules.chinese.brandTitle = 'english';
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
        } catch {}
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

    // 结果类型 3: 磁盘上原本没有该组件/资源或组件不完整，无法在客户端运行中直接热注入
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
  const triggerRestart = () => {
    try {
      setAppQuitting(true);
      targetApp.relaunch({ args });
      targetApp.quit();
    } catch {}
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

  ipcMain.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collectTokenHistoryAsync({ force: force === true }) }; }
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
      const opts = typeof options === 'boolean'
        ? { force: options }
        : (options && typeof options === 'object' ? { ...options } : {});
      if (!opts.origin) opts.origin = url.origin;
      opts.backendSource = 'electron-ipc';
      const res = await collector.fetchQuotaSnapshotFromHost(opts);
      const { _raw, ...safePayload } = res || {};
      let accountSyncResult = null;
      try {
        const { getSharedAccountsManager } = require('./meter-accounts');
        const mgr = getSharedAccountsManager({ origin: url.origin, getLiveOrigins: getActiveHubWindowOrigins });
        const switchInFlight = Boolean(mgr.isSwitchInFlight?.());
        const email = !switchInFlight
          ? (res?.planStatus?.email || (await mgr.detectCurrentActiveAccount())?.email || null)
          : null;
        if (!switchInFlight && email && res?.snapshot) {
          mgr.syncActiveHostQuotaSnapshot(res, email);
          const ov = mgr.getOverviewState();
          if (ov.autoSwitch?.enabled && !res.error) {
            accountSyncResult = await mgr.evaluateAutoSwitch({
              activeEmail: email,
              activeSnapshot: res.snapshot,
              syncState: 'fresh',
              isGenerating: Boolean(opts.isGenerating)
            });
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
        } catch {}
        try {
          hostBounds = targetWin.getBounds();
        } catch {}
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
      } catch {}

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
        } catch {}
      }
      if (typeof targetWin.setTitleBarOverlay !== 'function') return { ok: true };
      const patch = {};
      if (options && typeof options.color === 'string') patch.color = options.color;
      if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
      const rawHeight = options?.height ?? options?.heightCssPx;
      if (options && Number.isFinite(Number(rawHeight)) && Number(rawHeight) >= 24 && Number(rawHeight) <= 64) {
        patch.height = Math.round(Number(rawHeight));
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
      const updateRes = await applyUpdateAsync(options || {});
      return await tryInAppHotReloadAfterUpdate(updateRes, options || {});
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
          const enabled = ch.enabled !== false && ch.language !== 'en';
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
  ipcMain.handle('context-meter:toggle-module', handleToggleModule);

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
      return await dispatchAccountsAction(mgr, payload || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  // 1. 若为标准 BrowserWindow 或已定义 webContents getter
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;

  // 2. 宿主官方 utils.getHubWebContents(win)（最权威主会话 WebContents 来源）
  try {
    const utils = require('./utils');
    if (typeof utils.getHubWebContents === 'function') {
      const wc = utils.getHubWebContents(win);
      if (wc && !wc.isDestroyed?.()) return wc;
    }
  } catch {}

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
  } catch {}
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
    const { BrowserWindow } = require('electron');
    const allWins = typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : [];
    for (const win of allWins) {
      const wc = getWindowWebContents(win);
      if (wc && !wc.isDestroyed?.()) pushUrl(wc.getURL?.());
    }
  } catch { }
  return origins;
}


function syncWindowOverlayHeight(win) {
  try {
    if (!win || process.platform === 'darwin' || win.isDestroyed?.() || typeof win.setTitleBarOverlay !== 'function') return;
    const wc = getWindowWebContents(win);
    const zf = typeof wc?.getZoomFactor === 'function' ? wc.getZoomFactor() : 1;
    const targetH = Math.max(28, Math.min(60, Math.round(40 * (Number.isFinite(zf) && zf > 0 ? zf : 1))));
    win.setTitleBarOverlay({ height: targetH });
  } catch {}
}

async function ensureMeterInjected(win, options = {}) {
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
        if (alive === true) return true;
      } catch {}
    }

    const runtimeSource = getMeterSource();
    if (!runtimeSource) return false;

    await wc.executeJavaScript(runtimeSource);
    return true;
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
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

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    if (process.platform === 'win32') {
      try {
        if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
      } catch {}
    }
    const onWinVisibleOrActive = () => {
      if (process.platform === 'win32') {
        try {
          if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
        } catch {}
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
    } catch {}
  }

  const bindToWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => {
      void ensureMeterInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('zoom-changed', () => syncWindowOverlayHeight(win));
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
      } catch {}
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
      } catch {}
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
          } catch {}
        }, 120);
      } catch {}
    });
  }
} catch {}

function isHostRunInBackgroundEnabled() {
  try {
    if (process.platform === 'darwin') return true;
    let storagePath = null;
    if (app && typeof app.getPath === 'function') {
      try {
        storagePath = path.join(app.getPath('userData'), 'app_storage.json');
      } catch {}
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
      } catch {}
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
    } catch {}
  }
  const activeTargets = [];
  for (const w of wins) {
    const wc = getWindowWebContents(w);
    if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') continue;
    const rawUrl = wc.getURL?.() || '';
    if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(rawUrl)) continue;
    try {
      activeTargets.push({ win: w, wc, origin: new URL(rawUrl).origin });
    } catch {}
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
  } catch {}

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
        try { process.kill(info.pid); } catch {}
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
      } catch {}
    }
    try { if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp); } catch {}
  }

  if (!newLiveInfo || !newLiveInfo.port || !newLiveInfo.token) {
    if (spawnedChild?.pid) {
      try { process.kill(spawnedChild.pid); } catch {}
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
    try { fs.writeFileSync(liveSessionPath, JSON.stringify(newLiveInfo, null, 2)); } catch {}
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
    } catch {}
    let chineseBootstrap = '';
    try {
      const { loadModulesConfig } = require('./modules-config');
      const mCfg = loadModulesConfig();
      if (mCfg?.modules?.chinese) {
        chineseBootstrap = `window.__AGY_CHINESE_CONFIG__ = ${JSON.stringify(mCfg.modules.chinese)};\n`;
      }
    } catch {}

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
        } catch {}
      }
    }
  } catch (injectErr) {
    if (injectedCount === 0) {
      await shutdownFn(newLiveInfo).catch(() => {});
      if (previousLiveInfo) {
        try { fs.writeFileSync(liveSessionPath, JSON.stringify(previousLiveInfo, null, 2)); } catch {}
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
    await shutdownFn(newLiveInfo).catch(() => {});
    if (previousLiveInfo) {
      try { fs.writeFileSync(liveSessionPath, JSON.stringify(previousLiveInfo, null, 2)); } catch {}
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
    await shutdownFn(previousLiveInfo).catch(() => {});
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
