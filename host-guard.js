'use strict';
/**
 * 宿主更新后常驻守护与自动恢复引擎 (Issue #112 / ELV-105 延伸)
 * 职责：
 * 1. 管理一次性启用与停用的常驻守护配置、稳定持久化运行包 (stateDir/live-runtime) 与 Windows 无窗静默启动封装；
 * 2. 提供按安装目标隔离的单实例锁、文件变更去抖稳定观测、同一新版覆盖事件单次处置与安全窗口自动恢复状态机；
 * 3. 在宿主进程运行或未开启 CDP 时严禁强杀或抢改锁定文件：有受支持回环通道先走热挂载，退出后再安全补做磁盘恢复；
 * 4. 在 macOS 上严格保持官方 app.asar、Info.plist 与签名零修改，仅执行免改盘热挂载与边界状态报告；
 * 5. 输出分层可观测状态与脱敏诊断日志 (stateDir/host-guard.log)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  getStateDir,
  isIsolatedTestPath,
  resolveAsarTarget,
  computeAsarTargetKey,
  normalizeTargetPathForCompare
} = require('./asar-engine');
const {
  PROJECT_VERSION,
  loadModulesConfig,
  saveModulesConfig
} = require('./modules-config');
const { safeWriteJsonSync } = require('./meter-storage');
const { inspectHostRecoveryState, recoverHostInstallation } = require('./host-recovery');
const {
  resolveNodePath,
  getAutostartStatus,
  enableAutostart,
  disableAutostart
} = require('./autostart');

const MAX_GUARD_LOG_BYTES = 512 * 1024;
const WINDOWS_SILENT_LAUNCHER_NAME = 'host-guard-launcher.vbs';

function readFallbackWatchPid(stateDir) {
  try {
    const pidPath = path.join(stateDir, 'watch.pid');
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

async function stopPidGracefully(pid, graceMs = 2000) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid || !isPidAlive(n)) return false;
  try { process.kill(n, 'SIGTERM'); } catch { return false; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(n)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  if (isPidAlive(n)) {
    try { process.kill(n, 'SIGKILL'); } catch {}
  }
  return true;
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function redactDiagnosticText(value) {
  let str = String(value ?? '');
  // 脱敏常见凭据与邮箱，避免诊断日志泄露敏感信息
  str = str.replace(/(authorization|bearer|token|cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  str = str.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  return str;
}

function getGuardLogPath(stateDir = null) {
  const dir = stateDir ? path.resolve(String(stateDir)) : getStateDir();
  return path.join(dir, 'host-guard.log');
}

function getGuardIndexPath(stateDir = null) {
  const dir = stateDir ? path.resolve(String(stateDir)) : getStateDir();
  return path.join(dir, 'host-guard-state.json');
}

function getTargetGuardPaths(stateDir = null, targetKey = 'default') {
  const dir = stateDir ? path.resolve(String(stateDir)) : getStateDir();
  const safeKey = String(targetKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  const targetDir = path.join(dir, 'targets', safeKey);
  return {
    stateDir: dir,
    targetKey: safeKey,
    targetDir,
    lockPath: path.join(targetDir, 'guard.lock'),
    statePath: path.join(targetDir, 'guard-state.json'),
    indexPath: getGuardIndexPath(dir),
    logPath: getGuardLogPath(dir),
    vbsLauncherPath: path.join(dir, WINDOWS_SILENT_LAUNCHER_NAME)
  };
}

function appendGuardDiagnosticLog(stateDir, entry = {}) {
  try {
    const logPath = getGuardLogPath(stateDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath)) {
      const st = fs.statSync(logPath);
      if (st.size > MAX_GUARD_LOG_BYTES) {
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean).slice(-200);
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
      }
    }
    const sanitized = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event: String(entry.event || 'info'),
      ...(entry.targetKey ? { targetKey: String(entry.targetKey) } : {}),
      ...(entry.hostVersion ? { hostVersion: String(entry.hostVersion) } : {}),
      ...(entry.status ? { status: String(entry.status) } : {}),
      ...(entry.reason ? { reason: redactDiagnosticText(entry.reason) } : {}),
      ...(entry.action ? { action: String(entry.action) } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: Number(entry.durationMs) } : {}),
      ...(entry.asarSha256Prefix ? { asarSha256Prefix: String(entry.asarSha256Prefix).slice(0, 16) } : {}),
      ...(entry.detail ? { detail: redactDiagnosticText(entry.detail) } : {})
    };
    fs.appendFileSync(logPath, JSON.stringify(sanitized) + '\n', 'utf8');
    return logPath;
  } catch {
    return null;
  }
}

function readTargetGuardState(stateDir, targetKey = 'default') {
  const paths = getTargetGuardPaths(stateDir, targetKey);
  try {
    if (fs.existsSync(paths.statePath)) {
      const parsed = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return null;
}

function writeTargetGuardState(stateDir, targetKey, patch = {}) {
  const paths = getTargetGuardPaths(stateDir, targetKey);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  const prev = readTargetGuardState(stateDir, targetKey) || {};
  const next = {
    ...prev,
    ...patch,
    targetKey: paths.targetKey,
    updatedAt: new Date().toISOString()
  };
  safeWriteJsonSync(paths.statePath, next);

  try {
    let idx = { targets: {} };
    if (fs.existsSync(paths.indexPath)) {
      const raw = JSON.parse(fs.readFileSync(paths.indexPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        idx = { ...raw, targets: (raw.targets && typeof raw.targets === 'object') ? { ...raw.targets } : {} };
      }
    }
    idx.lastTargetKey = paths.targetKey;
    idx.updatedAt = next.updatedAt;
    idx.targets[paths.targetKey] = {
      targetKey: paths.targetKey,
      targetPath: next.targetPath || null,
      targetSource: next.targetSource || null,
      status: next.status || 'idle',
      waitingReason: next.waitingReason || null,
      hostVersion: next.hostVersion || null,
      daemonPid: next.daemonPid || null,
      lastRecovery: next.lastRecovery || null,
      updatedAt: next.updatedAt
    };
    safeWriteJsonSync(paths.indexPath, idx);
  } catch {}

  return next;
}

function readTargetGuardLock(stateDir, targetKey = 'default') {
  const paths = getTargetGuardPaths(stateDir, targetKey);
  try {
    if (!fs.existsSync(paths.lockPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(paths.lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { ...parsed, pid };
  } catch {
    return null;
  }
}

function writeTargetGuardLock(stateDir, targetKey, info = {}) {
  const paths = getTargetGuardPaths(stateDir, targetKey);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  let defaultRepo = null;
  try { defaultRepo = require('./meter-collector').OFFICIAL_REPO || null; } catch {}
  const payload = {
    pid: Number(info.pid || process.pid),
    targetKey: paths.targetKey,
    targetPath: info.targetPath ? path.resolve(String(info.targetPath)) : null,
    mode: info.mode || 'persistent',
    script: info.script || null,
    version: info.version || PROJECT_VERSION,
    repo: info.repo !== undefined ? info.repo : defaultRepo,
    buildId: info.buildId || null,
    startedAt: info.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  safeWriteJsonSync(paths.lockPath, payload);
  return payload;
}

function releaseTargetGuardLock(stateDir, targetKey, expectedPid = process.pid) {
  const paths = getTargetGuardPaths(stateDir, targetKey);
  try {
    const cur = readTargetGuardLock(stateDir, targetKey);
    if (cur && cur.pid === Number(expectedPid) && fs.existsSync(paths.lockPath)) {
      fs.unlinkSync(paths.lockPath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * 同步并定位宿主更新不会覆盖的持久化运行包 (stateDir/live-runtime/cli.js)
 */
