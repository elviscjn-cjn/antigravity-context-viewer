'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { buildCliProxyEnv } = require('./meter-proxy');

// 会话与项目工作区对应关系的内存缓存
const conversationWorkspaces = new Map();

/**
 * 从 URI 字符串安全解析为本地工作区绝对路径（兼容 file:// 格式与中文/空格转义）
 */
function extractWorkspacePathFromUri(uriStr) {
  if (!uriStr || typeof uriStr !== 'string') return null;
  try {
    const trimmed = uriStr.trim();
    if (trimmed.startsWith('file://')) {
      return path.resolve(fileURLToPath(trimmed));
    }
    if (path.isAbsolute(trimmed)) {
      return path.resolve(trimmed);
    }
  } catch {
    try {
      const decoded = decodeURIComponent(uriStr.replace(/^file:\/\/\/?/i, ''));
      const normalized = process.platform === 'win32' && /^[a-zA-Z]:/.test(decoded)
        ? decoded
        : (process.platform === 'win32' ? decoded.replace(/^\//, '') : '/' + decoded);
      if (path.isAbsolute(normalized)) return path.resolve(normalized);
    } catch {}
  }
  return null;
}

/**
 * 从轨迹元数据解析工作区路径
 */
function extractWorkspaceFromTrajectory(trajectory) {
  try {
    const meta = trajectory?.metadata || trajectory?.trajectoryMetadata || {};
    const wsList = Array.isArray(meta.workspaces) ? meta.workspaces : [];
    for (const ws of wsList) {
      const cand = extractWorkspacePathFromUri(ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri);
      if (cand && fs.existsSync(cand)) return cand;
    }
    const uriList = Array.isArray(meta.workspaceUris) ? meta.workspaceUris : [];
    for (const u of uriList) {
      const cand = extractWorkspacePathFromUri(u);
      if (cand && fs.existsSync(cand)) return cand;
    }
  } catch {}
  return null;
}

/**
 * 从会话日志文件头部提取工作区路径
 */
function extractWorkspaceFromTranscriptFile(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.slice(0, bytes).toString('utf8');
      const m1 = head.match(/Command Working Directory:\s*([^\r\n\\"]+)/i);
      if (m1 && m1[1]) {
        const cand = m1[1].trim();
        if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return path.resolve(cand);
      }
      const m2 = head.match(/Active Workspaces:\s*(?:\\n|\r?\n)\s*-\s*([^\r\n\\"]+)/i);
      if (m2 && m2[1]) {
        const cand = m2[1].trim();
        if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return path.resolve(cand);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

/**
 * 探测 Antigravity CLI (agy) 可执行文件路径
 */
function resolveCliExecutable(customCliPath) {
  if (customCliPath !== undefined && customCliPath !== null && String(customCliPath).trim() !== '') {
    const explicit = path.resolve(String(customCliPath).trim());
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
        const dir = path.dirname(explicit);
        const siblingExe = path.join(dir, 'agy.exe');
        const directExe = explicit.toLowerCase().endsWith('.exe')
          ? explicit
          : (fs.existsSync(siblingExe) ? siblingExe : explicit);
        return { ok: true, cliPath: explicit, exePath: directExe, source: 'explicit' };
      }
    } catch {}
    return {
      ok: false,
      code: 'CLI_NOT_FOUND',
      cliPath: explicit,
      error: `指定的 Antigravity CLI 路径不存在或不可用: ${explicit}`
    };
  }

  const home = process.env.USERPROFILE || os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const candidates = [];
  if (process.env.AG_CLI_PATH) candidates.push({ p: process.env.AG_CLI_PATH, src: 'env_AG_CLI_PATH' });
  if (process.platform === 'win32') {
    candidates.push(
      { p: path.join(home, '.gemini', 'antigravity', 'bin', 'agy.exe'), src: 'gemini_bin_exe' },
      { p: path.join(home, '.gemini', 'antigravity', 'bin', 'agy.cmd'), src: 'gemini_bin_cmd' },
      { p: path.join(appData, 'Antigravity', 'bin', 'agy.exe'), src: 'appdata_bin_exe' },
      { p: path.join(appData, 'Antigravity', 'bin', 'agy.cmd'), src: 'appdata_bin_cmd' },
      { p: path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin', 'agy.exe'), src: 'ide_bin_exe' },
      { p: path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin', 'agy.cmd'), src: 'ide_bin_cmd' },
      { p: path.join(home, '.local', 'bin', 'agy.exe'), src: 'local_bin' }
    );
  } else {
    candidates.push(
      { p: path.join(home, '.gemini', 'antigravity', 'bin', 'agy'), src: 'gemini_bin' },
      { p: path.join(home, '.local', 'bin', 'agy'), src: 'local_bin' },
      { p: '/usr/local/bin/agy', src: 'usr_local_bin' }
    );
  }

  for (const item of candidates) {
    try {
      if (item.p && fs.existsSync(item.p) && fs.statSync(item.p).isFile()) {
        let exePath = item.p;
        if (item.p.toLowerCase().endsWith('.cmd') || item.p.toLowerCase().endsWith('.bat')) {
          const content = fs.readFileSync(item.p, 'utf8');
          const m = content.match(/"([^"]*agy\.exe)"/i);
          if (m && m[1]) {
            const resolvedM = m[1].replace(/%~dp0/gi, path.dirname(item.p) + path.sep);
            if (fs.existsSync(resolvedM)) exePath = path.resolve(resolvedM);
          } else {
            const sib = path.join(path.dirname(item.p), 'agy.exe');
            if (fs.existsSync(sib)) exePath = sib;
          }
        }
        return {
          ok: true,
          cliPath: item.launcher && fs.existsSync(item.launcher) ? item.launcher : item.p,
          exePath,
          source: item.src
        };
      }
    } catch {}
  }

  // 回退扫描系统 PATH
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const binNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];
  for (const d of pathDirs) {
    for (const b of binNames) {
      const full = path.join(d, b);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return { ok: true, cliPath: full, exePath: full, source: 'PATH' };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    code: 'CLI_NOT_FOUND',
    cliPath: null,
    error: '未找到已安装的 Antigravity CLI (agy)。请将 agy 加入 PATH，或通过 AG_CLI_PATH 指定可执行文件。'
  };
}

/**
 * 探测并解析当前最适合的 CLI 项目工作目录
 */
async function resolveCliWorkspace(options = {}) {
  const home = process.env.USERPROFILE || os.homedir();
  const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const configDir = options.configDir || path.join(home, '.gemini', 'config');
  const appDataDir = options.appDataDir || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  // 1. 显式传入的 cwd 优先
  if (options.cwd !== undefined && options.cwd !== null && String(options.cwd).trim() !== '') {
    const rawCwd = String(options.cwd).trim();
    const resolvedCwd = extractWorkspacePathFromUri(rawCwd) || path.resolve(rawCwd);
    try {
      if (fs.existsSync(resolvedCwd) && fs.statSync(resolvedCwd).isDirectory()) {
        return { ok: true, cwd: resolvedCwd, source: 'explicit_cwd' };
      }
    } catch {}
    if (options.strictCwd) {
      return { ok: false, code: 'CWD_NOT_FOUND', cwd: resolvedCwd, error: `指定的工作目录不存在或无法访问: ${resolvedCwd}` };
    }
  }

  // 2. 根据当前打开的会话 cascadeId 解析对应项目目录
  const cascadeId = options.cascadeId && /^[a-f\d-]{36}$/i.test(String(options.cascadeId).trim())
    ? String(options.cascadeId).trim().toLowerCase()
    : null;

  if (cascadeId) {
    const cachedWs = conversationWorkspaces.get(cascadeId);
    if (cachedWs && fs.existsSync(cachedWs)) {
      return { ok: true, cwd: cachedWs, source: 'conversation_cache' };
    }
    const tPath = path.join(agDir, 'brain', cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
    const fromTranscript = extractWorkspaceFromTranscriptFile(tPath);
    if (fromTranscript) {
      conversationWorkspaces.set(cascadeId, fromTranscript);
      return { ok: true, cwd: fromTranscript, source: 'conversation_transcript' };
    }
    try {
      const { connect } = require('./local-api');
      const api = await connect();
      const full = await api.call('GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 1 });
      const wsPath = extractWorkspaceFromTrajectory(full?.trajectory);
      if (wsPath) {
        conversationWorkspaces.set(cascadeId, wsPath);
        return { ok: true, cwd: wsPath, source: 'conversation_trajectory' };
      }
    } catch {}
  }

  // 3. 读取 Antigravity 最近选中项目的文件夹
  try {
    const storagePath = path.join(appDataDir, 'Antigravity', 'app_storage.json');
    if (fs.existsSync(storagePath)) {
      const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      const lastProjId = storage['new-convo-last-selected-project'];
      if (lastProjId && typeof lastProjId === 'string') {
        const projFile = path.join(configDir, 'projects', `${lastProjId}.json`);
        if (fs.existsSync(projFile)) {
          const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
          const resources = proj?.projectResources?.resources || [];
          for (const res of resources) {
            const uri = res?.gitFolder?.folderUri || res?.folderUri;
            const folderPath = extractWorkspacePathFromUri(uri);
            if (folderPath && fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
              return { ok: true, cwd: folderPath, source: 'last_selected_project', projectName: proj.name || lastProjId };
            }
          }
        }
      }
    }
  } catch {}

  // 4. 未打开具体项目时，采用明确、合理的默认目录
  const defaultCandidates = [
    options.defaultDir,
    path.join(home, 'Documents', 'antigravity'),
    home
  ].filter(Boolean);

  for (const cand of defaultCandidates) {
    try {
      const resolved = path.resolve(cand);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return { ok: true, cwd: resolved, source: 'default_fallback' };
      }
    } catch {}
  }

  return { ok: true, cwd: home, source: 'homedir_fallback' };
}

/**
 * 组装启动环境并调度启动 Antigravity CLI 会话
 */
async function launchCliSession(options = {}) {
  const cliInfo = resolveCliExecutable(options.cliPath);
  if (!cliInfo.ok) {
    return cliInfo;
  }

  const wsInfo = await resolveCliWorkspace(options);
  if (!wsInfo.ok) {
    return wsInfo;
  }

  const cwd = wsInfo.cwd;
  const model = (typeof options.model === 'string' && /^[a-zA-Z0-9._-]+$/.test(options.model.trim()))
    ? options.model.trim()
    : 'gemini-3.8-flash-high';
  const extraArgs = Array.isArray(options.args)
    ? options.args.filter(a => typeof a === 'string' && a.trim().length > 0 && !/[\r\n\0]/.test(a))
    : [];

  const cliArgs = ['--model', model, ...extraArgs];
  const env = buildCliProxyEnv(process.env);
  // 恢复 Windows 交互式 CLI 子进程环境的原生彩虹渐变 Logo 与颜色能力（隔离宿主环境的 NO_COLOR/dumb）
  if (process.platform === 'win32') {
    delete env.NO_COLOR;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      cliPath: cliInfo.cliPath,
      exePath: cliInfo.exePath,
      cliSource: cliInfo.source,
      cwd,
      cwdSource: wsInfo.source,
      model,
      args: cliArgs,
      env: {
        NO_COLOR: env.NO_COLOR,
        TERM: env.TERM,
        COLORTERM: env.COLORTERM,
        HTTP_PROXY: env.HTTP_PROXY,
        HTTPS_PROXY: env.HTTPS_PROXY
      }
    };
  }

  try {
    if (process.platform === 'win32') {
      const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const stateDir = path.join(localBase, 'AntigravityContextMeter');
      fs.mkdirSync(stateDir, { recursive: true });
      const runnerBat = path.join(stateDir, 'launch-cli-runner.cmd');
      const probeFile = path.join(stateDir, 'last-cli-cwd.txt');
      try { if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile); } catch {}

      const batContent = [
        '@echo off',
        'if defined AG_CLI_PROBE_FILE (',
        '  > "%AG_CLI_PROBE_FILE%" echo %CD%',
        ')',
        '"%AG_CLI_TARGET_EXE%" --model "%AG_CLI_TARGET_MODEL%" %AG_CLI_EXTRA_ARGS%'
      ].join('\r\n') + '\r\n';
      fs.writeFileSync(runnerBat, batContent, 'ascii');

      env.AG_CLI_TARGET_EXE = cliInfo.exePath;
      env.AG_CLI_TARGET_MODEL = model;
      env.AG_CLI_TARGET_CWD = cwd;
      env.AG_CLI_RUNNER_BAT = runnerBat;
      env.AG_CLI_PROBE_FILE = probeFile;
      env.AG_CLI_EXTRA_ARGS = extraArgs.map(a => `"${String(a).replace(/"/g, '')}"`).join(' ');

      const psCmd = "$p = Start-Process -FilePath 'cmd.exe' -WorkingDirectory $env:AG_CLI_TARGET_CWD -ArgumentList @('/d', '/k', $env:AG_CLI_RUNNER_BAT) -PassThru; if ($p) { Write-Output $p.Id }";
      const launchCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true
      });

      if (launchCheck.error || launchCheck.status !== 0) {
        const errMsg = launchCheck.error?.message || (launchCheck.stderr || '').trim() || `退出码 ${launchCheck.status}`;
        return {
          ok: false,
          code: 'SPAWN_FAILED',
          error: `启动终端进程失败: ${errMsg}`,
          cliPath: cliInfo.cliPath,
          cwd
        };
      }

      const launchedPid = Number(String(launchCheck.stdout || '').trim().split(/\r?\n/).pop());
      return {
        ok: true,
        pid: Number.isFinite(launchedPid) && launchedPid > 0 ? launchedPid : null,
        probeFile,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    } else {
      const child = spawn(cliInfo.exePath, cliArgs, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return {
        ok: true,
        pid: child.pid || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: 'LAUNCH_ERROR',
      error: `启动 Antigravity CLI 异常: ${err?.message || err}`,
      cliPath: cliInfo.cliPath,
      cwd
    };
  }
}

module.exports = {
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveCliExecutable,
  resolveCliWorkspace,
  launchCliSession
};
