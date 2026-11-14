#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI
 * Cross-platform installer, live CDP hot-injector, background auto-attach watcher, and lifecycle manager
 * Format aligned with antigravity-chinese for one-command human & AI Agent execution.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadAsarEngine, getStateDir } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient, parseExplicitPort } = require('./local-api');
const { install, findAsarPath, tryHotInject } = require('./install');
const { restore, tryHotDispose } = require('./restore');
const { resolvePython } = require('./meter-collector');
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

function readWatchPid(stateDir = null) {
  const pidPath = getWatchPidPath(stateDir);
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.pid);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
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
  if (fs.existsSync(liveSessionPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
      existingInfo = info;
      if (isPidAliveForUser(info.pid) && (!live.origin || info.origin === live.origin)) {
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
    const liveHostScript = options.liveHostScript || path.join(__dirname, 'live-host.js');
    const child = spawner(process.execPath, [liveHostScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv
    });
    child.unref?.();

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
 * 随 Antigravity 中文.app 启动自动挂载顶部栏组件，并在客户端关闭后自动退出。
 */
async function runWatchDaemon(options = {}) {
  const { readWatchConfigSnapshot } = require('./modules-config');
  const stateDir = options.stateDir || getStateDir();
  const pidPath = getWatchPidPath(stateDir);

  // 1. 单实例 PID 互斥锁检查：若同用户已有存活的 watch 守护进程，干净退出 (0)
  const existingPid = readWatchPid(stateDir);
  if (existingPid && existingPid !== process.pid && isPidAliveForUser(existingPid)) {
    if (!options.silent) {
      console.log(`ℹ️ [Watch] 已有运行中的守护进程 (PID ${existingPid})，本次实例自动退出。`);
    }
    return { ok: true, alreadyRunning: true, pid: existingPid };
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');

  const startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.AG_WATCH_STARTUP_TIMEOUT_MS || 60000);
  const startupPollMs = options.startupPollMs ?? Number(process.env.AG_WATCH_STARTUP_POLL_MS || 1000);
  const pollIntervalMs = options.pollIntervalMs ?? Number(process.env.AG_WATCH_POLL_MS || 3000);
  const maxConsecutiveMisses = options.maxConsecutiveMisses ?? Number(process.env.AG_WATCH_MAX_MISSES || 3);
  const maxCycles = options.maxCycles ?? Infinity;

  let stopped = false;
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
      if (readWatchPid(stateDir) === process.pid && fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath);
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
        // topbar (默认 Mode 1) 或 both (双模式)：按需启动 live-host 并在组件缺失时自动热挂载
        let needsBridge = false;
        let needsInject = false;
        for (const target of discovered.targets) {
          let client = null;
          try {
            client = await createCdpClient(target.webSocketDebuggerUrl, options);
            const st = await client.evaluateValue(`(() => ({
              active: Boolean(window.__AGContextMeter),
              hasIpcBridge: Boolean(window.contextMeterAPI?.scan)
            }))()`, { timeoutMs: 3500 });
            if (!st?.hasIpcBridge) needsBridge = true;
            if (!st?.active) needsInject = true;
          } catch {} finally {
            if (client) { try { client.close(); } catch {} }
          }
        }

        if (needsBridge && !options.skipLiveHost) {
          await ensureLiveBridgeIfNeeded({
            ...options,
            stateDir,
            _liveSnapshot: {
              running: true,
              pageFound: true,
              cdpPort: discovered.port,
              origin: discovered.origin,
              hasIpcBridge: false
            }
          });
        }

        if (needsInject) {
          const injected = await tryHotInject({
            ...options,
            port: discovered.port,
            onlyIfAbsent: true
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
    await stopLiveBridge({ stateDir });
    cleanupLockfile();
  }

  return {
    ok: true,
    alreadyRunning: false,
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
  const watchPid = readWatchPid(stateDir);
  let watchStopped = false;

  if (watchPid && isPidAliveForUser(watchPid)) {
    watchStopped = await terminateProcessGracefully(watchPid, 2500);
  }
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
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
  let cmd = 'install';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--path' || a === '--backup' || a === '--port' || a === '--proxy-url') {
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
    await stopWatchDaemon();
    const res = await restore({ path: customPath, force: isForce, ...cdpOptions });
    console.log(`✅ 已完成卸载还原: ${res.restored}`);
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
    console.log('🔍 正在检测 Antigravity 后端上下文加长状态...');
    const st = await analyzeBinaryAsync(customPath);
    console.log(`- 目标文件: ${st.targetPath || '未检测到'}`);
    console.log(`- 目标架构: ${st.arch || '未知'} (${st.format || '未知'}, ${st.mode || '未知'})`);
    console.log(`- 解锁状态: [${st.statusText || st.status}] ${st.details || st.reason || ''}`);
    if (st.backupInfo) {
      console.log(`- 备份文件: ${st.backupInfo.backupPath}`);
    }
    console.log(`- ${st.author?.credit || AUTHOR_INFO.credit} (${st.author?.url || AUTHOR_INFO.url})`);
  } else if (cmd === 'unlock') {
    console.log('⚡ 正在执行 Antigravity 后端上下文加长解锁...');
    console.log(`ℹ ${AUTHOR_INFO.credit} (${AUTHOR_INFO.url})`);
    console.log(`⚠️  ${AUTHOR_INFO.disclaimer}`);
    const res = applyUnlock({ targetPath: customPath });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '解锁成功！'}`);
    if (res.backupPath) console.log(`📁 原版备份已安全保存至: ${res.backupPath}`);
  } else if (cmd === 'unlock-restore') {
    console.log('🔄 正在恢复 Antigravity 官方原版后端二进制...');
    const res = restoreUnlock({ targetPath: customPath });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '恢复完成！'}`);
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
    saveModulesConfig(cfg);
    await install({ path: customPath, modules: { chinese: { enabled: enable } }, ...cdpOptions });
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
  node cli.js restore                       一键无损卸载并恢复备份
  node cli.js unlock-status [--path <bin>]  检查 Antigravity 后端上下文加长状态
  node cli.js unlock [--path <bin>]         执行上下文加长解锁（解除 256K 限制）
  node cli.js unlock-restore [--path <bin>] 恢复官方原版二进制`);
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
  readWatchPid,
  tryHotDispose
};
