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
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const { loadAsarEngine, getStateDir, getAppDataDir, isIsolatedTestPath } = require('./asar-engine');
const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
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
const { resolvePython, syncLiveRuntimeBundle, getStagedLiveRuntime, OFFICIAL_REPO } = require('./meter-collector');
const { compareVersions } = require('./meter-core');
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

const DEFAULT_LAUNCH_CDP_PORT = DEFAULT_MANUAL_CDP_PORT;

function isRunningInsideAntigravitySession(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  return Boolean(
    env.ANTIGRAVITY_AGENT ||
    env.ANTIGRAVITY_CONVERSATION_ID ||
    env.ANTIGRAVITY_LS_ADDRESS ||
    env.ANTIGRAVITY_VSCODE_HOST ||
    env.ANTIGRAVITY_CLI_ALIAS
  );
}

async function isAntigravityHostRunning(customPath = null, options = {}) {
  if (options && typeof options._isHostRunning === 'function') {
    return Boolean(await options._isHostRunning());
  }
  if (process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') {
    return false;
  }
  let target = null;
  try {
    target = resolveAntigravityHostTarget(customPath, options);
  } catch {
    return false;
  }
  if (!target || !target.execPath) return false;
  if (target.platform === 'darwin') {
    try {
      const { listMacProcessesSync } = require('./macos-binary-utils');
      const expectedExec = path.resolve(target.execPath);
      return listMacProcessesSync().some(p => p && p.path && path.resolve(p.path) === expectedExec);
    } catch {
      return false;
    }
  }
  if (target.platform === 'win32') {
    try {
      const exeBase = path.basename(target.execPath);
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exeBase}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return String(out || '').toLowerCase().includes(`"${exeBase.toLowerCase()}"`);
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'args='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const expectedExec = path.resolve(target.execPath);
    return String(out || '').split(/\r?\n/).some(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes('--type=')) return false;
      return trimmed === expectedExec || trimmed.startsWith(expectedExec + ' ');
    });
  } catch {
    return false;
  }
}

function isLoopbackPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function pickAvailableCdpPort(preferredPort = null, options = {}) {
  const isPortFreeFn = (options && typeof options._isPortFree === 'function')
    ? options._isPortFree
    : isLoopbackPortFree;
  const explicit = parseExplicitPort(preferredPort ?? options?.port ?? process.env.AG_CDP_PORT);
  if (explicit) {
    if (options.checkPortOccupied) {
      const free = await isPortFreeFn(explicit);
      if (!free) {
        const err = new Error(`指定的 CDP 端口 ${explicit} 已被其他进程占用，请改用其他 --port 端口`);
        err.code = 'CDP_PORT_OCCUPIED';
        err.port = explicit;
        throw err;
      }
    }
    return explicit;
  }
  if (options && typeof options._pickPort === 'function') {
    return Number(await options._pickPort()) || DEFAULT_LAUNCH_CDP_PORT;
  }
  if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options._isPortFree) {
    return DEFAULT_LAUNCH_CDP_PORT;
  }
  const pool = Array.isArray(HANS_CANDIDATE_PORTS) && HANS_CANDIDATE_PORTS.length
    ? HANS_CANDIDATE_PORTS
    : [DEFAULT_LAUNCH_CDP_PORT];
  for (const candidate of pool) {
    if (await isPortFreeFn(candidate)) return candidate;
  }
  // 候选池均被占时尝试向系统申请一个临时可用回环端口
  if (!options._isPortFree) {
    const dynamicPort = await new Promise(resolve => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', () => resolve(null));
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = addr && typeof addr === 'object' ? addr.port : null;
        srv.close(() => resolve(p));
      });
    });
    if (parseExplicitPort(dynamicPort)) return dynamicPort;
  }
  return DEFAULT_LAUNCH_CDP_PORT;
}

function buildCleanHostLaunchEnv(baseEnv = process.env) {
  const cleanEnv = { ...(baseEnv || {}) };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('ANTIGRAVITY_')) {
      delete cleanEnv[key];
    }
  }
  return cleanEnv;
}

async function launchAntigravityHostWithCdp(target, port, options = {}) {
  if (options && typeof options._launchHost === 'function') {
    return options._launchHost(target, port);
  }
  if (process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') {
    throw new Error('Test mode blocks launching real Antigravity host');
  }
  if (!target) {
    throw new Error('未找到 Antigravity 客户端安装路径');
  }
  const cleanEnv = buildCleanHostLaunchEnv(options.env || process.env);
  if (target.platform === 'darwin' && target.appBundlePath) {
    execFileSync('open', ['-a', target.appBundlePath, '--args', `--remote-debugging-port=${port}`], {
      stdio: 'ignore',
      timeout: 10000,
      env: cleanEnv
    });
    return;
  }
  const child = spawn(target.execPath, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: cleanEnv
  });
  child.unref();
}

async function quitAntigravityHostGracefully(target, customPath = null, options = {}) {
  const activeEnv = (options && options.env) || process.env;
  if (isRunningInsideAntigravitySession(activeEnv)) {
    throw new Error('当前位于 Antigravity 内部会话中，禁止自动关闭宿主进程');
  }
  if (options && typeof options._quitHost === 'function') {
    await options._quitHost(target);
  } else {
    if (process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') {
      throw new Error('Test mode blocks quitting real Antigravity host');
    }
    if (target?.platform === 'darwin') {
      execFileSync('osascript', [
        '-e', 'on run argv',
        '-e', 'tell application (item 1 of argv) to quit',
        '-e', 'end run',
        '--',
        target.appBundlePath || 'Antigravity'
      ], {
        stdio: 'ignore',
        timeout: 8000
      });
    } else if (target?.platform === 'win32' && target.execPath) {
      const processes = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$target = [IO.Path]::GetFullPath($env:AG_METER_QUIT_EXE); ' +
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $target -and $_.CommandLine -notmatch "(^| )--type=" } | ' +
        'ForEach-Object { $_.ProcessId }'
      ], {
        encoding: 'utf8',
        env: { ...process.env, AG_METER_QUIT_EXE: target.execPath },
        timeout: 5000,
        windowsHide: true
      });
      const pids = String(processes).split(/\s+/).filter(pid => /^[1-9]\d*$/.test(pid));
      if (pids.length) execFileSync('taskkill.exe', pids.flatMap(pid => ['/PID', pid]), {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true
      });
    } else if (target?.execPath) {
      const out = execFileSync('ps', ['-ax', '-o', 'pid=,args='], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const expectedExec = path.resolve(target.execPath);
      for (const line of String(out || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const argsStr = m[2].trim();
        if (argsStr.includes('--type=')) continue;
        if (argsStr === expectedExec || argsStr.startsWith(expectedExec + ' ')) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
      }
    }
  }

  const quitTimeoutMs = options.quitTimeoutMs ?? 10000;
  const quitPollMs = options.quitPollMs ?? 200;
  const deadline = Date.now() + quitTimeoutMs;
  while (Date.now() <= deadline) {
    const stillRunning = await isAntigravityHostRunning(customPath, { ...options, _hostTarget: target });
    if (!stillRunning) {
      const settleMs = options.relaunchSettleMs ?? ((options && typeof options._quitHost === 'function') ? 0 : 300);
      if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
      return true;
    }
    await new Promise(r => setTimeout(r, quitPollMs));
  }
  return false;
}

async function confirmInteractiveRelaunch(options = {}) {
  if (options && options.relaunch === true) return true;
  if (options && typeof options._confirmRelaunch === 'function') {
    return Boolean(await options._confirmRelaunch());
  }
  const stdin = (options && options.stdin) || process.stdin;
  const stdout = (options && options.stdout) || process.stdout;
  if (!stdin || !stdout || !stdin.isTTY || !stdout.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise(resolve => {
    let settled = false;
    const finish = val => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      resolve(val);
    };
    rl.on('SIGINT', () => {
      try { stdout.write('\n'); } catch {}
      finish(false);
    });
    rl.on('close', () => finish(false));
    rl.question(
      '⚠️ 检测到 Antigravity 正在运行但未开启 CDP 调试端口（v2.33.0+ 默认关闭）。\n是否自动优雅重启客户端并挂载看板？[Y/n] ',
      answer => {
        const normalized = String(answer || '').trim().toLowerCase();
        finish(normalized === '' || normalized === 'y' || normalized === 'yes');
      }
    );
  });
}

