#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI
 * Cross-platform installer, live CDP hot-injector, zero-patch watch daemon, and lifecycle manager
 * Format aligned with antigravity-chinese for one-command human & AI Agent execution.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { loadAsarEngine, getStateDir } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient, parseExplicitPort } = require('./local-api');
const {
  install,
  findAsarPath,
  tryHotInject,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId
} = require('./install');
const { restore, tryHotDispose } = require('./restore');
const { resolvePython, OFFICIAL_REPO } = require('./meter-collector');
const { PROJECT_VERSION } = require('./modules-config');
const { analyzeBinary, analyzeBinaryAsync, applyUnlock, restoreUnlock, AUTHOR_INFO } = require('./meter-context-unlock');

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

  // Legacy plain-integer watch.pid: check POSIX ps command line for stale cli.js watch
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

async function queryLiveWindow(options = {}) {
  const discovered = await discoverAntigravityCdp(options);
  if (!discovered.running) {
    return { running: false, ...(discovered.error ? { error: discovered.error } : {}) };
  }
  if (!discovered.pageFound || !discovered.page) {
    return { running: true, cdpPort: discovered.port, pageFound: false };
  }
  const target = discovered.page;
  const origin = discovered.origin;
  let client = null;
  try {
    client = await createCdpClient(target.webSocketDebuggerUrl, options);
    const status = await client.evaluateValue(`(() => {
      const s = window.__AGContextMeter?.snapshot();
      const root = document.getElementById('ag-context-meter')?.shadowRoot;
      return {
        active: Boolean(window.__AGContextMeter),
        version: window.__AGContextMeter?.version || null,
        repo: window.__AGContextMeter?.repo || null,
        buildId: window.__AGContextMeter?.buildId || null,
        hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli && window.contextMeterAPI?.getContextUnlockStatus),
        badgeText: root?.getElementById('amount')?.textContent || null,
        route: s?.route || null,
        latest: s?.latest || null
      };
    })()`, { timeoutMs: 4000 });
    return {
      running: true,
      cdpPort: discovered.port,
      pageFound: true,
      origin,
      ...(status || {})
    };
  } catch (e) {
    return { running: false, error: e.message };
  } finally {
    if (client) {
      try { client.close(); } catch {}
    }
  }
}

async function stopLiveBridge(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  let stoppedPid = null;

  for (const p of [statePath, legacyPath]) {
    if (!fs.existsSync(p)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info && info.pid && isPidAliveForUser(info.pid)) {
        await terminateProcessGracefully(info.pid, 1500);
        stoppedPid = info.pid;
      }
    } catch {}
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  return { stopped: Boolean(stoppedPid), pid: stoppedPid };
}

async function ensureLiveBridgeIfNeeded(options = {}) {
  if (options.skipLiveHost) return false;
  const live = options._liveSnapshot || await queryLiveWindow(options);
  if (!live.running || !live.pageFound || live.hasIpcBridge) return false;

  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  const liveSessionPath = fs.existsSync(statePath) ? statePath : legacyPath;

  let alive = false;
  let existingInfo = null;
  const defaultLiveHostScript = path.join(__dirname, 'live-host.js');
  const liveHostScript = options.liveHostScript || defaultLiveHostScript;
  const isDefaultLiveHost = path.resolve(liveHostScript) === path.resolve(defaultLiveHostScript);
  const expectedBundleBuildId = options.expectedBundleBuildId !== undefined
    ? options.expectedBundleBuildId
    : getWatchBundleBuildId(options.bundleDir || null);

  if (fs.existsSync(liveSessionPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
      existingInfo = info;
      let matchesCurrentBridge = true;
      if (info.repo && info.repo !== OFFICIAL_REPO) matchesCurrentBridge = false;
      if (info.version && info.version !== PROJECT_VERSION) matchesCurrentBridge = false;
      if (info.script && path.resolve(info.script) !== path.resolve(liveHostScript)) matchesCurrentBridge = false;
      if (isDefaultLiveHost && expectedBundleBuildId && info.buildId !== expectedBundleBuildId) {
        matchesCurrentBridge = false;
      } else if (!isDefaultLiveHost && info.buildId && expectedBundleBuildId && info.buildId !== expectedBundleBuildId) {
        matchesCurrentBridge = false;
      }
      if (!info.script && !info.repo && !options.liveHostScript && process.platform !== 'win32') {
        const cmd = inspectProcessCommandPosix(info.pid, options._inspectProcessCommand);
        if (cmd && cmd.includes('live-host.js') && !cmd.includes(path.resolve(liveHostScript))) {
          matchesCurrentBridge = false;
        }
      }
      if (isPidAliveForUser(info.pid) && (!live.origin || info.origin === live.origin) && matchesCurrentBridge) {
        alive = true;
      }
    } catch {}
  }

  if (!alive) {
    if (existingInfo?.pid) {
      await terminateProcessGracefully(existingInfo.pid, 1000);
    }
    try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch {}
    try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath); } catch {}

    const childEnv = {
      ...process.env,
      AG_METER_STATE_DIR: stateDir
    };
    if (live.cdpPort) {
      childEnv.AG_CDP_PORT = String(live.cdpPort);
    }
    if (options.appDataDir) {
      childEnv.APPDATA = options.appDataDir;
    }

    const spawner = options._spawnLiveHost || spawn;
    const child = spawner(process.execPath, [liveHostScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv
    });
    child?.unref?.();

    const maxWaitMs = options.liveBridgeWaitMs || 5000;
    const intervalMs = 100;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      const checkPath = fs.existsSync(statePath) ? statePath : (fs.existsSync(legacyPath) ? legacyPath : null);
      if (checkPath) {
        try {
          const info = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
          if (info && info.pid && (!live.origin || info.origin === live.origin) && isPidAliveForUser(info.pid)) {
            alive = true;
            break;
          }
        } catch {}
      }
    }
  }
  return alive;
}