function ensureStableGuardRuntime(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const sourceDir = options.sourceDir ? path.resolve(String(options.sourceDir)) : __dirname;
  const runtimeDir = path.join(stateDir, 'live-runtime');
  const stableCliPath = path.join(runtimeDir, 'cli.js');
  let synced = false;
  try {
    const { syncLiveRuntimeBundle } = require('./meter-collector');
    const outDir = syncLiveRuntimeBundle(sourceDir, { version: options.version || PROJECT_VERSION, stateDir });
    if (outDir && fs.existsSync(path.join(outDir, 'cli.js'))) {
      synced = true;
    }
  } catch {}
  const cliPath = fs.existsSync(stableCliPath)
    ? stableCliPath
    : path.join(sourceDir, 'cli.js');
  return {
    stateDir,
    runtimeDir,
    cliPath: path.resolve(cliPath),
    isStableRuntime: fs.existsSync(stableCliPath),
    synced
  };
}

function escapeVbsString(value) {
  return String(value ?? '').replace(/"/g, '""');
}

/**
 * 构造纯 ASCII 的 VBScript 字符串表达式：ASCII 原样加引号，非 ASCII（如中文路径）转为 ChrW(码点)，
 * 确保 wscript.exe 在任意系统 ANSI 代码页下都能无损还原 Unicode 路径且不破坏 UTF-8 文件读取。
 */
function buildVbsStringExpr(value) {
  const s = String(value ?? '');
  if (!/[^\x20-\x7e]/.test(s)) {
    return `"${escapeVbsString(s)}"`;
  }
  const parts = [];
  let asciiBuf = '';
  const flushAscii = () => {
    if (asciiBuf) {
      parts.push(`"${escapeVbsString(asciiBuf)}"`);
      asciiBuf = '';
    }
  };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      asciiBuf += s[i];
    } else {
      flushAscii();
      parts.push(`ChrW(${code})`);
    }
  }
  flushAscii();
  return parts.length ? parts.join(' & ') : '""';
}

