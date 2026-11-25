'use strict';
/**
 * 宿主更新后自动检测与无损恢复中心 (ELV-105)
 * 职责：
 * 1. 检测宿主 ASAR 状态：healthy / overwritten_by_host_update / partial_or_corrupted / stale_host_version / not_installed / host_missing；
 * 2. 写入前预检：ASAR 结构、入口 dist/utils.js 骨架 (verifyCleanStructure) 与 macOS ElectronAsarIntegrity / 签名预检；
 * 3. 版本隔离备份：按宿主 version + targetKey 保存 app-<ver>-<key>-base.asar，不覆盖旧版本基线；
 * 4. 自动恢复已启用的 ContextMeter / Chinese / Proxy / Enhance 模块并保持用户开关配置。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadAsarEngine, builtinAsar, getStateDir, isIsolatedTestPath } = require('./asar-engine');
const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
const { cleanUtilsSource, verifyCleanStructure, diagnoseCleanStructure, TAGS } = require('./modular-installer');
const {
  PROJECT_VERSION,
  loadModulesConfig,
  inspectDiskModules,
  invalidateDiskModulesCache
} = require('./modules-config');
const { safeWriteJsonSync } = require('./meter-storage');

const asar = loadAsarEngine();

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function clearAsarCaches(archivePath) {
  try {
    if (asar && typeof asar.uncacheAll === 'function') asar.uncacheAll();
    if (asar && typeof asar.uncache === 'function' && archivePath) asar.uncache(archivePath);
  } catch {}
}

function extractArchiveFile(archivePath, relPath) {
  clearAsarCaches(archivePath);
  try {
    return asar.extractFile(archivePath, relPath);
  } catch {
    return builtinAsar.extractFile(archivePath, relPath);
  }
}

function resolveRecoveryTarget(options = {}) {
  const { findAsarPath } = require('./install');
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const explicitAsar = options.asarPath || options.path || null;
  let asarPath = null;
  let findError = null;
  try {
    asarPath = findAsarPath(explicitAsar);
  } catch (e) {
    findError = e?.message || String(e);
    if (explicitAsar) asarPath = path.resolve(String(explicitAsar));
  }
  return { stateDir, asarPath, findError };
}

function loadManifestForTarget(stateDir, asarPath) {
  const manifestPath = path.join(stateDir, 'installation.json');
  const legacyPath = path.join(__dirname, 'installation.json');
  const resolvedAsar = asarPath ? path.resolve(asarPath) : null;
  for (const candidate of [manifestPath, legacyPath]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const matchTarget = !resolvedAsar || !parsed.installed || path.resolve(parsed.installed) === resolvedAsar;
      if (matchTarget) {
        return { manifestPath: candidate, manifest: parsed };
      }
    } catch {}
  }
  return { manifestPath, manifest: null };
}

function checkHasPriorInstallHistory(stateDir, manifestInfo, disk) {
  if (manifestInfo && manifestInfo.manifest) return true;
  if (disk && (disk.meter || disk.chinese || disk.proxy)) return true;
  const backupDir = path.join(stateDir, 'backups');
  if (fs.existsSync(backupDir)) {
    try {
      const entries = fs.readdirSync(backupDir);
      if (entries.some(name => name.endsWith('.asar') && name.startsWith('app-'))) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * 在写入前校验 ASAR 可读性、dist/utils.js 骨架结构与平台完整性保护。
 */
