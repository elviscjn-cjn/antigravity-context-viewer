'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect, normalizeLoopbackOrigin, getAppDataDir } = require('./local-api');
const {
  collect,
  collectTurnState,
  getTokenHistoryResponse,
  collectSessionTimelineAsync,
  fetchQuotaSnapshotFromHost,
  checkUpdateAsync,
  applyUpdateAsync,
  recordModelCallsAsync,
  getPluginSettings,
  savePluginSettings,
  launchCliSession,
  getContextUnlockStatus,
  applyContextUnlockAsync,
  restoreContextUnlockAsync,
  syncPricingCatalogAsync
} = require('./meter-collector');
const { normalizeProxyUrl, normalizeBypassListForCompare, parseAndValidateProxyUrl, redactProxyUrl } = require('./meter-proxy');
const { getStateDir, findAsarPath, builtinAsar } = require('./asar-engine');
const { PROJECT_VERSION, getHostCoreBuildId } = require('./modules-config');
const { compareVersions } = require('./meter-core');

function resolveLiveHostTargetVersion() {
  const envVer = String(process.env.AG_HOST_VERSION || '').trim();
  if (envVer) return envVer;
  try {
    const stateDir = getStateDir();
    const manifestP = path.join(stateDir, 'installation.json');
    if (fs.existsSync(manifestP)) {
      const m = JSON.parse(fs.readFileSync(manifestP, 'utf8'));
      if (m?.version) return String(m.version);
    }
  } catch { }
  try {
    const asarPath = findAsarPath(null);
    if (asarPath && fs.existsSync(asarPath)) {
      const pkg = JSON.parse(builtinAsar.extractFile(asarPath, 'package.json').toString('utf8'));
      if (pkg?.version) return String(pkg.version);
    }
  } catch { }
  return '2.34.0';
}

const liveBootProxySnapshot = (() => {
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
})();

const liveBootChineseSnapshots = new Map();

function resolveLiveBootChineseSnapshot(customAsarPath = null) {
  const key = `${String(process.env.AG_METER_STATE_DIR || '__default__')}|${String(customAsarPath || '__auto__')}`;
  if (liveBootChineseSnapshots.has(key)) return liveBootChineseSnapshots.get(key);
  let snap = { enabled: false, language: 'en' };
  try {
    const { isIsolatedTestPath } = require('./asar-engine');
    const inIsolatedEnv = Boolean(
      process.env.AG_METER_TEST_MODE === '1' ||
      isIsolatedTestPath(process.env.APPDATA) ||
      isIsolatedTestPath(process.env.AG_METER_STATE_DIR)
    );
    if (inIsolatedEnv && !customAsarPath) {
      liveBootChineseSnapshots.set(key, snap);
      return snap;
    }
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules(customAsarPath || null);
    const ch = cfg?.modules?.chinese || {};
    const diskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
    const active = Boolean(ch.enabled && String(ch.language || '').toLowerCase() !== 'en' && diskReady);
    snap = {
      enabled: active,
      language: String(ch.language || (ch.enabled ? 'zh-CN' : 'en'))
    };
  } catch { }
  liveBootChineseSnapshots.set(key, snap);
  return snap;
}
try { resolveLiveBootChineseSnapshot(); } catch { }

