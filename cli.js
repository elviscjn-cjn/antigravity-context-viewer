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
const { spawn } = require('child_process');
const { loadAsarEngine, getStateDir } = require('./asar-engine');
const { install, findAsarPath, tryHotInject, tryHotInjectDetailed, probeLiveHostRuntimeInfo, shutdownLiveHostGracefully, extractAsarFile } = require('./install');
const { restore } = require('./restore');
const { resolvePython, syncLiveRuntimeBundle } = require('./meter-collector');
const { redactProxyUrl } = require('./meter-proxy');
const { analyzeBinary, analyzeBinaryAsync, applyUnlock, restoreUnlock, AUTHOR_INFO } = require('./meter-context-unlock');

const asar = loadAsarEngine();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function getDevToolsPort() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

async function queryLiveWindow() {
  const port = getDevToolsPort();
  if (!port) return { running: false };
  try {
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, { agent: false }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const matchedTargets = pages.filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    const target = matchedTargets[0];
    if (!target) return { running: true, cdpPort: port, pageFound: false, origins: [] };
    const origin = new URL(target.url).origin;
    const origins = Array.from(new Set(matchedTargets.map(p => { try { return new URL(p.url).origin; } catch { return null; } }).filter(Boolean)));

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('message', ev => {
        const d = JSON.parse(ev.data);
        if (d.id === 1) {
          clearTimeout(timer);
          resolve(d.result?.result?.value || null);
        }
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(async () => {
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
          })()`,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
    ws.close();
    return { running: true, cdpPort: port, pageFound: true, origin, origins, windowCount: matchedTargets.length, ...status };
  } catch (e) {
    return { running: false, error: e.message };
  }
}

async function ensureLiveBridgeIfNeeded(liveSnapshot = null) {
  const live = liveSnapshot || await queryLiveWindow();
  if (!live.running || !live.pageFound) {
    return { needed: false, ready: false, reason: 'no_running_window', liveInfo: null, previousLiveInfo: null };
  }
  let currentPkgVersion = null;
  try {
    currentPkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
  } catch {}

  const stateDir = getStateDir();
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

  if (existingInfo && existingInfo.pid) {
    const info = existingInfo;
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    if (pidAlive && coversAllOrigins(info) && info.hasQuota && (!currentPkgVersion || info.version === currentPkgVersion)) {
      const probe = await probeLiveHostRuntimeInfo(info, expectedOrigins[0]);
      if (probe && probe.ok && (!currentPkgVersion || probe.backendVersion === currentPkgVersion)) {
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
          const probe = await probeLiveHostRuntimeInfo(cand, expectedOrigins[0]);
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

async function cmdStatus(customPath) {
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

  const live = await queryLiveWindow();
  let liveSessionInfo = null;
  try {
    const lp = path.join(getStateDir(), '.live-session.json');
    if (fs.existsSync(lp)) {
      const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
      liveSessionInfo = { port: raw.port, pid: raw.pid, version: raw.version, backendSource: raw.backendSource || 'live-host', origins: raw.origins || (raw.origin ? [raw.origin] : []) };
    }
  } catch {}
  const py = resolvePython();
  const report = {
    pluginVersion,
    diskVersion: diskVersion || null,
    asarPath,
    antigravityVersion: version,
    asarPatched,
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

async function cmdCheck(customPath) {
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
  const live = await queryLiveWindow();
  console.log(`  - 运行中窗口 CDP 状态: ${live.running ? `已连接 (端口 ${live.cdpPort})` : '客户端未运行或未开启调试端口'}`);
  console.log('✅ 环境预检通过！');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args.find(a => !a.startsWith('-')) || 'install').toLowerCase();
  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;
  const backupIdx = args.indexOf('--backup');
  const customBackup = backupIdx >= 0 ? args[backupIdx + 1] : null;
  const isForce = args.includes('--force');

  if (cmd === 'install') {
    const meterVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`🚀 [Antigravity 对话上下文查看器 v${meterVersion}] 正在安装上下文可视化组件...`);
    const liveBefore = await queryLiveWindow();
    const bridgePrep = await ensureLiveBridgeIfNeeded(liveBefore);
    const hotInjectOptions = {
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
    const liveBefore = await queryLiveWindow();
    const bridgePrep = await ensureLiveBridgeIfNeeded(liveBefore);
    let report;
    try {
      report = await tryHotInjectDetailed({
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
      throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js install。');
    }
    if (bridgePrep.previousLiveInfo) {
      await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
    }
    console.log(`✅ 已通过 CDP 热注入当前运行的 ${report.injectedCount}/${report.windowCount} 个 Antigravity 窗口！`);
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    const restoreAll = args.includes('--all');
    const res = await restore({ path: customPath, force: isForce });
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
  } else if (cmd === 'status') {
    await cmdStatus(customPath);
  } else if (cmd === 'check') {
    await cmdCheck(customPath);
  } else {
    console.log(`用法:
  node cli.js install [--path <app.asar>]   一键持久化安装并热注入当前运行窗口
  node cli.js live                          免改盘 CDP 热挂载到当前运行窗口
  node cli.js status                        查看安装状态与当前对话实时上下文用量
  node cli.js check                         执行前置环境健康检查
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

module.exports = { cmdStatus, cmdCheck, rollbackPreparedLiveBridge };