async function waitForLiveWindowReady(cdpOptions = {}, options = {}) {
  const queryFn = (options && typeof options._queryLiveWindow === 'function')
    ? options._queryLiveWindow
    : queryLiveWindow;
  const timeoutMs = options.launchTimeoutMs ?? 20000;
  const pollMs = options.launchPollMs ?? 350;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snap = await queryFn(cdpOptions);
    if (snap && snap.running && snap.pageFound) {
      return snap;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return null;
}

/**
 * 确保存在可通过 CDP 连接的运行中 Antigravity 主窗口（整合 PR #43，感谢 Nymph-Beta）：
 * - 已连接 CDP：直接复用当前窗口
 * - 客户端未启动：自动从正确安装路径带 --remote-debugging-port 启动并等待就绪
 * - 客户端已无端口裸开：先结合 daemon_hub 探测状态，默认输出可执行的正常退出重开指引；
 *   仅在宿主外部且明确授权（--relaunch / 交互确认）时执行优雅重开，内部会话严格拦截
 */
async function ensureLiveWindowAvailable(customPath = null, cdpOptions = {}, options = {}) {
  const queryFn = (options && typeof options._queryLiveWindow === 'function')
    ? options._queryLiveWindow
    : queryLiveWindow;

  const initial = await queryFn(cdpOptions);
  if (initial && initial.running && initial.pageFound) {
    return { ok: true, live: initial, action: 'connected', port: initial.cdpPort };
  }
  if (initial && initial.running && initial.cdpEnabled !== false && !initial.pageFound) {
    const readyFromExistingPort = await waitForLiveWindowReady(cdpOptions, {
      ...options,
      launchTimeoutMs: options.pageReadyTimeoutMs ?? 5000
    });
    if (readyFromExistingPort) {
      return { ok: true, live: readyFromExistingPort, action: 'connected', port: readyFromExistingPort.cdpPort };
    }
  }

  let target = null;
  try {
    target = resolveAntigravityHostTarget(customPath, options);
  } catch {}
  const procRunning = await isAntigravityHostRunning(customPath, { ...options, _hostTarget: target });
  const hostRunning = Boolean(
    procRunning ||
    (initial && initial.running && initial.cdpEnabled === false && (initial.discoverySource !== 'daemon_hub' || !target))
  );

  let launchPort;
  try {
    launchPort = await pickAvailableCdpPort(cdpOptions.port, {
      ...options,
      checkPortOccupied: !hostRunning
    });
  } catch (portErr) {
    if (portErr && portErr.code === 'CDP_PORT_OCCUPIED') {
      return { ok: false, reason: 'port_occupied', error: portErr.message, port: portErr.port };
    }
    throw portErr;
  }

  const manualCmd = formatManualCdpLaunchCommand(target, launchPort);
  const probeOpts = {
    ...cdpOptions,
    port: cdpOptions.port || launchPort,
    strictPort: Boolean(cdpOptions.strictPort)
  };

  if (!hostRunning) {
    if (options.autoLaunch === false) {
      return { ok: false, reason: 'host_not_running', manualCmd, port: launchPort };
    }
    if (!target || (!options._launchHost && !target.asarPath && !fs.existsSync(target.execPath || ''))) {
      return { ok: false, reason: 'host_not_found', manualCmd, port: launchPort };
    }
    if (!options.silent) {
      console.log(`🚀 未检测到运行中的 Antigravity，正在带调试端口 (${launchPort}) 启动客户端...`);
    }
    await launchAntigravityHostWithCdp(target, launchPort, options);
    const readyLive = await waitForLiveWindowReady(probeOpts, options);
    if (readyLive) {
      return { ok: true, live: readyLive, action: 'launched', port: readyLive.cdpPort || launchPort };
    }
    return { ok: false, reason: 'launch_timeout', manualCmd, port: launchPort };
  }

  const activeEnv = (options && options.env) || process.env;
  if (isRunningInsideAntigravitySession(activeEnv)) {
    return { ok: false, reason: 'cdp_disabled_inside_host', manualCmd, port: launchPort };
  }

  const confirmed = await confirmInteractiveRelaunch(options);
  if (!confirmed) {
    return { ok: false, reason: 'cdp_disabled_needs_relaunch', manualCmd, port: launchPort };
  }

  if (!target) {
    return { ok: false, reason: 'host_not_found', manualCmd, port: launchPort };
  }
  if (!options.silent) {
    console.log(`🔄 正在优雅退出 Antigravity 并带调试端口 (${launchPort}) 重新启动...`);
  }
  const quitOk = await quitAntigravityHostGracefully(target, customPath, options);
  if (!quitOk) {
    return { ok: false, reason: 'relaunch_quit_timeout', manualCmd, port: launchPort };
  }
  await launchAntigravityHostWithCdp(target, launchPort, options);
  const readyLive = await waitForLiveWindowReady(probeOpts, options);
  if (readyLive) {
    return { ok: true, live: readyLive, action: 'relaunched', port: readyLive.cdpPort || launchPort };
  }
  return { ok: false, reason: 'launch_timeout', manualCmd, port: launchPort };
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
    const lightProbe = Boolean(options.lightProbe);

    const client = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 4000 });
    try {
      const status = await client.evaluateValue(`(async () => {
        const light = ${lightProbe ? 'true' : 'false'};
        const s = light ? null : window.__AGContextMeter?.snapshot();
        const root = light ? null : document.getElementById('ag-context-meter')?.shadowRoot;
        let ipcRuntimeInfo = null;
        if (typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
          try { ipcRuntimeInfo = await window.contextMeterAPI.getRuntimeInfo(); } catch {}
        }
        const bootBackend = window.__AGContextMeterBootBackend || null;
        const backendStatus = typeof window.__AGContextMeter?.getBackendStatusForTest === 'function'
          ? window.__AGContextMeter.getBackendStatusForTest()
          : null;
        const quotaState = (!light && typeof window.__AGContextMeter?.getModelQuotaStateForTest === 'function')
          ? window.__AGContextMeter.getModelQuotaStateForTest()
          : null;
        return {
          active: Boolean(window.__AGContextMeter),
          version: window.__AGContextMeter?.version || null,
          hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli && window.contextMeterAPI?.getContextUnlockStatus),
          hasQuotaIpcBridge: Boolean(window.contextMeterAPI?.getQuota),
          hasAccountsIpcBridge: Boolean(window.contextMeterAPI?.getAccountsOverview && window.contextMeterAPI?.accountsAction),
          hasRehydrateIpcBridge: Boolean(window.contextMeterAPI?.getRehydrateStatus && (!ipcRuntimeInfo?.capabilities || ipcRuntimeInfo.capabilities.rehydrate === true)),
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

function hasRehydrateCapability(caps) {
  if (Array.isArray(caps)) return caps.includes('rehydrate');
  return Boolean(caps && typeof caps === 'object' && caps.rehydrate === true);
}

function buildWin32DetachedBridgePowerShellScript(cmdLine, currentDir) {
  const escCmd = String(cmdLine || '').replace(/'/g, "''");
  const escCwd = String(currentDir || '').replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{",
    `  CommandLine = '${escCmd}'`,
    `  CurrentDirectory = '${escCwd}'`,
    "  ProcessStartupInformation = $si",
    "}",
    "if ($null -eq $r -or [int]$r.ReturnValue -ne 0) {",
    "  $rv = if ($null -eq $r) { 'null' } else { $r.ReturnValue }",
    "  Write-Error (\"WMI_CREATE_FAILED:\" + $rv)",
    "  exit 1",
    "}",
    "if (-not $r.ProcessId) {",
    "  Write-Error \"WMI_CREATE_FAILED:missing_pid\"",
    "  exit 1",
    "}",
    "Write-Output (\"WMI_PID:\" + $r.ProcessId)"
  ].join('\n');
}

function launchBridgeViaWin32Wmi(cmdLine, currentDir, env = process.env, options = {}) {
  const { spawnSync } = require('child_process');
  const runSpawnSync = options._spawnSync || spawnSync;
  const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
  const sysPs = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psExe = fs.existsSync(sysPs) ? sysPs : 'powershell.exe';
  const psCmd = buildWin32DetachedBridgePowerShellScript(cmdLine, currentDir);

  let wmiRes;
  try {
    wmiRes = runSpawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      windowsHide: true,
      timeout: options.timeoutMs || 4000,
      encoding: 'utf8',
      env
    });
  } catch (err) {
    return { ok: false, pid: null, error: `WMI_SPAWN_ERROR:${err?.message || err}` };
  }

  const stdout = String(wmiRes?.stdout || '').trim();
  const stderr = String(wmiRes?.stderr || '').trim();
  const mPid = stdout.match(/(?:^|\r?\n)(?:WMI_PID:)?(\d+)\s*$/);
  const parsedPid = mPid ? Number(mPid[1]) : NaN;
  if (wmiRes && !wmiRes.error && wmiRes.status === 0 && Number.isInteger(parsedPid) && parsedPid > 0) {
    return { ok: true, pid: parsedPid, error: null };
  }

  const mCode = (stderr + '\n' + stdout).match(/WMI_CREATE_FAILED:([A-Za-z0-9_-]+)/);
  const rawErr = wmiRes?.error?.message || (mCode ? `WMI_CREATE_FAILED:${mCode[1]}` : (stderr || `status=${wmiRes?.status}`));
  return {
    ok: false,
    pid: null,
    error: String(rawErr).replace(/\s+/g, ' ').slice(0, 200)
  };
}

async function ensureLiveBridgeIfNeeded(liveSnapshot = null, options = {}) {
  const probeFn = typeof options?._probeLiveHost === 'function' ? options._probeLiveHost : probeLiveHostRuntimeInfo;
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
    (live.hasAccountsIpcBridge !== undefined ? live.hasAccountsIpcBridge : true) &&
    live.hasRehydrateIpcBridge &&
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
    const infoBuildMatch = !expectedHostBuildId || !info.hostBuildId || info.hostBuildId === expectedHostBuildId;
    if (pidAlive && coversAllOrigins(info) && info.hasQuota && (!currentPkgVersion || info.version === currentPkgVersion) && infoBuildMatch) {
      const probe = await probeFn(info, expectedOrigins[0]);
      const probeBuildMatch = !expectedHostBuildId || !probe?.hostBuildId || probe?.hostBuildId === expectedHostBuildId;
      if (probe && probe.ok && hasRehydrateCapability(probe.capabilities) && (!currentPkgVersion || probe.backendVersion === currentPkgVersion) && probeBuildMatch) {
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
  if (options.stateDir) hostArgs.push('--state-dir', stateDir);

  let spawnedChild = null;
  let spawnedPid = null;
  let newInfo = null;
  let wmiError = null;
  try {
    const canBreakawayWmi = options._enableWin32Wmi === true || (
      process.platform === 'win32'
      && process.env.AG_METER_TEST_MODE !== '1'
      && process.env.NODE_ENV !== 'test'
      && !process.env.AG_METER_STATE_DIR
    );
    if (canBreakawayWmi) {
      const cmdLine = [process.execPath, ...hostArgs]
        .map(a => `"${String(a).replace(/"/g, '""')}"`)
        .join(' ');
      const wmiAttempt = launchBridgeViaWin32Wmi(cmdLine, path.dirname(hostEntryScript), childEnv, {
        _spawnSync: options._wmiSpawnSync
      });
      if (wmiAttempt.ok && wmiAttempt.pid) {
        spawnedPid = wmiAttempt.pid;
      } else {
        wmiError = wmiAttempt.error || 'WMI_CREATE_FAILED:unknown';
        if (typeof options.onWmiFallback === 'function') {
          try { options.onWmiFallback(wmiError); } catch {}
        }
      }
    }
    if (!spawnedPid) {
      const spawnFn = options._spawn || spawn;
      spawnedChild = spawnFn(process.execPath, hostArgs, {
        cwd: path.dirname(hostEntryScript),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv
      });
      spawnedChild?.unref?.();
      spawnedPid = spawnedChild?.pid || null;
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (!fs.existsSync(stagingStamp)) continue;
      try {
        const cand = JSON.parse(fs.readFileSync(stagingStamp, 'utf8'));
        if (cand && cand.pid && cand.port && cand.token) {
          process.kill(cand.pid, 0);
          const probe = await probeFn(cand, cand.origin || expectedOrigins[0]);
          if (probe && probe.ok && hasRehydrateCapability(probe.capabilities) && (!currentPkgVersion || probe.backendVersion === currentPkgVersion)) {
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
/**
 * 在启动宿主前安全检查是否因宿主升级被官方原版 ASAR 覆盖；仅在宿主未运行且通过预检时自动无损恢复。
 */
async function tryAutoRecoverBeforeLaunch(customPath = null, options = {}, contextLabel = 'launch') {
  try {
    const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !customPath && !options.stateDir) {
      return { skipped: true, reason: 'test_mode_isolated' };
    }
    if (isRunningInsideAntigravitySession(options)) {
      return { skipped: true, reason: 'inside_host_session' };
    }
    const hostRunning = await isAntigravityHostRunning(customPath, options);
    if (hostRunning) {
      return { skipped: true, reason: 'host_running' };
    }
    const { inspectHostRecoveryState, recoverHostInstallation } = require('./host-recovery');
    const inspected = inspectHostRecoveryState({ asarPath: customPath, stateDir });
    if (inspected.state !== 'overwritten_by_host_update' && inspected.state !== 'stale_host_version') {
      return { skipped: true, state: inspected.state };
    }
    if (inspected.preflight?.blocked) {
      if (!options.silent) {
        console.log(`⚠️ [自愈拦截:${contextLabel}] ${inspected.preflight.guidance}`);
      }
      return { ok: false, action: 'blocked', reason: inspected.preflight.reason, inspected };
    }
    const res = await recoverHostInstallation({
      asarPath: inspected.asarPath,
      stateDir,
      noHotInject: true
    });
    if (res.ok && res.changed && !options.silent) {
      console.log(`✅ [自愈恢复:${contextLabel}] 检测到宿主更新覆盖 (v${res.hostVersion})，已备份新版并自动恢复已启用的插件配置`);
    } else if (res.action === 'locked' && !options.silent) {
      console.log(`⚠️ [自愈跳过:${contextLabel}] ${res.error}`);
    }
    return res;
  } catch (e) {
    return { skipped: true, error: e?.message || String(e) };
  }
}

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

  const discoverFn = typeof options._discoverWindow === 'function'
    ? options._discoverWindow
    : () => queryLiveWindow({ ...options, lightProbe: true });

  if (!options._discoverWindow && !options._ensureLiveWindow && !options._hotInject && options.autoRecover !== false) {
    await tryAutoRecoverBeforeLaunch(options.customPath || null, { ...options, stateDir }, 'watch');
  }

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
      if (options.autoBootstrapHost) {
        const curSnap = await discoverFn();
        if (!curSnap || !curSnap.running || !curSnap.pageFound) {
          await ensureLiveWindowAvailable(options.customPath || null, options, {
            ...options,
            _queryLiveWindow: () => discoverFn()
          });
        }
      }
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
  let warnedMissingCdp = false;
  let prefetchedLive = null;

  const ensureBridgeFn = typeof options._ensureBridge === 'function'
    ? options._ensureBridge
    : (liveSnap) => ensureLiveBridgeIfNeeded(liveSnap, { ...options, stateDir });
  const hotInjectFn = typeof options._hotInject === 'function'
    ? options._hotInject
    : (injectOpts) => tryHotInjectDetailed({ ...options, ...injectOpts, stateDir });
  const hotDisposeFn = typeof options._hotDispose === 'function'
    ? options._hotDispose
    : () => tryHotDispose(options);

  if (options.autoBootstrapHost) {
    const bootstrapped = await ensureLiveWindowAvailable(options.customPath || null, options, {
      ...options,
      _queryLiveWindow: () => discoverFn()
    });
    if (bootstrapped.ok && bootstrapped.live) {
      prefetchedLive = bootstrapped.live;
    } else if (!bootstrapped.ok && bootstrapped.reason === 'port_occupied') {
      if (!options.silent) {
        console.error(`❌ [Watch] ${bootstrapped.error || 'CDP 端口被占用'}`);
      }
      exitReason = 'port_occupied';
      if (options.handleSignals !== false) {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
      cleanupLockfile();
      return {
        ok: false,
        pid: process.pid,
        replacedPid,
        exitReason,
        cycles,
        injectedCount,
        disposedCount,
        cdpPromptCount,
        selfReloaded
      };
    } else if (!bootstrapped.ok && (bootstrapped.reason === 'cdp_disabled_inside_host' || bootstrapped.reason === 'cdp_disabled_needs_relaunch' || bootstrapped.reason === 'relaunch_quit_timeout')) {
      warnedMissingCdp = true;
      cdpRestartPrompted = true;
      cdpPromptCount++;
      if (!options.silent) {
        const portArg = options.port ? ` --port ${options.port}` : '';
        console.warn('⚠️ [Watch] 检测到 Antigravity 正在运行但未开启 CDP 调试端口（v2.33.0+ 默认关闭）。');
        console.warn(`   👉 可在外部终端运行 node cli.js watch${portArg} --relaunch 一键重开守护，或手动退出客户端后执行: ${bootstrapped.manualCmd}`);
      }
    }
  }

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

      const staged = getStagedLiveRuntime({ stateDir });
      const stagedScript = staged && compareVersions(staged.version, expectedVersion) > 0 ? path.join(staged.dir, 'cli.js') : null;
      if (stagedScript || (startupHostBuildId && currentHostBuildId && currentHostBuildId !== startupHostBuildId)) {
        const isTestEnv = process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
        const shouldSelfReload = options.selfReloadOnHostChange === true ||
          (!isTestEnv && options.selfReloadOnHostChange !== false && maxCycles === Infinity);
        if (shouldSelfReload) {
          if (!options.silent) {
            console.log(`🔄 [Watch] 检测到核心宿主脚本已更新 (${startupHostBuildId} -> ${currentHostBuildId})，正在热重启守护进程...`);
          }
          await stopLiveBridge({ stateDir });
          cleanupLockfile();
          const reloadArgs = [stagedScript || expectedScript, 'watch', '--no-launch'];
          if (options.port) reloadArgs.push('--port', String(options.port));
          if (options.customPath) reloadArgs.push('--path', options.customPath);
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

      const live = prefetchedLive || await discoverFn();
      prefetchedLive = null;
      const hasWindow = Boolean(live && live.running && live.pageFound);

      if (!hasWindow) {
        if (live && live.running && live.cdpEnabled === false && !cdpRestartPrompted && !warnedMissingCdp) {
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
          if (!warnedMissingCdp && !(live && live.running && live.cdpEnabled === false)) {
            const hostRunning = await isAntigravityHostRunning(options.customPath || null, options);
            if (hostRunning) {
              warnedMissingCdp = true;
              cdpRestartPrompted = true;
              cdpPromptCount++;
              if (!options.silent) {
                let target = null;
                try { target = resolveAntigravityHostTarget(options.customPath || null, options); } catch {}
                const portHint = options.port || DEFAULT_LAUNCH_CDP_PORT;
                const portArg = options.port ? ` --port ${options.port}` : '';
                const manualCmd = formatManualCdpLaunchCommand(target, portHint);
                console.warn('⚠️ [Watch] 检测到 Antigravity 正在运行但未开启 CDP 调试端口（v2.33.0+ 默认关闭）。');
                console.warn(`   👉 可在外部终端运行 node cli.js watch${portArg} --relaunch 一键重开守护，或手动退出客户端后执行: ${manualCmd}`);
              }
            }
          }
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
      warnedMissingCdp = false;
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
  let macAsarIntegrity = null;
  if (asarPath) {
    try {
      const integ = inspectMacAsarIntegrity(asarPath, cdpOptions);
      if (integ.isMacAppBundle) macAsarIntegrity = integ;
    } catch {}
  }
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
  let hostRecovery = null;
  try {
    const { inspectHostRecoveryState } = require('./host-recovery');
    const rec = inspectHostRecoveryState({ asarPath: asarPath || customPath, stateDir: cdpOptions.stateDir || getStateDir(), ...cdpOptions });
    hostRecovery = {
      state: rec.state,
      needsRecovery: Boolean(rec.needsRecovery),
      reason: rec.reason || null,
      preflightBlocked: Boolean(rec.preflight?.blocked),
      preflightReason: rec.preflight?.reason || null,
      guidance: rec.preflight?.guidance || null,
      backupsByVersionCount: Object.keys(rec.backupsByVersion || {}).length
    };
  } catch {}
  const report = {
    pluginVersion,
    diskVersion: diskVersion || null,
    asarPath,
    antigravityVersion: version,
    asarPatched,
    ...(macAsarIntegrity ? { macAsarIntegrity } : {}),
    ...(hostRecovery ? { hostRecovery } : {}),
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
  let asarPath = null;
  try {
    asarPath = findAsarPath(customPath);
    const version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    console.log(`  - Antigravity 路径: ${asarPath} (v${version})`);
  } catch (e) {
    console.error(`  ❌ Antigravity 路径探测失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const macIntegrity = inspectMacAsarIntegrity(asarPath, cdpOptions);
  if (macIntegrity.isMacAppBundle) {
    console.log(`  - macOS ASAR 完整性 (ElectronAsarIntegrity): ${macIntegrity.hasAsarIntegrity === true ? `已启用 (${macIntegrity.integrityAlgorithm || 'SHA256'})` : (macIntegrity.hasAsarIntegrity === false ? '未启用' : '未知/不可读')}`);
    console.log(`  - macOS 代码签名: ${macIntegrity.signatureStatus}${macIntegrity.teamIdentifier ? ` (TeamIdentifier=${macIntegrity.teamIdentifier})` : ''}${macIntegrity.hardenedRuntime ? ' [Hardened Runtime]' : ''}`);
    console.log(`  - macOS 推荐入口: ${macIntegrity.recommendedEntry} (${macIntegrity.reason})`);
  }
  const py = resolvePython();
  console.log(`  - Python 附件深度解析器: ${py || '未检测到（基础上下文统计不受影响）'}`);
  let hasPreflightBlocker = false;
  try {
    const { inspectHostRecoveryState } = require('./host-recovery');
    const rec = inspectHostRecoveryState({ asarPath, stateDir: cdpOptions.stateDir || getStateDir(), ...cdpOptions });
    const recLabel = rec.state === 'healthy'
      ? '正常'
      : (rec.state === 'not_installed' ? '未安装（全新宿主）' : `⚠️ 需要恢复 (${rec.state}: ${rec.reason})`);
    console.log(`  - 宿主覆盖/恢复探测 (ELV-105): ${recLabel}`);
    console.log(`  - 入口结构与语法预检: ${rec.preflight?.structureValid ? '✅ 通过' : `❌ 未通过 (${rec.preflight?.structureStage || rec.preflight?.reason || 'unknown'})`}`);
    if (rec.needsRecovery && !rec.preflight?.blocked) {
      console.log('    建议执行: node cli.js recover');
    } else if (rec.preflight?.blocked) {
      hasPreflightBlocker = true;
      console.error(`    写前拦截 [阶段=${rec.preflight.structureStage || rec.preflight.reason || 'blocked'}]: ${rec.preflight.guidance}`);
    }
  } catch (e) {
    hasPreflightBlocker = true;
    console.error(`  ❌ 宿主结构预检异常: ${e?.message || e}`);
  }
  const queryFn = typeof cdpOptions._queryLiveWindow === 'function' ? cdpOptions._queryLiveWindow : queryLiveWindow;
  const live = await queryFn(cdpOptions);
  if (live.running && live.cdpEnabled !== false) {
    console.log(`  - 运行中窗口 CDP 状态: 已连接 (端口 ${live.cdpPort})`);
  } else {
    const procRunning = await isAntigravityHostRunning(customPath, cdpOptions);
    const hostRunning = procRunning || Boolean(live.running && live.cdpEnabled === false && live.discoverySource !== 'daemon_hub');
    if (hostRunning) {
      let target = null;
      try { target = resolveAntigravityHostTarget(customPath, cdpOptions); } catch {}
      const portHint = cdpOptions.port || DEFAULT_LAUNCH_CDP_PORT;
      const portArg = cdpOptions.port ? ` --port ${cdpOptions.port}` : '';
      const manualCmd = formatManualCdpLaunchCommand(target, portHint);
      console.log(`  - 运行中窗口状态: 客户端正在运行，但未开启 CDP 调试端口（可运行 node cli.js live${portArg} --relaunch 自动重开挂载，或手动执行: ${manualCmd}）`);
    } else {
      console.log('  - 运行中窗口 CDP 状态: 客户端未运行（运行 node cli.js live 或 watch 可自动带调试端口启动并挂载）');
    }
  }
  if (hasPreflightBlocker) {
    console.error('❌ 环境预检未通过，当前目标存在写前拦截条件，请按上方提示处理（勿直接改盘）。');
    process.exitCode = 1;
    return;
  }
  console.log('✅ 环境预检通过！');
}

async function cmdLive(customPath = null, cdpOptions = {}, options = {}) {
  if (!options._queryLiveWindow && !options._ensureLiveWindow && !options._hotInject && options.autoRecover !== false) {
    await tryAutoRecoverBeforeLaunch(customPath, cdpOptions, 'live');
  }
  const ensured = await ensureLiveWindowAvailable(customPath, cdpOptions, {
    autoLaunch: options.autoLaunch !== false,
    relaunch: Boolean(options.relaunch),
    ...options
  });
  if (!ensured.ok) {
    const portArg = cdpOptions.port ? ` --port ${cdpOptions.port}` : '';
    if (ensured.reason === 'port_occupied') {
      throw new Error(ensured.error || `指定的 CDP 端口 (${ensured.port}) 已被其他进程占用`);
    }
    if (ensured.reason === 'cdp_disabled_inside_host') {
      throw new Error(
        `检测到 Antigravity 正在运行但未开启 CDP 调试端口（v2.33.0+ 默认关闭；当前位于客户端内部会话，已阻止自动重启宿主）。请在外部终端运行: node cli.js live${portArg} --relaunch（或手动退出后执行: ${ensured.manualCmd}）`
      );
    }
    if (ensured.reason === 'cdp_disabled_needs_relaunch') {
      throw new Error(
        `检测到 Antigravity 正在运行但未开启 CDP 调试端口（v2.33.0+ 默认关闭）。请运行 node cli.js live${portArg} --relaunch 自动重开并挂载，或手动退出后执行: ${ensured.manualCmd}`
      );
    }
    if (ensured.reason === 'relaunch_quit_timeout') {
      throw new Error(
        `等待 Antigravity 优雅退出超时，未强制终止进程。请手动退出客户端后重新运行 node cli.js live（或执行: ${ensured.manualCmd}）`
      );
    }
    if (ensured.reason === 'launch_timeout') {
      throw new Error('已拉起 Antigravity，但等待主窗口 CDP 就绪超时。请待窗口加载完成后重试 node cli.js live。');
    }
    throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js watch。');
  }

  const effectiveCdpOptions = {
    ...cdpOptions,
    ...(ensured.port && !cdpOptions.port ? { port: ensured.port } : {})
  };
  const ensureBridgeFn = typeof options._ensureBridge === 'function' ? options._ensureBridge : ensureLiveBridgeIfNeeded;
  const hotInjectFn = typeof options._hotInject === 'function' ? options._hotInject : tryHotInjectDetailed;

  const bridgePrep = await ensureBridgeFn(ensured.live, effectiveCdpOptions);
  let report;
  try {
    report = await hotInjectFn({
      ...effectiveCdpOptions,
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
    throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js watch。');
  }
  if (bridgePrep.previousLiveInfo) {
    await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
  }
  if (!options.silent) {
    console.log(`✅ 已通过 CDP 热注入当前运行的 ${report.injectedCount}/${report.windowCount} 个 Antigravity 窗口！`);
  }
  return { ...report, action: ensured.action, port: ensured.port };
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
  '--path', '--backup', '--port', '--proxy-url', '--bypass', '--out', '--name',
  '--mode', '--limit', '--tier', '--title', '--context', '--brand', '--lang',
  '--account', '-a', '--model', '--session', '--cwd', '--interval', '--cli-path',
  '--ag-dir', '--cli-dir', '--state-dir'
]);

const CLI_BOOLEAN_FLAGS = new Set([
  '--force', '--all', '--cli', '--no-cli-sync', '--no-sync', '--previous', '--in-place', '--no-shortcut',
  '--today', '--week', '--month', '--json', '--compact', '--once', '--dry-run',
  '--clear', '--sync-cli-settings', '--no-open', '--relaunch', '--no-launch', '--force-mac-asar', '--disk-only',
  '--check-only', '--beta', '--silent'
]);

const CLI_KNOWN_COMMANDS = new Set([
  'install', 'update', 'recover', 'live', 'watch', 'stop-watch', 'restore', 'uninstall',
  'autostart-status', 'autostart:enable', 'autostart:disable',
  'install-cli', 'restore-cli', 'status-cli',
  'unlock-status', 'unlock', 'unlock-restore',
  'enhance-status', 'enhance', 'enhance-restore',
  'rehydrate-status', 'rehydrate:enable', 'rehydrate:disable', 'rehydrate:remove', 'rehydrate:install-python',
  'modules', 'chinese:enable', 'chinese:disable',
  'proxy:enable', 'proxy:disable', 'proxy:set', 'proxy:test', 'proxy:launch', 'proxy:launcher',
  'usage', 'monitor', 'launch-cli', 'context-set', 'context-status',
  'ui', 'dashboard', 'statusline',
  'status', 'check'
]);

const CLI_POS_ARG_COMMANDS = new Set(['proxy:set', 'proxy:test', 'proxy:launch', 'proxy:launcher']);

function printUsage() {
  console.log(`用法:
  node cli.js ui [--port <port>] [--no-open]   启动独立本地可视化看板 (仅监听 127.0.0.1，脱离桌面端独立运行)
  node cli.js statusline                      输出供终端状态行 (agy statusLine) 渲染的紧凑指标单行
  node cli.js install-cli                     适配终端直接敲 agy 即常驻显示本会话上下文 (保留代理、参数与退出码)
  node cli.js restore-cli                     无损还原 agy 启动脚本与 settings.json 状态行
  node cli.js status-cli                      查看 agy 启动链路与终端常驻监控状态
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
  node cli.js watch [--port <port>] [--relaunch] [--no-launch]  免改盘后台守护模式（未启动则自动拉起，关闭后自动退出）
  node cli.js stop-watch                    停止正在运行的 watch 守护进程与本地桥接服务
  node cli.js autostart-status              查看登录自启状态 · macOS LaunchAgent 与 Windows Run 键
  node cli.js autostart:enable [--port <port>]   写入登录自启项，登录后自动执行 watch 免改盘挂载
  node cli.js autostart:disable             移除登录自启项 · 不影响当前正在运行的 watch
  node cli.js live [--port <port>] [--relaunch] [--no-launch]   免改盘 CDP 热挂载（未开启调试端口时支持自动拉起/重开）
  node cli.js update [--check-only] [--beta] [--json]          检查或下载免改盘更新，供 live / watch 加载
  node cli.js install [--path <app.asar>] [--force-mac-asar]    一键持久化安装并热注入当前运行窗口
  node cli.js recover [--path <app.asar>] [--check-only] [--json]  检测并在宿主更新覆盖后自动备份恢复插件配置
  node cli.js status [--port <port>]        查看安装状态与当前对话实时上下文用量
  node cli.js check [--port <port>]         执行前置环境健康检查
  node cli.js restore [--all]               一键无损卸载并恢复备份 (--all 含还原内核增强)
  node cli.js proxy:launch [url] [--bypass <list>] [--port <cdp>]  免改盘直接以本地代理启动 Antigravity（不改 app.asar，跨版本可用）
  node cli.js proxy:launcher [url] [--no-shortcut]   生成独立免 TUN 启动器（Windows 默认附桌面快捷方式）
  node cli.js unlock-status [--cli] [--path <bin>]  检查桌面端与 agy CLI 上下文调整状态
  node cli.js unlock [--cli] --mode <default|fixed|dynamic> [--limit N]  调整上下文长度上限
  node cli.js unlock-restore [--cli] [--path <bin>] 恢复官方原版二进制
  node cli.js enhance-status                检查系统提示词精简与中文标题内核状态
  node cli.js enhance [--tier 0-4] [--title on|off] [--context default|512k|900k|dynamic] [--lang zh-CN|en] [--brand english|hidden|translated]
  node cli.js enhance-restore               一键还原系统提示词、英文标题与默认上下文
  node cli.js rehydrate-status              检查「改善 AGY 有损压缩」与 Python 3.10+ 状态
  node cli.js rehydrate:enable              开启「改善 AGY 有损压缩」(写入 hooks.json)
  node cli.js rehydrate:disable             停用「改善 AGY 有损压缩」(保留脚本与其他配置)
  node cli.js rehydrate:remove              卸载移除「改善 AGY 有损压缩」并清理脚本`);
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
  if (cmd === 'live' || cmd === 'watch') {
    const staged = getStagedLiveRuntime();
    if (staged && compareVersions(staged.version, PROJECT_VERSION) > 0) {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(staged.dir, 'cli.js'), ...args], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', code => resolve(code ?? 1));
      });
      process.exitCode = code;
      return;
    }
  }
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
  const isRelaunch = args.includes('--relaunch');
  const isNoLaunch = args.includes('--no-launch');
  const isForceMacAsar = args.includes('--force-mac-asar');
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
    const diskOnly = args.includes('--disk-only') || process.env.AG_EMIT_INSTALL_META === '1';
    const liveBefore = diskOnly ? {} : await queryLiveWindow(cdpOptions);
    const bridgePrep = diskOnly ? {} : await ensureLiveBridgeIfNeeded(liveBefore, cdpOptions);
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
      manifest = await install({
        path: customPath,
        backup: customBackup,
        force: isForce,
        allowIntegrityOverride: isForceMacAsar,
        hotInjectOptions,
        noHotInject: diskOnly
      });
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
  } else if (cmd === 'recover') {
    const { recoverHostInstallation } = require('./host-recovery');
    const stateDirIdx = args.indexOf('--state-dir');
    const customStateDir = stateDirIdx >= 0 ? args[stateDirIdx + 1] : null;
    const isCheckOnly = args.includes('--check-only');
    const wantJson = args.includes('--json');
    const isSilent = args.includes('--silent');
    const res = await recoverHostInstallation({
      asarPath: customPath,
      stateDir: customStateDir || undefined,
      checkOnly: isCheckOnly,
      force: isForce,
      forceMacAsar: isForceMacAsar,
      silent: isSilent
    });
    if (wantJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!isSilent) {
      if (isCheckOnly) {
        const st = res.inspected || {};
        console.log(`🔍 [ELV-105 自愈诊断] 状态: ${st.state || 'unknown'} | 宿主: v${st.hostVersion || 'unknown'} | 需要恢复: ${st.needsRecovery ? '是' : '否'}`);
        if (st.preflight?.blocked) {
          console.log(`⚠️ 写前预检拦截 (${st.preflight.reason}): ${st.preflight.guidance}`);
        }
      } else if (res.action === 'recovered') {
        console.log(`✅ [ELV-105 自愈恢复] 已恢复宿主 v${res.hostVersion} 上的插件与模块配置 (源状态: ${res.previousState})`);
        if (res.versionBackupPath) console.log(`   - 版本备份: ${res.versionBackupPath}`);
      } else if (res.action === 'noop') {
        console.log('✅ [ELV-105 自愈恢复] 当前安装完整健康，无需变更 (noop)。');
      } else if (res.action === 'blocked') {
        console.error(`❌ [ELV-105 写前拦截] ${res.guidance || res.reason}`);
      } else if (res.action === 'locked') {
        console.error(`⚠️ [ELV-105 文件被占用] ${res.error}`);
      } else {
        console.log(`ℹ️ [ELV-105 自愈] ${res.action}: ${res.reason || res.error || ''}`);
      }
    }
    if (isCheckOnly) {
      if (res.inspected?.state === 'host_missing') process.exitCode = 1;
    } else if (!res.ok && res.action !== 'skipped') {
      process.exitCode = 1;
    }
  } else if (cmd === 'update') {
    const { checkUpdateAsync, applyUpdateAsync } = require('./meter-collector');
    const flags = { liveOnly: true, ...(args.includes('--beta') ? { allowBetaUpdates: true } : {}) };
    const release = await checkUpdateAsync({ ...flags, force: true });
    if (!release.ok) throw new Error(release.error || '检查更新失败');
    const checkedOnly = args.includes('--check-only') || !release.hasUpdate;
    const result = checkedOnly ? release : await applyUpdateAsync({
      ...flags, version: release.latestVersion, allowBetaUpdates: release.allowBetaUpdates || release.prerelease
    });
    if (!result.ok) throw new Error(result.error || '免改盘更新失败');
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (result.liveStaged) console.log(`已下载并验证 v${result.version}。由 watch 自动切换，或运行 node cli.js live 加载。`);
    else if (result.hasUpdate) console.log(`发现可用版本 v${result.latestVersion}`);
    else console.log(`已是最新版本 v${result.installedVersion}`);
  } else if (cmd === 'live') {
    await cmdLive(customPath, cdpOptions, {
      relaunch: isRelaunch,
      autoRecover: getStagedLiveRuntime()?.dir !== __dirname,
      autoLaunch: !isNoLaunch
    });
  } else if (cmd === 'watch') {
    console.log('👀 [Antigravity 对话上下文查看器] 免改盘守护模式启动中（不修改 app.asar，保留官方原始签名）...');
    const res = await runWatchDaemon({
      ...cdpOptions,
      customPath,
      autoRecover: getStagedLiveRuntime()?.dir !== __dirname,
      autoBootstrapHost: !isNoLaunch,
      autoLaunch: !isNoLaunch,
      relaunch: isRelaunch
    });
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
  } else if (cmd === 'autostart-status' || cmd === 'autostart:enable' || cmd === 'autostart:disable') {
    const { getAutostartStatus, enableAutostart, disableAutostart } = require('./autostart');
    const autostartOptions = { port: cdpOptions.port };
    if (cmd === 'autostart:enable') {
      const res = await enableAutostart(autostartOptions);
      if (!res.ok) {
        console.error(`❌ 登录自启写入失败: ${res.reason || res.kind}`);
        process.exitCode = 1;
      } else if (res.action === 'already_enabled') {
        console.log(`ℹ️ 登录自启已存在，未做改动: ${res.command}`);
      } else {
        console.log(`✅ 已写入登录自启 · ${res.action}: ${res.file || 'HKCU Run 键'}`);
        console.log(`   命令: ${res.command}`);
        if (res.warning) console.log(`   ⚠️ ${res.warning}`);
        console.log('   提示: 下次登录会自动执行 watch；本会话如需立即生效，在外部终端运行 node cli.js watch。');
      }
    } else if (cmd === 'autostart:disable') {
      const res = await disableAutostart(autostartOptions);
      if (!res.ok) {
        console.error(`❌ 登录自启移除失败: ${res.reason || res.kind}`);
        process.exitCode = 1;
      } else if (res.action === 'already_disabled') {
        console.log('ℹ️ 当前没有登录自启项，无需移除。');
      } else {
        console.log(`✅ 已移除登录自启: ${res.file || 'HKCU Run 键'}`);
      }
    } else {
      const res = getAutostartStatus(autostartOptions);
      if (!res.supported) {
        console.log(`ℹ️ ${res.reason}`);
      } else {
        console.log(`🔎 登录自启状态: ${res.enabled ? '已启用' : '未启用'} · ${res.kind}`);
        if (res.file) console.log(`   - 配置位置: ${res.file}`);
        if (res.command) console.log(`   - 命令: ${res.command}`);
      }
    }
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    const restoreAll = args.includes('--all');
    const res = await restore({ path: customPath, force: isForce, ...cdpOptions });
    // 卸载时同步移除登录自启，避免登录后拉起已不存在的 watch
    if (!customPath) {
      await stopWatchDaemon();
      try {
        const { disableAutostart } = require('./autostart');
        const aRes = await disableAutostart({});
        if (!aRes.ok && aRes.supported !== false) {
          console.warn(`⚠️ 登录自启清理失败: ${aRes.reason || aRes.error || '请检查登录项'}`);
        } else if (aRes.ok && aRes.action === 'disabled') {
          console.log(`✅ 已同步移除登录自启: ${aRes.file || 'HKCU Run 键'}`);
        }
      } catch (error) {
        console.warn(`⚠️ 登录自启清理失败: ${error.message}`);
      }
    }
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
      try {
        const { restoreCliAdapter } = require('./meter-cli-adapter');
        const cRes = restoreCliAdapter({});
        if (cRes.ok && cRes.scriptRestored) {
          console.log('✅ 已同步恢复 CLI 代理启动脚本与终端状态行配置！');
        }
      } catch (e) {
        console.log(`⚠️  CLI 适配还原异常: ${e.message}`);
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
  } else if (cmd === 'rehydrate-status') {
    const { getRehydrateStatus } = require('./meter-rehydrate');
    const st = getRehydrateStatus();
    console.log('🩹 改善 AGY 有损压缩 (Post-Compact Rehydration):');
    console.log(`   - 状态: ${st.status}`);
    console.log(`   - Hook 注册: ${st.hookRegistered ? '已注册' : '未注册'}`);
    console.log(`   - 恢复脚本: ${st.scriptInstalled ? '已部署' : '未部署'}`);
    console.log(`   - Python 3.10+: ${st.pythonReady ? `就绪 (${st.pythonVersion || '可用'})` : '未就绪'}`);
  } else if (cmd === 'rehydrate:enable') {
    const { applyRehydrate } = require('./meter-rehydrate');
    const res = applyRehydrate();
    if (!res.ok) throw new Error(res.error);
    console.log('✅ 已成功开启「改善 AGY 有损压缩」！');
  } else if (cmd === 'rehydrate:disable') {
    const { disableRehydrate } = require('./meter-rehydrate');
    const res = disableRehydrate();
    if (!res.ok) throw new Error(res.error);
    console.log('⏸️ 已成功停用「改善 AGY 有损压缩」！');
  } else if (cmd === 'rehydrate:remove') {
    const { restoreRehydrate } = require('./meter-rehydrate');
    const res = restoreRehydrate({ force: true });
    if (!res.ok) throw new Error(res.error);
    console.log('🗑️ 已成功卸载移除「改善 AGY 有损压缩」！');
  } else if (cmd === 'rehydrate:install-python') {
    const { installPythonRuntimeAsync } = require('./meter-rehydrate');
    const res = await installPythonRuntimeAsync();
    if (!res.ok) throw new Error(res.error);
    console.log(`✅ Python 运行环境就绪: Python ${res.python?.version || '3.10+'} (${res.python?.executable || res.python?.command || ''})`);
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
  } else if (cmd === 'proxy:launch' || cmd === 'proxy:launcher') {
    const {
      resolveAntigravityExecutable,
      isProxyLaunchHostRunning,
      buildHostProxyLaunchSpec,
      createStandaloneNoTunLauncher,
      redactProxyUrl
    } = require('./meter-proxy');
    const { loadModulesConfig } = require('./modules-config');
    const getFlagVal = (flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
    };
    let posUrl = null;
    for (let i = 1; i < args.length; i++) {
      if (CLI_VALUE_FLAGS.has(args[i])) { i++; continue; }
      if (args[i].startsWith('-')) continue;
      posUrl = args[i];
      break;
    }
    const cfg = loadModulesConfig();
    const proxyUrl = getFlagVal('--proxy-url') || posUrl || cfg?.modules?.proxy?.proxyUrl || '';
    const bypassFlag = getFlagVal('--bypass');
    const noProxy = bypassFlag !== undefined ? bypassFlag : cfg?.modules?.proxy?.bypassList;

    if (cmd === 'proxy:launch') {
      const exePath = resolveAntigravityExecutable({ asarPath: customPath });
      if (!exePath) throw new Error('未检测到 Antigravity 可执行文件，请通过 --path 指定 app.asar 路径');
      if (isProxyLaunchHostRunning(exePath)) throw new Error('请先完整退出 Antigravity，再使用免 TUN 启动器打开');
      await tryAutoRecoverBeforeLaunch(customPath, cdpOptions, 'proxy:launch');
      const spec = buildHostProxyLaunchSpec({ proxyUrl, noProxy });
      const proxyLaunchArgs = explicitPort
        ? [...spec.args, `--remote-debugging-port=${explicitPort}`]
        : spec.args;
      const child = spawn(exePath, proxyLaunchArgs, {
        detached: true,
        stdio: 'ignore',
        env: spec.env,
        windowsHide: false
      });
      child.unref();
      console.log(`✅ 已免改盘启动 Antigravity (PID: ${child.pid || 'unknown'})`);
      console.log(`   - 可执行文件: ${exePath}`);
      console.log(`   - 本地代理: ${redactProxyUrl(spec.proxyUrl)}`);
      console.log('   - 说明: 不修改 app.asar，Antigravity 自动升级后依然可用。');
    } else {
      const res = createStandaloneNoTunLauncher({
        asarPath: customPath,
        proxyUrl,
        noProxy,
        outDir: getFlagVal('--out'),
        shortcutName: getFlagVal('--name'),
        createShortcut: !args.includes('--no-shortcut'),
        recoverCliPath: path.join(__dirname, 'cli.js')
      });
      console.log('✅ 已生成独立免 TUN 启动器（零改 app.asar，跨客户端升级有效）：');
      console.log(`   - 启动脚本: ${res.launcherPath}`);
      if (res.shortcutPath) console.log(`   - 桌面快捷方式: ${res.shortcutPath}`);
      console.log(`   - 目标程序: ${res.exePath}`);
      console.log(`   - 本地代理: ${redactProxyUrl(res.proxyUrl)}`);
    }
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
    const { saveCliModelContextPreference, parseCliWindowString } = require('./meter-cli-monitor');
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
    const parsedLimit = limitArg != null ? parseCliWindowString(limitArg) : null;
    const res = saveCliModelContextPreference({
      model: modelArg,
      mode: modeArg,
      limitTokens: parsedLimit,
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
  } else if (cmd === 'ui' || cmd === 'dashboard') {
    const { startCliUiServer } = require('./meter-cli-ui');
    const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined;
    const noOpen = args.includes('--no-open');
    const stateDirArg = args.includes('--state-dir') ? args[args.indexOf('--state-dir') + 1] : undefined;
    const srv = await startCliUiServer({
      port: portArg,
      noOpen,
      stateDir: stateDirArg
    });
    if (srv.reused) {
      console.log(`🌐 [Antigravity CLI 看板] 已复用运行中实例: ${srv.url} (PID: ${srv.pid})`);
    } else {
      console.log(`🚀 [Antigravity CLI 看板] 已启动 (仅监听 127.0.0.1): ${srv.url} (PID: ${srv.pid})`);
      console.log('   💡 脱离 Antigravity 桌面端也能独立运行与实时监控并发多 CLI 会话. 按 Ctrl+C 退出.');
      await new Promise(() => {});
    }
  } else if (cmd === 'statusline') {
    const { scanCliSessions, formatCliStatusLine, resolveCliModelContextBudget } = require('./meter-cli-monitor');
    const { getProcessSessionBinding, recordProcessSessionBinding } = require('./meter-cli-companion');
    const stateDirArg = args.includes('--state-dir') ? args[args.indexOf('--state-dir') + 1] : undefined;
    const agDirArg = args.includes('--ag-dir') ? args[args.indexOf('--ag-dir') + 1] : undefined;
    const cliDirArg = args.includes('--cli-dir') ? args[args.indexOf('--cli-dir') + 1] : undefined;
    const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
    const pidArg = args.includes('--target-pid') ? Number(args[args.indexOf('--target-pid') + 1]) : process.ppid;
    const companionPidEnv = Number(process.env.AG_METER_COMPANION_PID || 0);

    // 尝试非阻塞检查 stdin 是否传入了 JSON 数据 (例如 StatusLineData)，绝不使用同步阻塞 readFileSync(0)
    let stdinSessionId = null;
    let stdinModel = null;
    let stdinCwd = null;
    if (!process.stdin.isTTY) {
      try {
        const stdinBuf = await new Promise((resolve) => {
          let chunks = '';
          const timer = setTimeout(() => {
            try { process.stdin.pause(); } catch {}
            resolve(chunks);
          }, 80);
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', chunk => {
            chunks += chunk;
            if (chunks.includes('}') || chunks.length > 4096) {
              clearTimeout(timer);
              resolve(chunks);
            }
          });
          process.stdin.on('end', () => {
            clearTimeout(timer);
            resolve(chunks);
          });
          process.stdin.on('error', () => {
            clearTimeout(timer);
            resolve('');
          });
          process.stdin.resume();
        });
        if (stdinBuf && stdinBuf.trim().startsWith('{')) {
          const parsed = JSON.parse(stdinBuf.trim());
          stdinSessionId = parsed.session_id || parsed.sessionId || parsed.conversation_id || null;
          stdinCwd = parsed.cwd || parsed.workspace?.current_dir || parsed.workspace?.project_dir || null;
          if (typeof parsed.model === 'string') {
            stdinModel = parsed.model.trim();
          } else if (parsed.model && typeof parsed.model === 'object') {
            stdinModel = String(parsed.model.id || parsed.model.model || parsed.model.display_name || parsed.model.name || '').trim() || null;
          }
          const bindTarget = stdinSessionId || sessionArg;
          if (bindTarget) {
            if (pidArg) {
              recordProcessSessionBinding({ pid: pidArg, sessionId: bindTarget, cwd: stdinCwd, stateDir: stateDirArg });
            }
            if (Number.isInteger(companionPidEnv) && companionPidEnv > 0 && companionPidEnv !== pidArg) {
              recordProcessSessionBinding({ pid: companionPidEnv, sessionId: bindTarget, cwd: stdinCwd, stateDir: stateDirArg });
            }
          }
        }
      } catch {}
    }

    const scan = scanCliSessions({ stateDir: stateDirArg, agDir: agDirArg, agCliDir: cliDirArg });
    let currentSession = null;

    // 1. 优先通过显式传入的 --session 绑定
    if (sessionArg) {
      currentSession = scan.sessions?.find(s => s.sessionId === sessionArg || s.shortId === sessionArg) || null;
    }
    // 2. 其次通过 stdin 传入的 session_id 绑定
    if (!currentSession && stdinSessionId) {
      currentSession = scan.sessions?.find(s => s.sessionId === stdinSessionId) || null;
    }
    // 3. 再次通过进程绑定注册表 (PPID / targetPid / companionPid) 查找
    if (!currentSession) {
      const pidList = [pidArg, companionPidEnv].filter(p => Number.isInteger(p) && p > 0);
      for (const p of pidList) {
        const binding = getProcessSessionBinding(p, { stateDir: stateDirArg });
        if (binding && binding.sessionId) {
          currentSession = scan.sessions?.find(s => s.sessionId === binding.sessionId) || null;
          if (currentSession) break;
        }
      }
    }

    // 4. 若 stdin 传来已绑定会话的最新模型（例如首轮尚未落盘 ledger 或刚切换模型），同步重算模型上限
    if (currentSession && stdinModel) {
      const budget = resolveCliModelContextBudget([stdinModel, currentSession.model, currentSession.modelLabel], {
        stateDir: stateDirArg,
        agCliDir: cliDirArg
      });
      if (budget.limitTokens) {
        currentSession = {
          ...currentSession,
          model: stdinModel,
          contextLimitTokens: budget.limitTokens,
          contextLimitSource: budget.budgetSource,
          contextPercent: currentSession.contextUsedTokens !== null
            ? Math.min(999, Math.round((currentSession.contextUsedTokens / budget.limitTokens) * 1000) / 10)
            : null
        };
      }
    }

    // 5. 严格防串线约束：若绑定尚未建立，保持 currentSession = null，显示等待当前会话，严禁借用其他会话数字
    const line = formatCliStatusLine(currentSession);
    process.stdout.write(line + '\n');
  } else if (cmd === 'install-cli' || (cmd === 'install' && isCliTarget)) {
    const { installCliAdapter } = require('./meter-cli-adapter');
    const proxyArg = args.includes('--proxy-script') ? args[args.indexOf('--proxy-script') + 1] : undefined;
    const res = installCliAdapter({ proxyScript: proxyArg });
    if (!res.ok) {
      throw new Error(res.error || 'CLI 终端常驻适配安装失败');
    }
    console.log(`✅ [Antigravity CLI 常驻监控] 安装成功:`);
    console.log(`   - 代理入口脚本: ${res.proxyScript} (已备份至 ${path.basename(res.backupPath)})`);
    console.log(`   - 状态行联动: ${res.statusLineConfigured ? `已注入 ${res.settingsPath}` : '未配置'}`);
    console.log(`   - 终端生效: 普通 CMD / PowerShell 直接输入 agy 即可在窗口标题栏与状态行实时常驻显示上下文！`);
  } else if (cmd === 'restore-cli' || (cmd === 'restore' && isCliTarget)) {
    const { restoreCliAdapter } = require('./meter-cli-adapter');
    const proxyArg = args.includes('--proxy-script') ? args[args.indexOf('--proxy-script') + 1] : undefined;
    const res = restoreCliAdapter({ proxyScript: proxyArg });
    if (!res.ok) {
      throw new Error(res.error || 'CLI 终端常驻适配还原失败');
    }
    console.log(`✅ [Antigravity CLI 常驻监控] 已无损还原:`);
    console.log(`   - 代理脚本还原: ${res.scriptRestored ? '已恢复官方原版/备份' : '无需变更'}`);
    console.log(`   - 状态行配置还原: ${res.statusLineRestored ? '已清理 settings.json' : '未配置'}`);
  } else if (cmd === 'status-cli') {
    const { statusCliAdapter } = require('./meter-cli-adapter');
    const st = statusCliAdapter();
    console.log(`🔍 [Antigravity CLI 启动链路与监控状态]`);
    console.log(`   - 代理入口: ${st.proxyScript || '未检测到'}`);
    console.log(`   - 常驻监视状态: ${st.isAdapted ? '已挂接伴随监视' : '未挂接'}`);
    console.log(`   - 原版备份存在: ${st.backupExists ? '是' : '否'}`);
    console.log(`   - agy statusLine 钩子: ${st.statusLineConfigured ? '已启用' : '未启用'}`);
    if (st.chainInfo?.chain?.length) {
      console.log(`   - 完整启动链路:`);
      for (const p of st.chainInfo.chain) {
        console.log(`     * ${p}`);
      }
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
  cmdLive,
  ensureLiveWindowAvailable,
  isRunningInsideAntigravitySession,
  resolveAntigravityHostTarget,
  isAntigravityHostRunning,
  pickAvailableCdpPort,
  launchAntigravityHostWithCdp,
  quitAntigravityHostGracefully,
  confirmInteractiveRelaunch,
  waitForLiveWindowReady,
  ensureLiveBridgeIfNeeded,
  rollbackPreparedLiveBridge,
  stopLiveBridge,
  buildWin32DetachedBridgePowerShellScript,
  launchBridgeViaWin32Wmi,
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