/**
 * 免改盘守护模式 (node cli.js watch)
 * 随 Antigravity 启动自动挂载顶部栏组件，支持动态检测渲染包 mtimeMs / buildId 变化自动热刷新，并在客户端关闭后自动退出。
 */
async function runWatchDaemon(options = {}) {
  const { readWatchConfigSnapshot } = require('./modules-config');
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
      for (const liveFile of [path.join(stateDir, '.live-session.json'), path.join(__dirname, '.live-session.json')]) {
        if (!fs.existsSync(liveFile)) continue;
        try {
          const info = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
          if (info?.pid && isPidAliveForUser(info.pid)) {
            await terminateProcessGracefully(info.pid, 1500);
          }
        } catch {}
        try { if (fs.existsSync(liveFile)) fs.unlinkSync(liveFile); } catch {}
      }
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
        if (typeof options.onHostBundleChanged === 'function') {
          try {
            await options.onHostBundleChanged({
              previousHostBuildId: startupHostBuildId,
              nextHostBuildId: currentHostBuildId,
              previousBundleBuildId: activeBundleBuildId,
              nextBundleBuildId: currentBundleBuildId
            });
          } catch {}
        }
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
          if (options.port) {
            reloadArgs.push('--port', String(options.port));
          }
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

      const discovered = await discoverAntigravityCdp(options);
      const hasWindow = Boolean(discovered.running && discovered.targets && discovered.targets.length > 0);

      if (!hasWindow) {
        if (!windowEverSeen) {
          if (Date.now() - startedAt >= startupTimeoutMs) {
            exitReason = 'startup_timeout';
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

      // 已探测到活跃的 Antigravity 窗口
      windowEverSeen = true;
      consecutiveMisses = 0;

      const cfgPath = options.modulesConfigPath || path.join(stateDir, 'modules.json');
      const { displayMode, meterEnabled } = readWatchConfigSnapshot(cfgPath);

      if (displayMode === 'sidebar' || !meterEnabled) {
        // 仅侧边栏模式 (Mode 2) 或监控已禁用：若当前页面挂载了顶栏实例则即时卸载并保持空闲
        for (const target of discovered.targets) {
          let client = null;
          try {
            client = await createCdpClient(target.webSocketDebuggerUrl, options);
            const active = await client.evaluateValue('Boolean(window.__AGContextMeter)', { timeoutMs: 3000 });
            if (active) {
              await client.evaluate('window.__AGContextMeter?.dispose()', { timeoutMs: 3000 });
              disposedCount++;
            }
          } catch {} finally {
            if (client) { try { client.close(); } catch {} }
          }
        }
        await stopLiveBridge({ stateDir });
      } else {
        // topbar (默认 Mode 1) 或 both (双模式)：按需启动 live-host 并在组件缺失或版本/仓库/buildId 陈旧时自动热升级挂载
        let needsBridge = false;
        let needsInject = false;
        let hasLivePortProbe = false;
        const targetStates = [];
        for (const target of discovered.targets) {
          let client = null;
          try {
            client = await createCdpClient(target.webSocketDebuggerUrl, options);
            const st = await client.evaluateValue(`(() => ({
              active: Boolean(window.__AGContextMeter),
              version: window.__AGContextMeter?.version || null,
              repo: window.__AGContextMeter?.repo || null,
              buildId: window.__AGContextMeter?.buildId || null,
              livePort: window.__AGContextMeterLive?.port || null,
              liveToken: window.__AGContextMeterLive?.token || null,
              hasIpcBridge: Boolean(window.contextMeterAPI?.scan)
            }))()`, { timeoutMs: 3500 });
            targetStates.push(st || null);
            if (st && st.livePort !== undefined) hasLivePortProbe = true;
            if (!st?.hasIpcBridge) needsBridge = true;
            const isOutdated = Boolean(
              st?.active &&
              (
                st.version !== expectedVersion ||
                st.repo !== expectedRepo ||
                (activeRendererBuildId && st.buildId !== activeRendererBuildId)
              )
            );
            if (!st?.active || isOutdated) {
              if (isOutdated) {
                try {
                  await client.evaluate('window.__AGContextMeter?.dispose()', { timeoutMs: 3000 });
                  disposedCount++;
                } catch {}
              }
              needsInject = true;
            }
          } catch {} finally {
            if (client) { try { client.close(); } catch {} }
          }
        }

        if (needsBridge && !options.skipLiveHost) {
          await ensureLiveBridgeIfNeeded({
            ...options,
            stateDir,
            bundleDir: rootDir,
            expectedBundleBuildId: activeBundleBuildId,
            _liveSnapshot: {
              running: true,
              pageFound: true,
              cdpPort: discovered.port,
              origin: discovered.origin,
              hasIpcBridge: false
            }
          });
        }

        let needsBridgeSync = false;
        if (!needsInject && hasLivePortProbe && !options.skipLiveHost) {
          const liveFile = fs.existsSync(path.join(stateDir, '.live-session.json'))
            ? path.join(stateDir, '.live-session.json')
            : path.join(__dirname, '.live-session.json');
          if (fs.existsSync(liveFile)) {
            try {
              const bridgeInfo = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
              if (bridgeInfo && (!discovered.origin || bridgeInfo.origin === discovered.origin)) {
                needsBridgeSync = targetStates.some(st => (
                  st?.active &&
                  st.livePort !== undefined &&
                  ((st.livePort || null) !== (bridgeInfo.port || null) || (st.liveToken || null) !== (bridgeInfo.token || null))
                ));
              }
            } catch {}
          }
        }

        if (needsInject || needsBridgeSync) {
          const injected = await tryHotInject({
            ...options,
            stateDir,
            bundleDir: rootDir,
            port: discovered.port,
            onlyIfAbsent: true,
            expectedVersion,
            expectedRepo,
            expectedBuildId: activeRendererBuildId
          });
          if (injected) injectedCount++;
        }
      }

      if (cycles >= maxCycles || stopped) break;
      await sleep(pollIntervalMs);
    }
  } finally {
    if (options.handleSignals !== false) {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    }
    if (!selfReloaded) {
      await stopLiveBridge({ stateDir });
      cleanupLockfile();
    }
  }

  return {
    ok: true,
    alreadyRunning: false,
    replacedPid,
    selfReloaded,
    reason: exitReason,
    windowEverSeen,
    injectedCount,
    disposedCount,
    cycles
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
  try {
    asarPath = findAsarPath(customPath);
    version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    const utilsSource = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    asarPatched = utilsSource.includes('installContextMeter(win)');
  } catch {}

  const { getEffectiveDisplayMode } = require('./modules-config');
  const live = await queryLiveWindow(cdpOptions);
  const py = resolvePython();
  const watchPid = readWatchPid();
  const report = {
    asarPath,
    antigravityVersion: version,
    asarPatched,
    displayMode: getEffectiveDisplayMode(),
    watcherRunning: Boolean(watchPid && isPidAliveForUser(watchPid)),
    watcherPid: (watchPid && isPidAliveForUser(watchPid)) ? watchPid : null,
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function cmdCheck(customPath, cdpOptions = {}) {
  console.log('🔍 [Antigravity 对话上下文查看器] 正在执行环境预检...');
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
  console.log(`  - 运行中窗口 CDP 状态: ${live.running ? `已连接 (端口 ${live.cdpPort})` : '客户端未运行或未开启调试端口'}`);
  console.log('✅ 环境预检通过！');
}

async function main() {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set([
    '--path', '--backup', '--port', '--proxy-url',
    '--mode', '--limit', '--tier', '--title', '--context', '--brand', '--lang'
  ]);
  let cmd = 'install';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) {
      cmd = a.toLowerCase();
      break;
    }
  }

  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;
  const backupIdx = args.indexOf('--backup');
  const customBackup = backupIdx >= 0 ? args[backupIdx + 1] : null;
  const explicitPort = parseExplicitPort({ argv: process.argv });
  const isForce = args.includes('--force');
  const cdpOptions = explicitPort ? { port: explicitPort } : {};

  if (cmd === 'install') {
    const meterVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`🚀 [Antigravity 对话上下文查看器 v${meterVersion}] 正在安装上下文可视化组件...`);
    await ensureLiveBridgeIfNeeded(cdpOptions);
    const manifest = await install({ path: customPath, backup: customBackup, force: isForce, ...cdpOptions });
    await tryHotInject(cdpOptions);
    console.log(`✅ 插件 v${manifest.meterVersion} 安装完成 (Antigravity 宿主 v${manifest.version})`);
    console.log(`✅ ASAR 持久化注入完成: ${manifest.installed} (校验 ${manifest.originalFilesVerified} 个原文件)`);
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules(manifest.installed);
    console.log('📦 模块状态分层报告:');
    console.log('   - ⚡ 上下文与 Token 监控:');
    console.log(`     * 配置状态: [配置: ${cfg.modules.meter.enabled ? '已开启' : '已关闭'}] (显示模式: ${cfg.displayMode})`);
    console.log(`     * 磁盘注入: ${disk.meter ? '✅ 已注入' : '⚪ 未注入'}`);
    console.log(`     * 运行中加载: ${manifest.liveInjected ? '✅ 已即时挂载生效（无需重启）' : '⏳ 待下次启动客户端时生效'}`);

    console.log('   - 🇨🇳 客户端界面汉化 (桌面客户端):');
    console.log(`     * 配置状态: [配置: ${cfg.modules.chinese.enabled ? '已开启' : '已关闭'}]`);
    console.log(`     * 磁盘组件: ${disk.chineseReady ? '✅ 已注入（支持配置门禁与离线切换）' : (disk.chinese ? '⚠️ 磁盘注入不完整' : '⚪ 未注入')}`);
    console.log(`     * 生效说明: ${cfg.modules.chinese.enabled ? '⏳ 重启 Antigravity 客户端后加载中文' : '⚪ 默认保持官方原生英文，可在客户端面板中随时开启并重启生效'}`);

    console.log('   - 🌐 免 TUN 网络直连 (本地代理):');
    console.log(`     * 配置状态: [配置: ${cfg.modules.proxy.enabled ? '已开启' : '已关闭'}] (代理: ${cfg.modules.proxy.proxyUrl || '未配置'})`);
    console.log(`     * 磁盘组件: ${disk.proxyReady ? '✅ 已注入（支持 Session 代理与环境变量拦截）' : (disk.proxy ? '⚠️ 磁盘注入不完整' : '⚪ 未注入')}`);
    console.log(`     * 生效说明: ${cfg.modules.proxy.enabled ? '🔍 需通过 node cli.js proxy:test 测试连通性' : '⚪ 跟随系统默认网络栈，可在客户端面板中随时配置并开启'}`);
    console.log(`     * 模型请求验证: 待通过真实在线会话验证 (分层标定，未发送请求前不宣称生效)`);
    console.log(`✅ 运行中窗口热挂载状态: ${manifest.liveInjected ? '已即时生效（无需重启）' : '将在下次启动 Antigravity 时自动生效'}`);
  } else if (cmd === 'live') {
    await ensureLiveBridgeIfNeeded(cdpOptions);
    const ok = await tryHotInject(cdpOptions);
    if (!ok) throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js watch。');
    console.log('✅ 已通过 CDP 热注入当前运行的 Antigravity 窗口！');
  } else if (cmd === 'watch') {
    const res = await runWatchDaemon(cdpOptions);
    if (!res.alreadyRunning) {
      console.log(`✅ [Watch] 守护进程已正常结束 (原因: ${res.reason}, 挂载次数: ${res.injectedCount})`);
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
    console.log('🔍 正在检测 Antigravity 后端上下文调整状态...');
    const st = await analyzeBinaryAsync(customPath);
    console.log(`- 目标文件: ${st.targetPath || '未检测到'}`);
    console.log(`- 目标架构: ${st.arch || '未知'} (${st.format || '未知'}, ${st.mode || '未知'})`);
    console.log(`- 磁盘模式: ${st.configuredSummary || '未知'}`);
    console.log(`- 运行状态: [${st.statusText || st.status}] ${st.details || st.reason || ''}`);
    if (st.scopeNotice) console.log(`- 作用范围: ${st.scopeNotice}`);
    if (st.backupInfo) {
      console.log(`- 备份文件: ${st.backupInfo.backupPath}${st.backupStaleReason ? ` (⚠️ ${st.backupStaleReason})` : ''}`);
    }
    console.log(`- ${st.author?.credit || AUTHOR_INFO.credit} (${st.author?.url || AUTHOR_INFO.url})`);
  } else if (cmd === 'unlock') {
    const modeIdx = args.indexOf('--mode');
    const modeVal = modeIdx >= 0 ? args[modeIdx + 1] : undefined;
    const limitIdx = args.indexOf('--limit');
    const limitVal = limitIdx >= 0 ? args[limitIdx + 1] : undefined;
    const noCliSync = args.includes('--no-cli-sync') || args.includes('--no-sync');
    console.log('⚡ 正在执行 Antigravity 后端上下文长度调整...');
    console.log(`ℹ ${AUTHOR_INFO.credit} (${AUTHOR_INFO.url})`);
    console.log(`⚠️  ${AUTHOR_INFO.disclaimer}`);
    const res = applyUnlock({ targetPath: customPath, mode: modeVal, limitTokens: limitVal, syncConfigFiles: true, syncCliConfigs: !noCliSync });
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
    console.log('🔄 正在恢复 Antigravity 官方原版后端二进制...');
    const res = restoreUnlock({ targetPath: customPath, syncConfigFiles: true, syncCliConfigs: !noCliSync });
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
    const { loadModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    const asarPath = findAsarPath(customPath);
    let asarUtils = '';
    let asarPreload = '';
    try {
      asarUtils = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
      asarPreload = asar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    } catch {}

    console.log('📦 [Antigravity 统一模块状态总览]');
    console.log(`0. 显示模式 (displayMode): ${cfg.displayMode}`);
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
    saveModulesConfig(cfg);
    await install({ path: customPath, modules: { chinese: { enabled: enable, language: cfg.modules.chinese.language } }, ...cdpOptions });
    console.log(`✅ 客户端界面汉化模块已${enable ? '开启' : '关闭'}并完成 ASAR 注入同步！`);
  } else if (cmd === 'proxy:enable' || cmd === 'proxy:disable') {
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    const enable = cmd === 'proxy:enable';
    cfg.modules.proxy.enabled = enable;
    saveModulesConfig(cfg);
    await install({ path: customPath, modules: { proxy: { enabled: enable } }, ...cdpOptions });
    console.log(`✅ 免 TUN 网络直连模块已${enable ? '开启' : '关闭'}并完成 ASAR 注入同步！`);
  } else if (cmd === 'proxy:set') {
    const newUrl = args[1] && !args[1].startsWith('-') ? args[1] : args[2];
    if (!newUrl) throw new Error('请提供有效的代理地址，例如: node cli.js proxy:set http://127.0.0.1:7890');
    const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
    const cfg = loadModulesConfig();
    cfg.modules.proxy.proxyUrl = newUrl;
    saveModulesConfig(cfg);
    if (cfg.modules.proxy.enabled) {
      await install({ path: customPath, modules: { proxy: { proxyUrl: newUrl } }, ...cdpOptions });
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
  } else if (cmd === 'status') {
    await cmdStatus(customPath, cdpOptions);
  } else if (cmd === 'check') {
    await cmdCheck(customPath, cdpOptions);
  } else {
    console.log(`用法:
  node cli.js watch [--port <port>]         免改盘后台守护模式（随客户端启动自动挂载顶栏，关闭后自动退出）
  node cli.js stop-watch                    停止正在运行的 watch 守护进程与本地桥接服务
  node cli.js live [--port <port>]          免改盘单次 CDP 热挂载到当前运行窗口
  node cli.js install [--path <app.asar>]   一键持久化安装并热注入当前运行窗口
  node cli.js status [--port <port>]        查看安装状态与当前对话实时上下文用量
  node cli.js check [--port <port>]         执行前置环境健康检查
  node cli.js restore [--all]               一键无损卸载并恢复备份 (--all 含还原内核增强)
  node cli.js unlock-status [--path <bin>]  检查 Antigravity 后端上下文调整状态
  node cli.js unlock --mode <default|fixed|dynamic> [--limit N]  调整上下文长度上限
  node cli.js unlock-restore [--path <bin>] 恢复官方原版二进制
  node cli.js enhance-status                检查系统提示词精简与中文标题内核状态
  node cli.js enhance [--tier 0-4] [--title on|off] [--context default|512k|900k|dynamic] [--lang zh-CN|en] [--brand english|hidden|translated]
  node cli.js enhance-restore               一键还原系统提示词、英文标题与默认上下文`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  cmdStatus,
  cmdCheck,
  queryLiveWindow,
  ensureLiveBridgeIfNeeded,
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
