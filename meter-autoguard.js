'use strict';
// Preserve Electron ASAR support in the host process.

/**
 * Antigravity Win10 Auto 智能审批 Hook 生命周期管理模块 (meter-autoguard.js)
 * 职责：
 * 1. 管理 ~/.gemini/config/hooks/auto_guard_hook.js 的部署、哈希校验、备份与移除；
 * 2. 以 fail-closed 方式安全读写 ~/.gemini/config/hooks.json 中的 "antigravity-auto-guard" 条目，
 *    严格保留用户其他已有 Hook（如 post-compact-rehydrate、rtk 等）；
 * 3. 解析 Node.js 运行时并生成跨平台兼容的 PreToolUse Hook 命令；
 * 4. 在测试模式下强制隔离路径，绝不触碰真实宿主环境配置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { getStateDir } = require('./asar-engine');
const { loadModulesConfig, saveModulesConfig } = require('./modules-config');

const HOOK_NAME = 'antigravity-auto-guard';
const SCRIPT_FILENAME = 'auto_guard_hook.js';
const TOOL_MATCHER = 'run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content';
const VALID_MODES = ['smart', 'strict_auto', 'guard_only'];

function normalizeAutoGuardMode(mode) {
  const raw = String(mode || '').trim().toLowerCase();
  if (raw === 'strict' || raw === 'strict_auto') return 'strict_auto';
  if (raw === 'guard' || raw === 'guard_only') return 'guard_only';
  return 'smart';
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isTestModeActive() {
  return (
    process.env.AG_METER_TEST_MODE === '1' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function resolveGeminiConfigDir(options = {}) {
  if (options && typeof options.configDir === 'string' && options.configDir.trim()) {
    return path.resolve(options.configDir.trim());
  }
  if (options && typeof options.homeDir === 'string' && options.homeDir.trim()) {
    return path.join(path.resolve(options.homeDir.trim()), '.gemini', 'config');
  }
  if (process.env.AG_METER_GEMINI_CONFIG_DIR && process.env.AG_METER_GEMINI_CONFIG_DIR.trim()) {
    return path.resolve(process.env.AG_METER_GEMINI_CONFIG_DIR.trim());
  }
  if (isTestModeActive()) {
    const baseState =
      options && typeof options.stateDir === 'string' && options.stateDir.trim()
        ? path.resolve(options.stateDir.trim())
        : process.env.AG_METER_STATE_DIR
          ? getStateDir()
          : os.tmpdir();
    return path.join(baseState, 'isolated-gemini-config');
  }
  return path.join(os.homedir(), '.gemini', 'config');
}

function resolveBundledAutoGuardScript(options = {}) {
  const candidates = [];
  if (options && typeof options.bundledScriptPath === 'string' && options.bundledScriptPath.trim()) {
    candidates.push(path.resolve(options.bundledScriptPath.trim()));
  }
  candidates.push(
    path.join(__dirname, 'autoguard', SCRIPT_FILENAME),
    path.join(__dirname, 'dist', 'autoguard', SCRIPT_FILENAME),
    path.join(__dirname, '..', 'autoguard', SCRIPT_FILENAME)
  );
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const buf = fs.readFileSync(cand);
        return {
          path: cand,
          content: buf.toString('utf8'),
          sha256: sha256Buffer(buf)
        };
      }
    } catch {}
  }
  return { path: null, content: null, sha256: null };
}

function collectNodeCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = [];
  if (process.env.AG_METER_NODE && process.env.AG_METER_NODE.trim()) {
    candidates.push({ command: process.env.AG_METER_NODE.trim(), preferBare: false });
  }
  candidates.push({ command: 'node', preferBare: true });
  if (!process.versions?.electron) {
    candidates.push({ command: process.execPath, preferBare: false });
  }
  if (platform === 'win32') {
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const exe of [
      path.join(progFiles, 'nodejs', 'node.exe'),
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe')
    ]) {
      try {
        if (fs.existsSync(exe)) candidates.push({ command: exe, preferBare: false });
      } catch {}
    }
  } else {
    for (const exe of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      try {
        if (fs.existsSync(exe)) candidates.push({ command: exe, preferBare: false });
      } catch {}
    }
  }
  return candidates;
}

const NODE_PROBE_CACHE_TTL_MS = 30_000;
const nodeProbeCache = new Map();

function resolveNodeForHook(options = {}) {
  if (typeof options._nodeProbe === 'function') {
    return options._nodeProbe();
  }
  const platform = options.platform || process.platform;
  const cacheKey = `${platform}|${process.env.AG_METER_NODE || ''}|${process.env.PATH || ''}`;
  const cached = nodeProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NODE_PROBE_CACHE_TTL_MS) {
    return { ...cached.value };
  }

  for (const cand of collectNodeCandidates(options)) {
    try {
      const out = childProcess.execFileSync(cand.command, ['-p', 'process.versions.electron ? "electron" : process.version'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
      if (out && out !== 'electron') {
        const res = {
          ok: true,
          command: cand.preferBare ? 'node' : cand.command,
          version: out
        };
        nodeProbeCache.set(cacheKey, { ts: Date.now(), value: res });
        return res;
      }
    } catch {}
  }
  return { ok: false, command: null, version: null };
}

async function resolveNodeForHookAsync(options = {}) {
  if (typeof options._nodeProbe === 'function') {
    return await options._nodeProbe();
  }
  const platform = options.platform || process.platform;
  const cacheKey = `${platform}|${process.env.AG_METER_NODE || ''}|${process.env.PATH || ''}`;
  const cached = nodeProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NODE_PROBE_CACHE_TTL_MS) {
    return { ...cached.value };
  }

  for (const cand of collectNodeCandidates(options)) {
    const out = await new Promise((resolve) => {
      childProcess.execFile(
        cand.command,
        ['-p', 'process.versions.electron ? "electron" : process.version'],
        { encoding: 'utf8', timeout: 2500, windowsHide: true },
        (err, stdout) => {
          resolve(err ? '' : String(stdout || '').trim());
        }
      );
    });
    if (out && out !== 'electron') {
      const res = {
        ok: true,
        command: cand.preferBare ? 'node' : cand.command,
        version: out
      };
      nodeProbeCache.set(cacheKey, { ts: Date.now(), value: res });
      return res;
    }
  }
  return { ok: false, command: null, version: null };
}

const WIN_UNSAFE_RE = /[\s"&|<>^%()!']/;
const POSIX_SAFE_RE = /^[A-Za-z0-9_./:@+-]+$/;

function sanitizeAutoGuardRendererOptions(rawOptions, action = 'status') {
  const safe = {};
  if (!rawOptions || typeof rawOptions !== 'object') return safe;
  if (action === 'restore' && rawOptions.force === true) {
    safe.force = true;
  }
  if (action === 'apply') {
    if (typeof rawOptions.mode === 'string' && VALID_MODES.includes(normalizeAutoGuardMode(rawOptions.mode))) {
      safe.mode = normalizeAutoGuardMode(rawOptions.mode);
    }
    if (typeof rawOptions.protectOutsideWorkspace === 'boolean') {
      safe.protectOutsideWorkspace = rawOptions.protectOutsideWorkspace;
    }
  }
  return safe;
}

function quotePosixArg(arg) {
  const s = String(arg || '');
  if (POSIX_SAFE_RE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeCmdSetVal(val) {
  return String(val || '').replace(/([\^&|<>()])/g, '^$1');
}

function buildAutoGuardHookCommand(nodeCmd, deployedScriptPath, platform = process.platform) {
  const nodeBin = String(nodeCmd || 'node').trim();
  const normScript = String(deployedScriptPath || '').replace(/\\/g, '/');

  if (platform !== 'win32') {
    return `${quotePosixArg(nodeBin)} ${quotePosixArg(normScript)}`;
  }

  const nodeUnsafe = WIN_UNSAFE_RE.test(nodeBin);
  const scriptUnsafe = WIN_UNSAFE_RE.test(normScript);
  if (!nodeUnsafe && !scriptUnsafe) {
    return `${nodeBin} ${normScript}`;
  }

  const b64 = Buffer.from(normScript, 'utf8').toString('base64');
  const runnerArgs = `-e require(Buffer.from('${b64}','base64').toString('utf8')).runCliHook()`;
  if (!nodeUnsafe) {
    return `${nodeBin} ${runnerArgs}`;
  }

  const nodeDir = path.win32.dirname(nodeBin).replace(/\//g, '\\');
  const nodeBase = path.win32.basename(nodeBin);
  if (!WIN_UNSAFE_RE.test(nodeBase) && nodeDir && nodeDir !== '.' && !nodeDir.includes(';')) {
    return `set PATH=${escapeCmdSetVal(nodeDir)};%PATH%&&${nodeBase} ${runnerArgs}`;
  }
  return `call "${nodeBin}" ${runnerArgs}`;
}

function isSymlinkPath(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function hasAnySymlink(paths) {
  return paths.some(p => isSymlinkPath(p));
}

function readHooksJsonSafe(hooksJsonPath, guardPaths = []) {
  if (hasAnySymlink([...guardPaths, hooksJsonPath])) {
    return {
      exists: true,
      valid: false,
      isSymlink: true,
      errorKey: 'rehydrate.err.symlinkBlocked',
      error: '检测到 ~/.gemini/config 或 hooks.json 为符号链接，出于安全考虑已中止读写'
    };
  }
  if (!fs.existsSync(hooksJsonPath)) {
    return { exists: false, valid: true, data: {} };
  }
  try {
    const stat = fs.statSync(hooksJsonPath);
    if (!stat.isFile()) {
      return {
        exists: true,
        valid: false,
        errorKey: 'rehydrate.err.corruptHooksJson',
        error: 'hooks.json 不是常规文件，为保护配置已中止操作'
      };
    }
    const raw = fs.readFileSync(hooksJsonPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        exists: true,
        valid: false,
        errorKey: 'rehydrate.err.corruptHooksJson',
        error: 'hooks.json 根节点必须为 JSON 对象，为保护现有 Hook 配置已中止写入'
      };
    }
    return { exists: true, valid: true, data: parsed };
  } catch {
    return {
      exists: true,
      valid: false,
      errorKey: 'rehydrate.err.corruptHooksJson',
      error: 'hooks.json 格式损坏或无法解析，为保护现有其他 Hook 配置已中止写入'
    };
  }
}

function writeFileAtomic(targetPath, content, mode = undefined) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(tmpPath, content);
    } else {
      fs.writeFileSync(tmpPath, content, 'utf8');
    }
    if (mode !== undefined && process.platform !== 'win32') {
      try { fs.chmodSync(tmpPath, mode); } catch {}
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function getAutoGuardCfgOpts(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return { stateDir: path.resolve(options.stateDir.trim()) };
  }
  if (isTestModeActive() && !process.env.AG_METER_STATE_DIR) {
    return { stateDir: path.join(os.tmpdir(), 'ag-meter-isolated-test-state') };
  }
  return {};
}

const CORRUPT_MODULES_CFG_ERR = 'modules.json 配置文件已损坏，为保护其他模块设置与恢复基线已中止写入';

function readAutoGuardModuleState(options = {}) {
  const cfg = loadModulesConfig(getAutoGuardCfgOpts(options));
  const state = {
    enabled: false,
    managed: false,
    baselineCaptured: false,
    mode: 'smart',
    protectOutsideWorkspace: true,
    hadPreexistingHook: false,
    preexistingHook: null,
    hadPreexistingScript: false,
    preexistingScriptBackupPath: null,
    lastUpdated: null,
    ...(cfg?.modules?.autoguard || {})
  };
  state.mode = normalizeAutoGuardMode(state.mode);
  state.protectOutsideWorkspace = state.protectOutsideWorkspace !== false;
  Object.defineProperties(state, {
    _configCorrupted: { value: Boolean(cfg?.__configCorrupted), enumerable: false },
    _configError: { value: cfg?.__configError || null, enumerable: false }
  });
  return state;
}

function writeAutoGuardModuleState(patch, options = {}) {
  const cfgOpts = getAutoGuardCfgOpts(options);
  const cfg = loadModulesConfig(cfgOpts);
  if (cfg && cfg.__configCorrupted) {
    throw new Error(CORRUPT_MODULES_CFG_ERR);
  }
  if (!cfg.modules) cfg.modules = {};
  cfg.modules.autoguard = {
    enabled: false,
    managed: false,
    baselineCaptured: false,
    mode: 'smart',
    protectOutsideWorkspace: true,
    hadPreexistingHook: false,
    preexistingHook: null,
    hadPreexistingScript: false,
    preexistingScriptBackupPath: null,
    ...(cfg.modules.autoguard || {}),
    ...patch,
    lastUpdated: new Date().toISOString()
  };
  saveModulesConfig(cfg, cfgOpts);
}

function extractCommandFromPreToolUse(entry) {
  const groups = Array.isArray(entry?.PreToolUse) ? entry.PreToolUse : [];
  for (const grp of groups) {
    if (!grp || typeof grp !== 'object') continue;
    if (typeof grp.command === 'string' && (grp.command.includes(SCRIPT_FILENAME) || grp.command.includes(HOOK_NAME))) {
      return grp.command;
    }
    const hooks = Array.isArray(grp.hooks) ? grp.hooks : [];
    for (const h of hooks) {
      if (h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(SCRIPT_FILENAME)) {
        return h.command;
      }
      if (h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes('Buffer.from')) {
        return h.command;
      }
    }
  }
  return null;
}

function isPluginManagedHookEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const extraKeys = Object.keys(entry).filter(k => k !== 'enabled' && k !== 'PreToolUse');
  if (extraKeys.length > 0) return false;
  return Boolean(extractCommandFromPreToolUse(entry));
}

function buildAutoGuardStatus(options = {}, nodeInfo = null) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);
  const bundled = resolveBundledAutoGuardScript(options);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  const modState = readAutoGuardModuleState(options);
  const modulesConfigValid = !modState._configCorrupted;
  const otherHookNames = hooksRead.valid
    ? Object.keys(hooksRead.data).filter(k => k !== HOOK_NAME)
    : [];

  let hookRegistered = false;
  let hookEnabled = false;
  let currentCommand = null;
  if (hooksRead.valid && hooksRead.data[HOOK_NAME] && typeof hooksRead.data[HOOK_NAME] === 'object' && !Array.isArray(hooksRead.data[HOOK_NAME])) {
    const entry = hooksRead.data[HOOK_NAME];
    const cmd = extractCommandFromPreToolUse(entry);
    if (cmd) {
      hookRegistered = true;
      hookEnabled = entry.enabled !== false;
      currentCommand = cmd;
    }
  }

  let scriptInstalled = false;
  let scriptMatchesBundled = false;
  if (!hasAnySymlink([configDir, hooksDir, deployedScriptPath]) && fs.existsSync(deployedScriptPath)) {
    try {
      if (fs.statSync(deployedScriptPath).isFile()) {
        scriptInstalled = true;
        const deployedSha = sha256Buffer(fs.readFileSync(deployedScriptPath));
        scriptMatchesBundled = Boolean(bundled.sha256 && deployedSha === bundled.sha256);
      }
    } catch {}
  }

  const nodeReady = Boolean(nodeInfo && nodeInfo.ok);
  let status = 'not_installed';
  let errorKey = null;
  let error = null;

  if (!hooksRead.valid) {
    status = 'corrupt_hooks_json';
    errorKey = hooksRead.errorKey;
    error = hooksRead.error;
  } else if (hookRegistered && hookEnabled) {
    if (!scriptInstalled) {
      status = 'broken';
      errorKey = 'autoguard.err.missingScript';
      error = 'hooks.json 已注册 antigravity-auto-guard，但缺失脚本 auto_guard_hook.js';
    } else if (!nodeReady) {
      status = 'broken';
      errorKey = 'autoguard.err.noNode';
      error = '未检测到可用的 Node.js 运行时';
    } else {
      status = 'enabled';
    }
  } else if (hookRegistered && !hookEnabled) {
    status = 'disabled';
  }

  return {
    supported: true,
    status,
    enabled: status === 'enabled',
    mode: modState.mode,
    protectOutsideWorkspace: modState.protectOutsideWorkspace,
    hookName: HOOK_NAME,
    hookRegistered,
    hookEnabled,
    scriptInstalled,
    scriptMatchesBundled,
    bundledAvailable: Boolean(bundled.path),
    configDir,
    hooksJsonPath,
    hooksFileExists: hooksRead.exists,
    hooksFileValid: hooksRead.valid,
    modulesConfigValid,
    deployedScriptPath,
    otherHookNames,
    nodeReady,
    nodeVersion: nodeInfo?.version || null,
    nodeCommand: nodeInfo?.command || null,
    command: currentCommand,
    errorKey,
    error
  };
}

function getAutoGuardStatus(options = {}) {
  const nodeInfo = resolveNodeForHook(options);
  return buildAutoGuardStatus(options, nodeInfo);
}

async function getAutoGuardStatusAsync(options = {}) {
  const nodeInfo = await resolveNodeForHookAsync(options);
  return buildAutoGuardStatus(options, nodeInfo);
}

function executeApplyAutoGuard(options = {}, nodeInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return { ok: false, errorKey: hooksRead.errorKey, error: hooksRead.error, status: buildAutoGuardStatus(options, nodeInfo) };
  }
  if (!nodeInfo || !nodeInfo.ok) {
    return {
      ok: false,
      errorKey: 'autoguard.err.noNode',
      error: '未检测到 Node.js 运行时，无法启用 Auto 智能审批 Hook',
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }
  const bundled = resolveBundledAutoGuardScript(options);
  if (!bundled.path || bundled.content === null) {
    return {
      ok: false,
      errorKey: 'autoguard.err.missingBundledScript',
      error: '未找到随包附带的 auto_guard_hook.js 脚本文件',
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }

  const prevModState = readAutoGuardModuleState(options);
  if (prevModState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }

  const prePluginBak = `${deployedScriptPath}.pre-plugin.bak`;
  if (hasAnySymlink([deployedScriptPath, prePluginBak])) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.symlinkBlocked',
      error: '检测到 Auto Guard 脚本或备份文件为符号链接，已中止写入',
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }

  const hookExistedBefore = hooksRead.exists && Object.prototype.hasOwnProperty.call(hooksRead.data, HOOK_NAME);
  let scriptExistedBefore = false;
  let existingScriptShaBefore = null;
  if (fs.existsSync(deployedScriptPath) && fs.statSync(deployedScriptPath).isFile()) {
    scriptExistedBefore = true;
    existingScriptShaBefore = sha256Buffer(fs.readFileSync(deployedScriptPath));
  }

  fs.mkdirSync(hooksDir, { recursive: true });

  const hasSavedBaseline = Boolean(prevModState.managed === true || prevModState.baselineCaptured === true);
  let nextManagedMeta;
  if (hasSavedBaseline) {
    nextManagedMeta = {
      hadPreexistingHook: Boolean(prevModState.hadPreexistingHook),
      preexistingHook: prevModState.preexistingHook || null,
      hadPreexistingScript: Boolean(prevModState.hadPreexistingScript),
      preexistingScriptBackupPath: prevModState.preexistingScriptBackupPath || null
    };
  } else {
    let preexistingScriptBackupPath = null;
    if (scriptExistedBefore && existingScriptShaBefore !== bundled.sha256) {
      preexistingScriptBackupPath = prePluginBak;
      writeFileAtomic(preexistingScriptBackupPath, fs.readFileSync(deployedScriptPath));
    }
    nextManagedMeta = {
      hadPreexistingHook: Boolean(hookExistedBefore),
      preexistingHook: hookExistedBefore ? JSON.parse(JSON.stringify(hooksRead.data[HOOK_NAME])) : null,
      hadPreexistingScript: Boolean(scriptExistedBefore),
      preexistingScriptBackupPath
    };
    writeAutoGuardModuleState({
      enabled: Boolean(prevModState.enabled),
      managed: false,
      baselineCaptured: true,
      mode: prevModState.mode,
      protectOutsideWorkspace: prevModState.protectOutsideWorkspace,
      ...nextManagedMeta
    }, options);
  }

  let scriptChanged = false;
  if (!scriptExistedBefore || existingScriptShaBefore !== bundled.sha256) {
    writeFileAtomic(deployedScriptPath, bundled.content, 0o755);
    scriptChanged = true;
  }

  const hooksObj = { ...hooksRead.data };
  const targetCmd = buildAutoGuardHookCommand(nodeInfo.command, deployedScriptPath, options.platform || process.platform);
  const nextEntry = {
    enabled: true,
    PreToolUse: [
      {
        matcher: TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: targetCmd,
            timeout: 8
          }
        ]
      }
    ]
  };
  const hookChanged = JSON.stringify(hooksObj[HOOK_NAME]) !== JSON.stringify(nextEntry);
  if (hookChanged || !hooksRead.exists) {
    hooksObj[HOOK_NAME] = nextEntry;
    writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
  }

  const nextMode = options.mode !== undefined ? normalizeAutoGuardMode(options.mode) : prevModState.mode;
  const nextProtect = typeof options.protectOutsideWorkspace === 'boolean'
    ? options.protectOutsideWorkspace
    : prevModState.protectOutsideWorkspace;
  const settingsChanged = nextMode !== prevModState.mode || nextProtect !== prevModState.protectOutsideWorkspace || prevModState.enabled !== true;

  writeAutoGuardModuleState({
    enabled: true,
    managed: true,
    baselineCaptured: true,
    mode: nextMode,
    protectOutsideWorkspace: nextProtect,
    ...nextManagedMeta
  }, options);

  return {
    ok: true,
    changed: Boolean(scriptChanged || hookChanged || !hooksRead.exists || prevModState.managed !== true || settingsChanged),
    status: buildAutoGuardStatus(options, nodeInfo)
  };
}

function applyAutoGuard(options = {}) {
  return executeApplyAutoGuard(options, resolveNodeForHook(options));
}

async function applyAutoGuardAsync(options = {}) {
  return executeApplyAutoGuard(options, await resolveNodeForHookAsync(options));
}

function executeDisableAutoGuard(options = {}, nodeInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return { ok: false, errorKey: hooksRead.errorKey, error: hooksRead.error, status: buildAutoGuardStatus(options, nodeInfo) };
  }
  const modState = readAutoGuardModuleState(options);
  if (modState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }

  let changed = false;
  if (hooksRead.exists && hooksRead.data[HOOK_NAME] && typeof hooksRead.data[HOOK_NAME] === 'object' && !Array.isArray(hooksRead.data[HOOK_NAME])) {
    const hooksObj = { ...hooksRead.data };
    if (hooksObj[HOOK_NAME].enabled !== false) {
      hooksObj[HOOK_NAME] = {
        ...hooksObj[HOOK_NAME],
        enabled: false
      };
      writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
      changed = true;
    }
  }

  writeAutoGuardModuleState({ enabled: false }, options);

  return {
    ok: true,
    changed: Boolean(changed || modState.enabled === true),
    status: buildAutoGuardStatus(options, nodeInfo)
  };
}

function disableAutoGuard(options = {}) {
  return executeDisableAutoGuard(options, resolveNodeForHook(options));
}

async function disableAutoGuardAsync(options = {}) {
  return executeDisableAutoGuard(options, await resolveNodeForHookAsync(options));
}

function executeRestoreAutoGuard(options = {}, nodeInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return { ok: false, errorKey: hooksRead.errorKey, error: hooksRead.error, status: buildAutoGuardStatus(options, nodeInfo) };
  }

  const forceRemove = Boolean(options && options.force === true);
  const modState = readAutoGuardModuleState(options);
  if (!forceRemove && modState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildAutoGuardStatus(options, nodeInfo)
    };
  }

  const isManaged = Boolean(modState.managed === true || modState.baselineCaptured === true);
  const prePluginBak = typeof modState.preexistingScriptBackupPath === 'string' && modState.preexistingScriptBackupPath
    ? modState.preexistingScriptBackupPath
    : `${deployedScriptPath}.pre-plugin.bak`;

  if (!forceRemove && !isManaged) {
    if (modState.enabled !== false) {
      writeAutoGuardModuleState({ enabled: false, managed: false, baselineCaptured: false }, options);
    }
    return { ok: true, changed: false, skippedUnmanaged: true, status: buildAutoGuardStatus(options, nodeInfo) };
  }

  let changed = false;
  if (hooksRead.exists && Object.prototype.hasOwnProperty.call(hooksRead.data, HOOK_NAME)) {
    const hooksObj = { ...hooksRead.data };
    if (!forceRemove && modState.hadPreexistingHook && modState.preexistingHook && isPluginManagedHookEntry(hooksObj[HOOK_NAME])) {
      hooksObj[HOOK_NAME] = modState.preexistingHook;
      writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
      changed = true;
    } else if (forceRemove || isPluginManagedHookEntry(hooksObj[HOOK_NAME])) {
      delete hooksObj[HOOK_NAME];
      writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
      changed = true;
    }
  }

  if (fs.existsSync(deployedScriptPath) && !isSymlinkPath(deployedScriptPath)) {
    if (!forceRemove && modState.hadPreexistingScript && fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak)) {
      writeFileAtomic(deployedScriptPath, fs.readFileSync(prePluginBak), 0o755);
    } else {
      fs.unlinkSync(deployedScriptPath);
    }
    changed = true;
  }

  try {
    if (fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak)) {
      fs.unlinkSync(prePluginBak);
    }
  } catch {}

  if (!modState._configCorrupted) {
    writeAutoGuardModuleState({
      enabled: false,
      managed: false,
      baselineCaptured: false,
      hadPreexistingHook: false,
      preexistingHook: null,
      hadPreexistingScript: false,
      preexistingScriptBackupPath: null
    }, options);
  }

  return { ok: true, changed, status: buildAutoGuardStatus(options, nodeInfo) };
}

function restoreAutoGuard(options = {}) {
  return executeRestoreAutoGuard(options, resolveNodeForHook(options));
}

async function restoreAutoGuardAsync(options = {}) {
  return executeRestoreAutoGuard(options, await resolveNodeForHookAsync(options));
}

module.exports = {
  HOOK_NAME,
  SCRIPT_FILENAME,
  TOOL_MATCHER,
  VALID_MODES,
  normalizeAutoGuardMode,
  sanitizeAutoGuardRendererOptions,
  resolveGeminiConfigDir,
  resolveBundledAutoGuardScript,
  resolveNodeForHook,
  resolveNodeForHookAsync,
  buildAutoGuardHookCommand,
  getAutoGuardStatus,
  getAutoGuardStatusAsync,
  applyAutoGuard,
  applyAutoGuardAsync,
  disableAutoGuard,
  disableAutoGuardAsync,
  restoreAutoGuard,
  restoreAutoGuardAsync
};
