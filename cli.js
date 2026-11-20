#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI
 * Cross-platform installer, live CDP hot-injector, and lifecycle manager
 * Format aligned with antigravity-chinese for one-command human & AI Agent execution.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { loadAsarEngine, getStateDir, getAppDataDir, isIsolatedTestPath } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient, parseExplicitPort, normalizeLoopbackOrigin, HANS_CANDIDATE_PORTS } = require('./local-api');
const {
  install,
  findAsarPath,
  tryHotInject,
  tryHotInjectDetailed,
  probeLiveHostRuntimeInfo,
  shutdownLiveHostGracefully,
  extractAsarFile,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId
} = require('./install');
const { restore, tryHotDispose } = require('./restore');
const { resolvePython, syncLiveRuntimeBundle, OFFICIAL_REPO } = require('./meter-collector');
const { PROJECT_VERSION } = require('./modules-config');
const { redactProxyUrl } = require('./meter-proxy');
const { analyzeBinary, analyzeBinaryAsync, applyUnlock, restoreUnlock, detectCliBinary, AUTHOR_INFO } = require('./meter-context-unlock');

const asar = loadAsarEngine();

function isPidAliveForUser(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function getWatchPidPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch.pid');
}

function getWatchMetaPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch-meta.json');
}

function readWatchMetaInfo(stateDir = null) {
  const metaPath = getWatchMetaPath(stateDir);
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = fs.readFileSync(metaPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null,
      script: typeof parsed.script === 'string' ? parsed.script : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      repo: typeof parsed.repo === 'string' ? parsed.repo : null,
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null,
      rendererBuildId: typeof parsed.rendererBuildId === 'string' ? parsed.rendererBuildId : null,
      hostBuildId: typeof parsed.hostBuildId === 'string' ? parsed.hostBuildId : null,
      rendererMtimeMs: Number.isFinite(parsed.rendererMtimeMs) ? parsed.rendererMtimeMs : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    };
  } catch {
    return null;
  }
}

function readWatchLockInfo(stateDir = null) {
  const pidPath = getWatchPidPath(stateDir);
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.pid);
      if (!Number.isInteger(n) || n <= 0) return null;
      return {
        pid: n,
        format: 'json',
        script: typeof parsed.script === 'string' ? parsed.script : null,
        version: typeof parsed.version === 'string' ? parsed.version : null,
        repo: typeof parsed.repo === 'string' ? parsed.repo : null,
        buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null,
        rendererBuildId: typeof parsed.rendererBuildId === 'string' ? parsed.rendererBuildId : null
      };
    }
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { pid: n, format: 'legacy', script: null, version: null, repo: null, buildId: null, rendererBuildId: null };
  } catch {
    return null;
  }
}

function readWatchPid(stateDir = null) {
  const info = readWatchLockInfo(stateDir);
  return info ? info.pid : null;
}

function inspectProcessCommandPosix(pid, customInspector = null) {
  if (typeof customInspector === 'function') {
    try { return String(customInspector(pid) || ''); } catch { return ''; }
  }
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function shouldTakeOverWatchLock(lockInfo, options = {}) {
  if (!lockInfo || !lockInfo.pid) return false;
  const expectedScript = path.resolve(options.watchScript || __filename);
  const expectedVersion = options.expectedVersion || PROJECT_VERSION;
  const expectedRepo = options.expectedRepo || OFFICIAL_REPO;
  const hasExplicitBuildId = options.expectedBuildId !== undefined;
  const expectedBuildId = hasExplicitBuildId
    ? options.expectedBuildId
    : (options.expectedBundleBuildId !== undefined
      ? options.expectedBundleBuildId
      : getWatchBundleBuildId(options.bundleDir || null));

  if (lockInfo.format === 'json') {
    const sameScript = Boolean(lockInfo.script && path.resolve(lockInfo.script) === expectedScript);
    const sameVersion = lockInfo.version === expectedVersion;
    const sameRepo = lockInfo.repo === expectedRepo;
    const sameBuildId = !expectedBuildId || lockInfo.buildId === expectedBuildId;
    if (!(sameScript && sameVersion && sameRepo && sameBuildId)) {
      return true;
    }
    if (!hasExplicitBuildId && options.stateDir && options.requireWatchMeta !== false) {
      const meta = readWatchMetaInfo(options.stateDir);
      if (!meta) return true;
      if (meta.pid && Number(meta.pid) !== Number(lockInfo.pid)) return true;
      if (expectedBuildId && meta.buildId !== expectedBuildId) return true;
    }
    return false;
  }

  if (process.platform !== 'win32' || typeof options._inspectProcessCommand === 'function') {
    const cmd = inspectProcessCommandPosix(lockInfo.pid, options._inspectProcessCommand);
    if (!cmd) return false;
    if (cmd.includes('cli.js') && cmd.includes('watch')) {
      return !cmd.includes(expectedScript) || Boolean(expectedBuildId);
    }
  }
  return false;
}

async function terminateProcessGracefully(pid, graceMs = 2000) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  if (!isPidAliveForUser(n)) return false;
  try {
    process.kill(n, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAliveForUser(n)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  if (isPidAliveForUser(n)) {
    try { process.kill(n, 'SIGKILL'); } catch {}
  }
  return true;
}

async function stopLiveBridge(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  let stopped = false;
  let stoppedPid = null;
  for (const liveFile of Array.from(new Set([statePath, legacyPath]))) {
    if (!fs.existsSync(liveFile)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
      if (info && info.pid) {
        await shutdownLiveHostGracefully(info);
        stopped = true;
        stoppedPid = info.pid;
      }
    } catch {}
    try { if (fs.existsSync(liveFile)) fs.unlinkSync(liveFile); } catch {}
  }
  return { stopped, pid: stoppedPid };
}

const DEFAULT_MANUAL_CDP_PORT = (Array.isArray(HANS_CANDIDATE_PORTS) && HANS_CANDIDATE_PORTS[0]) || 58321;

function resolveAntigravityHostTarget(customPath = null, options = {}) {
  if (options && options._hostTarget) return options._hostTarget;
  const platform = (options && options.platform) || process.platform;
  let asarPath = null;
  try { asarPath = findAsarPath(customPath); } catch {}
  if (!asarPath) {
    return {
      platform,
      asarPath: null,
      appBundlePath: platform === 'darwin' ? '/Applications/Antigravity.app' : null,
      execPath: platform === 'win32' ? 'Antigravity.exe' : 'antigravity'
    };
  }
  if (platform === 'darwin') {
    const bundleCandidate = path.resolve(asarPath, '..', '..', '..');
    const isAppBundle = bundleCandidate.toLowerCase().endsWith('.app');
    const appBundlePath = isAppBundle ? bundleCandidate : null;
    let exeName = isAppBundle ? path.basename(bundleCandidate, '.app') : 'Antigravity';
    if (appBundlePath) {
      try {
        const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
        if (fs.existsSync(plistPath)) {
          const plistRaw = fs.readFileSync(plistPath, 'utf8');
          const m = plistRaw.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<\s][^<]*?)\s*<\/string>/);
          if (m && m[1]) exeName = m[1].trim();
        }
      } catch {}
    }
    const execPath = appBundlePath
      ? path.join(appBundlePath, 'Contents', 'MacOS', exeName)
      : path.resolve(asarPath, '..', '..', 'MacOS', exeName);
    return { platform, asarPath, appBundlePath, execPath };
  }
  const installDir = path.resolve(asarPath, '..', '..');
  if (platform === 'win32') {
    const candidates = ['Antigravity.exe', 'antigravity.exe'].map(n => path.join(installDir, n));
    const execPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
    return { platform, asarPath, appBundlePath: null, execPath };
  }
  const candidates = ['antigravity', 'Antigravity'].map(n => path.join(installDir, n));
  const execPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
  return { platform, asarPath, appBundlePath: null, execPath };
}

function formatManualCdpLaunchCommand(target = null, port = DEFAULT_MANUAL_CDP_PORT) {
  const platform = target?.platform || process.platform;
  if (platform === 'darwin') {
    const appRef = target?.appBundlePath || '/Applications/Antigravity.app';
    return appRef === '/Applications/Antigravity.app'
      ? `open -a Antigravity --args --remote-debugging-port=${port}`
      : `open -a "${appRef}" --args --remote-debugging-port=${port}`;
  }
  if (platform === 'win32') {
    const exe = target?.execPath || 'Antigravity.exe';
    return `& "${exe}" --remote-debugging-port=${port}`;
  }
  const exe = target?.execPath || 'antigravity';
  return `"${exe}" --remote-debugging-port=${port}`;
}

function buildManualCdpRestartGuidance(customPath = null, options = {}) {
  const port = parseExplicitPort(options.port ?? process.env.AG_CDP_PORT) || DEFAULT_MANUAL_CDP_PORT;
  const target = resolveAntigravityHostTarget(customPath, options);
  const cmd = formatManualCdpLaunchCommand(target, port);
  return {
    port,
    command: cmd,
    lines: [
      '⚠️ 检测到 Antigravity 客户端正在运行，但未开启 CDP 远程调试端口（v2.33.0+ 默认关闭）。',
      '   为避免中断当前会话与未保存状态，插件不会自动结束您的客户端进程。',
      '   请手动完全退出 Antigravity（macOS 按 Cmd + Q / Windows 右键托盘退出），然后使用以下命令重新启动：',
      `   ${cmd}`,
      '   或改用持久化安装（免 CDP 调试端口）：node cli.js install'
    ]
  };
}