function quoteWinCmdArg(value) {
  const s = String(value ?? '');
  return /[\s"]/u.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * 在用户状态目录生成 Windows 无窗静默 VBScript 启动封装，彻底避免登录后或后台重建弹出黑框 (Issue #78)
 */
function ensureWindowsSilentLauncher(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const vbsPath = path.join(stateDir, WINDOWS_SILENT_LAUNCHER_NAME);
  const nodePath = resolveNodePath(options.nodePath);
  const cliPath = path.resolve(options.cliPath || path.join(stateDir, 'live-runtime', 'cli.js'));
  const args = [cliPath, 'watch', '--persistent', '--no-launch', '--silent'];
  if (options.targetPath) args.push('--path', path.resolve(String(options.targetPath)));
  if (options.port) args.push('--port', String(options.port));
  if (options.liveOnly) args.push('--live-only');
  if (options.stateDir) args.push('--state-dir', stateDir);

  const cmdLine = [quoteWinCmdArg(nodePath), ...args.map(quoteWinCmdArg)].join(' ');
  const vbsContent = [
    '\' Antigravity Context Meter silent host-guard launcher',
    'Option Explicit',
    'Dim shell, cmd',
    'Set shell = CreateObject("WScript.Shell")',
    `cmd = ${buildVbsStringExpr(cmdLine)}`,
    'shell.Run cmd, 0, False',
    'Set shell = Nothing'
  ].join('\r\n') + '\r\n';

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(vbsPath, vbsContent, 'utf8');
  return {
    vbsPath,
    cmdLine,
    runCommand: `wscript.exe //B //NoLogo "${vbsPath}"`
  };
}

function removeWindowsSilentLauncher(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const vbsPath = path.join(stateDir, WINDOWS_SILENT_LAUNCHER_NAME);
  try {
    if (fs.existsSync(vbsPath)) {
      fs.unlinkSync(vbsPath);
      return true;
    }
  } catch {}
  return false;
}

function createGuardTracker() {
  return {
    lastFileSig: null,
    stableCount: 0,
    unreadableRetries: 0,
    hostWasRunning: false,
    pendingDiskRecoveryAfterExit: false,
    lastProcessedSha: null,
    lastProcessedStatus: null
  };
}

/**
 * 单步执行常驻守护的宿主更新观测、去抖与安全自动恢复状态机。
 * 规则：
 * - 文件暂缺或大小/时间戳仍在变化时仅静默等待，绝不抢写或回写旧备份；
 * - 同一目标与同一 ASAR SHA-256 覆盖事件只处置一次，避免失败死循环；
 * - 宿主正在运行或文件被锁定时绝不强杀或覆盖，转入 waiting_host_exit_for_recovery；
 * - macOS 或 liveOnly 模式绝不修改 app.asar，保持官方签名完整；
 * - 用户主动关闭宿主后保持关闭，绝不反复拉起宿主。
 */
async function evaluateGuardTick(ctx = {}) {
  const stateDir = ctx.stateDir ? path.resolve(String(ctx.stateDir)) : getStateDir();
  const platform = ctx.platform || process.platform;
  const customPath = ctx.customPath || null;
  const liveOnly = Boolean(ctx.liveOnly || platform === 'darwin');
  const debounceStableChecks = Math.max(1, Number(ctx.debounceStableChecks ?? 2));
  const maxUnreadableRetries = Math.max(1, Number(ctx.maxUnreadableRetries ?? 3));
  const tracker = ctx.tracker || createGuardTracker();

  const resolveFn = typeof ctx._resolveTarget === 'function'
    ? ctx._resolveTarget
    : () => resolveAsarTarget(customPath, {
      stateDir,
      platform,
      homeDir: ctx.homeDir,
      localAppData: ctx.localAppData,
      programFiles: ctx.programFiles,
      extraCandidates: ctx.extraCandidates,
      env: ctx.env
    });

  const resolved = resolveFn();
  const targetPath = resolved?.asarPath || (customPath ? path.resolve(String(customPath)) : null);
  const targetKey = resolved?.targetKey || (targetPath ? computeAsarTargetKey(targetPath) : 'default');
  const targetSource = resolved?.source || 'not_found';

  const persisted = readTargetGuardState(stateDir, targetKey) || {};
  if (!tracker.lastProcessedSha && persisted.lastProcessedSha) {
    tracker.lastProcessedSha = persisted.lastProcessedSha;
    tracker.lastProcessedStatus = persisted.lastProcessedStatus || null;
  }

  const statFn = typeof ctx._statFile === 'function'
    ? ctx._statFile
    : (p) => (p && fs.existsSync(p) ? fs.statSync(p) : null);

  let fileStat = null;
  try {
    fileStat = targetPath ? statFn(targetPath) : null;
  } catch {
    fileStat = null;
  }

  if (!targetPath || !fileStat) {
    tracker.lastFileSig = null;
    tracker.stableCount = 0;
    const isTransient = Boolean(persisted.targetPath || customPath || tracker.hostWasRunning);
    const nextStatus = isTransient ? 'waiting_host_update_stable' : 'host_missing';
    const waitingReason = isTransient ? 'target_temporarily_missing' : (resolved?.error || 'host_missing');
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      status: nextStatus,
      waitingReason,
      daemonPid: process.pid
    });
    return {
      ok: true,
      action: isTransient ? 'wait_update_stable' : 'host_missing',
      status: nextStatus,
      waitingReason,
      targetKey,
      targetPath,
      targetSource
    };
  }

  const fileSig = `${fileStat.size}:${Math.floor(Number(fileStat.mtimeMs) || 0)}`;
  if (tracker.lastFileSig !== fileSig) {
    tracker.lastFileSig = fileSig;
    tracker.stableCount = 1;
    tracker.unreadableRetries = 0;
    if (debounceStableChecks > 1) {
      writeTargetGuardState(stateDir, targetKey, {
        targetPath,
        targetSource,
        status: 'waiting_host_update_stable',
        waitingReason: 'file_write_stabilizing',
        asarSize: fileStat.size,
        asarMtimeMs: fileStat.mtimeMs,
        daemonPid: process.pid
      });
      return {
        ok: true,
        action: 'wait_debounce',
        status: 'waiting_host_update_stable',
        waitingReason: 'file_write_stabilizing',
        targetKey,
        targetPath,
        targetSource
      };
    }
  } else {
    tracker.stableCount += 1;
    if (tracker.stableCount < debounceStableChecks) {
      return {
        ok: true,
        action: 'wait_debounce',
        status: 'waiting_host_update_stable',
        waitingReason: 'file_write_stabilizing',
        targetKey,
        targetPath,
        targetSource
      };
    }
  }

  const inspectFn = typeof ctx._inspectRecovery === 'function'
    ? ctx._inspectRecovery
    : (opts) => inspectHostRecoveryState(opts);
  const inspected = inspectFn({
    asarPath: targetPath,
    stateDir,
    _platform: platform,
    _existsSync: ctx._existsSync,
    _readFileSync: ctx._readFileSync,
    _execFileSync: ctx._execFileSync,
    includeAsarSha256: true
  });

  const isHostRunningFn = typeof ctx._isHostRunning === 'function'
    ? ctx._isHostRunning
    : async () => {
      const cli = require('./cli');
      return cli.isAntigravityHostRunning(targetPath, { platform });
    };
  const hostRunning = Boolean(await isHostRunningFn(targetPath));
  const hostJustClosed = tracker.hostWasRunning && !hostRunning;
  tracker.hostWasRunning = hostRunning;

  if (inspected.state === 'partial_or_corrupted' && inspected.reason === 'host_asar_corrupted_or_unreadable') {
    tracker.unreadableRetries += 1;
    if (tracker.unreadableRetries < maxUnreadableRetries) {
      writeTargetGuardState(stateDir, targetKey, {
        targetPath,
        targetSource,
        status: 'waiting_host_update_stable',
        waitingReason: 'asar_incomplete_waiting_write',
        daemonPid: process.pid
      });
      return {
        ok: true,
        action: 'wait_incomplete_write',
        status: 'waiting_host_update_stable',
        waitingReason: 'asar_incomplete_waiting_write',
        targetKey,
        targetPath,
        inspected
      };
    }
  } else {
    tracker.unreadableRetries = 0;
  }

  if (inspected.state === 'healthy') {
    tracker.pendingDiskRecoveryAfterExit = false;
    const status = hostRunning ? 'healthy' : (hostJustClosed || persisted.status === 'host_closed_by_user' ? 'host_closed_by_user' : 'healthy');
    const waitingReason = status === 'host_closed_by_user' ? 'host_closed_stay_closed' : null;
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      diskRendererBuildId: inspected.diskRendererBuildId || null,
      asarSha256: inspected.asarSha256 || null,
      status,
      waitingReason,
      hostRunning,
      daemonPid: process.pid
    });
    return {
      ok: true,
      action: 'healthy',
      status,
      waitingReason,
      hostRunning,
      targetKey,
      targetPath,
      inspected
    };
  }

  if (inspected.state === 'not_installed') {
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status: 'not_installed',
      waitingReason: 'no_prior_installation',
      hostRunning,
      daemonPid: process.pid
    });
    return {
      ok: true,
      action: 'noop_not_installed',
      status: 'not_installed',
      waitingReason: 'no_prior_installation',
      hostRunning,
      targetKey,
      targetPath,
      inspected
    };
  }

  // macOS 官方签名保护或显式免改盘模式：绝不修改 app.asar
  const isMacProtected = liveOnly
    || inspected.preflight?.reason === 'macos_asar_integrity_blocked'
    || inspected.preflight?.reason === 'macos_bundle_signature_blocked';
  if (isMacProtected) {
    const status = 'macos_signature_protected';
    const waitingReason = hostRunning ? 'live_mount_only_on_signed_host' : 'waiting_signed_host_launch';
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status,
      waitingReason,
      hostRunning,
      daemonPid: process.pid
    });
    return {
      ok: true,
      action: 'live_only_protected',
      status,
      waitingReason,
      hostRunning,
      targetKey,
      targetPath,
      inspected
    };
  }

  const currentSha = inspected.asarSha256 || `${inspected.hostVersion || 'unknown'}:${fileSig}`;

  if (inspected.preflight?.blocked) {
    const status = inspected.preflight.reason === 'host_structure_unsupported'
      ? 'unknown_anchor_blocked'
      : 'recovery_failed';
    const alreadyLogged = tracker.lastProcessedSha === currentSha && tracker.lastProcessedStatus === status;
    tracker.lastProcessedSha = currentSha;
    tracker.lastProcessedStatus = status;
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status,
      waitingReason: inspected.preflight.reason || 'preflight_blocked',
      lastError: inspected.preflight.guidance || inspected.preflight.reason,
      lastProcessedSha: currentSha,
      lastProcessedStatus: status,
      hostRunning,
      daemonPid: process.pid
    });
    if (!alreadyLogged) {
      appendGuardDiagnosticLog(stateDir, {
        event: 'recovery_blocked',
        targetKey,
        hostVersion: inspected.hostVersion,
        status,
        reason: inspected.preflight.reason,
        asarSha256Prefix: currentSha,
        detail: inspected.preflight.guidance
      });
    }
    return {
      ok: false,
      action: 'blocked',
      status,
      reason: inspected.preflight.reason,
      guidance: inspected.preflight.guidance,
      hostRunning,
      targetKey,
      targetPath,
      inspected
    };
  }

  // 同一新版覆盖事件去重（非 waiting_host_exit_for_recovery 且未显式强制重试时不再重复写盘）
  if (
    !ctx.forceRetry
    && tracker.lastProcessedSha === currentSha
    && tracker.lastProcessedStatus
    && tracker.lastProcessedStatus !== 'waiting_host_exit_for_recovery'
  ) {
    return {
      ok: tracker.lastProcessedStatus === 'healthy',
      action: 'deduped_already_handled',
      status: tracker.lastProcessedStatus,
      waitingReason: persisted.waitingReason || null,
      hostRunning,
      targetKey,
      targetPath,
      inspected
    };
  }

  // 若宿主正在运行（例如官方更新器早于恢复直接自动重开了新版宿主）：
  // 绝不强杀进程或抢改锁定文件，先标记 waiting_host_exit_for_recovery，由外层对受支持 CDP 窗口热挂载，退出后补做磁盘恢复
  if (hostRunning && ctx.allowWriteWhileHostRunning !== true) {
    const firstDefer = !tracker.pendingDiskRecoveryAfterExit || persisted.status !== 'waiting_host_exit_for_recovery';
    tracker.pendingDiskRecoveryAfterExit = true;
    const status = 'waiting_host_exit_for_recovery';
    const waitingReason = 'host_running_defer_disk_recovery';
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status,
      waitingReason,
      hostRunning: true,
      daemonPid: process.pid
    });
    if (firstDefer) {
      appendGuardDiagnosticLog(stateDir, {
        event: 'recovery_deferred_host_running',
        targetKey,
        hostVersion: inspected.hostVersion,
        status,
        reason: inspected.reason,
        asarSha256Prefix: currentSha
      });
    }
    return {
      ok: true,
      action: 'defer_until_host_exit',
      status,
      waitingReason,
      hostRunning: true,
      targetKey,
      targetPath,
      inspected
    };
  }

  // 宿主已关闭且文件稳定 -> 安全执行新版备份与无损恢复事务
  const recoverFn = typeof ctx._recoverHost === 'function'
    ? ctx._recoverHost
    : (opts) => recoverHostInstallation(opts);

  const t0 = Date.now();
  try {
    const res = await recoverFn({
      asarPath: inspected.asarPath,
      stateDir,
      noHotInject: true,
      silent: true,
      _platform: platform,
      _existsSync: ctx._existsSync,
      _readFileSync: ctx._readFileSync,
      _execFileSync: ctx._execFileSync
    });
    const durationMs = Date.now() - t0;

    if (res?.action === 'locked') {
      tracker.pendingDiskRecoveryAfterExit = true;
      const status = 'waiting_host_exit_for_recovery';
      writeTargetGuardState(stateDir, targetKey, {
        targetPath,
        targetSource,
        hostVersion: inspected.hostVersion,
        asarSha256: inspected.asarSha256 || null,
        status,
        waitingReason: 'host_asar_locked',
        hostRunning: false,
        daemonPid: process.pid
      });
      appendGuardDiagnosticLog(stateDir, {
        event: 'recovery_locked_retry_later',
        targetKey,
        hostVersion: inspected.hostVersion,
        status,
        reason: res.reason || 'host_asar_locked',
        durationMs,
        asarSha256Prefix: currentSha
      });
      return {
        ok: true,
        action: 'locked_deferred',
        status,
        waitingReason: 'host_asar_locked',
        durationMs,
        targetKey,
        targetPath,
        result: res
      };
    }

    if (res?.action === 'blocked') {
      const status = res.reason === 'host_structure_unsupported' ? 'unknown_anchor_blocked' : 'recovery_failed';
      tracker.lastProcessedSha = currentSha;
      tracker.lastProcessedStatus = status;
      writeTargetGuardState(stateDir, targetKey, {
        targetPath,
        targetSource,
        hostVersion: inspected.hostVersion,
        asarSha256: inspected.asarSha256 || null,
        status,
        waitingReason: res.reason || 'preflight_blocked',
        lastError: res.guidance || res.reason,
        lastProcessedSha: currentSha,
        lastProcessedStatus: status,
        daemonPid: process.pid
      });
      appendGuardDiagnosticLog(stateDir, {
        event: 'recovery_blocked',
        targetKey,
        hostVersion: inspected.hostVersion,
        status,
        reason: res.reason,
        durationMs,
        asarSha256Prefix: currentSha
      });
      return {
        ok: false,
        action: 'blocked',
        status,
        reason: res.reason,
        durationMs,
        targetKey,
        targetPath,
        result: res
      };
    }

    if (res?.ok && (res.action === 'recovered' || res.action === 'noop')) {
      const postInspect = inspectFn({
        asarPath: targetPath,
        stateDir,
        _platform: platform,
        includeAsarSha256: true
      });
      const postStat = statFn(targetPath);
      if (postStat) {
        tracker.lastFileSig = `${postStat.size}:${Math.floor(Number(postStat.mtimeMs) || 0)}`;
        tracker.stableCount = debounceStableChecks;
      }
      tracker.pendingDiskRecoveryAfterExit = false;
      tracker.lastProcessedSha = postInspect?.asarSha256 || res.manifest?.patchedSha256 || currentSha;
      tracker.lastProcessedStatus = 'healthy';
      const lastRecovery = {
        ok: true,
        at: new Date().toISOString(),
        durationMs,
        action: res.action,
        fromState: res.previousState || inspected.state,
        hostVersion: res.hostVersion || inspected.hostVersion,
        previousAsarSha256: inspected.asarSha256 || null,
        patchedAsarSha256: postInspect?.asarSha256 || res.manifest?.patchedSha256 || null,
        diskRendererBuildId: postInspect?.diskRendererBuildId || null,
        backupPath: res.versionBackupPath || null
      };
      const finalStatus = hostJustClosed ? 'host_closed_by_user' : 'healthy';
      writeTargetGuardState(stateDir, targetKey, {
        targetPath,
        targetSource,
        hostVersion: lastRecovery.hostVersion,
        diskRendererBuildId: lastRecovery.diskRendererBuildId,
        asarSha256: lastRecovery.patchedAsarSha256,
        status: finalStatus,
        waitingReason: finalStatus === 'host_closed_by_user' ? 'host_closed_stay_closed' : null,
        lastError: null,
        lastRecovery,
        lastProcessedSha: tracker.lastProcessedSha,
        lastProcessedStatus: 'healthy',
        hostRunning: false,
        daemonPid: process.pid
      });
      appendGuardDiagnosticLog(stateDir, {
        event: 'recovery_succeeded',
        targetKey,
        hostVersion: lastRecovery.hostVersion,
        status: finalStatus,
        action: res.action,
        reason: lastRecovery.fromState,
        durationMs,
        asarSha256Prefix: lastRecovery.patchedAsarSha256 || currentSha
      });
      return {
        ok: true,
        action: res.action,
        status: finalStatus,
        durationMs,
        targetKey,
        targetPath,
        lastRecovery,
        result: res
      };
    }

    const failStatus = 'recovery_failed';
    tracker.lastProcessedSha = currentSha;
    tracker.lastProcessedStatus = failStatus;
    const errMsg = res?.error || res?.reason || 'unknown_recovery_failure';
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status: failStatus,
      waitingReason: errMsg,
      lastError: errMsg,
      lastProcessedSha: currentSha,
      lastProcessedStatus: failStatus,
      daemonPid: process.pid
    });
    appendGuardDiagnosticLog(stateDir, {
      event: 'recovery_failed',
      targetKey,
      hostVersion: inspected.hostVersion,
      status: failStatus,
      reason: errMsg,
      durationMs,
      asarSha256Prefix: currentSha
    });
    return {
      ok: false,
      action: 'failed',
      status: failStatus,
      reason: errMsg,
      durationMs,
      targetKey,
      targetPath,
      result: res
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err?.message || String(err);
    const rolledBack = /rollback|回滚|中止写入|checksum mismatch|语法编译断言/i.test(msg);
    const failStatus = rolledBack ? 'rolled_back' : 'recovery_failed';
    tracker.lastProcessedSha = currentSha;
    tracker.lastProcessedStatus = failStatus;
    const lastRecovery = {
      ok: false,
      at: new Date().toISOString(),
      durationMs,
      action: failStatus,
      fromState: inspected.state,
      hostVersion: inspected.hostVersion,
      error: redactDiagnosticText(msg)
    };
    writeTargetGuardState(stateDir, targetKey, {
      targetPath,
      targetSource,
      hostVersion: inspected.hostVersion,
      asarSha256: inspected.asarSha256 || null,
      status: failStatus,
      waitingReason: failStatus,
      lastError: redactDiagnosticText(msg),
      lastRecovery,
      lastProcessedSha: currentSha,
      lastProcessedStatus: failStatus,
      daemonPid: process.pid
    });
    appendGuardDiagnosticLog(stateDir, {
      event: rolledBack ? 'recovery_rolled_back' : 'recovery_exception',
      targetKey,
      hostVersion: inspected.hostVersion,
      status: failStatus,
      reason: msg,
      durationMs,
      asarSha256Prefix: currentSha
    });
    return {
      ok: false,
      action: failStatus,
      status: failStatus,
      reason: redactDiagnosticText(msg),
      durationMs,
      targetKey,
      targetPath
    };
  }
}

