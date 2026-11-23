'use strict';
// Preserve Electron ASAR support in the host process.

/**
 * Antigravity 压缩后上下文恢复与跨 /fork 溯源 Hook 生命周期管理模块 (meter-rehydrate.js)
 * 思路参考 AGY Post-Compact Rehydration 方案，本仓库附带的恢复脚本与管理模块按 MIT 协议独立实现。
 * 职责：
 * 1. 管理 ~/.gemini/config/hooks/rehydrate_after_compact.py 的部署、哈希校验、备份与移除；
 * 2. 以 fail-closed 方式安全读写 ~/.gemini/config/hooks.json 中的 "post-compact-rehydrate" 条目，
 *    严格保留用户其他已有 Hook（如 herdr 等）；
 * 3. 探测 Python 3.10+ 运行环境并生成跨平台兼容的 Hook 调用命令；
 * 4. 在测试模式下强制隔离路径，绝不触碰真实宿主环境配置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { getStateDir } = require('./asar-engine');
const { loadModulesConfig, saveModulesConfig } = require('./modules-config');

const HOOK_NAME = 'post-compact-rehydrate';
const SCRIPT_FILENAME = 'rehydrate_after_compact.py';
const REHYDRATE_AUTHOR_INFO = {
  name: 'AGY Post-Compact Rehydration 方案',
  url: 'https://agy-rehydrate.pages.dev/',
  credit: '思路参考：AGY Post-Compact Rehydration（本仓库脚本按 MIT 独立实现）'
};

const PY_CHECK_CODE =
  "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}'); raise SystemExit(0 if sys.version_info >= (3, 10) else 1)";

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

/**
 * 解析 Gemini 全局配置目录（测试模式下默认严格隔离至临时状态目录）
 */
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

/**
 * 解析随包附带的 rehydrate_after_compact.py 源脚本路径与内容
 */