/**
 * 复用 v0.8.8 免 CDP 主进程 origin 发现方案：
 * 通过 daemon/hub_*.json 存活语言服务与本地状态探测运行中窗口原点，避免在 v2.33.0 未开 CDP 时误判客户端未启动。
 */
function discoverHostOriginsWithoutCdp(options = {}) {
  const isTestEnv = process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
  const hasExplicitScope = Boolean(
    options.daemonDir ||
    options.homeDir ||
    options.stateDir ||
    options._discoverDaemonHubOrigins ||
    isIsolatedTestPath(options.appDataDir)
  );
  if (isTestEnv && !hasExplicitScope) {
    return { runningWithoutCdp: false, origins: [], hubCount: 0, discoverySource: null };
  }

  let hubs = [];
  if (typeof options._discoverDaemonHubOrigins === 'function') {
    hubs = options._discoverDaemonHubOrigins(options) || [];
  } else {
    try {
      const { discoverDaemonHubOrigins } = require('./meter-accounts');
      hubs = discoverDaemonHubOrigins({
        ...(options.daemonDir ? { daemonDir: options.daemonDir } : {}),
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(typeof options.isPidAlive === 'function' ? { isPidAlive: options.isPidAlive } : {})
      });
    } catch { }
  }

  const origins = [];
  for (const h of (Array.isArray(hubs) ? hubs : [])) {
    const norm = normalizeLoopbackOrigin(h?.origin);
    if (norm && !origins.includes(norm)) origins.push(norm);
  }
  if (origins.length > 0) {
    return {
      runningWithoutCdp: true,
      origins,
      hubCount: hubs.length,
      discoverySource: 'daemon_hub'
    };
  }

  try {
    const stateDir = options.stateDir || getStateDir();
    const liveFile = path.join(stateDir, '.live-session.json');
    if (fs.existsSync(liveFile)) {
      const info = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
      const pidAlive = info?.pid && isPidAliveForUser(info.pid);
      if (pidAlive) {
        const candidates = [...(Array.isArray(info.origins) ? info.origins : []), info.origin].filter(Boolean);
        for (const c of candidates) {
          const norm = normalizeLoopbackOrigin(c);
          if (norm && !origins.includes(norm)) origins.push(norm);
        }
        if (origins.length > 0) {
          return {
            runningWithoutCdp: true,
            origins,
            hubCount: 0,
            discoverySource: 'live_session'
          };
        }
      }
    }
  } catch { }

  if (typeof options._isHostRunning === 'function') {
    try {
      if (options._isHostRunning()) {
        return { runningWithoutCdp: true, origins: [], hubCount: 0, discoverySource: 'host_process' };
      }
    } catch { }
  }

  return { runningWithoutCdp: false, origins: [], hubCount: 0, discoverySource: null };
}

async function queryLiveWindow(options = {}) {
  try {
    const appData = getAppDataDir(options);
    const hasIsolatedOpts = Boolean(options.port || options.appDataDir || options.homeDir || options.daemonDir || options._discoverDaemonHubOrigins);
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !hasIsolatedOpts) {
      if (!isIsolatedTestPath(appData)) {
        return { running: false };
      }
    }
    const discovered = await discoverAntigravityCdp(options);
    const matchedTargets = Array.isArray(discovered.pages) ? discovered.pages : [];
    const target = discovered.page || matchedTargets[0];
    const port = discovered.port;
    if (!target) return { running: true, cdpEnabled: true, cdpPort: port, pageFound: false, origins: [] };
    const origin = normalizeLoopbackOrigin(target.url) || new URL(target.url).origin;
    const origins = Array.from(new Set(matchedTargets.map(p => normalizeLoopbackOrigin(p.url)).filter(Boolean)));

    const client = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 4000 });
    try {
      const status = await client.evaluateValue(`(async () => {
        const s = window.__AGContextMeter?.snapshot();
        const root = document.getElementById('ag-context-meter')?.shadowRoot;
        let ipcRuntimeInfo = null;
        if (typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
          try { ipcRuntimeInfo = await window.contextMeterAPI.getRuntimeInfo(); } catch {}
        }
        const bootBackend = window.__AGContextMeterBootBackend || null;
        const backendStatus = typeof window.__AGContextMeter?.getBackendStatusForTest === 'function'
          ? window.__AGContextMeter.getBackendStatusForTest()
          : null;
        const quotaState = typeof window.__AGContextMeter?.getModelQuotaStateForTest === 'function'
          ? window.__AGContextMeter.getModelQuotaStateForTest()
          : null;
        return {
          active: Boolean(window.__AGContextMeter),
          version: window.__AGContextMeter?.version || null,
          hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli && window.contextMeterAPI?.getContextUnlockStatus),
          hasQuotaIpcBridge: Boolean(window.contextMeterAPI?.getQuota),
          hasAccountsIpcBridge: Boolean(window.contextMeterAPI?.getAccountsOverview && window.contextMeterAPI?.accountsAction),
          hasRestartBridge: Boolean(window.contextMeterAPI?.restartHost),
          ipcBackendVersion: ipcRuntimeInfo?.backendVersion || bootBackend?.backendVersion || null,
          liveBridgeAttached: window.__AGContextMeterLive ? {
            version: window.__AGContextMeterLive.version || null,
            port: window.__AGContextMeterLive.port || null,
            backendSource: window.__AGContextMeterLive.backendSource || 'live-host'
          } : null,
          effectiveBackendSource: backendStatus?.backendSource || (ipcRuntimeInfo?.backendVersion ? 'electron-ipc' : null),
          effectiveBackendVersion: backendStatus?.backendVersion || quotaState?.state?.collectorVersion || ipcRuntimeInfo?.backendVersion || null,
          badgeText: root?.getElementById('amount')?.textContent || null,
          route: s?.route || null,
          latest: s?.latest || null
        };
      })()`, { timeoutMs: 4000 });
      return { running: true, cdpEnabled: true, cdpPort: port, pageFound: true, origin, origins, windowCount: matchedTargets.length, ...(status || {}) };
    } finally {
      client.close();
    }
  } catch (e) {
    const cdpFree = discoverHostOriginsWithoutCdp(options);
    if (cdpFree.runningWithoutCdp) {
      return {
        running: true,
        cdpEnabled: false,
        pageFound: false,
        origin: cdpFree.origins[0] || null,
        origins: cdpFree.origins,
        discoverySource: cdpFree.discoverySource,
        reason: 'cdp_not_enabled',
        error: e.message
      };
    }
    return { running: false, cdpEnabled: false, pageFound: false, origins: [], error: e.message };
  }
}