/**
 * 静默拉起后台常驻守护进程（Windows 全程无控制台黑框）
 */
function spawnPersistentGuardDaemon(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const platform = options.platform || process.platform;
  const runtime = ensureStableGuardRuntime({ stateDir, sourceDir: options.sourceDir || __dirname });
  const nodePath = resolveNodePath(options.nodePath);
  const args = [runtime.cliPath, 'watch', '--persistent', '--no-launch', '--silent'];
  if (options.targetPath) args.push('--path', path.resolve(String(options.targetPath)));
  if (options.port) args.push('--port', String(options.port));
  if (options.liveOnly) args.push('--live-only');
  if (options.stateDir) args.push('--state-dir', stateDir);

  if (typeof options._spawnDaemon === 'function') {
    const pid = options._spawnDaemon(nodePath, args, { stateDir, platform, runtime });
    return { ok: true, pid: pid || null, cliPath: runtime.cliPath, method: 'custom' };
  }

  const childEnv = {
    ...process.env,
    ...(options.stateDir ? { AG_METER_STATE_DIR: stateDir } : {})
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  if (platform === 'win32' && options.useWmi !== false && process.env.AG_METER_TEST_MODE !== '1' && process.env.NODE_ENV !== 'test') {
    try {
      const { launchBridgeViaWin32Wmi } = require('./cli');
      const cmdLine = [nodePath, ...args].map(a => `"${String(a).replace(/"/g, '""')}"`).join(' ');
      const wmi = launchBridgeViaWin32Wmi(cmdLine, path.dirname(runtime.cliPath), childEnv);
      if (wmi && wmi.ok && wmi.pid) {
        return { ok: true, pid: wmi.pid, cliPath: runtime.cliPath, method: 'win32_wmi_hidden' };
      }
    } catch {}
  }

  const child = spawn(nodePath, args, {
    cwd: path.dirname(runtime.cliPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv
  });
  child.unref();
  return { ok: Boolean(child && child.pid), pid: child?.pid || null, cliPath: runtime.cliPath, method: 'detached_spawn' };
}

/**
 * 汇总宿主更新常驻守护的完整分层状态（供 CLI status / guard-status / 宿主设置页 / live-host 共用）
 */
function getHostGuardOverview(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const platform = options.platform || process.platform;
  const cfg = loadModulesConfig({ stateDir });
  const guardCfg = cfg?.modules?.hostGuard || { enabled: false, mode: 'auto', targetPath: null, cdpPort: null };
  const customPath = options.asarPath || options.path || guardCfg.targetPath || null;

  const inspected = inspectHostRecoveryState({
    asarPath: customPath,
    stateDir,
    _platform: platform,
    homeDir: options.homeDir,
    localAppData: options.localAppData,
    programFiles: options.programFiles,
    extraCandidates: options.extraCandidates,
    includeAsarSha256: options.includeAsarSha256 !== false,
    _existsSync: options._existsSync,
    _readFileSync: options._readFileSync,
    _execFileSync: options._execFileSync
  });

  const targetKey = inspected.targetKey || (inspected.asarPath ? computeAsarTargetKey(inspected.asarPath) : 'default');
  const paths = getTargetGuardPaths(stateDir, targetKey);
  const targetState = readTargetGuardState(stateDir, targetKey) || {};
  const targetLock = readTargetGuardLock(stateDir, targetKey);

  let fallbackWatchPid = null;
  const rawWatchPid = readFallbackWatchPid(stateDir);
  if (rawWatchPid && isPidAlive(rawWatchPid)) {
    fallbackWatchPid = rawWatchPid;
  }

  const lockAlive = Boolean(targetLock && isPidAlive(targetLock.pid));
  const daemonPid = lockAlive ? targetLock.pid : fallbackWatchPid;
  const daemonRunning = Boolean(daemonPid);
  const daemonMode = lockAlive ? (targetLock.mode || 'persistent') : (fallbackWatchPid ? 'watch' : null);

  const autostart = getAutostartStatus({
    platform,
    homeDir: options.homeDir,
    exec: options.exec
  });

  const liveRuntimeCliPath = path.join(stateDir, 'live-runtime', 'cli.js');
  const stableRuntimeReady = fs.existsSync(liveRuntimeCliPath);

  const silentLauncherExists = platform === 'win32' ? fs.existsSync(paths.vbsLauncherPath) : false;
  const driftReasons = [];
  if (!guardCfg.enabled) {
    if (daemonRunning) driftReasons.push('daemon_running_while_disabled');
    if (autostart.enabled) driftReasons.push('autostart_registered_while_disabled');
    if (silentLauncherExists) driftReasons.push('silent_launcher_leftover');
  } else {
    if (!daemonRunning) driftReasons.push('daemon_not_running_while_enabled');
    if (autostart.supported && !autostart.enabled) driftReasons.push('autostart_missing_while_enabled');
  }
  const configDrift = driftReasons.length > 0;

  let derivedStatus = targetState.status || 'idle';
  if (inspected.state === 'host_missing') {
    derivedStatus = 'host_missing';
  } else if (inspected.state === 'not_installed') {
    derivedStatus = 'not_installed';
  } else if (inspected.preflight?.reason === 'macos_asar_integrity_blocked' || inspected.preflight?.reason === 'macos_bundle_signature_blocked') {
    derivedStatus = 'macos_signature_protected';
  } else if (inspected.preflight?.reason === 'host_structure_unsupported') {
    derivedStatus = 'unknown_anchor_blocked';
  } else if (inspected.state === 'overwritten_by_host_update' || inspected.state === 'stale_host_version' || inspected.state === 'partial_or_corrupted') {
    if (targetState.status === 'waiting_host_exit_for_recovery' || targetState.status === 'recovery_failed' || targetState.status === 'rolled_back') {
      derivedStatus = targetState.status;
    } else {
      derivedStatus = 'overwritten_waiting_recovery';
    }
  } else if (!guardCfg.enabled && configDrift) {
    derivedStatus = 'disabled_drift';
  } else if (!guardCfg.enabled) {
    derivedStatus = 'disabled';
  } else if (inspected.state === 'healthy') {
    if (targetState.status === 'host_closed_by_user') derivedStatus = 'host_closed_by_user';
    else derivedStatus = 'healthy';
  }

  const supportBoundary = platform === 'darwin'
    ? {
      platform: 'darwin',
      officialEntryAutoRecover: false,
      companionEntrySupported: true,
      diskPatchPolicy: 'official_signature_preserved',
      note: 'macOS 保持官方 app.asar 与代码签名不改盘，普通 Dock 或访达启动无回环调试端口时需通过伴随启动或带参数入口挂载'
    }
    : {
      platform,
      officialEntryAutoRecover: true,
      companionEntrySupported: true,
      diskPatchPolicy: 'safe_window_auto_recover',
      note: 'Windows 启用常驻恢复后，宿主官方更新覆盖或修复安装将在安全窗口自动备份新版并恢复已启用插件；若官方更新器先拉起未开调试端口的窗口，正常退出客户端后立即自动补做磁盘恢复'
    };

  return {
    ok: true,
    enabled: Boolean(guardCfg.enabled),
    mode: guardCfg.mode || 'auto',
    platform,
    targetKey,
    targetPath: inspected.asarPath || customPath || null,
    targetSource: inspected.targetSource || 'not_found',
    recordedTargetMissing: Boolean(inspected.recordedTargetMissing),
    recordedTargetPath: inspected.recordedTargetPath || null,
    hostRecordedVersion: inspected.manifestVersion || null,
    hostDiskVersion: inspected.hostVersion || null,
    diskPatched: Boolean(inspected.disk?.meter),
    diskVersion: inspected.pluginVersion || null,
    diskRendererBuildId: inspected.diskRendererBuildId || null,
    recoveryState: inspected.state,
    recoveryReason: inspected.reason || null,
    needsRecovery: Boolean(inspected.needsRecovery),
    preflightBlocked: Boolean(inspected.preflight?.blocked),
    preflightReason: inspected.preflight?.reason || null,
    preflightGuidance: inspected.preflight?.guidance || null,
    status: derivedStatus,
    configDrift,
    driftReasons,
    waitingReason: targetState.waitingReason || (inspected.needsRecovery ? inspected.reason : null),
    lastError: targetState.lastError || null,
    lastRecovery: targetState.lastRecovery || null,
    lastEventAt: targetState.updatedAt || null,
    daemonRunning,
    daemonPid,
    daemonMode,
    autostartSupported: Boolean(autostart.supported),
    autostartRegistered: Boolean(autostart.enabled),
    autostartKind: autostart.kind || null,
    autostartCommand: autostart.command || null,
    autostartFile: autostart.file || null,
    silentLauncherExists,
    stableRuntimeReady,
    liveRuntimeCliPath: stableRuntimeReady ? liveRuntimeCliPath : null,
    logPath: paths.logPath,
    supportBoundary
  };
}

/**
 * 一次性启用宿主更新常驻守护与登录自启（仅在用户主动启用时注册）
 */
async function enableHostGuard(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  if (
    process.env.AG_METER_TEST_MODE === '1' &&
    options.allowNonIsolatedInTest !== true &&
    !isIsolatedTestPath(stateDir)
  ) {
    throw new Error(`测试模式禁止在非隔离目录启用常驻守护: ${stateDir}`);
  }
  const platform = options.platform || process.platform;
  const customPath = options.asarPath || options.path || null;

  const resolved = resolveAsarTarget(customPath, {
    stateDir,
    platform,
    homeDir: options.homeDir,
    localAppData: options.localAppData,
    programFiles: options.programFiles,
    extraCandidates: options.extraCandidates,
    env: options.env
  });
  if (customPath && !resolved.ok) {
    return { ok: false, action: 'invalid_target', error: resolved.error || '指定的 app.asar 路径不存在' };
  }

  const targetPath = resolved.ok ? resolved.asarPath : null;
  const targetKey = targetPath ? computeAsarTargetKey(targetPath) : 'default';
  const liveOnly = Boolean(options.liveOnly || platform === 'darwin');
  const mode = liveOnly ? 'live-only' : 'auto';

  const runtime = ensureStableGuardRuntime({ stateDir, sourceDir: options.sourceDir || __dirname });

  const cfg = loadModulesConfig({ stateDir });
  cfg.modules.hostGuard = {
    enabled: true,
    mode,
    targetPath: customPath ? path.resolve(String(customPath)) : (targetPath || null),
    cdpPort: options.port ? Number(options.port) : null,
    lastUpdated: new Date().toISOString()
  };
  saveModulesConfig(cfg, { stateDir });

  let autostartRes = { ok: false, action: 'skipped', supported: false };
  if (options.registerAutostart !== false) {
    let winSilent = null;
    if (platform === 'win32') {
      winSilent = ensureWindowsSilentLauncher({
        stateDir,
        nodePath: options.nodePath,
        cliPath: runtime.cliPath,
        targetPath: cfg.modules.hostGuard.targetPath,
        port: cfg.modules.hostGuard.cdpPort,
        liveOnly
      });
    }
    autostartRes = await enableAutostart({
      platform,
      homeDir: options.homeDir,
      exec: options.exec,
      nodePath: options.nodePath,
      scriptPath: runtime.cliPath,
      port: cfg.modules.hostGuard.cdpPort || undefined,
      persistent: true,
      noLaunch: true,
      silent: true,
      liveOnly,
      customPath: cfg.modules.hostGuard.targetPath || undefined,
      stateDir: options.stateDir ? stateDir : undefined,
      windowsCommandOverride: winSilent ? winSilent.runCommand : undefined,
      force: true
    });
  }

  let daemonSpawn = { ok: false, pid: null, skipped: true };
  const existingLock = readTargetGuardLock(stateDir, targetKey);
  const alreadyAlive = Boolean(existingLock && isPidAlive(existingLock.pid));
  if (options.spawnDaemon !== false && (!alreadyAlive || options.restartDaemon === true)) {
    if (alreadyAlive && options.restartDaemon === true && existingLock.pid !== process.pid) {
      await stopPidGracefully(existingLock.pid, 2000);
      releaseTargetGuardLock(stateDir, targetKey, existingLock.pid);
    }
    const inTestWithoutHook = (process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && typeof options._spawnDaemon !== 'function';
    if (!inTestWithoutHook) {
      daemonSpawn = spawnPersistentGuardDaemon({
        stateDir,
        platform,
        sourceDir: options.sourceDir || __dirname,
        nodePath: options.nodePath,
        targetPath: cfg.modules.hostGuard.targetPath,
        port: cfg.modules.hostGuard.cdpPort,
        liveOnly,
        _spawnDaemon: options._spawnDaemon
      });
    }
  } else if (alreadyAlive) {
    daemonSpawn = { ok: true, pid: existingLock.pid, alreadyRunning: true };
  }

  writeTargetGuardState(stateDir, targetKey, {
    targetPath,
    targetSource: resolved.source || 'not_found',
    status: 'healthy',
    waitingReason: null,
    ...(daemonSpawn.pid ? { daemonPid: daemonSpawn.pid } : {})
  });
  appendGuardDiagnosticLog(stateDir, {
    event: 'guard_enabled',
    targetKey,
    status: 'enabled',
    action: autostartRes.action || 'enabled',
    detail: `mode=${mode}, stableRuntime=${runtime.isStableRuntime}`
  });

  return {
    ok: true,
    action: 'enabled',
    runtime,
    autostart: autostartRes,
    daemon: daemonSpawn,
    overview: getHostGuardOverview({ ...options, stateDir, asarPath: targetPath || customPath })
  };
}

/**
 * 停用并清理宿主更新常驻守护、登录自启、静默启动封装与后台进程
 */
async function disableHostGuard(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  if (
    process.env.AG_METER_TEST_MODE === '1' &&
    options.allowNonIsolatedInTest !== true &&
    !isIsolatedTestPath(stateDir)
  ) {
    throw new Error(`测试模式禁止在非隔离目录停用常驻守护: ${stateDir}`);
  }
  const platform = options.platform || process.platform;
  const cfg = loadModulesConfig({ stateDir });
  const prevTargetPath = options.asarPath || options.path || cfg?.modules?.hostGuard?.targetPath || null;

  cfg.modules.hostGuard = {
    ...(cfg.modules.hostGuard || {}),
    enabled: false,
    lastUpdated: new Date().toISOString()
  };
  saveModulesConfig(cfg, { stateDir });

  let autostartRes = { ok: true, action: 'skipped' };
  if (options.unregisterAutostart !== false) {
    autostartRes = await disableAutostart({
      platform,
      homeDir: options.homeDir,
      exec: options.exec
    });
  }

  const vbsRemoved = platform === 'win32' ? removeWindowsSilentLauncher({ stateDir }) : false;

  // 停止全部目标锁下的常驻进程与通用 watch / live-host
  const stoppedPids = [];
  const targetsDir = path.join(stateDir, 'targets');
  if (fs.existsSync(targetsDir)) {
    try {
      for (const entry of fs.readdirSync(targetsDir)) {
        const lock = readTargetGuardLock(stateDir, entry);
        if (lock && lock.pid && lock.pid !== process.pid && isPidAlive(lock.pid)) {
          await stopPidGracefully(lock.pid, 2000);
          stoppedPids.push(lock.pid);
        }
        const lp = path.join(targetsDir, entry, 'guard.lock');
        try { if (fs.existsSync(lp)) fs.unlinkSync(lp); } catch {}
      }
    } catch {}
  }

  let watchStopRes = null;
  if (options.stopDaemon !== false) {
    try {
      const cli = require('./cli');
      watchStopRes = await cli.stopWatchDaemon({ stateDir });
    } catch {}
  }

  const targetKey = prevTargetPath ? computeAsarTargetKey(prevTargetPath) : 'default';
  writeTargetGuardState(stateDir, targetKey, {
    status: 'disabled',
    waitingReason: 'disabled_by_user',
    daemonPid: null
  });
  appendGuardDiagnosticLog(stateDir, {
    event: 'guard_disabled',
    targetKey,
    status: 'disabled',
    detail: `stoppedPids=${stoppedPids.join(',') || 'none'}, vbsRemoved=${vbsRemoved}`
  });

  return {
    ok: true,
    action: 'disabled',
    autostart: autostartRes,
    vbsRemoved,
    stoppedPids,
    watchStop: watchStopRes,
    overview: getHostGuardOverview({ ...options, stateDir, asarPath: prevTargetPath })
  };
}

/**
 * 安装或升级插件后若用户已启用 hostGuard，保持启用设置并同步持久化运行包与自启注册（绝不给未启用用户擅自注册）
 */
async function refreshHostGuardAfterUpgrade(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const cfg = loadModulesConfig({ stateDir });
  if (cfg?.modules?.hostGuard?.enabled !== true) {
    return { ok: true, action: 'skipped_not_enabled' };
  }
  return enableHostGuard({
    ...options,
    stateDir,
    asarPath: options.asarPath || cfg.modules.hostGuard.targetPath || undefined,
    port: options.port || cfg.modules.hostGuard.cdpPort || undefined,
    liveOnly: cfg.modules.hostGuard.mode === 'live-only',
    restartDaemon: true
  });
}

module.exports = {
  WINDOWS_SILENT_LAUNCHER_NAME,
  getGuardLogPath,
  getGuardIndexPath,
  getTargetGuardPaths,
  appendGuardDiagnosticLog,
  readTargetGuardState,
  writeTargetGuardState,
  readTargetGuardLock,
  writeTargetGuardLock,
  releaseTargetGuardLock,
  ensureStableGuardRuntime,
  buildVbsStringExpr,
  ensureWindowsSilentLauncher,
  removeWindowsSilentLauncher,
  createGuardTracker,
  evaluateGuardTick,
  spawnPersistentGuardDaemon,
  getHostGuardOverview,
  enableHostGuard,
  disableHostGuard,
  refreshHostGuardAfterUpgrade
};