function runPreflightChecks(asarPath, options = {}) {
  const preflight = {
    ok: true,
    blocked: false,
    reason: null,
    guidance: null,
    hostVersion: null,
    structureValid: false,
    hasPluginTraceInUtils: false,
    macAsarIntegrity: null
  };

  let utilsRaw = '';
  let preloadRaw = '';
  try {
    const pkgRaw = JSON.parse(extractArchiveFile(asarPath, 'package.json').toString('utf8'));
    preflight.hostVersion = pkgRaw && typeof pkgRaw.version === 'string' ? pkgRaw.version : null;
    utilsRaw = extractArchiveFile(asarPath, 'dist/utils.js').toString('utf8');
    try {
      preloadRaw = extractArchiveFile(asarPath, 'dist/preload.js').toString('utf8');
    } catch {
      preloadRaw = '';
    }
  } catch (e) {
    preflight.ok = false;
    preflight.blocked = true;
    preflight.reason = 'host_asar_corrupted_or_unreadable';
    preflight.guidance = `无法读取宿主 ASAR 核心结构 (${e?.message || '未知解析错误'})，已阻止写入，建议重新运行官方安装修复程序。`;
    return preflight;
  }

  const hasTrace = Boolean(
    utilsRaw.includes('installContextMeter')
    || utilsRaw.includes(TAGS.METER_UTILS_START)
    || utilsRaw.includes(TAGS.PROXY_START)
    || preloadRaw.includes(TAGS.CHINESE_START)
  );
  preflight.hasPluginTraceInUtils = hasTrace;

  const cleanCandidate = hasTrace ? cleanUtilsSource(utilsRaw) : utilsRaw;
  const cleanDiag = diagnoseCleanStructure(cleanCandidate);
  preflight.structureValid = Boolean(cleanDiag.ok);
  preflight.structureStage = cleanDiag.stage;
  if (!preflight.structureValid) {
    preflight.ok = false;
    preflight.blocked = true;
    preflight.reason = 'host_structure_unsupported';
    preflight.guidance = `宿主 dist/utils.js 入口结构不兼容当前补丁锚点 (${cleanDiag.stage}: ${cleanDiag.reason})，已写前拦截并禁止强写；请等待适配更新或改用免改盘 live/watch 模式。`;
    return preflight;
  }

  const macCheck = inspectMacAsarIntegrity(asarPath, {
    _platform: options._platform,
    _existsSync: options._existsSync,
    _readFileSync: options._readFileSync,
    _execFileSync: options._execFileSync
  });
  if (macCheck.isMacAppBundle) {
    preflight.macAsarIntegrity = macCheck;
    const effectivePlatform = options._platform || process.platform;
    const enforceMac = effectivePlatform === 'darwin' || options.enforceMacIntegrityCheck === true;
    const allowOverride = Boolean(options.allowIntegrityOverride || options.forceMacAsar);
    if (enforceMac && (macCheck.patchRisk === 'blocked_integrity' || macCheck.patchRisk === 'blocked_signature') && !allowOverride) {
      preflight.ok = false;
      preflight.blocked = true;
      preflight.reason = macCheck.patchRisk === 'blocked_integrity' ? 'macos_asar_integrity_blocked' : 'macos_bundle_signature_blocked';
      preflight.guidance = `${macCheck.reason}。已阻止写入。`;
      return preflight;
    }
  }

  return preflight;
}

/**
 * 按宿主版本隔离备份原版 ASAR，保留历史版本基线不覆盖。
 */
function backupHostAsarByVersion(options = {}) {
  const { stateDir, asarPath, findError } = resolveRecoveryTarget(options);
  if (!asarPath || !fs.existsSync(asarPath)) {
    return { ok: false, reason: 'host_missing', error: findError || '未找到宿主 app.asar', backupPath: null };
  }
  const hostVersion = options.hostVersion || (() => {
    try {
      return JSON.parse(extractArchiveFile(asarPath, 'package.json').toString('utf8')).version || 'unknown';
    } catch {
      return 'unknown';
    }
  })();

  let utilsRaw = '';
  try {
    utilsRaw = extractArchiveFile(asarPath, 'dist/utils.js').toString('utf8');
  } catch (e) {
    return { ok: false, reason: 'host_asar_corrupted_or_unreadable', error: e?.message || String(e), backupPath: null };
  }
  if (
    utilsRaw.includes('installContextMeter')
    || utilsRaw.includes(TAGS.METER_UTILS_START)
    || utilsRaw.includes(TAGS.PROXY_START)
  ) {
    return { ok: false, reason: 'target_already_patched', error: '当前 app.asar 已包含补丁痕迹，不覆盖纯净原版备份', backupPath: null };
  }

  const targetKey = crypto.createHash('sha256').update(path.resolve(asarPath)).digest('hex').slice(0, 8);
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `app-${hostVersion}-${targetKey}-base.asar`);
  const currentSha = sha256File(asarPath);

  let reused = false;
  if (fs.existsSync(backupPath)) {
    try {
      if (sha256File(backupPath) === currentSha) {
        reused = true;
      } else {
        fs.copyFileSync(asarPath, backupPath);
      }
    } catch {
      fs.copyFileSync(asarPath, backupPath);
    }
  } else {
    fs.copyFileSync(asarPath, backupPath);
  }

  const manifestPath = path.join(stateDir, 'installation.json');
  try {
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : { installed: path.resolve(asarPath) };
    const backupsByVersion = (manifest.backupsByVersion && typeof manifest.backupsByVersion === 'object')
      ? { ...manifest.backupsByVersion }
      : {};
    backupsByVersion[hostVersion] = {
      backup: backupPath,
      sha256: currentSha,
      recordedAt: new Date().toISOString()
    };
    manifest.backupsByVersion = backupsByVersion;
    safeWriteJsonSync(manifestPath, manifest);
  } catch {}

  return {
    ok: true,
    hostVersion,
    backupPath,
    sha256: currentSha,
    reused
  };
}