async function ensureLiveBridgeIfNeeded(liveSnapshot = null, options = {}) {
  const live = liveSnapshot || await queryLiveWindow(options);
  if (!live.running || !live.pageFound) {
    return { needed: false, ready: false, reason: 'no_running_window', liveInfo: null, previousLiveInfo: null };
  }
  let currentPkgVersion = null;
  try {
    currentPkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
  } catch {}

  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  const liveSessionPath = fs.existsSync(statePath) ? statePath : legacyPath;

  let existingInfo = null;
  if (fs.existsSync(liveSessionPath)) {
    try {
      existingInfo = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
    } catch {}
  }

  const expectedOrigins = Array.isArray(live.origins) && live.origins.length
    ? live.origins
    : (live.origin ? [live.origin] : []);

  // 绝不能因 hasIpcBridge && hasQuotaIpcBridge 为真就跳过后台版本检查：
  // 只有确认 Electron 主进程 IPC 后台本身已是目标版本且无旧 live-host 残留时，才无需外置 live-host。
  const electronIpcAligned = Boolean(
    live.hasIpcBridge &&
    live.hasQuotaIpcBridge &&
    live.hasAccountsIpcBridge &&
    currentPkgVersion &&
    live.ipcBackendVersion === currentPkgVersion
  );
  if (electronIpcAligned) {
    return {
      needed: false,
      ready: true,
      backendSource: 'electron-ipc',
      backendVersion: live.ipcBackendVersion,
      clearStaleLiveBridge: true,
      liveInfo: null,
      previousLiveInfo: existingInfo
    };
  }

  const coversAllOrigins = (info) => {
    if (!info) return false;
    const covered = new Set([...(Array.isArray(info.origins) ? info.origins : []), info.origin].filter(Boolean));
    return expectedOrigins.every(o => covered.has(o));
  };

  const expectedHostBuildId = getHostCoreBuildId(__dirname);
  if (existingInfo && existingInfo.pid) {
    const info = existingInfo;
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    const infoBuildMatch = !expectedHostBuildId || info.hostBuildId === expectedHostBuildId;
    if (pidAlive && coversAllOrigins(info) && info.hasQuota && (!currentPkgVersion || info.version === currentPkgVersion) && infoBuildMatch) {
      const probe = await probeLiveHostRuntimeInfo(info, expectedOrigins[0]);
      const probeBuildMatch = !expectedHostBuildId || probe?.hostBuildId === expectedHostBuildId;
      if (probe && probe.ok && probe.capabilities?.accounts && (!currentPkgVersion || probe.backendVersion === currentPkgVersion) && probeBuildMatch) {
        return {
          needed: true,
          ready: true,
          reused: true,
          backendSource: 'live-host',
          backendVersion: probe.backendVersion || info.version,
          liveInfo: { ...info, capabilities: probe.capabilities || info.capabilities },
          previousLiveInfo: null
        };
      }
    }
  }

  // 安全平滑启动新版 live-host：先写入 staging stamp 并验证 /runtime-info 健康，验证通过前绝不毁掉旧连接
  const stagingStamp = path.join(stateDir, `.live-session.staging.${process.pid}.${Date.now()}.json`);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp);
  } catch {}

  const liveRuntimeScript = path.join(stateDir, 'live-runtime', 'live-host.js');
  // 在从临时解压目录安装或升级前先同步持久化 live-runtime，避免触发进程删除临时目录后影响后台按需加载
  let syncedRuntimeDir = null;
  try {
    syncedRuntimeDir = syncLiveRuntimeBundle(__dirname, { version: currentPkgVersion, stateDir });
  } catch {}
  const hostEntryScript = (syncedRuntimeDir && fs.existsSync(liveRuntimeScript))
    ? liveRuntimeScript
    : (fs.existsSync(liveRuntimeScript) && !__dirname.toLowerCase().includes(os.tmpdir().toLowerCase())
      ? liveRuntimeScript
      : path.join(__dirname, 'live-host.js'));

  const childEnv = {
    ...process.env,
    ...(options.stateDir ? { AG_METER_STATE_DIR: stateDir } : {}),
    ...(options.appDataDir ? { APPDATA: options.appDataDir } : {}),
    AG_LIVE_STAMP_PATH: stagingStamp,
    ...(expectedOrigins.length ? { AG_LIVE_ORIGINS: JSON.stringify(expectedOrigins) } : {})
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const originsB64 = expectedOrigins.length
    ? Buffer.from(JSON.stringify(expectedOrigins), 'utf8').toString('base64')
    : '';
  const hostArgs = [hostEntryScript, '--stamp', stagingStamp];
  if (originsB64) hostArgs.push('--origins-b64', originsB64);

  let spawnedChild = null;
  let spawnedPid = null;
  let newInfo = null;
  try {
    const canBreakawayWmi = process.platform === 'win32'
      && process.env.AG_METER_TEST_MODE !== '1'
      && process.env.NODE_ENV !== 'test'
      && !process.env.AG_METER_STATE_DIR;
    if (canBreakawayWmi) {
      try {
        const { spawnSync } = require('child_process');
        const cmdLine = [process.execPath, ...hostArgs]
          .map(a => `"${String(a).replace(/"/g, '""')}"`)
          .join(' ');
        const psCmd = `
          $si = [CimInstance](New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly)
          $si.ShowWindow = 0
          $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = '${cmdLine.replace(/'/g, "''")}'
            CurrentDirectory = '${path.dirname(hostEntryScript).replace(/'/g, "''")}'
            ProcessStartupInformation = $si
          }
          if ($r.ReturnValue -eq 0 -and $r.ProcessId) { Write-Output $r.ProcessId }
        `;
        const wmiRes = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          windowsHide: true,
          timeout: 4000,
          encoding: 'utf8'
        });
        const parsedPid = Number(String(wmiRes.stdout || '').trim().split(/\r?\n/).pop());
        if (Number.isInteger(parsedPid) && parsedPid > 0) {
          spawnedPid = parsedPid;
        }
      } catch {}
    }
    if (!spawnedPid) {
      spawnedChild = spawn(process.execPath, hostArgs, {
        cwd: path.dirname(hostEntryScript),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv
      });
      spawnedChild.unref();
      spawnedPid = spawnedChild.pid || null;
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (!fs.existsSync(stagingStamp)) continue;
      try {
        const cand = JSON.parse(fs.readFileSync(stagingStamp, 'utf8'));
        if (cand && cand.pid && cand.port && cand.token) {
          process.kill(cand.pid, 0);
          const probe = await probeLiveHostRuntimeInfo(cand, cand.origin || expectedOrigins[0]);
          if (probe && probe.ok && (!currentPkgVersion || probe.backendVersion === currentPkgVersion)) {
            newInfo = {
              ...cand,
              version: probe.backendVersion || cand.version || currentPkgVersion,
              backendSource: 'live-host',
              capabilities: probe.capabilities || cand.capabilities || null,
              origins: probe.origins || cand.origins || expectedOrigins
            };
            break;
          }
        }
      } catch {}
    }
  } catch {}

  try { if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp); } catch {}

  if (!newInfo) {
    const killPid = spawnedPid || spawnedChild?.pid;
    if (killPid) {
      try { process.kill(killPid); } catch {}
    }
    return {
      needed: true,
      ready: false,
      reason: 'live_host_probe_failed',
      liveInfo: null,
      previousLiveInfo: existingInfo
    };
  }

  // 新服务已通过 /runtime-info 实测可用，原子切换正式 .live-session.json 并将旧实例留待注入后再关闭
  try {
    const tmpMain = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpMain, JSON.stringify(newInfo, null, 2));
    fs.renameSync(tmpMain, statePath);
  } catch {
    try { fs.writeFileSync(statePath, JSON.stringify(newInfo, null, 2)); } catch {}
  }

  const prevToShutdown = (existingInfo && existingInfo.pid && existingInfo.pid !== newInfo.pid)
    ? existingInfo
    : null;
  return {
    needed: true,
    ready: true,
    reused: false,
    backendSource: 'live-host',
    backendVersion: newInfo.version,
    liveInfo: newInfo,
    previousLiveInfo: prevToShutdown,
    statePath
  };
}

/**
 * 若本次新建了 live-host 但随后安装或窗口注入失败，关闭新建后台并还原 .live-session.json
 */
async function rollbackPreparedLiveBridge(bridgePrep) {
  if (!bridgePrep || bridgePrep.reused || !bridgePrep.liveInfo) return { rolledBack: false };
  const statePath = bridgePrep.statePath || path.join(getStateDir(), '.live-session.json');
  try {
    await shutdownLiveHostGracefully(bridgePrep.liveInfo);
  } catch {}
  try {
    if (bridgePrep.previousLiveInfo) {
      const tmpRestore = `${statePath}.rollback-${process.pid}`;
      fs.writeFileSync(tmpRestore, JSON.stringify(bridgePrep.previousLiveInfo, null, 2));
      fs.renameSync(tmpRestore, statePath);
    } else if (fs.existsSync(statePath)) {
      const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (cur && cur.pid === bridgePrep.liveInfo.pid) {
        fs.unlinkSync(statePath);
      }
    }
  } catch {}
  return { rolledBack: true };
}

/**
 * 免改盘后台守护模式 (node cli.js watch)
 * 复用现有 live-host 与 tryHotInjectDetailed 架构：等待宿主启动、页面刷新后自动恢复挂载、支持多窗口、关闭后自动清理退出。
 */