function buildLiveRuntimeModulesMeta(cfg, customAsarPath = null) {
  const diskProxy = cfg?.modules?.proxy || {};
  const diskEnabled = Boolean(diskProxy.enabled);
  const diskUrl = normalizeProxyUrl(diskProxy.proxyUrl || '');
  const diskBypass = normalizeBypassListForCompare(diskProxy.bypassList || '');
  const runtimeEnabled = Boolean(liveBootProxySnapshot.enabled);
  const runtimeUrl = normalizeProxyUrl(liveBootProxySnapshot.proxyUrl || '');
  const runtimeBypass = normalizeBypassListForCompare(liveBootProxySnapshot.bypassList || '');
  const proxyNeedsRestart = runtimeEnabled !== diskEnabled ||
    (diskEnabled && runtimeEnabled && (diskUrl !== runtimeUrl || diskBypass !== runtimeBypass));
  const bootZh = resolveLiveBootChineseSnapshot(customAsarPath);
  const diskCh = cfg?.modules?.chinese || {};
  const diskZhActive = Boolean(diskCh.enabled && String(diskCh.language || '').toLowerCase() !== 'en');
  return {
    injectedAtStartup: Boolean(liveBootProxySnapshot.injectedAtStartup),
    proxyActive: runtimeEnabled,
    runtimeProxyUrl: redactProxyUrl(runtimeUrl) || null,
    runtimeBypassList: typeof liveBootProxySnapshot.bypassList === 'string' ? liveBootProxySnapshot.bypassList : null,
    proxyNeedsRestart,
    chineseActive: Boolean(bootZh.enabled),
    chineseBootLanguage: bootZh.language,
    chineseNeedsRestart: diskZhActive !== Boolean(bootZh.enabled)
  };
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 传输体积上限
const MAX_RECORD_CALLS = 500; // 单批次最大记录数
const ALLOWED_ROUTES = [
  '/runtime-info',
  '/scan',
  '/turn-state',
  '/token-history',
  '/session-timeline',
  '/quota',
  '/record-calls',
  '/get-settings',
  '/save-settings',
  '/launch-cli',
  '/context-unlock-status',
  '/context-unlock-apply',
  '/context-unlock-restore',
  '/enhance-status',
  '/enhance-apply',
  '/enhance-restore',
  '/restart-language-servers',
  '/rehydrate-status',
  '/rehydrate-apply',
  '/rehydrate-disable',
  '/rehydrate-restore',
  '/rehydrate-install-python',
  '/modules-status',
  '/toggle-module',
  '/test-proxy',
  '/check-update',
  '/apply-update',
  '/accounts-overview',
  '/accounts-action',
  '/sync-pricing',
  '/open-dashboard-browser',
  '/shutdown',
  '/restart-host'
];

const LIVE_HOST_STARTED_AT = Date.now();
const LIVE_HOST_BUILD_ID = getHostCoreBuildId(__dirname);
const LIVE_CAPABILITIES = {
  scan: true,
  turnState: true,
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
  restartHost: false,
  hotReload: true,
  syncPricing: true
};

function timingSafeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createLiveRequestHandler({ api, secret, getAllowedOrigins = null, onShutdown = null, startedAt = LIVE_HOST_STARTED_AT, _applyUpdateAsync = applyUpdateAsync }) {
  let activeApplyUpdateCount = 0;
  let deferredShutdownRequested = false;
  const resolveAllowedSet = () => {
    const set = new Set();
    const addAllowed = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const norm = normalizeLoopbackOrigin(trimmed);
      set.add(norm || trimmed);
    };
    if (typeof getAllowedOrigins === 'function') {
      const list = getAllowedOrigins() || [];
      for (const o of list) addAllowed(o);
    }
    if (Array.isArray(api?.origins)) {
      for (const o of api.origins) addAllowed(o);
    }
    if (api?.origin) addAllowed(api.origin);
    return set;
  };

  return async (req, res) => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const reqOrigin = normalizeLoopbackOrigin(rawOrigin) || rawOrigin;
    const allowedSet = resolveAllowedSet();
    if (!reqOrigin || !allowedSet.has(reqOrigin)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || !timingSafeTokenEqual(req.headers['x-ag-context-token'], secret)) { res.writeHead(403); res.end(); return; }
    let body = '';
    let bodyLength = 0;
    let exceeded = false;
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求体积超出限制（最大 1MB）' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (exceeded) return;
      try {
        const request = JSON.parse(body || '{}');
        if (req.url === '/record-calls') {
          const calls = Array.isArray(request.calls) ? request.calls : [];
          if (calls.length > MAX_RECORD_CALLS) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `单次入账记录数超出上限（最多 ${MAX_RECORD_CALLS} 条）` }));
            return;
          }
          let recOpts = {};
          try {
            const { getSharedAccountsManager } = require('./meter-accounts');
            const mgr = getSharedAccountsManager({ origin: reqOrigin });
            const ov = mgr.getOverviewState();
            const activeEmail = ov?.activeAccountEmail || null;
            const sessions = Array.isArray(ov?.accountSessions) ? ov.accountSessions : [];
            const openSess = activeEmail
              ? sessions.slice().reverse().find(s => String(s.email).toLowerCase() === String(activeEmail).toLowerCase() && s.endAtMs == null)
              : null;
            recOpts = {
              accountSessions: sessions,
              ...(activeEmail ? {
                confirmedAccountEmail: activeEmail,
                liveConfirmedAccount: {
                  email: activeEmail,
                  verifiedAtMs: openSess?.lastVerifiedAtMs || Date.now(),
                  sessionStartMs: openSess?.startAtMs || Date.now()
                }
              } : {})
            };
          } catch { }
          const resCall = await recordModelCallsAsync(calls, recOpts);
          if (resCall && typeof resCall === 'object' && resCall.ok === false) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              changed: false,
              error: resCall.error || '入账落盘失败',
              ...(resCall.phase ? { phase: resCall.phase } : {}),
              ...(resCall.code ? { code: resCall.code } : {})
            }));
            return;
          }
          const changed = (resCall && typeof resCall === 'object') ? !!resCall.changed : !!resCall;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, changed }));
          return;
        }
        if (req.url === '/get-settings') {
          const result = getPluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/save-settings') {
          const result = savePluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/launch-cli') {
          const result = await launchCliSession(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/context-unlock-status') {
          const result = await getContextUnlockStatus(undefined, request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/context-unlock-apply') {
          const opts = { ...(request || {}) };
          if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
          const result = await applyContextUnlockAsync(opts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/context-unlock-restore') {
          const opts = { ...(request || {}) };
          if (opts.syncConfigFiles === undefined && !opts.backupDir) opts.syncConfigFiles = true;
          const result = await restoreContextUnlockAsync(opts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/enhance-status') {
          const { getEnhanceStatusAsync } = require('./meter-enhance');
          const result = await getEnhanceStatusAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/enhance-apply') {
          const { applyEnhancePatchAsync } = require('./meter-enhance');
          const result = await applyEnhancePatchAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/enhance-restore') {
          const { restoreAllEnhanceAsync } = require('./meter-enhance');
          const result = await restoreAllEnhanceAsync(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/restart-language-servers') {
          const { restartLanguageServersAsync } = require('./meter-enhance');
          const result = await restartLanguageServersAsync();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/rehydrate-status') {
          const { getRehydrateStatusAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
          const result = await getRehydrateStatusAsync(sanitizeRehydrateRendererOptions(request, 'status'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/rehydrate-apply') {
          const { applyRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
          const result = await applyRehydrateAsync(sanitizeRehydrateRendererOptions(request, 'apply'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/rehydrate-disable') {
          const { disableRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
          const result = await disableRehydrateAsync(sanitizeRehydrateRendererOptions(request, 'disable'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/rehydrate-restore') {
          const { restoreRehydrateAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
          const result = await restoreRehydrateAsync(sanitizeRehydrateRendererOptions(request, 'restore'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/rehydrate-install-python') {
          const { installPythonRuntimeAsync, sanitizeRehydrateRendererOptions } = require('./meter-rehydrate');
          const result = await installPythonRuntimeAsync(sanitizeRehydrateRendererOptions(request, 'install-python'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/test-proxy') {
          const { testProxyHealth } = require('./modules-config');
          const report = await testProxyHealth(request?.proxyUrl);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: report }));
          return;
        }
        if (req.url === '/modules-status') {
          const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
          const cfg = loadModulesConfig();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: cfg,
            disk: inspectDiskModules(request?.asarPath || null),
            runtime: buildLiveRuntimeModulesMeta(cfg, request?.asarPath || null),
            configCorrupted: Boolean(cfg.__configCorrupted),
            configError: cfg.__configError || null,
            corruptedConfigPath: cfg.__corruptedConfigPath || null
          }));
          return;
        }
        if (req.url === '/toggle-module') {
          const { loadModulesConfig, saveModulesConfig, inspectDiskModules, normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
          const cfg = loadModulesConfig();
          const mod = request?.name;
          if (!cfg.modules[mod]) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `未知模块: ${mod}` }));
            return;
          }
          const extra = request?.opts || {};
          const targetEnable = Boolean(request?.enable);
          const disk = inspectDiskModules(extra.asarPath || null);
          const hasDiskCapability = mod === 'chinese'
            ? Boolean(disk.chineseReady)
            : (mod === 'proxy' ? Boolean(disk.proxyReady) : Boolean(disk.meterReady));

          // 在热挂载模式或未持久化注入下尝试开启未注入模块时，给出可执行的外部补装指引，不假报切换成功
          if (targetEnable && !hasDiskCapability) {
            const modLabel = mod === 'chinese' ? '汉化' : (mod === 'proxy' ? '免 TUN 代理' : '核心监控');
            const subCmd = mod === 'proxy' ? 'proxy:enable' : (mod === 'chinese' ? 'chinese:enable' : 'install');
            const cmdHint = process.platform === 'win32'
              ? `在插件目录打开终端运行 install.bat 或 node cli.js ${subCmd}`
              : `在插件目录打开终端运行 node cli.js ${subCmd}`;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: false,
              status: 'install_failed',
              data: cfg,
              disk,
              runtime: buildLiveRuntimeModulesMeta(cfg, extra.asarPath || null),
              error: `当前客户端磁盘 ASAR 未注入${modLabel}组件（或组件不完整）。请先彻底退出 Antigravity（包含系统托盘），再${cmdHint} 完成持久化注入。`,
              restartRequired: false
            }));
            return;
          }

          // 在写盘更改前先确保本生命周期启动汉化快照已捕获
          resolveLiveBootChineseSnapshot(extra.asarPath || null);
          const prevChineseEnabled = Boolean(cfg.modules.chinese?.enabled);
          const prevChineseLang = cfg.modules.chinese?.language || (prevChineseEnabled ? 'zh-CN' : 'en');
          if (mod === 'chinese') {
            const nextLang = normalizeClientLanguage(extra.language, targetEnable);
            cfg.modules.chinese.language = nextLang;
            cfg.modules.chinese.enabled = nextLang === 'zh-CN';
            if (extra.brandTitle !== undefined) cfg.modules.chinese.brandTitle = normalizeBrandTitle(extra.brandTitle);
            cfg.modules.chinese.lastUpdated = new Date().toISOString();
          } else {
            if (mod === 'proxy' && extra.proxyUrl !== undefined) {
              const check = parseAndValidateProxyUrl(extra.proxyUrl);
              if (!check.ok) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  ok: false,
                  status: 'invalid_config',
                  error: check.error,
                  data: cfg,
                  runtime: buildLiveRuntimeModulesMeta(cfg, extra.asarPath || null)
                }));
                return;
              }
              cfg.modules.proxy.proxyUrl = check.value;
            }
            cfg.modules[mod].enabled = targetEnable;
            if (mod === 'proxy') {
              if (typeof extra.bypassList === 'string') {
                cfg.modules.proxy.bypassList = extra.bypassList.trim();
              }
              cfg.modules.proxy.lastUpdated = new Date().toISOString();
            }
          }
          saveModulesConfig(cfg);
          const runtime = buildLiveRuntimeModulesMeta(cfg, extra.asarPath || null);
          const langChanged = mod === 'chinese' && (
            Boolean(cfg.modules.chinese.enabled) !== prevChineseEnabled ||
            cfg.modules.chinese.language !== prevChineseLang
          );
          const brandOnlyUpdate = mod === 'chinese' && extra.brandTitle !== undefined && !langChanged;
          const restartRequired = mod === 'proxy'
            ? Boolean(runtime.proxyNeedsRestart)
            : (brandOnlyUpdate ? false : Boolean(runtime.chineseNeedsRestart));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            status: 'config_toggled',
            data: cfg,
            disk,
            runtime,
            restartRequired
          }));
          return;
        }
        if (req.url === '/runtime-info') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            backendVersion: PROJECT_VERSION,
            hostBuildId: LIVE_HOST_BUILD_ID,
            backendSource: 'live-host',
            pid: process.pid,
            startedAt,
            capabilities: { ...LIVE_CAPABILITIES },
            origins: Array.from(resolveAllowedSet())
          }));
          return;
        }
        if (req.url === '/check-update') {
          const result = await checkUpdateAsync({
            force: request?.force === true,
            allowBetaUpdates: typeof request?.allowBetaUpdates === 'boolean' ? request.allowBetaUpdates : undefined,
            currentVersion: PROJECT_VERSION,
            liveOnly: true
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/sync-pricing') {
          const result = await syncPricingCatalogAsync({ force: request?.force !== false });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/open-dashboard-browser') {
          const { startCliUiServer } = require('./meter-cli-ui');
          const rawSid = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
          const cleanSid = (rawSid && !/[/\\]|\.\./.test(rawSid)) ? rawSid : '';
          const rawSrc = typeof request?.source === 'string' ? request.source.trim().toLowerCase() : 'desktop';
          const cleanSrc = (rawSrc === 'cli' || rawSrc === 'desktop') ? rawSrc : 'desktop';
          const shouldOpenExternal = request?.openExternal === true;
          if (!globalThis.__agLiveDashboardServerPromise) {
            globalThis.__agLiveDashboardServerPromise = startCliUiServer({ host: '127.0.0.1', port: 0, open: false }).catch(err => {
              globalThis.__agLiveDashboardServerPromise = null;
              throw err;
            });
          }
          const srv = await globalThis.__agLiveDashboardServerPromise;
          const baseUrl = srv?.baseUrl || srv?.url || `http://127.0.0.1:${srv?.port || 56780}`;
          const dashboardUrl = cleanSid
            ? `${baseUrl}/?sessionId=${encodeURIComponent(cleanSid)}&source=${encodeURIComponent(cleanSrc)}`
            : baseUrl;
          let openedExternal = false;
          if (shouldOpenExternal) {
            try {
              const { spawn } = require('child_process');
              if (process.platform === 'win32') {
                spawn('cmd.exe', ['/c', 'start', '', dashboardUrl], { detached: true, stdio: 'ignore' }).unref();
              } else if (process.platform === 'darwin') {
                spawn('open', [dashboardUrl], { detached: true, stdio: 'ignore' }).unref();
              } else {
                spawn('xdg-open', [dashboardUrl], { detached: true, stdio: 'ignore' }).unref();
              }
              openedExternal = true;
            } catch { }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            baseUrl,
            url: dashboardUrl,
            port: srv?.port || null,
            pid: srv?.pid || null,
            sessionId: cleanSid || null,
            source: cleanSrc,
            openedExternal
          }));
          return;
        }
        if (req.url === '/apply-update') {
          activeApplyUpdateCount += 1;
          let result;
          try {
            result = await _applyUpdateAsync({
              ...(request || {}),
              version: typeof request?.version === 'string' ? request.version : undefined,
              allowBetaUpdates: request?.allowBetaUpdates === true || request?.prerelease === true,
              prerelease: request?.prerelease === true,
              currentVersion: PROJECT_VERSION,
              backendSource: 'live-host',
              bundleDir: process.env.AG_BUNDLE_SOURCE_DIR || __dirname,
              callerLiveHostPid: process.pid,
              liveOnly: request?.liveOnly !== undefined ? request.liveOnly === true : true
            });
          } finally {
            activeApplyUpdateCount = Math.max(0, activeApplyUpdateCount - 1);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          if (((result && result.ok && result.shouldShutdownCallerLiveHost) || deferredShutdownRequested) && typeof onShutdown === 'function') {
            res.once('finish', () => {
              setTimeout(() => {
                try { onShutdown(); } catch { }
              }, 250);
            });
          }
          return;
        }
        if (req.url === '/shutdown') {
          res.setHeader('Content-Type', 'application/json');
          if (activeApplyUpdateCount > 0) {
            deferredShutdownRequested = true;
            res.end(JSON.stringify({ ok: true, shuttingDown: true, deferred: true, deferredForApplyUpdate: true, pid: process.pid, version: PROJECT_VERSION }));
            return;
          }
          res.end(JSON.stringify({ ok: true, shuttingDown: true, pid: process.pid, version: PROJECT_VERSION }));
          if (typeof onShutdown === 'function') {
            setImmediate(() => {
              try { onShutdown(); } catch { }
            });
          }
          return;
        }
        if (req.url === '/restart-host') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, supported: false }));
          return;
        }
        if (req.url === '/token-history') {
          const result = await getTokenHistoryResponse({ force: request.force === true, knownRevision: request.knownRevision, knownAccountKey: request.knownAccountKey });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/session-timeline') {
          const tlOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const targetOrigin = allowedSet.has(tlOrigin) ? tlOrigin : reqOrigin;
          const opts = request?.options && typeof request.options === 'object' ? request.options : request;
          const safeOpts = {
            origin: targetOrigin,
            force: opts?.force === true,
            ...(Array.isArray(opts?.liveSteps) ? { liveSteps: opts.liveSteps } : {}),
            ...(Array.isArray(opts?.liveCalls) ? { liveCalls: opts.liveCalls } : {}),
            ...(Array.isArray(opts?.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {}),
            ...(opts?.userStatus && typeof opts.userStatus === 'object' ? { userStatus: opts.userStatus } : {})
          };
          const data = await collectSessionTimelineAsync(request?.id || '', safeOpts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: {
              ...(data || {}),
              backendVersion: PROJECT_VERSION,
              backendSource: 'live-host'
            }
          }));
          return;
        }
        if (req.url === '/quota') {
          const reqTargetOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const targetOrigin = allowedSet.has(reqTargetOrigin) ? reqTargetOrigin : reqOrigin;
          const resData = await fetchQuotaSnapshotFromHost({
            force: request.force === true,
            origin: targetOrigin,
            backendSource: 'live-host',
            currentModel: request.currentModel || null,
            browsePoolKey: request.browsePoolKey || null
          });
          const { _raw, ...safeData } = resData || {};
          let accountSyncResult = null;
          try {
            const { getSharedAccountsManager, deriveTrustedAutoSwitchQuotaContext } = require('./meter-accounts');
            const mgr = getSharedAccountsManager({ origin: targetOrigin });
            const switchInFlight = Boolean(mgr.isSwitchInFlight?.());
            const sourceEmail = !switchInFlight
              ? (resData?.email || _raw?.planStatus?.email || _raw?.userStatus?.email || _raw?.email || resData?.planStatus?.email || null)
              : null;
            const activeDetectedEmail = !switchInFlight
              ? (sourceEmail || (await mgr.detectCurrentActiveAccount())?.email || null)
              : null;
            const trustCtx = deriveTrustedAutoSwitchQuotaContext({
              res: resData,
              raw: _raw,
              activeEmail: activeDetectedEmail
            });
            if (!switchInFlight && trustCtx.trusted && trustCtx.email && resData?.snapshot) {
              mgr.syncActiveHostQuotaSnapshot(resData, trustCtx.email);
            }
            const ov = mgr.getOverviewState();
            if (!switchInFlight && ov.autoSwitch?.enabled) {
              const requiresClientRestart = compareVersions(resolveLiveHostTargetVersion(), '2.34.0') >= 0;
              const evalSyncState = trustCtx.trusted
                ? 'fresh'
                : (trustCtx.syncState && trustCtx.syncState !== 'fresh' ? trustCtx.syncState : 'untrusted');
              accountSyncResult = await mgr.evaluateAutoSwitch({
                activeEmail: trustCtx.email || activeDetectedEmail,
                activeSnapshot: resData?.snapshot || null,
                syncState: evalSyncState,
                allowLiveCandidateRefresh: true,
                isGenerating: Boolean(request?.isGenerating),
                hasUnsavedDraft: Boolean(request?.hasUnsavedDraft),
                requiresClientRestart,
                blockedRestartReason: requiresClientRestart ? 'live_mode_cannot_auto_restart' : undefined
              });
              if (accountSyncResult && typeof accountSyncResult === 'object') {
                accountSyncResult.overview = mgr.getOverviewState();
              }
            }
          } catch { }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: safeData, accountSyncResult }));
          return;
        }
        if (req.url === '/accounts-overview') {
          const { getSharedAccountsManager } = require('./meter-accounts');
          const targetOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const mgr = getSharedAccountsManager({ origin: targetOrigin });
          await mgr.detectCurrentActiveAccount();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(mgr.getOverviewState()));
          return;
        }
        if (req.url === '/accounts-action') {
          const { getSharedAccountsManager, dispatchAccountsAction } = require('./meter-accounts');
          const targetOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const mgr = getSharedAccountsManager({ origin: targetOrigin });
          const requiresClientRestart = compareVersions(resolveLiveHostTargetVersion(), '2.34.0') >= 0;
          const outRes = await dispatchAccountsAction(mgr, request || {}, {
            requiresClientRestart,
            allowManualRestartPending: requiresClientRestart
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(outRes));
          return;
        }
        const scanOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
        const effectiveOrigin = allowedSet.has(scanOrigin) ? scanOrigin : reqOrigin;
        if (req.url === '/turn-state') {
          const data = await collectTurnState(effectiveOrigin, request.id);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: {
              ...(data || {}),
              backendVersion: PROJECT_VERSION,
              backendSource: 'live-host'
            }
          }));
          return;
        }
        if (req.url === '/predict-next-prompt') {
          const settings = getPluginSettings();
          if (settings.nextPromptEnabled !== true) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, abstained: true, suggestion: '', reason: 'feature_disabled', requestCount: 0 }));
            return;
          }
          const { predictNextPromptAsync } = require('./meter-next-prompt');
          const safeInput = {
            cascadeId: typeof request?.cascadeId === 'string' ? request.cascadeId : undefined,
            turnId: typeof request?.turnId === 'string' ? request.turnId : undefined,
            language: typeof request?.language === 'string' ? request.language : undefined,
            turns: Array.isArray(request?.turns) ? request.turns : [],
            preferences: Array.isArray(request?.preferences) ? request.preferences : [],
            verificationEvidence: typeof request?.verificationEvidence === 'string' ? request.verificationEvidence : undefined,
            taskMarkdown: typeof request?.taskMarkdown === 'string' ? request.taskMarkdown : undefined
          };
          const predRes = await predictNextPromptAsync(safeInput, {
            origin: effectiveOrigin,
            model: typeof request?.model === 'string' && request.model.trim() ? request.model.trim() : undefined,
            allowGetModelResponseFallback: request?.allowGetModelResponseFallback === true
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ...predRes, backendVersion: PROJECT_VERSION, backendSource: 'live-host' }));
          return;
        }
        const data = await collect(effectiveOrigin, request.id, { force: request.force === true });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          data: {
            ...(data || {}),
            backendVersion: PROJECT_VERSION,
            backendSource: 'live-host'
          }
        }));
      }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  };
}