/**
 * 只读探测宿主 ASAR 当前状态与写入前置兼容性，绝不改盘。
 */
function inspectHostRecoveryState(options = {}) {
  const { stateDir, asarPath, findError } = resolveRecoveryTarget(options);
  if (!asarPath || !fs.existsSync(asarPath)) {
    return {
      ok: false,
      state: 'host_missing',
      needsRecovery: false,
      stateDir,
      asarPath: asarPath || null,
      error: findError || '未检测到 Antigravity app.asar'
    };
  }

  invalidateDiskModulesCache();
  const cfg = loadModulesConfig({ stateDir });
  const disk = inspectDiskModules(asarPath);
  const manifestInfo = loadManifestForTarget(stateDir, asarPath);
  const preflight = runPreflightChecks(asarPath, options);
  const hostVersion = preflight.hostVersion || null;
  const hasPriorHistory = checkHasPriorInstallHistory(stateDir, manifestInfo, disk);
  const savedModules = {
    meter: cfg.modules?.meter?.enabled !== false,
    chinese: cfg.modules?.chinese?.enabled === true,
    proxy: cfg.modules?.proxy?.enabled === true
  };
  const savedEnhanceIntent = {
    promptTier: cfg.modules?.enhance?.promptTier ?? null,
    chineseTitle: cfg.modules?.enhance?.chineseTitle ?? null
  };

  let state = 'healthy';
  let reason = 'ok';
  const hasAnyPluginTrace = Boolean(disk.meter || disk.chinese || disk.proxy || preflight.hasPluginTraceInUtils);

  if (!preflight.structureValid && preflight.reason === 'host_asar_corrupted_or_unreadable') {
    state = 'partial_or_corrupted';
    reason = preflight.reason;
  } else if (!hasAnyPluginTrace) {
    if (hasPriorHistory) {
      state = 'overwritten_by_host_update';
      reason = 'host_updated_without_plugin';
    } else {
      state = 'not_installed';
      reason = 'no_prior_installation';
    }
  } else if (
    !disk.meterReady
    || (savedModules.chinese && !disk.chineseReady)
    || (savedModules.proxy && !disk.proxyReady)
  ) {
    state = 'partial_or_corrupted';
    reason = disk.meterReason || disk.chineseReason || disk.proxyReason || 'incomplete_disk_modules';
  } else if (
    manifestInfo.manifest?.version
    && hostVersion
    && manifestInfo.manifest.version !== hostVersion
  ) {
    state = 'stale_host_version';
    reason = `manifest_version_mismatch (${manifestInfo.manifest.version} -> ${hostVersion})`;
  }

  const needsRecovery = state === 'overwritten_by_host_update'
    || state === 'partial_or_corrupted'
    || state === 'stale_host_version';

  return {
    ok: preflight.ok && !needsRecovery,
    state,
    needsRecovery,
    reason,
    stateDir,
    asarPath: path.resolve(asarPath),
    hostVersion,
    manifestVersion: manifestInfo.manifest?.version || null,
    pluginVersion: manifestInfo.manifest?.meterVersion || null,
    expectedPluginVersion: PROJECT_VERSION,
    disk,
    savedModules,
    savedEnhanceIntent,
    backupsByVersion: manifestInfo.manifest?.backupsByVersion || {},
    preflight
  };
}

function isFileLockError(err) {
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '');
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    || /EBUSY|resource busy|being used by another process|permission denied/i.test(msg);
}

/**
 * 执行宿主更新检测与自动无损恢复（支持 checkOnly、写前预检拦截、多版本备份、模块与内核增强延续）。
 */