async function runWatchDaemon(options = {}) {
  const { loadModulesConfig } = require('./modules-config');
  const stateDir = options.stateDir || getStateDir();
  const rootDir = options.bundleDir ? path.resolve(options.bundleDir) : __dirname;
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const expectedScript = path.resolve(options.watchScript || __filename);
  const expectedVersion = options.expectedVersion || PROJECT_VERSION;
  const expectedRepo = options.expectedRepo || OFFICIAL_REPO;
  const rendererFilePath = path.join(rootDir, 'meter-renderer.js');

  const getRendererMtimeMs = () => {
    try {
      return fs.statSync(rendererFilePath).mtimeMs;
    } catch {
      return null;
    }
  };

  let activeRendererBuildId = options.expectedBuildId !== undefined
    ? options.expectedBuildId
    : getRendererBuildId(rendererFilePath);
  let activeBundleBuildId = options.expectedBuildId !== undefined
    ? options.expectedBuildId
    : (options.expectedBundleBuildId !== undefined ? options.expectedBundleBuildId : getWatchBundleBuildId(rootDir));
  const startupHostBuildId = getHostCoreBuildId(rootDir);
  const startedAtIso = new Date().toISOString();

  // 1. 单实例 PID 互斥锁与陈旧守护进程接管检查
  let replacedPid = null;
  const existingLock = readWatchLockInfo(stateDir);
  const existingPid = existingLock ? existingLock.pid : null;
  if (existingPid && existingPid !== process.pid && isPidAliveForUser(existingPid)) {
    const takeoverOpts = {
      ...options,
      stateDir,
      bundleDir: rootDir,
      watchScript: expectedScript,
      expectedVersion,
      expectedRepo,
      expectedBundleBuildId: activeBundleBuildId
    };
    if (shouldTakeOverWatchLock(existingLock, takeoverOpts)) {
      if (!options.silent) {
        console.log(`🔄 [Watch] 检测到旧版或异源守护进程 (PID ${existingPid})，正在安全接管...`);
      }
      await terminateProcessGracefully(existingPid, 2000);
      await stopLiveBridge({ stateDir });
      try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
      await new Promise(r => setTimeout(r, 60));
      replacedPid = existingPid;
    } else {
      if (!options.silent) {
        console.log(`ℹ️ [Watch] 已有运行中的守护进程 (PID ${existingPid})，本次实例自动退出。`);
      }
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const persistWatchLockAndMeta = () => {
    const rendererMtimeMs = getRendererMtimeMs();
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      script: expectedScript,
      version: expectedVersion,
      repo: expectedRepo,
      buildId: activeBundleBuildId,
      rendererBuildId: activeRendererBuildId
    }) + '\n', 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({
      pid: process.pid,
      script: expectedScript,
      version: expectedVersion,
      repo: expectedRepo,
      buildId: activeBundleBuildId,
      rendererBuildId: activeRendererBuildId,
      hostBuildId: startupHostBuildId,
      rendererMtimeMs,
      startedAt: startedAtIso,
      updatedAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
  };
  persistWatchLockAndMeta();

  const startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.AG_WATCH_STARTUP_TIMEOUT_MS || 60000);
  const startupPollMs = options.startupPollMs ?? Number(process.env.AG_WATCH_STARTUP_POLL_MS || 1000);
  const pollIntervalMs = options.pollIntervalMs ?? Number(process.env.AG_WATCH_POLL_MS || 3000);
  const maxConsecutiveMisses = options.maxConsecutiveMisses ?? Number(process.env.AG_WATCH_MAX_MISSES || 3);
  const maxCycles = options.maxCycles ?? Infinity;

  let stopped = false;
  let selfReloaded = false;
  let wakeSleep = null;
  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });

  const requestStop = () => {
    stopped = true;
    if (wakeSleep) wakeSleep();
  };

  const onSigInt = () => requestStop();
  const onSigTerm = () => requestStop();
  if (options.handleSignals !== false) {
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
  }
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    if (options.signal.aborted) requestStop();
    else options.signal.addEventListener('abort', requestStop, { once: true });
  }

  const cleanupLockfile = () => {
    try {
      if (readWatchPid(stateDir) === process.pid) {
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      }
    } catch {}
  };

  const startedAt = Date.now();
  let windowEverSeen = false;
  let consecutiveMisses = 0;
  let injectedCount = 0;
  let disposedCount = 0;
  let cycles = 0;
  let exitReason = 'stopped';
  let cdpRestartPrompted = false;
  let cdpPromptCount = 0;

  const discoverFn = typeof options._discoverWindow === 'function'
    ? options._discoverWindow
    : () => queryLiveWindow(options);
  const ensureBridgeFn = typeof options._ensureBridge === 'function'
    ? options._ensureBridge
    : (liveSnap) => ensureLiveBridgeIfNeeded(liveSnap, { ...options, stateDir });
  const hotInjectFn = typeof options._hotInject === 'function'
    ? options._hotInject
    : (injectOpts) => tryHotInjectDetailed({ ...options, ...injectOpts, stateDir });
  const hotDisposeFn = typeof options._hotDispose === 'function'
    ? options._hotDispose
    : () => tryHotDispose(options);

  try {
    while (!stopped && cycles < maxCycles) {
      cycles++;

      const currentHostBuildId = getHostCoreBuildId(rootDir);
      const currentRendererBuildId = options.expectedBuildId !== undefined
        ? options.expectedBuildId
        : getRendererBuildId(rendererFilePath);
      const currentBundleBuildId = options.expectedBuildId !== undefined
        ? options.expectedBuildId
        : (options.expectedBundleBuildId !== undefined ? options.expectedBundleBuildId : getWatchBundleBuildId(rootDir));

      if (startupHostBuildId && currentHostBuildId && currentHostBuildId !== startupHostBuildId) {
        const isTestEnv = process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
        const shouldSelfReload = options.selfReloadOnHostChange === true ||
          (!isTestEnv && options.selfReloadOnHostChange !== false && maxCycles === Infinity);
        if (shouldSelfReload) {
          if (!options.silent) {
            console.log(`🔄 [Watch] 检测到核心宿主脚本已更新 (${startupHostBuildId} -> ${currentHostBuildId})，正在热重启守护进程...`);
          }
          await stopLiveBridge({ stateDir });
          cleanupLockfile();
          const reloadArgs = [expectedScript, 'watch'];
          if (options.port) reloadArgs.push('--port', String(options.port));
          const reloadSpawner = options._spawnSelfReload || spawn;
          const child = reloadSpawner(process.execPath, reloadArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, AG_METER_STATE_DIR: stateDir }
          });
          child?.unref?.();
          selfReloaded = true;
          exitReason = 'host_bundle_reloaded';
          break;
        }
      }

      if (currentRendererBuildId !== activeRendererBuildId || currentBundleBuildId !== activeBundleBuildId) {
        activeRendererBuildId = currentRendererBuildId;
        activeBundleBuildId = currentBundleBuildId;
        persistWatchLockAndMeta();
      }

      const live = await discoverFn();
      const hasWindow = Boolean(live && live.running && live.pageFound);

      if (!hasWindow) {
        if (live && live.running && live.cdpEnabled === false && !cdpRestartPrompted) {
          cdpRestartPrompted = true;
          cdpPromptCount++;
          if (!options.silent) {
            const guidance = buildManualCdpRestartGuidance(options.customPath || null, options);
            for (const line of guidance.lines) {
              console.log(line);
            }
          }
        }
        if (!windowEverSeen) {
          if (Date.now() - startedAt >= startupTimeoutMs) {
            exitReason = (live && live.running && live.cdpEnabled === false) ? 'cdp_not_enabled' : 'startup_timeout';
            break;
          }
          await sleep(startupPollMs);
          continue;
        }

        consecutiveMisses++;
        if (consecutiveMisses >= maxConsecutiveMisses) {
          exitReason = 'window_closed';
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      windowEverSeen = true;
      cdpRestartPrompted = false;
      consecutiveMisses = 0;

      let meterEnabled = true;
      try {
        const cfg = loadModulesConfig({ stateDir });
        if (cfg?.modules?.meter?.enabled === false) {
          meterEnabled = false;
        }
      } catch {}

      if (!meterEnabled) {
        const didDispose = await hotDisposeFn();
        if (didDispose) disposedCount++;
        await stopLiveBridge({ stateDir });
      } else {
        const expectedOrigins = Array.isArray(live.origins) && live.origins.length
          ? live.origins
          : (live.origin ? [live.origin] : []);
        let coveredByLiveSession = false;
        try {
          const lp = path.join(stateDir, '.live-session.json');
          if (fs.existsSync(lp)) {
            const info = JSON.parse(fs.readFileSync(lp, 'utf8'));
            const covered = new Set([...(Array.isArray(info?.origins) ? info.origins : []), info?.origin].filter(Boolean));
            coveredByLiveSession = Boolean(
              info?.pid &&
              isPidAliveForUser(info.pid) &&
              info?.version === expectedVersion &&
              expectedOrigins.every(o => covered.has(o))
            );
          }
        } catch {}

        const needsBridge = Boolean(
          (!live.hasIpcBridge || live.ipcBackendVersion !== expectedVersion) &&
          (!coveredByLiveSession || !live.liveBridgeAttached || live.liveBridgeAttached.version !== expectedVersion)
        );
        const needsInject = Boolean(
          !live.active ||
          live.version !== expectedVersion ||
          (live.effectiveBackendVersion && live.effectiveBackendVersion !== expectedVersion) ||
          needsBridge
        );

        if (needsBridge || needsInject) {
          const bridgePrep = await ensureBridgeFn(live);
          const report = await hotInjectFn({
            source: 'cli-watch',
            liveInfo: bridgePrep?.liveInfo || null,
            liveVerified: Boolean(bridgePrep?.ready && bridgePrep?.liveInfo),
            preferLiveHost: Boolean(bridgePrep?.ready && bridgePrep?.backendSource === 'live-host'),
            clearStaleLiveBridge: Boolean(bridgePrep?.clearStaleLiveBridge)
          });
          if (report?.ok) {
            injectedCount += Number(report.injectedCount || 1);
            if (bridgePrep?.previousLiveInfo) {
              await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
            }
          } else if (bridgePrep && !bridgePrep.reused && bridgePrep.liveInfo) {
            await rollbackPreparedLiveBridge(bridgePrep);
          }
        }
      }

      if (cycles >= maxCycles) {
        exitReason = 'max_cycles';
        break;
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    if (options.handleSignals !== false) {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    }
    if (!selfReloaded) {
      if (exitReason === 'window_closed' || exitReason === 'stopped' || exitReason === 'startup_timeout' || exitReason === 'cdp_not_enabled') {
        await stopLiveBridge({ stateDir });
      }
      cleanupLockfile();
    }
  }

  return {
    ok: true,
    pid: process.pid,
    replacedPid,
    exitReason,
    cycles,
    injectedCount,
    disposedCount,
    cdpPromptCount,
    selfReloaded
  };
}

/**
 * 停止正在运行的 watch 守护进程与 live-host 桥接进程 (node cli.js stop-watch)
 */
async function stopWatchDaemon(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const watchPid = readWatchPid(stateDir);
  let watchStopped = false;

  if (watchPid && isPidAliveForUser(watchPid)) {
    watchStopped = await terminateProcessGracefully(watchPid, 2500);
  }
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {}
  try {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {}

  const bridgeRes = await stopLiveBridge({ stateDir });
  return {
    ok: true,
    watchStopped,
    watchPid: watchPid || null,
    liveBridgeStopped: bridgeRes.stopped,
    liveBridgePid: bridgeRes.pid
  };
}

async function cmdStatus(customPath, cdpOptions = {}) {
  let asarPath = null;
  let version = null;
  let asarPatched = false;
  let diskVersion = null;
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
  } catch {}
  try {
    asarPath = findAsarPath(customPath);
    version = JSON.parse(extractAsarFile(asarPath, 'package.json').toString('utf8')).version;
    const utilsSource = extractAsarFile(asarPath, 'dist/utils.js').toString('utf8');
    asarPatched = utilsSource.includes('installContextMeter(win)');
    try {
      const manifestRaw = extractAsarFile(asarPath, 'dist/meter-manifest.json');
      const mObj = JSON.parse(manifestRaw.toString('utf8'));
      if (mObj?.version) diskVersion = mObj.version;
    } catch {}
    if (!diskVersion && asarPatched) {
      const mPath = path.join(getStateDir(), 'installation.json');
      if (fs.existsSync(mPath)) {
        const inst = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        if (inst?.meterVersion) diskVersion = inst.meterVersion;
      }
    }
  } catch {}

  const live = await queryLiveWindow(cdpOptions);
  let liveSessionInfo = null;
  try {
    const lp = path.join(getStateDir(), '.live-session.json');
    if (fs.existsSync(lp)) {
      const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
      liveSessionInfo = { port: raw.port, pid: raw.pid, version: raw.version, backendSource: raw.backendSource || 'live-host', origins: raw.origins || (raw.origin ? [raw.origin] : []) };
    }
  } catch {}
  const watchPid = readWatchPid();
  const py = resolvePython();
  const report = {
    pluginVersion,
    diskVersion: diskVersion || null,
    asarPath,
    antigravityVersion: version,
    asarPatched,
    watcherRunning: Boolean(watchPid && isPidAliveForUser(watchPid)),
    watcherPid: (watchPid && isPidAliveForUser(watchPid)) ? watchPid : null,
    versions: {
      diskVersion: diskVersion || null,
      rendererVersion: live.version || null,
      ipcBackendVersion: live.ipcBackendVersion || null,
      liveHostVersion: liveSessionInfo?.version || null,
      effectiveBackendSource: live.effectiveBackendSource || live.liveBridgeAttached?.backendSource || null,
      effectiveBackendVersion: live.effectiveBackendVersion || live.liveBridgeAttached?.version || null
    },
    liveSession: liveSessionInfo,
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function cmdCheck(customPath, cdpOptions = {}) {
  let pluginVersion = 'unknown';
  try {
    pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
  } catch {}
  console.log(`🔍 [Antigravity 对话上下文查看器 v${pluginVersion}] 正在执行环境预检...`);
  console.log(`  - Node.js 运行时: ${process.version} (${process.execPath})`);
  try {
    const asarPath = findAsarPath(customPath);
    const version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    console.log(`  - Antigravity 路径: ${asarPath} (v${version})`);
  } catch (e) {
    console.error(`  ❌ Antigravity 路径探测失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const py = resolvePython();
  console.log(`  - Python 附件深度解析器: ${py || '未检测到（基础上下文统计不受影响）'}`);
  const live = await queryLiveWindow(cdpOptions);
  if (live.running && live.cdpEnabled !== false) {
    console.log(`  - 运行中窗口 CDP 状态: 已连接 (端口 ${live.cdpPort})`);
  } else if (live.running && live.cdpEnabled === false) {
    console.log(`  - 运行中窗口状态: 已检测到运行中 Antigravity (免 CDP 来源: ${live.discoverySource || 'host'}，未开启调试端口)`);
    const guidance = buildManualCdpRestartGuidance(customPath, cdpOptions);
    console.log(`  - 如需使用免改盘 live/watch，请手动重启客户端: ${guidance.command}`);
  } else {
    console.log('  - 运行中窗口 CDP 状态: 客户端未运行或未开启调试端口');
  }
  console.log('✅ 环境预检通过！');
}

async function runLiveCommand(cdpOptions = {}, customPath = null) {
  const queryFn = typeof cdpOptions._queryLiveWindow === 'function' ? cdpOptions._queryLiveWindow : queryLiveWindow;
  const liveBefore = await queryFn(cdpOptions);
  if (liveBefore.running && liveBefore.cdpEnabled === false && !liveBefore.pageFound) {
    const guidance = buildManualCdpRestartGuidance(customPath, cdpOptions);
    const err = new Error(guidance.lines.join('\n'));
    err.code = 'CDP_NOT_ENABLED';
    err.guidance = guidance;
    throw err;
  }
  const bridgePrep = typeof cdpOptions._ensureBridge === 'function'
    ? await cdpOptions._ensureBridge(liveBefore, cdpOptions)
    : await ensureLiveBridgeIfNeeded(liveBefore, cdpOptions);
  let report;
  try {
    report = typeof cdpOptions._hotInject === 'function'
      ? await cdpOptions._hotInject({
          ...cdpOptions,
          source: 'cli-live',
          liveInfo: bridgePrep.liveInfo || null,
          liveVerified: Boolean(bridgePrep.ready && bridgePrep.liveInfo),
          preferLiveHost: Boolean(bridgePrep.ready && bridgePrep.backendSource === 'live-host'),
          clearStaleLiveBridge: Boolean(bridgePrep.clearStaleLiveBridge)
        })
      : await tryHotInjectDetailed({
          ...cdpOptions,
          source: 'cli-live',
          liveInfo: bridgePrep.liveInfo || null,
          liveVerified: Boolean(bridgePrep.ready && bridgePrep.liveInfo),
          preferLiveHost: Boolean(bridgePrep.ready && bridgePrep.backendSource === 'live-host'),
          clearStaleLiveBridge: Boolean(bridgePrep.clearStaleLiveBridge)
        });
  } catch (liveErr) {
    await rollbackPreparedLiveBridge(bridgePrep);
    throw liveErr;
  }
  if (!report.ok) {
    await rollbackPreparedLiveBridge(bridgePrep);
    if (report.reason === 'cdp_not_enabled') {
      const guidance = buildManualCdpRestartGuidance(customPath, cdpOptions);
      const err = new Error(guidance.lines.join('\n'));
      err.code = 'CDP_NOT_ENABLED';
      err.guidance = guidance;
      throw err;
    }
    throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js watch。');
  }
  if (bridgePrep.previousLiveInfo) {
    await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
  }
  return report;
}

const CLI_VALUE_FLAGS = new Set([
  '--path', '--backup', '--port', '--proxy-url',
  '--mode', '--limit', '--tier', '--title', '--context', '--brand', '--lang',
  '--account', '-a', '--model', '--session', '--cwd', '--interval', '--cli-path',
  '--ag-dir', '--cli-dir', '--state-dir'
]);

const CLI_BOOLEAN_FLAGS = new Set([
  '--force', '--all', '--cli', '--no-cli-sync', '--no-sync', '--previous', '--in-place',
  '--today', '--week', '--month', '--json', '--compact', '--once', '--dry-run',
  '--clear', '--sync-cli-settings'
]);

const CLI_KNOWN_COMMANDS = new Set([
  'install', 'live', 'watch', 'stop-watch', 'restore', 'uninstall',
  'unlock-status', 'unlock', 'unlock-restore',
  'enhance-status', 'enhance', 'enhance-restore',
  'modules', 'chinese:enable', 'chinese:disable',
  'proxy:enable', 'proxy:disable', 'proxy:set', 'proxy:test',
  'usage', 'monitor', 'launch-cli', 'context-set', 'context-status',
  'status', 'check'
]);

const CLI_POS_ARG_COMMANDS = new Set(['proxy:set', 'proxy:test']);

function printUsage() {
  console.log(`用法:
  node cli.js usage [--today|--week|--month|--all] [--account <q>] [--model <q>] [--json]
                                            在终端只读查询累计 Token 消耗 (口径与面板一致)
  node cli.js monitor [--session <id>] [--cwd <dir>] [--compact] [--interval <ms>] [--once] [--json]
                                            终端常驻监视 CLI 会话上下文与用量 (独立于桌面客户端)
  node cli.js launch-cli [--account <email>] [--model <id>] [--cwd <dir>] [--dry-run] [--json]
                                            以指定账号独立启动 agy CLI（凭据隔离，不覆盖桌面客户端）
  node cli.js context-set --model <id> --mode <default|fixed|dynamic> [--limit N] [--clear] [--sync-cli-settings]
                                            配置 CLI 按模型自定义上下文偏好
  node cli.js context-status [--model <id>] [--json]
                                            查看 CLI 按模型上下文偏好与二进制门禁状态
  node cli.js watch [--port <port>]         免改盘后台守护模式（随客户端启动自动挂载，关闭后自动退出）
  node cli.js stop-watch                    停止正在运行的 watch 守护进程与本地桥接服务
  node cli.js live [--port <port>]          免改盘 CDP 热挂载到当前运行窗口
  node cli.js install [--path <app.asar>]   一键持久化安装并热注入当前运行窗口
  node cli.js status [--port <port>]        查看安装状态与当前对话实时上下文用量
  node cli.js check [--port <port>]         执行前置环境健康检查
  node cli.js restore [--all]               一键无损卸载并恢复备份 (--all 含还原内核增强)
  node cli.js unlock-status [--cli] [--path <bin>]  检查桌面端与 agy CLI 上下文调整状态
  node cli.js unlock [--cli] --mode <default|fixed|dynamic> [--limit N]  调整上下文长度上限
  node cli.js unlock-restore [--cli] [--path <bin>] 恢复官方原版二进制
  node cli.js enhance-status                检查系统提示词精简与中文标题内核状态
  node cli.js enhance [--tier 0-4] [--title on|off] [--context default|512k|900k|dynamic] [--lang zh-CN|en] [--brand english|hidden|translated]
  node cli.js enhance-restore               一键还原系统提示词、英文标题与默认上下文`);
}

/**
 * 严格解析 CLI 参数：遇到 --help / -h 或任何未知命令/未知参数时立即返回帮助状态与非 0 退出码，绝不回落至 install 写盘或热注入。
 */
function parseCliArgs(args = []) {
  let cmd = null;
  let positionalExtraCount = 0;

  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] ?? '');
    if (a === '--help' || a === '-h') {
      return { cmd: 'help', showHelp: true, exitCode: 1, reason: 'help', unknownArg: null };
    }
    if (a.startsWith('-')) {
      if (CLI_VALUE_FLAGS.has(a)) {
        if (i + 1 >= args.length) {
          return { cmd: 'unknown', showHelp: true, exitCode: 1, reason: 'missing_value', unknownArg: a };
        }
        i++;
        continue;
      }
      if (CLI_BOOLEAN_FLAGS.has(a)) {
        continue;
      }
      return { cmd: 'unknown', showHelp: true, exitCode: 1, reason: 'unknown_flag', unknownArg: a };
    }
    if (!cmd) {
      const lower = a.toLowerCase();
      if (!CLI_KNOWN_COMMANDS.has(lower)) {
        return { cmd: 'unknown', showHelp: true, exitCode: 1, reason: 'unknown_command', unknownArg: a };
      }
      cmd = lower;
      continue;
    }
    if (CLI_POS_ARG_COMMANDS.has(cmd) && positionalExtraCount === 0) {
      positionalExtraCount++;
      continue;
    }
    return { cmd: 'unknown', showHelp: true, exitCode: 1, reason: 'unexpected_arg', unknownArg: a };
  }

  return { cmd: cmd || 'install', showHelp: false, exitCode: 0, reason: null, unknownArg: null };
}

async function main() {
  const args = process.argv.slice(2);
  const parsedArgs = parseCliArgs(args);
  if (parsedArgs.showHelp) {
    if (parsedArgs.unknownArg) {
      console.error(`❌ 未知或无效参数: ${parsedArgs.unknownArg}`);
    }
    printUsage();
    process.exitCode = parsedArgs.exitCode || 1;
    return;
  }
  const cmd = parsedArgs.cmd;
  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;
  const backupIdx = args.indexOf('--backup');
  const customBackup = backupIdx >= 0 ? args[backupIdx + 1] : null;
  const portIdx = args.indexOf('--port');
  const explicitPort = portIdx >= 0 ? parseExplicitPort(args[portIdx + 1]) : null;
  if (portIdx >= 0 && !explicitPort) {
    throw new Error(`无效的 --port 参数: ${args[portIdx + 1]}`);
  }
  const cdpOptions = explicitPort ? { port: explicitPort, strictPort: true } : {};
  const isForce = args.includes('--force');
  const isCliTarget = args.includes('--cli');

  const resolveUnlockCliOrCustomTarget = () => {
    if (customPath) return customPath;
    if (!isCliTarget) return null;
    const cliBin = detectCliBinary(null);
    if (!cliBin) {
      throw new Error('未检测到 Antigravity CLI (agy) 可执行文件，请使用 --path <bin> 显式指定或将 agy 加入 PATH。');
    }
    return cliBin;
  };

  const printUnlockStatusBlock = (st, headerLabel) => {
    console.log(headerLabel);
    console.log(`- 目标文件: ${st.targetPath || '未检测到'}`);
    console.log(`- 目标架构: ${st.arch || '未知'} (${st.format || '未知'}, ${st.mode || '未知'})`);
    console.log(`- 磁盘模式: ${st.configuredSummary || '未知'}`);
    console.log(`- 运行状态: [${st.statusText || st.status}] ${st.details || st.reason || ''}`);
    if (st.scopeNotice) console.log(`- 作用范围: ${st.scopeNotice}`);
    if (st.backupInfo) {
      console.log(`- 备份文件: ${st.backupInfo.backupPath}${st.backupStaleReason ? ` (⚠️ ${st.backupStaleReason})` : ''}`);
    }
    console.log(`- ${st.author?.credit || AUTHOR_INFO.credit} (${st.author?.url || AUTHOR_INFO.url})`);
  };

  if (cmd === 'install') {
    const meterVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`🚀 [Antigravity 对话上下文查看器 v${meterVersion}] 正在安装上下文可视化组件...`);
    const liveBefore = await queryLiveWindow(cdpOptions);
    const bridgePrep = await ensureLiveBridgeIfNeeded(liveBefore, cdpOptions);
    const hotInjectOptions = {
      ...cdpOptions,
      source: 'cli-install',
      liveInfo: bridgePrep.liveInfo || null,
      liveVerified: Boolean(bridgePrep.ready && bridgePrep.liveInfo),
      preferLiveHost: Boolean(bridgePrep.ready && bridgePrep.backendSource === 'live-host'),
      clearStaleLiveBridge: Boolean(bridgePrep.clearStaleLiveBridge)
    };
    let manifest;
    try {
      manifest = await install({ path: customPath, backup: customBackup, force: isForce, hotInjectOptions });
    } catch (installErr) {
      await rollbackPreparedLiveBridge(bridgePrep);
      throw installErr;
    }

    if (manifest.liveInjected && bridgePrep.previousLiveInfo) {
      await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
    } else if (!manifest.liveInjected) {
      await rollbackPreparedLiveBridge(bridgePrep);
    }

    const reportBackendVersion = manifest.hotInjectReport?.backendVersion || bridgePrep.backendVersion || null;
    const reportBackendSource = manifest.hotInjectReport?.backendSource || bridgePrep.backendSource || null;
    const backendAligned = Boolean(
      manifest.liveInjected &&
      reportBackendVersion === meterVersion
    );
    const hasStaleMainProcess = Boolean(
      manifest.liveInjected &&
      !backendAligned &&
      liveBefore.running &&
      liveBefore.hasIpcBridge
    );
    console.log(`✅ 插件 v${manifest.meterVersion} 安装完成 (Antigravity 宿主 v${manifest.version})`);
    console.log(`✅ ASAR 持久化注入完成: ${manifest.installed} (校验 ${manifest.originalFilesVerified} 个原文件)`);
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules(manifest.installed);
    console.log('📦 模块状态分层报告:');
    console.log('   - ⚡ 上下文与 Token 监控:');
    console.log(`     * 配置状态: [配置: ${cfg.modules.meter.enabled ? '已开启' : '已关闭'}]`);
    console.log(`     * 磁盘注入: ${disk.meter ? '✅ 已注入' : '⚪ 未注入'} (磁盘版本 v${manifest.meterVersion})`);
    if (manifest.liveInjected && backendAligned) {
      console.log(`     * 运行中加载: ✅ 界面与后台已同步热加载为 v${meterVersion} (${reportBackendSource === 'live-host' ? '外置 Live-Host 接管，无需重启' : 'Electron IPC 已对齐，无需重启'})`);
    } else if (manifest.liveInjected) {
      console.log(`     * 运行中加载: ⚠️ 界面已热挂载为 v${meterVersion}，但当前后台仍为旧版 (${reportBackendVersion || liveBefore.version || '未知'}，请重启客户端以加载新版主进程模块)`);
    } else {
      console.log('     * 运行中加载: ⏳ 未连接到支持热挂载的运行中窗口（如客户端未使用调试端口启动），请重启客户端后生效');
    }

    console.log('   - 🇨🇳 客户端界面汉化 (桌面客户端):');
    console.log(`     * 配置状态: [配置: ${cfg.modules.chinese.enabled ? '已开启' : '已关闭'}]`);
    console.log(`     * 磁盘组件: ${disk.chineseReady ? '✅ 已注入（支持配置门禁与离线切换）' : (disk.chinese ? '⚠️ 磁盘注入不完整' : '⚪ 未注入')}`);
    console.log(`     * 生效说明: ${cfg.modules.chinese.enabled ? '⏳ 重启 Antigravity 客户端后加载中文' : '⚪ 默认保持官方原生英文，可在客户端面板中随时开启并重启生效'}`);

    console.log('   - 🌐 免 TUN 网络直连 (本地代理):');
    console.log(`     * 配置状态: [配置: ${cfg.modules.proxy.enabled ? '已开启' : '已关闭'}] (代理: ${redactProxyUrl(cfg.modules.proxy.proxyUrl) || '未配置'})`);
    console.log(`     * 磁盘组件: ${disk.proxyReady ? '✅ 已注入（支持 Session 代理与环境变量拦截）' : (disk.proxy ? '⚠️ 磁盘注入不完整' : '⚪ 未注入')}`);
    console.log(`     * 生效说明: ${cfg.modules.proxy.enabled ? '🔍 需通过 node cli.js proxy:test 测试连通性' : '⚪ 跟随系统默认网络栈，可在客户端面板中随时配置并开启'}`);
    console.log(`     * 模型请求验证: 待通过真实在线会话验证 (分层标定，未发送请求前不宣称生效)`);
    console.log(`✅ 运行中窗口热挂载状态: ${manifest.liveInjected ? (backendAligned ? '已即时生效（无需重启）' : '界面已挂载但后台需重启对齐') : '将在下次启动 Antigravity 时自动生效'}`);
    if (process.env.AG_EMIT_INSTALL_META === '1') {
      console.log('__AG_INSTALL_META__=' + JSON.stringify({
        meterVersion: manifest.meterVersion,
        liveInjected: Boolean(manifest.liveInjected),
        backendHotReloaded: Boolean(backendAligned),
        backendVersion: reportBackendVersion,
        backendSource: reportBackendSource,
        hasStaleMainProcess,
        hotInjectReport: manifest.hotInjectReport || null
      }));
    }
  } else if (cmd === 'live') {
    const report = await runLiveCommand(cdpOptions, customPath);
    console.log(`✅ 已通过 CDP 热注入当前运行的 ${report.injectedCount}/${report.windowCount} 个 Antigravity 窗口！`);
  } else if (cmd === 'watch') {
    console.log('👀 [Antigravity 对话上下文查看器] 免改盘守护模式启动中（不修改 app.asar，保留官方原始签名）...');
    const res = await runWatchDaemon(cdpOptions);
    if (!res.alreadyRunning && !res.selfReloaded) {
      console.log(`👋 守护模式已停止 (${res.exitReason})，已清理临时桥接状态。`);
    }
  } else if (cmd === 'stop-watch') {
    const res = await stopWatchDaemon();
    if (res.watchStopped || res.liveBridgeStopped) {
      console.log(`✅ 已停止守护进程与本地桥接服务 (watch: ${res.watchStopped ? res.watchPid : '未运行'}, live-host: ${res.liveBridgeStopped ? res.liveBridgePid : '未运行'})`);
    } else {
      console.log('ℹ️ 当前没有正在运行的 watch 或 live-host 进程。');
    }
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    const restoreAll = args.includes('--all');
    await stopWatchDaemon();
    const res = await restore({ path: customPath, force: isForce, ...cdpOptions });
    console.log(`✅ 已完成卸载还原: ${res.restored}`);
    if (restoreAll) {
      try {
        const { restoreAllEnhance } = require('./meter-enhance');
        const eRes = restoreAllEnhance({});
        if (eRes.ok) {
          console.log('✅ 已同步恢复内核系统提示词、中文标题及上下文默认状态！');
        } else {
          console.log(`⚠️  内核还原部分未执行: ${eRes.error}`);
        }
      } catch (e) {
        console.log(`⚠️  内核还原异常: ${e.message}`);
      }
    }
    console.log('📦 模块清理与运行时状态说明:');
    console.log(`   - 磁盘处理方式: ${res.inPlaceCleaned ? '原位手术刀精准解构（保留宿主第三方修改）' : '官方原版备份整包还原'}`);
    console.log('   - 磁盘清理状态:');
    console.log('     * ⚡ 上下文与 Token 监控: 磁盘代码已移除');
    console.log('     * 🇨🇳 客户端界面汉化: 磁盘注入已移除');
    console.log('     * 🌐 免 TUN 网络直连: 磁盘代理拦截已移除');
    console.log('   - 运行中残留与重启说明:');
    console.log(`     * 上下文监控: ${res.hotDisposed ? '已通过 CDP 即时销毁运行实例' : '运行实例需重启客户端彻底清理'}`);
    console.log('     * 界面汉化: 运行中已渲染 DOM 受客户端页面内存缓存影响，需完全重启客户端彻底恢复纯净英文');
    console.log('     * 代理环境: 运行中进程已加载的 process.env 环境变量与 Electron session 代理无法即时热撤销，必须完全重启客户端以彻底退出代理环境');
  } else if (cmd === 'unlock-status') {
    const explicitTarget = resolveUnlockCliOrCustomTarget();
    if (explicitTarget) {
      const header = isCliTarget && !customPath
        ? '🔍 正在检测 Antigravity CLI (agy) 上下文调整状态...'
        : '🔍 正在检测 Antigravity 后端上下文调整状态...';
      const st = await analyzeBinaryAsync(explicitTarget);
      printUnlockStatusBlock(st, header);
    } else {
      const st = await analyzeBinaryAsync(null);
      printUnlockStatusBlock(st, '🔍 正在检测 Antigravity 后端上下文调整状态...');
      const cliBin = detectCliBinary(null);
      if (cliBin && (!st.targetPath || path.resolve(cliBin) !== path.resolve(st.targetPath))) {
        const cliSt = await analyzeBinaryAsync(cliBin);
        console.log('');
        printUnlockStatusBlock(cliSt, '🔍 检测到 Antigravity CLI (agy) 独立可执行文件:');
        console.log('  💡 可通过 `node cli.js unlock --cli --mode ...` / `unlock-restore --cli` 单独管理 CLI');
      }
    }
  } else if (cmd === 'unlock') {
    const modeIdx = args.indexOf('--mode');
    const modeVal = modeIdx >= 0 ? args[modeIdx + 1] : undefined;
    const limitIdx = args.indexOf('--limit');
    const limitVal = limitIdx >= 0 ? args[limitIdx + 1] : undefined;
    const noCliSync = args.includes('--no-cli-sync') || args.includes('--no-sync');
    const targetBin = resolveUnlockCliOrCustomTarget();
    console.log(`⚡ 正在执行 ${isCliTarget && !customPath ? 'Antigravity CLI (agy)' : 'Antigravity 后端'}上下文长度调整...`);
    console.log(`ℹ ${AUTHOR_INFO.credit} (${AUTHOR_INFO.url})`);
    console.log(`⚠️  ${AUTHOR_INFO.disclaimer}`);
    const res = applyUnlock({ targetPath: targetBin, mode: modeVal, limitTokens: limitVal, syncConfigFiles: true, syncCliConfigs: !noCliSync });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '调整完成！'}`);
    if (res.warnings?.length) {
      for (const w of res.warnings) console.log(`⚠️  ${w}`);
    }
    if (res.backupPath) console.log(`📁 原版备份已安全保存至: ${res.backupPath}`);
  } else if (cmd === 'unlock-restore') {
    const noCliSync = args.includes('--no-cli-sync') || args.includes('--no-sync');
    const targetBin = resolveUnlockCliOrCustomTarget();
    console.log(`🔄 正在恢复 ${isCliTarget && !customPath ? 'Antigravity CLI (agy)' : 'Antigravity 官方原版'}二进制...`);
    const res = restoreUnlock({ targetPath: targetBin, syncConfigFiles: true, syncCliConfigs: !noCliSync });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '恢复完成！'}`);
  } else if (cmd === 'enhance-status') {
    const { getEnhanceStatus } = require('./meter-enhance');
    const st = getEnhanceStatus();
    console.log(JSON.stringify(st, null, 2));
  } else if (cmd === 'enhance') {
    const { applyEnhancePatch } = require('./meter-enhance');
    const getFlag = (flag) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const tierVal = getFlag('--tier');
    const titleVal = getFlag('--title');
    const ctxVal = getFlag('--context');
    const limitVal = getFlag('--limit');
    const brandVal = getFlag('--brand');
    const langVal = getFlag('--lang');
    if (brandVal || langVal) {
      const { loadModulesConfig, saveModulesConfig, normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
      const cfg = loadModulesConfig();
      if (langVal) {
        const nl = normalizeClientLanguage(langVal, cfg.modules.chinese.enabled);
        cfg.modules.chinese.language = nl;
        cfg.modules.chinese.enabled = nl === 'zh-CN';
      }
      if (brandVal) {
        cfg.modules.chinese.brandTitle = normalizeBrandTitle(brandVal);
      }
      cfg.modules.chinese.lastUpdated = new Date().toISOString();
      saveModulesConfig(cfg);
      console.log(`✅ 已更新界面语言/品牌配置: language=${cfg.modules.chinese.language}, brandTitle=${cfg.modules.chinese.brandTitle}（重启客户端后生效）`);
    }
    if (tierVal !== undefined || titleVal !== undefined || ctxVal !== undefined) {
      const res = applyEnhancePatch({
        promptTier: tierVal,
        chineseTitle: titleVal,
        contextMode: ctxVal,
        contextLimitTokens: limitVal ? Number(limitVal) : undefined
      });
      if (!res.ok) throw new Error(res.error);
      for (const l of (res.logs || [])) console.log('  ', l);
      console.log('✅ 内核增强应用完成！');
    }
  } else if (cmd === 'enhance-restore') {
    const { restoreAllEnhance } = require('./meter-enhance');
    const res = restoreAllEnhance({});
    if (!res.ok) throw new Error(res.error);
    console.log('✅ 已还原官方原版系统提示词、英文会话标题与默认上下文上限！');
  } else if (cmd === 'modules') {
    const { loadModulesConfig, detectAndMigrateLegacyConfigs } = require('./modules-config');
    const cfg = loadModulesConfig();
    const asarPath = findAsarPath(customPath);
    let asarUtils = '';
    let asarPreload = '';
    try {
      asarUtils = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
      asarPreload = asar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    } catch {}

    console.log('📦 [Antigravity 统一模块状态总览]');
    console.log('1. 上下文与 Token 监控 (ContextMeter):');
    console.log(`   - 配置状态: ${cfg.modules.meter.enabled ? '🟢 已启用' : '⚪ 已禁用'}`);
    console.log(`   - 磁盘注入: ${asarUtils.includes('installContextMeter') ? '✅ 已注入' : '⚪ 未注入'}`);

    console.log('2. 客户端界面汉化 (Chinese Desktop):');
    console.log(`   - 配置状态: ${cfg.modules.chinese.enabled ? '🟢 已启用' : '⚪ 已禁用'}`);
    console.log(`   - 磁盘注入: ${asarPreload.includes('Antigravity Chinese Localization') ? '✅ 已注入' : '⚪ 未注入'}`);
    if (cfg.modules.chinese.migratedFrom) {
      console.log(`   - 迁移来源: ${cfg.modules.chinese.migratedFrom}`);
    }

    console.log('3. 免 TUN 网络直连 (ProxyNoTun):');
    console.log(`   - 配置状态: ${cfg.modules.proxy.enabled ? '🟢 已启用' : '⚪ 已禁用'}`);
    console.log(`   - 代理地址: ${cfg.modules.proxy.proxyUrl || '未配置'}`);
    console.log(`   - 绕过列表: ${cfg.modules.proxy.bypassList || '默认'}`);
    console.log(`   - 磁盘注入: ${asarUtils.includes('Antigravity Proxy NoTun') ? '✅ 已注入' : '⚪ 未注入'}`);
    if (cfg.modules.proxy.migratedFrom) {
      console.log(`   - 迁移来源: ${cfg.modules.proxy.migratedFrom}`);
    }
  } else if (cmd === 'chinese:enable' || cmd === 'chinese:disable') {
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    const enable = cmd === 'chinese:enable';
    cfg.modules.chinese.enabled = enable;
    cfg.modules.chinese.language = enable ? 'zh-CN' : 'en';
    cfg.modules.chinese.lastUpdated = new Date().toISOString();
    saveModulesConfig(cfg);
    await install({ path: customPath, modules: { chinese: { enabled: enable, language: cfg.modules.chinese.language } } });
    console.log(`✅ 客户端界面汉化模块已${enable ? '开启' : '关闭'}并完成 ASAR 注入同步！`);
  } else if (cmd === 'proxy:enable' || cmd === 'proxy:disable') {
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    const enable = cmd === 'proxy:enable';
    cfg.modules.proxy.enabled = enable;
    cfg.modules.proxy.lastUpdated = new Date().toISOString();
    saveModulesConfig(cfg);
    await install({ path: customPath, modules: { proxy: { enabled: enable } } });
    console.log(`✅ 免 TUN 网络直连模块已${enable ? '开启' : '关闭'}并完成 ASAR 注入同步！`);
  } else if (cmd === 'proxy:set') {
    const rawUrl = args[1] && !args[1].startsWith('-') ? args[1] : args[2];
    if (!rawUrl) throw new Error('请提供有效的代理地址，例如: node cli.js proxy:set http://127.0.0.1:7890');
    const { parseAndValidateProxyUrl } = require('./meter-proxy');
    const check = parseAndValidateProxyUrl(rawUrl);
    if (!check.ok) {
      throw new Error(check.error || '代理地址格式错误，需包含有效协议(http/https/socks5)与端口(1-65535)');
    }
    const newUrl = check.value;
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    cfg.modules.proxy.proxyUrl = newUrl;
    cfg.modules.proxy.lastUpdated = new Date().toISOString();
    saveModulesConfig(cfg);
    if (cfg.modules.proxy.enabled) {
      await install({ path: customPath, modules: { proxy: { proxyUrl: newUrl } } });
    }
    console.log(`✅ 代理地址已更新为: ${newUrl}`);
  } else if (cmd === 'proxy:test') {
    const { loadModulesConfig, testProxyHealth } = require('./modules-config');
    const cfg = loadModulesConfig();
    const urlToTest = args[1] && !args[1].startsWith('-') ? args[1] : cfg.modules.proxy.proxyUrl;
    console.log(`🔍 正在分层检测代理地址连通性: ${urlToTest}...`);
    const r = await testProxyHealth(urlToTest);
    console.log(`  - 1. 配置格式验证: ${r.configValid ? '✅ 合法' : '❌ 错误'}`);
    console.log(`  - 2. 本地代理端口: ${r.proxyReachable ? '✅ 可连接' : '❌ 无法连接'}`);
    console.log(`  - 3. 实际网络连通: ${r.internetReachable ? '✅ 可访问公网' : '⚠️ 无法访问公网 (可能节点无境外连接)'}`);
    console.log(`  - 4. 真实模型请求: 待通过真实在线会话验证 (分层标定)`);
    if (r.error) console.log(`  ⚠️ 诊断提示: ${r.error}`);
  } else if (cmd === 'usage') {
    const { queryCliUsage, formatCliUsageText } = require('./meter-cli-monitor');
    const getVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    let period = 'all';
    if (args.includes('--today')) period = 'today';
    else if (args.includes('--week')) period = 'week';
    else if (args.includes('--month')) period = 'month';
    const wantJson = args.includes('--json');
    const res = await queryCliUsage({
      period,
      account: getVal('--account'),
      model: getVal('--model'),
      agDir: getVal('--ag-dir') || undefined,
      agCliDir: getVal('--cli-dir') || undefined,
      stateDir: getVal('--state-dir') || undefined,
      readOnly: true
    });
    if (wantJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatCliUsageText(res));
    }
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === 'monitor') {
    const { runCliMonitor } = require('./meter-cli-monitor');
    const getVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const intervalVal = getVal('--interval');
    await runCliMonitor({
      sessionFilter: getVal('--session'),
      cwdFilter: getVal('--cwd'),
      compact: args.includes('--compact'),
      once: args.includes('--once'),
      json: args.includes('--json'),
      intervalMs: intervalVal ? Number(intervalVal) : 2000,
      agDir: getVal('--ag-dir') || undefined,
      agCliDir: getVal('--cli-dir') || undefined,
      stateDir: getVal('--state-dir') || undefined,
      readOnly: true
    });
  } else if (cmd === 'launch-cli') {
    const { resolveCliExecutable, launchCliSession } = require('./meter-cli-launcher');
    const getVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const cliPathArg = getVal('--cli-path');
    const cwdArg = getVal('--cwd');
    const modelArg = getVal('--model');
    const accountArg = getVal('--account') || getVal('-a');
    const dryRun = args.includes('--dry-run');
    const wantJson = args.includes('--json');
    const detectRes = resolveCliExecutable(cliPathArg);
    if (!detectRes.ok) {
      if (wantJson) console.log(JSON.stringify(detectRes, null, 2));
      else console.error(`❌ ${detectRes.error}`);
      process.exitCode = 1;
      return;
    }
    const launchRes = await launchCliSession({
      cliPath: detectRes.cliPath,
      cwd: cwdArg || process.cwd(),
      model: modelArg || undefined,
      account: accountArg || undefined,
      stateDir: getVal('--state-dir') || undefined,
      dryRun
    });
    if (wantJson) {
      console.log(JSON.stringify(launchRes, null, 2));
    } else if (launchRes.ok) {
      const accLabel = launchRes.account ? `, 独立账号: ${launchRes.account}` : '';
      console.log(`✅ CLI ${dryRun ? '预检' : '启动'}成功: ${launchRes.cliPath} (工作区: ${launchRes.cwd}, 模型: ${launchRes.model}${accLabel})`);
      if (launchRes.isolatedDir) {
        console.log(`   凭据隔离: ${launchRes.isolatedDir} (已隔离系统 Keyring，互不覆盖)`);
      }
    } else {
      console.error(`❌ CLI 启动失败: ${launchRes.error}`);
    }
    if (!launchRes.ok) process.exitCode = 1;
  } else if (cmd === 'context-set') {
    const { saveCliModelContextPreference } = require('./meter-cli-monitor');
    const getVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const modelArg = getVal('--model');
    const modeArg = getVal('--mode') || 'fixed';
    const limitArg = getVal('--limit');
    const clearFlag = args.includes('--clear');
    const syncCli = args.includes('--sync-cli-settings');
    const wantJson = args.includes('--json');
    const res = saveCliModelContextPreference({
      model: modelArg,
      mode: modeArg,
      limitTokens: limitArg ? Number(limitArg) : null,
      clear: clearFlag,
      syncCliSettings: syncCli,
      stateDir: getVal('--state-dir') || undefined,
      agCliDir: getVal('--cli-dir') || undefined
    });
    if (wantJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      console.log(`✅ 已立即保存模型 ${res.model} 的 CLI 上下文偏好 (${res.mode}${res.limitTokens ? `: ${res.limitTokens}` : ''}).`);
      console.log(`   生效时机: ${res.effectiveTiming.explanation}`);
    } else {
      console.error(`❌ 保存失败: ${res.error}`);
    }
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === 'context-status') {
    const { resolveCliModelContextBudget } = require('./meter-cli-monitor');
    const { getPluginSettings } = require('./meter-collector');
    const getVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const modelArg = getVal('--model');
    const stateDirArg = getVal('--state-dir') || undefined;
    const cliDirArg = getVal('--cli-dir') || undefined;
    const wantJson = args.includes('--json');
    const cliBin = detectCliBinary(null);
    const cliGate = cliBin ? await analyzeBinaryAsync(cliBin) : null;
    const settingsSnap = getPluginSettings({ stateDir: stateDirArg });
    const resolved = modelArg
      ? resolveCliModelContextBudget(modelArg, { stateDir: stateDirArg, agCliDir: cliDirArg })
      : null;
    const report = {
      ok: true,
      cliBinary: cliBin || null,
      binaryGate: cliGate ? {
        status: cliGate.status,
        mode: cliGate.mode,
        origLimit: cliGate.gate3a?.origLimit || null,
        currentLimit: cliGate.gate3a?.limit ?? null
      } : null,
      contextPreferences: settingsSnap?.contextPreferences || {},
      ...(resolved ? { selectedModelBudget: resolved } : {})
    };
    if (wantJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`🔍 CLI 上下文状态 | 二进制: ${cliBin || '未检测到'}${cliGate ? ` (${cliGate.status}, Gate3A=${cliGate.gate3a?.limit ?? '动态'})` : ''}`);
      if (resolved) {
        console.log(`   模型 ${resolved.model}: 有效上限=${resolved.limitTokens ?? '未知'} (来源: ${resolved.budgetSource})`);
      }
      console.log(`   已保存按模型偏好数: ${Object.keys(report.contextPreferences).length}`);
    }
  } else if (cmd === 'status') {
    await cmdStatus(customPath, cdpOptions);
  } else if (cmd === 'check') {
    await cmdCheck(customPath, cdpOptions);
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseCliArgs,
  cmdStatus,
  cmdCheck,
  queryLiveWindow,
  discoverHostOriginsWithoutCdp,
  buildManualCdpRestartGuidance,
  formatManualCdpLaunchCommand,
  runLiveCommand,
  ensureLiveBridgeIfNeeded,
  rollbackPreparedLiveBridge,
  stopLiveBridge,
  runWatchDaemon,
  stopWatchDaemon,
  getWatchPidPath,
  getWatchMetaPath,
  readWatchMetaInfo,
  readWatchLockInfo,
  readWatchPid,
  shouldTakeOverWatchLock,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId,
  tryHotDispose
};