function resolveBundledRehydrateScript(options = {}) {
  const candidates = [];
  if (options && typeof options.bundledScriptPath === 'string' && options.bundledScriptPath.trim()) {
    candidates.push(path.resolve(options.bundledScriptPath.trim()));
  }
  candidates.push(
    path.join(__dirname, 'rehydrate', SCRIPT_FILENAME),
    path.join(__dirname, 'dist', 'rehydrate', SCRIPT_FILENAME),
    path.join(__dirname, '..', 'rehydrate', SCRIPT_FILENAME)
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

function collectPythonCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = [];
  const home = options.homeDir ? path.resolve(options.homeDir) : os.homedir();

  if (process.env.AG_METER_PYTHON && process.env.AG_METER_PYTHON.trim()) {
    candidates.push({ command: process.env.AG_METER_PYTHON.trim(), preferBare: false });
  }

  if (platform === 'win32') {
    // 1. 系统 PATH 中的裸命令（如已被正常安装进 PATH）
    candidates.push({ command: 'python', preferBare: true });
    candidates.push({ command: 'python3', preferBare: true });
    candidates.push({ command: 'py', args: ['-3'], preferBare: true });

    // 2. 独立可靠的 Python 运行时（优先于未加入 PATH 的各目录，防止 WindowsApps 占位应用商店存根）
    const knownExes = [
      path.join(home, '.gemini', 'antigravity-cli', 'runtimes', 'python', 'python.exe'),
      path.join(home, '.gemini', 'antigravity', 'runtimes', 'python', 'python.exe'),
      path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
    ];
    for (const exe of knownExes) {
      if (fs.existsSync(exe)) candidates.push({ command: exe, preferBare: false });
    }

    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roots = [
      path.join(localAppData, 'Programs', 'Python'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Python')
    ];
    for (const rootDir of roots) {
      try {
        if (!fs.existsSync(rootDir)) continue;
        const dirs = fs.readdirSync(rootDir).filter(d => /^Python3\d+/i.test(d)).sort().reverse();
        for (const d of dirs) {
          const exe = path.join(rootDir, d, 'python.exe');
          if (fs.existsSync(exe)) candidates.push({ command: exe, preferBare: false });
        }
      } catch {}
    }
  } else {
    for (const p of [
      path.join(home, '.gemini/antigravity-cli/runtimes/python/bin/python3'),
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      path.join(home, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')
    ]) {
      try {
        if (fs.existsSync(p)) candidates.push({ command: p, preferBare: false });
      } catch {}
    }
    const bareCmds = ['python3', 'python'];
    for (const cmd of bareCmds) {
      candidates.push({ command: cmd, preferBare: true });
    }
  }
  return candidates;
}

function parsePythonProbeOutput(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/)[0] || '';
  const sepIdx = line.indexOf('|');
  if (sepIdx <= 0) return null;
  const version = line.slice(0, sepIdx).trim();
  const executable = line.slice(sepIdx + 1).trim();
  // 严格过滤 Windows Store 占位跳转程序
  if (executable && /microsoft[\\/]windowsapps[\\/]python/i.test(executable)) {
    return null;
  }
  const parts = version.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { version, major, minor, executable, ok: major > 3 || (major === 3 && minor >= 10) };
}

const PYTHON_PROBE_CACHE_TTL_MS = 30_000;
const pythonProbeCache = new Map();

function clearPythonProbeCache() {
  pythonProbeCache.clear();
}

function getPythonProbeCacheKey(options = {}) {
  const platform = options.platform || process.platform;
  const customPy = process.env.AG_METER_PYTHON || '';
  const envPath = options.envPath ?? process.env.PATH ?? '';
  return `${platform}|${customPy}|${envPath}`;
}

function readPythonProbeCache(cacheKey, now = Date.now()) {
  const entry = pythonProbeCache.get(cacheKey);
  if (!entry) return null;
  if (now - entry.ts >= PYTHON_PROBE_CACHE_TTL_MS) {
    pythonProbeCache.delete(cacheKey);
    return null;
  }
  return { ...entry.value };
}

function writePythonProbeCache(cacheKey, result, now = Date.now()) {
  if (!result || result.ok !== true) return;
  pythonProbeCache.set(cacheKey, { ts: now, value: { ...result } });
}

function resolvePosixCommandInPath(cmdName, envPath = process.env.PATH) {
  if (typeof cmdName !== 'string' || !cmdName.trim()) return null;
  const cmd = cmdName.trim();
  if (cmd.includes('/')) return cmd.startsWith('/') ? cmd : null;
  for (const rawDir of String(envPath || '').split(':')) {
    const dir = rawDir.trim();
    if (!dir || !dir.startsWith('/')) continue;
    const candidate = path.posix.join(dir, cmd);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      if (process.platform !== 'win32') {
        fs.accessSync(candidate, fs.constants.X_OK);
      }
      return candidate;
    } catch {}
  }
  return null;
}

function formatResolvedPythonResult(cand, parsed, resolvedPosix, targetPlatform) {
  const command = targetPlatform !== 'win32' && cand.preferBare
    ? (resolvedPosix || parsed.executable || cand.command)
    : (cand.preferBare ? cand.command : (parsed.executable || cand.command));
  return {
    ok: true,
    command,
    executable: parsed.executable || cand.command,
    version: parsed.version
  };
}

function resolvePython310(options = {}) {
  if (typeof options._pythonProbe === 'function') {
    return options._pythonProbe();
  }
  const cacheKey = getPythonProbeCacheKey(options);
  const cached = readPythonProbeCache(cacheKey);
  if (cached) return cached;

  const targetPlatform = options.platform || process.platform;
  const envPath = options.envPath ?? process.env.PATH;
  let detectedOldVer = null;
  for (const cand of collectPythonCandidates(options)) {
    const resolvedPosix = targetPlatform !== 'win32' && cand.preferBare
      ? resolvePosixCommandInPath(cand.command, envPath)
      : null;
    const probeCmd = resolvedPosix || cand.command;
    try {
      const out = childProcess.execFileSync(probeCmd, ['-c', PY_CHECK_CODE], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const parsed = parsePythonProbeOutput(out);
      if (parsed && parsed.ok) {
        const result = formatResolvedPythonResult(cand, parsed, resolvedPosix, targetPlatform);
        writePythonProbeCache(cacheKey, result);
        return result;
      }
      if (parsed && !detectedOldVer) detectedOldVer = parsed.version;
    } catch (err) {
      const parsed = parsePythonProbeOutput(err?.stdout);
      if (parsed && !detectedOldVer) detectedOldVer = parsed.version;
    }
  }
  return { ok: false, command: null, executable: null, version: detectedOldVer };
}

async function resolvePython310Async(options = {}) {
  if (typeof options._pythonProbe === 'function') {
    return await options._pythonProbe();
  }
  const cacheKey = getPythonProbeCacheKey(options);
  const cached = readPythonProbeCache(cacheKey);
  if (cached) return cached;

  const targetPlatform = options.platform || process.platform;
  const envPath = options.envPath ?? process.env.PATH;
  let detectedOldVer = null;
  for (const cand of collectPythonCandidates(options)) {
    const resolvedPosix = targetPlatform !== 'win32' && cand.preferBare
      ? resolvePosixCommandInPath(cand.command, envPath)
      : null;
    const probeCmd = resolvedPosix || cand.command;
    const res = await new Promise((resolve) => {
      childProcess.execFile(
        probeCmd,
        ['-c', PY_CHECK_CODE],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
        (err, stdout) => {
          const parsed = parsePythonProbeOutput(stdout);
          if (!err && parsed && parsed.ok) {
            resolve({ hit: true, parsed });
          } else {
            resolve({ hit: false, parsed });
          }
        }
      );
    });
    if (res.hit) {
      const result = formatResolvedPythonResult(cand, res.parsed, resolvedPosix, targetPlatform);
      writePythonProbeCache(cacheKey, result);
      return result;
    }
    if (res.parsed && !detectedOldVer) detectedOldVer = res.parsed.version;
  }
  return { ok: false, command: null, executable: null, version: detectedOldVer };
}

const WIN_UNSAFE_RE = /[\s"&|<>^%()!']/;
const POSIX_SAFE_RE = /^[A-Za-z0-9_./:@+-]+$/;

function sanitizeRehydrateRendererOptions(rawOptions, action = 'status') {
  if (action === 'restore' && rawOptions && typeof rawOptions === 'object' && rawOptions.force === true) {
    return { force: true };
  }
  return {};
}

function quotePosixArg(arg) {
  const s = String(arg || '');
  if (POSIX_SAFE_RE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeCmdSetVal(val) {
  return String(val || '').replace(/([\^&|<>()])/g, '^$1');
}

/**
 * 构建跨平台安全的 PreInvocation Hook 命令：
 * - Windows 含空格或 cmd 元字符时通过 Base64 runpy 与 set PATH 规避 cmd /c 与 Go EscapeArg 双引号转义冲突，且不依赖 cwd
 * - POSIX 含空白或特殊字符时采用单引号安全包裹
 */
function buildHookCommand(pythonCmd, deployedScriptPath, platform = process.platform) {
  const py = String(pythonCmd || (platform === 'win32' ? 'python' : 'python3')).trim();
  const normScript = String(deployedScriptPath || '').replace(/\\/g, '/');

  if (platform !== 'win32') {
    return `${quotePosixArg(py)} -X utf8 ${quotePosixArg(normScript)}`;
  }

  const pyUnsafe = WIN_UNSAFE_RE.test(py);
  const scriptUnsafe = WIN_UNSAFE_RE.test(normScript);
  if (!pyUnsafe && !scriptUnsafe) {
    return `${py} -X utf8 ${normScript}`;
  }

  const b64 = Buffer.from(normScript, 'utf8').toString('base64');
  const runnerArgs = `-X utf8 -c __import__('runpy').run_path(__import__('base64').b64decode('${b64}').decode('utf-8'),run_name='__main__')#${SCRIPT_FILENAME}`;
  if (!pyUnsafe) {
    return `${py} ${runnerArgs}`;
  }

  const pyDir = path.win32.dirname(py).replace(/\//g, '\\');
  const pyBase = path.win32.basename(py);
  if (!WIN_UNSAFE_RE.test(pyBase) && pyDir && pyDir !== '.' && !pyDir.includes(';')) {
    return `set PATH=${escapeCmdSetVal(pyDir)};%PATH%&&${pyBase} ${runnerArgs}`;
  }
  return `call "${py}" ${runnerArgs}`;
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

function archiveScriptBackup(deployedScriptPath, contentBuf) {
  const buf = Buffer.isBuffer(contentBuf) ? contentBuf : Buffer.from(String(contentBuf), 'utf8');
  const newSha = sha256Buffer(buf);
  const bakPath = `${deployedScriptPath}.bak`;
  if (isSymlinkPath(bakPath)) {
    throw new Error('检测到 Rehydrate 备份文件为符号链接，出于安全考虑已中止读写');
  }
  if (fs.existsSync(bakPath) && fs.statSync(bakPath).isFile()) {
    const prevBuf = fs.readFileSync(bakPath);
    const prevSha = sha256Buffer(prevBuf);
    if (prevSha === newSha) {
      return bakPath;
    }
    const historyBakPath = `${deployedScriptPath}.bak.${prevSha.slice(0, 8)}`;
    if (isSymlinkPath(historyBakPath)) {
      throw new Error('检测到 Rehydrate 历史备份文件为符号链接，出于安全考虑已中止读写');
    }
    if (!fs.existsSync(historyBakPath)) {
      writeFileAtomic(historyBakPath, prevBuf);
    }
  }
  writeFileAtomic(bakPath, buf);
  return bakPath;
}

function getRehydrateCfgOpts(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return { stateDir: path.resolve(options.stateDir.trim()) };
  }
  if (isTestModeActive() && !process.env.AG_METER_STATE_DIR) {
    return { stateDir: path.join(os.tmpdir(), 'ag-meter-isolated-test-state') };
  }
  return {};
}

const CORRUPT_MODULES_CFG_ERR = 'modules.json 配置文件已损坏，为保护其他模块设置与恢复基线已中止写入';

function readRehydrateModuleState(options = {}) {
  const cfg = loadModulesConfig(getRehydrateCfgOpts(options));
  const state = {
    enabled: false,
    managed: false,
    baselineCaptured: false,
    hadPreexistingHook: false,
    preexistingHook: null,
    hadPreexistingScript: false,
    preexistingScriptBackupPath: null,
    lastUpdated: null,
    ...(cfg?.modules?.rehydrate || {})
  };
  Object.defineProperties(state, {
    _configCorrupted: { value: Boolean(cfg?.__configCorrupted), enumerable: false },
    _configError: { value: cfg?.__configError || null, enumerable: false }
  });
  return state;
}

function writeRehydrateModuleState(patch, options = {}) {
  const cfgOpts = getRehydrateCfgOpts(options);
  const cfg = loadModulesConfig(cfgOpts);
  if (cfg && cfg.__configCorrupted) {
    throw new Error(CORRUPT_MODULES_CFG_ERR);
  }
  if (!cfg.modules) cfg.modules = {};
  cfg.modules.rehydrate = {
    enabled: false,
    managed: false,
    baselineCaptured: false,
    hadPreexistingHook: false,
    preexistingHook: null,
    hadPreexistingScript: false,
    preexistingScriptBackupPath: null,
    ...(cfg.modules.rehydrate || {}),
    ...patch,
    lastUpdated: new Date().toISOString()
  };
  saveModulesConfig(cfg, cfgOpts);
}

function isPluginManagedHookEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const extraKeys = Object.keys(entry).filter(k => k !== 'enabled' && k !== 'PreInvocation');
  if (extraKeys.length > 0) return false;
  const handlers = Array.isArray(entry.PreInvocation) ? entry.PreInvocation : [];
  if (handlers.length === 0) return true;
  return handlers.every(
    h => h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(SCRIPT_FILENAME)
  );
}

function buildRehydrateStatus(options = {}, pyInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);
  const bundled = resolveBundledRehydrateScript(options);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  const modState = readRehydrateModuleState(options);
  const modulesConfigValid = !modState._configCorrupted;
  const otherHookNames = hooksRead.valid
    ? Object.keys(hooksRead.data).filter(k => k !== HOOK_NAME)
    : [];

  let hookRegistered = false;
  let hookEnabled = false;
  let currentCommand = null;
  if (hooksRead.valid && hooksRead.data[HOOK_NAME] && typeof hooksRead.data[HOOK_NAME] === 'object' && !Array.isArray(hooksRead.data[HOOK_NAME])) {
    const entry = hooksRead.data[HOOK_NAME];
    const preInv = Array.isArray(entry.PreInvocation) ? entry.PreInvocation : [];
    const matched = preInv.find(
      h => h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(SCRIPT_FILENAME)
    );
    if (matched) {
      hookRegistered = true;
      hookEnabled = entry.enabled !== false;
      currentCommand = matched.command;
    }
  }

  let scriptInstalled = false;
  let deployedSha256 = null;
  let scriptMatchesBundled = false;
  if (!hasAnySymlink([configDir, hooksDir, deployedScriptPath]) && fs.existsSync(deployedScriptPath)) {
    try {
      const st = fs.statSync(deployedScriptPath);
      if (st.isFile()) {
        scriptInstalled = true;
        deployedSha256 = sha256Buffer(fs.readFileSync(deployedScriptPath));
        scriptMatchesBundled = Boolean(bundled.sha256 && deployedSha256 === bundled.sha256);
      }
    } catch {}
  }

  const pythonReady = Boolean(pyInfo && pyInfo.ok);
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
      errorKey = 'rehydrate.err.missingScript';
      error = 'hooks.json 已注册 post-compact-rehydrate，但缺失脚本文件 rehydrate_after_compact.py';
    } else if (!pythonReady) {
      status = 'broken';
      errorKey = 'rehydrate.err.noPython310';
      error = '未检测到 Python 3.10+ 运行环境，Hook 将无法执行';
    } else {
      status = 'enabled';
    }
  } else if (hookRegistered && !hookEnabled) {
    status = 'disabled';
  }
  if (!modulesConfigValid && !errorKey) {
    errorKey = 'rehydrate.err.corruptModulesJson';
    error = CORRUPT_MODULES_CFG_ERR;
  }

  return {
    supported: true,
    status,
    hookName: HOOK_NAME,
    hookRegistered,
    hookEnabled,
    scriptInstalled,
    scriptMatchesBundled,
    bundledAvailable: Boolean(bundled.path),
    bundledScriptPath: bundled.path,
    configDir,
    hooksJsonPath,
    hooksFileExists: hooksRead.exists,
    hooksFileValid: hooksRead.valid,
    modulesConfigValid,
    deployedScriptPath,
    otherHookNames,
    pythonReady,
    pythonVersion: pyInfo?.version || null,
    pythonCommand: pyInfo?.command || null,
    command: currentCommand,
    errorKey,
    error,
    author: REHYDRATE_AUTHOR_INFO
  };
}

function getRehydrateStatus(options = {}) {
  const pyInfo = resolvePython310(options);
  return buildRehydrateStatus(options, pyInfo);
}

async function getRehydrateStatusAsync(options = {}) {
  const pyInfo = await resolvePython310Async(options);
  return buildRehydrateStatus(options, pyInfo);
}

function executeApplyRehydrate(options = {}, pyInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return {
      ok: false,
      errorKey: hooksRead.errorKey,
      error: hooksRead.error,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  if (!pyInfo || !pyInfo.ok) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.noPython310',
      error: '未检测到 Python 3.10+ 运行环境，请安装 Python 3.10 或更高版本后再启用压缩后回水 Hook',
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  const bundled = resolveBundledRehydrateScript(options);
  if (!bundled.path || bundled.content === null) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.missingBundledScript',
      error: '未找到随包附带的 rehydrate_after_compact.py 脚本文件',
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  const prevModState = readRehydrateModuleState(options);
  if (prevModState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }
  const bakDefault = `${deployedScriptPath}.bak`;
  const prePluginBakDefault = `${deployedScriptPath}.pre-plugin.bak`;
  const guardBackups = [bakDefault, prePluginBakDefault];
  if (typeof prevModState.preexistingScriptBackupPath === 'string' && prevModState.preexistingScriptBackupPath) {
    guardBackups.push(prevModState.preexistingScriptBackupPath);
  }
  if (hasAnySymlink(guardBackups)) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.symlinkBlocked',
      error: '检测到 Rehydrate 备份文件为符号链接，出于安全考虑已中止读写',
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  const hookExistedBefore = hooksRead.exists && Object.prototype.hasOwnProperty.call(hooksRead.data, HOOK_NAME);
  let scriptExistedBefore = false;
  let existingScriptShaBefore = null;
  if (fs.existsSync(deployedScriptPath) && !isSymlinkPath(deployedScriptPath)) {
    try {
      if (fs.statSync(deployedScriptPath).isFile()) {
        scriptExistedBefore = true;
        existingScriptShaBefore = sha256Buffer(fs.readFileSync(deployedScriptPath));
      }
    } catch {}
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
      preexistingScriptBackupPath = prePluginBakDefault;
      writeFileAtomic(preexistingScriptBackupPath, fs.readFileSync(deployedScriptPath));
    }
    nextManagedMeta = {
      hadPreexistingHook: Boolean(hookExistedBefore),
      preexistingHook: hookExistedBefore ? JSON.parse(JSON.stringify(hooksRead.data[HOOK_NAME])) : null,
      hadPreexistingScript: Boolean(scriptExistedBefore),
      preexistingScriptBackupPath
    };
    // 改写宿主脚本与 hooks.json 前先持久化接管基线，防止写入中途失败后重试覆盖真实基线
    writeRehydrateModuleState({
      enabled: Boolean(prevModState.enabled),
      managed: false,
      baselineCaptured: true,
      ...nextManagedMeta
    }, options);
  }

  let backupPath = null;
  let scriptChanged = false;
  if (scriptExistedBefore) {
    if (existingScriptShaBefore !== bundled.sha256) {
      backupPath = archiveScriptBackup(deployedScriptPath, fs.readFileSync(deployedScriptPath));
      writeFileAtomic(deployedScriptPath, bundled.content, 0o755);
      scriptChanged = true;
    } else if (process.platform !== 'win32') {
      try { fs.chmodSync(deployedScriptPath, 0o755); } catch {}
    }
  } else {
    writeFileAtomic(deployedScriptPath, bundled.content, 0o755);
    scriptChanged = true;
  }

  const verifiedSha = sha256Buffer(fs.readFileSync(deployedScriptPath));
  if (verifiedSha !== bundled.sha256) {
    throw new Error('部署的 rehydrate_after_compact.py SHA-256 校验失败');
  }

  const hooksObj = { ...hooksRead.data };
  const targetCmd = buildHookCommand(pyInfo.command, deployedScriptPath, options.platform || process.platform);
  const nextEntry = {
    enabled: true,
    PreInvocation: [
      {
        type: 'command',
        command: targetCmd,
        timeout: 10
      }
    ]
  };
  const hookChanged = JSON.stringify(hooksObj[HOOK_NAME]) !== JSON.stringify(nextEntry);
  if (hookChanged || !hooksRead.exists) {
    hooksObj[HOOK_NAME] = nextEntry;
    writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
  }

  writeRehydrateModuleState({
    enabled: true,
    managed: true,
    baselineCaptured: true,
    ...nextManagedMeta
  }, options);

  return {
    ok: true,
    changed: Boolean(scriptChanged || hookChanged || !hooksRead.exists || prevModState.managed !== true),
    backupPath,
    status: buildRehydrateStatus(options, pyInfo)
  };
}

function applyRehydrate(options = {}) {
  const pyInfo = resolvePython310(options);
  return executeApplyRehydrate(options, pyInfo);
}

async function applyRehydrateAsync(options = {}) {
  const pyInfo = await resolvePython310Async(options);
  return executeApplyRehydrate(options, pyInfo);
}

function executeDisableRehydrate(options = {}, pyInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return {
      ok: false,
      errorKey: hooksRead.errorKey,
      error: hooksRead.error,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  const modState = readRehydrateModuleState(options);
  if (modState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildRehydrateStatus(options, pyInfo)
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

  writeRehydrateModuleState({ enabled: false }, options);

  return {
    ok: true,
    changed,
    status: buildRehydrateStatus(options, pyInfo)
  };
}

function disableRehydrate(options = {}) {
  const pyInfo = resolvePython310(options);
  return executeDisableRehydrate(options, pyInfo);
}

async function disableRehydrateAsync(options = {}) {
  const pyInfo = await resolvePython310Async(options);
  return executeDisableRehydrate(options, pyInfo);
}

function executeRestoreRehydrate(options = {}, pyInfo) {
  const configDir = resolveGeminiConfigDir(options);
  const hooksDir = path.join(configDir, 'hooks');
  const hooksJsonPath = path.join(configDir, 'hooks.json');
  const deployedScriptPath = path.join(hooksDir, SCRIPT_FILENAME);

  const hooksRead = readHooksJsonSafe(hooksJsonPath, [configDir, hooksDir, deployedScriptPath]);
  if (!hooksRead.valid) {
    return {
      ok: false,
      errorKey: hooksRead.errorKey,
      error: hooksRead.error,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  const forceRemove = Boolean(options && options.force === true);
  const modState = readRehydrateModuleState(options);
  if (!forceRemove && modState._configCorrupted) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.corruptModulesJson',
      error: CORRUPT_MODULES_CFG_ERR,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }
  const isManaged = Boolean(modState.managed === true || modState.baselineCaptured === true);
  const bakCandidate = `${deployedScriptPath}.bak`;
  const prePluginBak = typeof modState.preexistingScriptBackupPath === 'string' && modState.preexistingScriptBackupPath
    ? modState.preexistingScriptBackupPath
    : `${deployedScriptPath}.pre-plugin.bak`;

  // 分支 1：非显式卸载下若未曾由本插件接管托管，绝不删除或覆盖用户独立部署的 Hook 与脚本
  if (!forceRemove && !isManaged) {
    if (modState.enabled !== false) {
      writeRehydrateModuleState({
        enabled: false,
        managed: false,
        baselineCaptured: false
      }, options);
    }
    return {
      ok: true,
      changed: false,
      skippedUnmanaged: true,
      backupPath: null,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  if (hasAnySymlink([bakCandidate, prePluginBak])) {
    return {
      ok: false,
      errorKey: 'rehydrate.err.symlinkBlocked',
      error: '检测到 Rehydrate 备份文件为符号链接，出于安全考虑已中止读写',
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  // 分支 2：默认恢复（如「全部恢复官方默认」 / restore --all），精准退回插件接管前状态
  if (!forceRemove) {
    const needsPreScriptRestore = Boolean(modState.hadPreexistingScript && modState.preexistingScriptBackupPath);
    if (needsPreScriptRestore) {
      let preReady = false;
      try {
        preReady = fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak) && fs.statSync(prePluginBak).isFile();
      } catch {}
      if (!preReady) {
        return {
          ok: false,
          errorKey: 'rehydrate.err.missingBackup',
          error: '未找到开启前的原始脚本备份文件，为避免覆盖丢失已中止自动还原；如需直接清理可点击“卸载移除”',
          status: buildRehydrateStatus(options, pyInfo)
        };
      }
    }

    let changed = false;
    let backupPath = null;
    const hooksObj = { ...hooksRead.data };
    const hasHookEntry = hooksRead.exists && Object.prototype.hasOwnProperty.call(hooksRead.data, HOOK_NAME);

    if (modState.hadPreexistingHook && modState.preexistingHook && typeof modState.preexistingHook === 'object' && !Array.isArray(modState.preexistingHook)) {
      if (!hasHookEntry || isPluginManagedHookEntry(hooksRead.data[HOOK_NAME])) {
        if (JSON.stringify(hooksObj[HOOK_NAME]) !== JSON.stringify(modState.preexistingHook)) {
          hooksObj[HOOK_NAME] = modState.preexistingHook;
          writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
          changed = true;
        }
      }
    } else if (hasHookEntry && isPluginManagedHookEntry(hooksRead.data[HOOK_NAME])) {
      delete hooksObj[HOOK_NAME];
      writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
      changed = true;
    }

    const bundled = resolveBundledRehydrateScript(options);
    const preContent = needsPreScriptRestore ? fs.readFileSync(prePluginBak) : null;
    const preSha = preContent ? sha256Buffer(preContent) : null;
    try {
      if (modState.hadPreexistingScript) {
        let existingSha = null;
        if (fs.existsSync(deployedScriptPath) && !isSymlinkPath(deployedScriptPath) && fs.statSync(deployedScriptPath).isFile()) {
          const curBuf = fs.readFileSync(deployedScriptPath);
          existingSha = sha256Buffer(curBuf);
          // 若主脚本尚未退回为接管前版本且已被人工改写，先归档至 .bak（避免失败重试时冲掉）
          if (bundled.sha256 && existingSha !== bundled.sha256 && (!preSha || existingSha !== preSha)) {
            backupPath = archiveScriptBackup(deployedScriptPath, curBuf);
          }
        }
        if (needsPreScriptRestore && existingSha !== preSha) {
          writeFileAtomic(deployedScriptPath, preContent, 0o755);
          changed = true;
        }
      } else if (fs.existsSync(deployedScriptPath) && !isSymlinkPath(deployedScriptPath)) {
        const curBuf = fs.readFileSync(deployedScriptPath);
        const existingSha = sha256Buffer(curBuf);
        if (bundled.sha256 && existingSha !== bundled.sha256) {
          backupPath = archiveScriptBackup(deployedScriptPath, curBuf);
        }
        fs.unlinkSync(deployedScriptPath);
        changed = true;
      }
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        status: buildRehydrateStatus(options, pyInfo)
      };
    }

    const restoredEnabled = Boolean(modState.hadPreexistingHook && modState.preexistingHook?.enabled !== false);
    writeRehydrateModuleState({
      enabled: restoredEnabled,
      managed: false,
      baselineCaptured: false,
      hadPreexistingHook: false,
      preexistingHook: null,
      hadPreexistingScript: false,
      preexistingScriptBackupPath: null
    }, options);

    // 仅在 modules.json 状态成功提交后清理 .pre-plugin.bak，保证写入失败后重试幂等可恢复
    if (needsPreScriptRestore) {
      try {
        if (fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak)) {
          fs.unlinkSync(prePluginBak);
        }
      } catch {}
    }

    return {
      ok: true,
      changed,
      backupPath,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  // 分支 3：显式卸载移除（force === true）
  let changed = false;
  let backupPath = null;

  if (hooksRead.exists && Object.prototype.hasOwnProperty.call(hooksRead.data, HOOK_NAME)) {
    const hooksObj = { ...hooksRead.data };
    delete hooksObj[HOOK_NAME];
    writeFileAtomic(hooksJsonPath, JSON.stringify(hooksObj, null, 2) + '\n');
    changed = true;
  }

  let shouldUnlinkPrePluginBak = false;
  try {
    if (fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak) && fs.statSync(prePluginBak).isFile()) {
      backupPath = archiveScriptBackup(deployedScriptPath, fs.readFileSync(prePluginBak));
      shouldUnlinkPrePluginBak = true;
      changed = true;
    }

    if (fs.existsSync(deployedScriptPath) && !isSymlinkPath(deployedScriptPath) && fs.statSync(deployedScriptPath).isFile()) {
      const bundled = resolveBundledRehydrateScript(options);
      const curBuf = fs.readFileSync(deployedScriptPath);
      const existingSha = sha256Buffer(curBuf);
      if (bundled.sha256 && existingSha !== bundled.sha256) {
        backupPath = archiveScriptBackup(deployedScriptPath, curBuf);
      }
      fs.unlinkSync(deployedScriptPath);
      changed = true;
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      status: buildRehydrateStatus(options, pyInfo)
    };
  }

  if (!modState._configCorrupted) {
    writeRehydrateModuleState({
      enabled: false,
      managed: false,
      baselineCaptured: false,
      hadPreexistingHook: false,
      preexistingHook: null,
      hadPreexistingScript: false,
      preexistingScriptBackupPath: null
    }, options);
  }

  if (shouldUnlinkPrePluginBak) {
    try {
      if (fs.existsSync(prePluginBak) && !isSymlinkPath(prePluginBak)) {
        fs.unlinkSync(prePluginBak);
      }
    } catch {}
  }

  return {
    ok: true,
    changed,
    backupPath,
    status: buildRehydrateStatus(options, pyInfo)
  };
}

function restoreRehydrate(options = {}) {
  const pyInfo = options && options.skipPythonProbe === true
    ? { ok: false, command: null, executable: null, version: null }
    : resolvePython310(options);
  return executeRestoreRehydrate(options, pyInfo);
}

async function restoreRehydrateAsync(options = {}) {
  const pyInfo = options && options.skipPythonProbe === true
    ? { ok: false, command: null, executable: null, version: null }
    : await resolvePython310Async(options);
  return executeRestoreRehydrate(options, pyInfo);
}

const DEFAULT_WIN_PYTHON_VERSION = '3.12.8';

function getManagedPythonDir(options = {}) {
  if (options && typeof options.pythonDir === 'string' && options.pythonDir.trim()) {
    return path.resolve(options.pythonDir.trim());
  }
  if (options && typeof options.homeDir === 'string' && options.homeDir.trim()) {
    return path.join(path.resolve(options.homeDir.trim()), '.gemini', 'antigravity-cli', 'runtimes', 'python');
  }
  if (isTestModeActive()) {
    const baseState =
      options && typeof options.stateDir === 'string' && options.stateDir.trim()
        ? path.resolve(options.stateDir.trim())
        : (process.env.AG_METER_STATE_DIR ? getStateDir() : os.tmpdir());
    return path.join(baseState, 'isolated-runtimes', 'python');
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'runtimes', 'python');
}

function getPythonEmbedDownloadUrl(arch = process.arch) {
  const suffix = arch === 'arm64' ? 'arm64' : (arch === 'ia32' ? 'win32' : 'amd64');
  return `https://www.python.org/ftp/python/${DEFAULT_WIN_PYTHON_VERSION}/python-${DEFAULT_WIN_PYTHON_VERSION}-embed-${suffix}.zip`;
}

async function downloadPythonZipAsync(urlStr, destZipPath, options = {}) {
  if (typeof options._downloadFile === 'function') {
    await options._downloadFile(urlStr, destZipPath, options);
    return;
  }
  const { requestWithProxyTunnel } = require('./meter-proxy');
  let currentUrl = urlStr;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await requestWithProxyTunnel(currentUrl, {
      method: 'GET',
      timeoutMs: Number(options.timeoutMs) || 30000,
      maxBytes: 64 * 1024 * 1024,
      binary: true,
      stage: 'rehydrate_python_download',
      headers: {
        'User-Agent': 'AntigravityContextMeter/0.8.9',
        'Accept': 'application/octet-stream,*/*'
      }
    });
    if (res.status >= 300 && res.status < 400 && res.headers?.location && hop < 3) {
      currentUrl = new URL(res.headers.location, currentUrl).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = Buffer.isBuffer(res.bodyBuffer)
      ? res.bodyBuffer
      : (Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || '', 'binary'));
    if (!buf || buf.length < 1024) {
      throw new Error('下载的 Python 运行时压缩包内容异常');
    }
    fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
    fs.writeFileSync(destZipPath, buf);
    return;
  }
  throw new Error('下载 Python 运行时重定向次数过多');
}

function execAsyncSimple(command, args, opts = {}) {
  if (typeof opts._execFile === 'function') {
    return opts._execFile(command, args, opts);
  }
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: opts.timeoutMs || 180000,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

async function extractZipToDirAsync(zipPath, targetDir, options = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tarExe)) {
      try {
        await execAsyncSimple(tarExe, ['-xf', zipPath, '-C', targetDir], options);
        return;
      } catch {}
    }
    const psCmd = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`;
    await execAsyncSimple('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], options);
    return;
  }
  await execAsyncSimple('unzip', ['-o', zipPath, '-d', targetDir], options);
}

/**
 * 缺 Python 3.10+ 时的一键安装实现：
 * - Windows：优先下载官方 Python 3.12 嵌入式免安装运行包至独立目录 ~/.gemini/antigravity-cli/runtimes/python，
 *   失败时回退至 winget 用户级静默安装；
 * - macOS：检测并调用 Homebrew 安装 python@3.12；
 * - 安装完成后自动清理探测缓存并返回最新状态。
 */
async function installPythonRuntimeAsync(options = {}) {
  if (typeof options._installPython === 'function') {
    const customRes = await options._installPython(options);
    clearPythonProbeCache();
    const pyAfter = await resolvePython310Async(options);
    const st = buildRehydrateStatus(options, pyAfter);
    if (customRes && customRes.ok === false) {
      return {
        ok: false,
        errorKey: customRes.errorKey || 'rehydrate.err.installPythonFailed',
        error: customRes.error || '自动安装 Python 3.10+ 失败',
        status: st
      };
    }
    return {
      ok: Boolean(pyAfter && pyAfter.ok),
      installed: Boolean(pyAfter && pyAfter.ok),
      alreadyInstalled: Boolean(customRes?.alreadyInstalled),
      method: customRes?.method || 'custom',
      python: pyAfter,
      status: st,
      ...(pyAfter && pyAfter.ok ? {} : {
        errorKey: 'rehydrate.err.installPythonFailed',
        error: '自动安装完成但未能探测到可用的 Python 3.10+ 运行时'
      })
    };
  }

  clearPythonProbeCache();
  const existing = typeof options._probePython === 'function'
    ? await options._probePython(options)
    : await resolvePython310Async(options);
  if (existing && existing.ok) {
    return {
      ok: true,
      installed: false,
      alreadyInstalled: true,
      method: 'existing',
      python: existing,
      status: buildRehydrateStatus(options, existing)
    };
  }

  const platform = options.platform || process.platform;
  const errors = [];
  let method = null;

  if (platform === 'win32') {
    const pyDir = getManagedPythonDir(options);
    const tmpZip = path.join(os.tmpdir(), `ag-python-embed-${process.pid}-${Date.now()}.zip`);
    try {
      const url = getPythonEmbedDownloadUrl(options.arch || process.arch);
      await downloadPythonZipAsync(url, tmpZip, options);
      await extractZipToDirAsync(tmpZip, pyDir, options);
      method = 'python_embed_zip';
    } catch (e) {
      errors.push(`embed: ${e?.message || String(e)}`);
      try {
        await execAsyncSimple(
          'winget',
          ['install', '-e', '--id', 'Python.Python.3.12', '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements', '--silent'],
          options
        );
        method = 'winget';
      } catch (we) {
        errors.push(`winget: ${we?.message || String(we)}`);
      }
    } finally {
      try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    }
  } else if (platform === 'darwin') {
    try {
      await execAsyncSimple('brew', ['install', 'python@3.12'], options);
      method = 'homebrew';
    } catch (e) {
      errors.push(`brew: ${e?.message || String(e)}`);
    }
  } else {
    errors.push('请使用系统包管理器安装 Python 3.10+ (例如 sudo apt install -y python3)');
  }

  clearPythonProbeCache();
  const pyAfter = typeof options._probePython === 'function'
    ? await options._probePython(options)
    : await resolvePython310Async(options);
  const st = buildRehydrateStatus(options, pyAfter);
  if (pyAfter && pyAfter.ok) {
    return {
      ok: true,
      installed: true,
      alreadyInstalled: false,
      method: method || 'detected',
      python: pyAfter,
      status: st
    };
  }

  return {
    ok: false,
    errorKey: 'rehydrate.err.installPythonFailed',
    error: errors.length ? `自动安装 Python 3.10+ 失败 (${errors.join('; ')})` : '自动安装 Python 3.10+ 失败',
    status: st
  };
}

module.exports = {
  HOOK_NAME,
  SCRIPT_FILENAME,
  REHYDRATE_AUTHOR_INFO,
  sanitizeRehydrateRendererOptions,
  resolveGeminiConfigDir,
  getManagedPythonDir,
  getPythonEmbedDownloadUrl,
  resolveBundledRehydrateScript,
  resolvePosixCommandInPath,
  clearPythonProbeCache,
  resolvePython310,
  resolvePython310Async,
  installPythonRuntimeAsync,
  buildHookCommand,
  getRehydrateStatus,
  getRehydrateStatusAsync,
  applyRehydrate,
  applyRehydrateAsync,
  disableRehydrate,
  disableRehydrateAsync,
  restoreRehydrate,
  restoreRehydrateAsync
};