async function recoverHostInstallation(options = {}) {
  const inspected = inspectHostRecoveryState(options);
  if (options.checkOnly === true) {
    return {
      ok: inspected.preflight ? inspected.preflight.ok : false,
      action: 'check_only',
      changed: false,
      inspected
    };
  }

  if (inspected.state === 'host_missing') {
    return {
      ok: false,
      action: 'skipped',
      changed: false,
      reason: 'host_missing',
      error: inspected.error || '未检测到 Antigravity app.asar',
      inspected
    };
  }

  if (inspected.state === 'not_installed' && options.forceInstall !== true) {
    return {
      ok: false,
      action: 'skipped',
      changed: false,
      reason: 'not_installed',
      inspected
    };
  }

  if (inspected.state === 'healthy' && options.force !== true) {
    return {
      ok: true,
      action: 'noop',
      changed: false,
      reason: 'already_healthy',
      inspected
    };
  }

  if (inspected.preflight?.blocked) {
    return {
      ok: false,
      action: 'blocked',
      changed: false,
      reason: inspected.preflight.reason,
      guidance: inspected.preflight.guidance,
      inspected
    };
  }

  let versionBackup = null;
  if (inspected.state === 'overwritten_by_host_update' || !inspected.preflight?.hasPluginTraceInUtils) {
    versionBackup = backupHostAsarByVersion({
      ...options,
      stateDir: inspected.stateDir,
      asarPath: inspected.asarPath,
      hostVersion: inspected.hostVersion
    });
  }

  const { install } = require('./install');
  const noHotInject = options.noHotInject !== undefined
    ? Boolean(options.noHotInject)
    : isIsolatedTestPath(inspected.stateDir);

  let manifest = null;
  try {
    manifest = await install({
      path: inspected.asarPath,
      stateDir: inspected.stateDir,
      force: true,
      allowIntegrityOverride: Boolean(options.allowIntegrityOverride || options.forceMacAsar),
      enforceMacIntegrityCheck: options.enforceMacIntegrityCheck,
      noHotInject,
      hotInjectOptions: options.hotInjectOptions || {},
      _platform: options._platform,
      _existsSync: options._existsSync,
      _readFileSync: options._readFileSync,
      _execFileSync: options._execFileSync
    });
  } catch (err) {
    if (isFileLockError(err)) {
      return {
        ok: false,
        action: 'locked',
        changed: false,
        reason: 'host_asar_locked',
        error: `宿主 app.asar 正在被占用锁定，请先关闭 Antigravity 客户端后重试恢复（或改用 node cli.js live）。详情: ${err.message}`,
        inspected
      };
    }
    throw err;
  }

  let enhanceRecovery = { attempted: false, skipped: true, reason: 'no_saved_enhance_intent' };
  const intent = inspected.savedEnhanceIntent || {};
  const hasEnhanceIntent = Boolean(intent.promptTier || intent.chineseTitle);
  const canRecoverEnhance = options.recoverEnhance !== false
    && hasEnhanceIntent
    && (Array.isArray(options.enhanceTargets) || !isIsolatedTestPath(inspected.stateDir));

  if (canRecoverEnhance) {
    enhanceRecovery = { attempted: true, skipped: false };
    try {
      const { getEnhanceStatusAsync, applyEnhancePatchAsync } = require('./meter-enhance');
      const enhanceOpts = {
        agDir: inspected.stateDir,
        ...(Array.isArray(options.enhanceTargets) ? { targets: options.enhanceTargets } : {}),
        ...(options._platform ? { platform: options._platform } : {}),
        ...(options._arch ? { arch: options._arch } : {})
      };
      const st = await getEnhanceStatusAsync({ ...enhanceOpts, skipProcessCheck: true });
      if (st?.supported !== false) {
        const applied = await applyEnhancePatchAsync(
          {
            ...(intent.promptTier ? { promptTier: intent.promptTier } : {}),
            ...(intent.chineseTitle ? { chineseTitle: intent.chineseTitle } : {})
          },
          enhanceOpts
        );
        enhanceRecovery.ok = Boolean(applied?.ok);
        enhanceRecovery.result = applied;
      } else {
        enhanceRecovery.skipped = true;
        enhanceRecovery.reason = st?.reason || 'enhance_unsupported_on_platform';
      }
    } catch (enhErr) {
      enhanceRecovery.ok = false;
      enhanceRecovery.error = enhErr?.message || String(enhErr);
    }
  }

  invalidateDiskModulesCache();
  const diskAfter = inspectDiskModules(inspected.asarPath);
  const manifestPath = path.join(inspected.stateDir, 'installation.json');
  let latestManifest = manifest;
  try {
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      m.lastRecoveredAt = new Date().toISOString();
      m.lastRecoveryFromState = inspected.state;
      safeWriteJsonSync(manifestPath, m);
      latestManifest = m;
    }
  } catch {}

  return {
    ok: true,
    action: 'recovered',
    changed: true,
    previousState: inspected.state,
    hostVersion: inspected.hostVersion,
    recoveredModules: inspected.savedModules,
    versionBackupPath: versionBackup?.backupPath || manifest?.backup || null,
    backupsByVersion: latestManifest?.backupsByVersion || manifest?.backupsByVersion || {},
    diskAfter,
    manifest: latestManifest,
    enhanceRecovery,
    inspectedBefore: inspected
  };
}

module.exports = {
  inspectHostRecoveryState,
  backupHostAsarByVersion,
  recoverHostInstallation,
  runPreflightChecks
};
