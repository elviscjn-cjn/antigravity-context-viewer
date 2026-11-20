'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect, normalizeLoopbackOrigin, getAppDataDir } = require('./local-api');
const {
  collect,
  collectTokenHistoryAsync,
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
  restoreContextUnlockAsync
} = require('./meter-collector');
const { normalizeProxyUrl, normalizeBypassListForCompare, parseAndValidateProxyUrl } = require('./meter-proxy');
const { getStateDir } = require('./asar-engine');
const { PROJECT_VERSION, getHostCoreBuildId } = require('./modules-config');

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

function resolveLiveBootChineseSnapshot() {
  const key = String(process.env.AG_METER_STATE_DIR || '__default__');
  if (liveBootChineseSnapshots.has(key)) return liveBootChineseSnapshots.get(key);
  let snap = { enabled: false, language: 'en' };
  try {
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules();
    const ch = cfg?.modules?.chinese || {};
    const diskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
    const active = Boolean(ch.enabled && String(ch.language || '').toLowerCase() !== 'en' && diskReady);
    snap = {
      enabled: active,
      language: String(ch.language || (ch.enabled ? 'zh-CN' : 'en'))
    };
  } catch {}
  liveBootChineseSnapshots.set(key, snap);
  return snap;
}
try { resolveLiveBootChineseSnapshot(); } catch {}

function buildLiveRuntimeModulesMeta(cfg) {
  const diskProxy = cfg?.modules?.proxy || {};
  const diskEnabled = Boolean(diskProxy.enabled);
  const diskUrl = normalizeProxyUrl(diskProxy.proxyUrl || '');
  const diskBypass = normalizeBypassListForCompare(diskProxy.bypassList || '');
  const runtimeEnabled = Boolean(liveBootProxySnapshot.enabled);
  const runtimeUrl = normalizeProxyUrl(liveBootProxySnapshot.proxyUrl || '');
  const runtimeBypass = normalizeBypassListForCompare(liveBootProxySnapshot.bypassList || '');
  const proxyNeedsRestart = runtimeEnabled !== diskEnabled ||
    (diskEnabled && runtimeEnabled && (diskUrl !== runtimeUrl || diskBypass !== runtimeBypass));
  const bootZh = resolveLiveBootChineseSnapshot();
  const diskCh = cfg?.modules?.chinese || {};
  const diskZhActive = Boolean(diskCh.enabled && String(diskCh.language || '').toLowerCase() !== 'en');
  return {
    injectedAtStartup: Boolean(liveBootProxySnapshot.injectedAtStartup),
    proxyActive: runtimeEnabled,
    runtimeProxyUrl: runtimeUrl || null,
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
  '/modules-status',
  '/toggle-module',
  '/test-proxy',
  '/check-update',
  '/apply-update',
  '/accounts-overview',
  '/accounts-action',
  '/shutdown',
  '/restart-host'
];

const LIVE_HOST_STARTED_AT = Date.now();
const LIVE_HOST_BUILD_ID = getHostCoreBuildId(__dirname);
const LIVE_CAPABILITIES = {
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
  restartHost: false,
  hotReload: true
};

function timingSafeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createLiveRequestHandler({ api, secret, getAllowedOrigins = null, onShutdown = null, startedAt = LIVE_HOST_STARTED_AT }) {
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
            runtime: buildLiveRuntimeModulesMeta(cfg),
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
              runtime: buildLiveRuntimeModulesMeta(cfg),
              error: `当前客户端磁盘 ASAR 未注入${modLabel}组件（或组件不完整）。请先彻底退出 Antigravity（包含系统托盘），再${cmdHint} 完成持久化注入。`,
              restartRequired: false
            }));
            return;
          }

          // 在写盘更改前先确保本生命周期启动汉化快照已捕获
          resolveLiveBootChineseSnapshot();
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
                  runtime: buildLiveRuntimeModulesMeta(cfg)
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
          const runtime = buildLiveRuntimeModulesMeta(cfg);
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
          const result = await checkUpdateAsync({ ...(request || {}), currentVersion: PROJECT_VERSION });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/apply-update') {
          const result = await applyUpdateAsync({ ...(request || {}), currentVersion: PROJECT_VERSION });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/shutdown') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, shuttingDown: true, pid: process.pid, version: PROJECT_VERSION }));
          if (typeof onShutdown === 'function') {
            setImmediate(() => {
              try { onShutdown(); } catch {}
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
          const data = await collectTokenHistoryAsync({ force: request.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
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
            const { getSharedAccountsManager } = require('./meter-accounts');
            const mgr = getSharedAccountsManager({ origin: targetOrigin });
            const email = resData?.planStatus?.email || (await mgr.detectCurrentActiveAccount())?.email || null;
            if (email && resData?.snapshot) {
              mgr.syncActiveHostQuotaSnapshot(resData, email);
              const ov = mgr.getOverviewState();
              if (ov.autoSwitch?.enabled && !resData.error) {
                accountSyncResult = await mgr.evaluateAutoSwitch({
                  activeEmail: email,
                  activeSnapshot: resData.snapshot,
                  syncState: 'fresh',
                  isGenerating: Boolean(request?.isGenerating)
                });
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
          const outRes = await dispatchAccountsAction(mgr, request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(outRes));
          return;
        }
        const scanOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
        const effectiveOrigin = allowedSet.has(scanOrigin) ? scanOrigin : reqOrigin;
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
    try { raw = Buffer.from(cliOriginsB64, 'base64').toString('utf8').trim(); } catch {}
  }
  if (!raw) return [];
  try {
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? Array.from(new Set(parsed.map(normalizeLoopbackOrigin).filter(Boolean)))
        : [];
    }
  } catch {}
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
      } catch {}
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