function getCliArgValue(flagName) {
  const idx = process.argv.indexOf(flagName);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return String(process.argv[idx + 1] || '').trim();
  }
  return '';
}

function parseInitialOriginsEnv() {
  const cliOriginsB64 = getCliArgValue('--origins-b64');
  let raw = String(process.env.AG_LIVE_ORIGINS || '').trim();
  if (!raw && cliOriginsB64) {
    try { raw = Buffer.from(cliOriginsB64, 'base64').toString('utf8').trim(); } catch { }
  }
  if (!raw) return [];
  try {
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? Array.from(new Set(parsed.map(normalizeLoopbackOrigin).filter(Boolean)))
        : [];
    }
  } catch { }
  return Array.from(new Set(raw.split(/[,;\s]+/).map(normalizeLoopbackOrigin).filter(Boolean)));
}

function discoverCdpPageOrigins() {
  return new Promise((resolve) => {
    try {
      const portFile = path.join(getAppDataDir(), 'Antigravity', 'DevToolsActivePort');
      if (!fs.existsSync(portFile)) return resolve([]);
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (!Number.isFinite(port) || port <= 0) return resolve([]);
      const req = http.get(`http://127.0.0.1:${port}/json/list`, { agent: false }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const pages = JSON.parse(d);
            const list = Array.from(new Set(
              (Array.isArray(pages) ? pages : [])
                .filter(item => item && item.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(item.url))
                .map(item => normalizeLoopbackOrigin(item.url))
                .filter(Boolean)
            ));
            resolve(list);
          } catch { resolve([]); }
        });
      });
      req.setTimeout(2000, () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

function probeOriginAlive(origin) {
  return new Promise((resolve) => {
    try {
      const safeOrigin = normalizeLoopbackOrigin(origin);
      if (!safeOrigin) return resolve(false);
      const transport = safeOrigin.startsWith('https:') ? require('https') : http;
      const req = transport.request(safeOrigin + '/', { agent: false, rejectUnauthorized: false, method: 'GET' }, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function startLiveHost() {
  const cliStateDir = getCliArgValue('--state-dir');
  if (cliStateDir) {
    process.env.AG_METER_STATE_DIR = path.resolve(cliStateDir);
  }
  const envOrigins = parseInitialOriginsEnv();
  let currentOrigins = envOrigins;
  let api = null;
  if (currentOrigins.length > 0) {
    let lastConnectErr = null;
    for (const candOrigin of currentOrigins) {
      try {
        api = await connect({ origin: candOrigin });
        break;
      } catch (err) {
        lastConnectErr = err;
      }
    }
    if (!api) {
      throw lastConnectErr || new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
    }
    api.origins = currentOrigins.includes(api.origin)
      ? currentOrigins
      : [api.origin, ...currentOrigins];
  } else {
    api = await connect();
    currentOrigins = Array.isArray(api.origins) && api.origins.length ? api.origins : [api.origin];
  }
  const secret = crypto.randomBytes(32).toString('hex');
  const cliStamp = getCliArgValue('--stamp');
  const stampRaw = process.env.AG_LIVE_STAMP_PATH || cliStamp;
  const stamp = stampRaw
    ? path.resolve(stampRaw)
    : path.join(getStateDir(), '.live-session.json');
  const hostPidRaw = Number(process.env.AG_LIVE_HOST_PID || getCliArgValue('--host-pid') || 0);
  const watchHostPid = Number.isInteger(hostPidRaw) && hostPidRaw > 0 ? hostPidRaw : null;

  let checkTimer = null;
  let server = null;
  let shuttingDown = false;
  const shutdownGracefully = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    const primaryStamp = path.join(getStateDir(), '.live-session.json');
    for (const candidateStamp of Array.from(new Set([stamp, primaryStamp]))) {
      try {
        if (fs.existsSync(candidateStamp)) {
          const cur = JSON.parse(fs.readFileSync(candidateStamp, 'utf8'));
          if (cur && cur.pid === process.pid) fs.unlinkSync(candidateStamp);
        }
      } catch { }
    }
    if (server) {
      try {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      } catch {
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  };

  server = http.createServer(createLiveRequestHandler({
    api,
    secret,
    getAllowedOrigins: () => currentOrigins,
    onShutdown: shutdownGracefully,
    startedAt: LIVE_HOST_STARTED_AT
  }));

  server.listen(0, '127.0.0.1', () => {
    const info = {
      port: server.address().port,
      token: secret,
      pid: process.pid,
      origin: api.origin,
      origins: currentOrigins,
      version: PROJECT_VERSION,
      hostBuildId: LIVE_HOST_BUILD_ID,
      backendSource: 'live-host',
      hasQuota: true,
      hasRuntimeInfo: true,
      hasTurnState: true,
      capabilities: Object.keys(LIVE_CAPABILITIES).filter(k => LIVE_CAPABILITIES[k]),
      startedAt: LIVE_HOST_STARTED_AT
    };
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    const tmpStamp = `${stamp}.tmp-${process.pid}`;
    fs.writeFileSync(tmpStamp, JSON.stringify(info, null, 2));
    fs.renameSync(tmpStamp, stamp);
    console.log('Context Meter local bridge ready on loopback port ' + info.port);
  });

  let misses = 0;
  checkTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      if (watchHostPid) {
        try { process.kill(watchHostPid, 0); } catch {
          shutdownGracefully();
          return;
        }
      }
      const cdpOrigins = await discoverCdpPageOrigins();
      if (cdpOrigins.length > 0) {
        currentOrigins = Array.from(new Set([...cdpOrigins, ...envOrigins]));
        misses = 0;
        return;
      }
      if (envOrigins.length > 0) {
        const aliveResults = await Promise.all(envOrigins.map(o => probeOriginAlive(o)));
        if (aliveResults.some(Boolean)) {
          misses = 0;
          return;
        }
      }
      throw new Error('No live Antigravity origins available');
    } catch {
      if (++misses >= 3) {
        shutdownGracefully();
      }
    }
  }, 10000);
}

if (require.main === module) {
  startLiveHost().catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  ALLOWED_ROUTES,
  LIVE_CAPABILITIES,
  LIVE_HOST_BUILD_ID,
  buildLiveRuntimeModulesMeta,
  createLiveRequestHandler,
  parseInitialOriginsEnv,
  startLiveHost
};
