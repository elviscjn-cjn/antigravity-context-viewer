'use strict';

/**
 * Antigravity Context Meter - CLI 终端常驻监控与链路适配器 (meter-cli-adapter.js)
 * 适配普通 CMD / PowerShell 敲入 agy 即自动常驻显示当前会话上下文
 * 严格保留原有代理设置、参数传递、退出码与 Ctrl+C 信号行为，支持无损安装与还原
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveAgyLaunchChain(options = {}) {
  const customChain = options.launchChain;
  if (Array.isArray(customChain) && customChain.length > 0) {
    return {
      proxyScript: customChain.find(p => /proxy-bin[\\/]agy\.(cmd|bat)$/i.test(p)) || customChain[0],
      binScript: customChain.find(p => /bin[\\/]agy\.(cmd|bat)$/i.test(p)) || null,
      rawBinary: customChain.find(p => /agy\.exe$/i.test(p)) || null,
      chain: customChain
    };
  }

  const explicitProxy = options.proxyScript || process.env.AG_CLI_PROXY_SCRIPT;
  if (explicitProxy && fs.existsSync(explicitProxy)) {
    return {
      proxyScript: path.resolve(explicitProxy),
      binScript: options.binScript || null,
      rawBinary: options.rawBinary || null,
      chain: [path.resolve(explicitProxy)]
    };
  }

  const chain = [];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['agy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) {
          chain.push(path.resolve(trimmed));
        }
      }
    } catch {}
  } else {
    try {
      const out = execFileSync('which', ['-a', 'agy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) {
          chain.push(path.resolve(trimmed));
        }
      }
    } catch {}
  }

  // 若 where.exe 没找到，按标准用户目录及可选环境变量配置路径后备探测
  if (chain.length === 0) {
    const customBinDir = typeof options.cliBinDir === 'string' && options.cliBinDir.trim()
      ? options.cliBinDir.trim()
      : (typeof process.env.AG_CLI_BIN_DIR === 'string' ? process.env.AG_CLI_BIN_DIR.trim() : '');
    const defaultCandidates = [
      ...(customBinDir ? [
        path.join(customBinDir, 'proxy-bin', 'agy.cmd'),
        path.join(customBinDir, 'bin', 'agy.cmd'),
        path.join(customBinDir, 'bin', 'agy.exe'),
        path.join(customBinDir, 'agy.cmd'),
        path.join(customBinDir, 'agy.exe')
      ] : []),
      path.join(os.homedir(), '.gemini', 'bin', 'agy.cmd'),
      path.join(os.homedir(), '.gemini', 'bin', 'agy.exe'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy.exe')
    ];
    for (const cand of defaultCandidates) {
      if (fs.existsSync(cand)) {
        chain.push(path.resolve(cand));
      }
    }
  }

  const proxyScript = chain.find(p => /proxy-bin[\\/]agy\.(cmd|bat)$/i.test(p)) || chain[0] || null;
  const binScript = chain.find(p => /bin[\\/]agy\.(cmd|bat)$/i.test(p)) || null;
  const rawBinary = chain.find(p => /agy\.exe$/i.test(p) || (process.platform !== 'win32' && /bin[\\/]agy$/i.test(p))) || null;

  return {
    proxyScript,
    binScript,
    rawBinary,
    chain
  };
}

function getCliSettingsPath(options = {}) {
  const dir = options.agCliDir || process.env.AG_CLI_DIR || path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity-cli');
  return path.join(dir, 'settings.json');
}

function isScriptAdapted(content) {
  if (typeof content !== 'string') return false;
  return content.includes('meter-cli-companion.js') || content.includes('AntigravityContextMeter');
}

/**
 * 生成增强版代理脚本，保留原代理设置与退出码，无缝挂接伴随监视
 */
function buildAdaptedProxyScript(originalContent, companionScriptPath, binaryPath) {
  const normCompanion = path.resolve(companionScriptPath);
  let targetBin = binaryPath ? `"${path.resolve(binaryPath)}"` : null;

  // 分析原脚本中的代理配置行与目标执行行，若存在则原样继承；无代理时不强行注入固定本机端口
  const lines = originalContent.split(/\r?\n/);
  const proxyLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^set\s+["']?(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(trimmed)) {
      proxyLines.push(line);
    } else if (/^"[^"]*agy(\.exe|\.cmd|\.bat)?"\s+%\*/i.test(trimmed) || /agy(\.exe|\.cmd|\.bat)?\s+%\*/i.test(trimmed)) {
      const m = trimmed.match(/^("?[^"\r\n]+agy(?:\.exe|\.cmd|\.bat)?"?)/i);
      if (m && m[1] && !targetBin) {
        targetBin = m[1];
      }
    }
  }
  if (!targetBin) targetBin = 'agy.exe';

  // 统一采用纯 ASCII 注释，通过 --run 托管原生 agy 客户端，保持交互与退出码，跨周期刷新标题栏
  return [
    '@echo off',
    ':: Antigravity Context Meter - Enhanced Proxy Wrapper with Context Companion',
    'setlocal',
    ...proxyLines,
    '',
    ':: Launch agy client wrapped by Context Meter Companion',
    ':: Preserves interactive TUI, arguments, Ctrl+C handling, and exit code',
    `node "${normCompanion}" --run ${targetBin} %*`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n');
}

/**
 * Windows 兼容处理：获取 8.3 纯短路径以彻底避免空格被 Go statusline_runner 误分词
 */
function getShortPath(targetPath) {
  if (process.platform !== 'win32' || !targetPath || !targetPath.includes(' ')) {
    return targetPath;
  }
  try {
    const { execSync } = require('child_process');
    const out = execSync(`cmd.exe /c "for %I in (\"${targetPath}\") do @echo %~sI"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });
    const trimmed = out.trim();
    if (trimmed && !trimmed.includes(' ') && fs.existsSync(trimmed)) {
      return trimmed;
    }
  } catch {}
  return targetPath;
}

/**
 * 生成与 agy Go 宿主 statusline_runner 深度兼容的命令：
 * 1. 优先使用无空格的正斜杠路径（若含空格则提取 Windows 8.3 短路径）；
 * 2. 严禁在外层拼接转义双引号，因为 Go statusline_runner 会将引号作为字面文件名传给 node 导致模块找不到；
 * 3. 若路径含空格且无法获取 8.3 短名，则生成专属 acm-statusline.cmd 引导脚本.
 */
function buildCompatibleStatusLineCommand(cliJsPath, options = {}) {
  const normPath = path.resolve(cliJsPath);
  const shortPath = getShortPath(normPath);
  const cleanPath = shortPath.replace(/\\/g, '/');

  if (!cleanPath.includes(' ')) {
    return `node ${cleanPath} statusline`;
  }

  // 备用方案：生成无空格专属中转脚本
  const stateDir = options.stateDir || (require('./asar-engine').getStateDir ? require('./asar-engine').getStateDir() : null);
  const launcherDir = stateDir && !stateDir.includes(' ') ? stateDir : (options.proxyScript ? path.dirname(options.proxyScript) : path.dirname(normPath));
  const launcherPath = path.join(launcherDir, 'acm-statusline.cmd');
  try {
    const scriptContent = `@echo off\r\nnode "${normPath}" statusline %*\r\n`;
    fs.writeFileSync(launcherPath, scriptContent, 'utf8');
    const shortLauncher = getShortPath(launcherPath).replace(/\\/g, '/');
    if (!shortLauncher.includes(' ')) {
      return shortLauncher;
    }
  } catch {}

  return `cmd.exe /c node "${normPath}" statusline`;
}

/**
 * 安装终端常驻上下文监控 (支持可恢复的备份与 settings.json 联动)
 */
function installCliAdapter(options = {}) {
  const chainInfo = resolveAgyLaunchChain(options);
  const proxyScript = chainInfo.proxyScript;
  if (!proxyScript || !fs.existsSync(proxyScript)) {
    return {
      ok: false,
      code: 'PROXY_SCRIPT_NOT_FOUND',
      error: '未找到可适配的 agy 代理启动脚本 (请在 PATH 中配置或通过 --proxy-script 指定)'
    };
  }

  const companionPath = options.companionPath || path.resolve(__dirname, 'meter-cli-companion.js');
  if (!fs.existsSync(companionPath)) {
    return {
      ok: false,
      code: 'COMPANION_NOT_FOUND',
      error: `伴随模块文件不存在: ${companionPath}`
    };
  }

  const rawBinary = chainInfo.rawBinary || chainInfo.binScript || null;
  const originalContent = fs.readFileSync(proxyScript, 'utf8');

  let backupCreated = false;
  const backupPath = options.backupPath || `${proxyScript}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, originalContent, 'utf8');
    backupCreated = true;
  }

  const adaptedContent = buildAdaptedProxyScript(originalContent, companionPath, rawBinary);
  fs.writeFileSync(proxyScript, adaptedContent, 'utf8');

  // 配置 ~/.gemini/antigravity-cli/settings.json 中的 statusLine
  let statusLineConfigured = false;
  const settingsPath = options.settingsPath || getCliSettingsPath(options);
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    let settingsObj = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      } catch {}
    }
    const settingsBackupPath = options.settingsBackupPath || `${settingsPath}.bak`;
    if (!fs.existsSync(settingsBackupPath) && fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, settingsBackupPath);
    }
    // 备份用户原先的 statusLine 配置 (若原先已由用户自定义且非本插件命令)
    const originalStatusLineFile = options.originalStatusLineFile || path.join(path.dirname(settingsPath), '.original_statusline.json');
    if (settingsObj.statusLine && !fs.existsSync(originalStatusLineFile)) {
      const cmdStr = String(settingsObj.statusLine.command || '');
      const isOurCmd = cmdStr.includes('cli.js') || cmdStr.includes('AntigravityContextMeter');
      if (!isOurCmd) {
        fs.writeFileSync(originalStatusLineFile, JSON.stringify(settingsObj.statusLine, null, 2) + '\n', 'utf8');
      }
    }
    const cliJsPath = path.resolve(__dirname, 'cli.js');
    settingsObj.statusLine = {
      command: buildCompatibleStatusLineCommand(cliJsPath, options),
      stack_with_default: true
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2) + '\n', 'utf8');
    statusLineConfigured = true;
  } catch {}

  return {
    ok: true,
    adapted: true,
    proxyScript,
    backupPath,
    backupCreated,
    statusLineConfigured,
    settingsPath,
    chainInfo
  };
}

/**
 * 无损还原代理启动脚本与 CLI 状态行配置
 */
function restoreCliAdapter(options = {}) {
  const chainInfo = resolveAgyLaunchChain(options);
  const proxyScript = chainInfo.proxyScript;
  if (!proxyScript) {
    return {
      ok: false,
      code: 'PROXY_SCRIPT_NOT_FOUND',
      error: '未找到 agy 代理启动脚本'
    };
  }

  const backupPath = options.backupPath || `${proxyScript}.bak`;
  let scriptRestored = false;
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, proxyScript);
    scriptRestored = true;
  } else {
    // 若没有 .bak 文件但当前脚本已被适配，则剥离伴随包装并原样保留代理与目标二进制路径
    const cur = fs.existsSync(proxyScript) ? fs.readFileSync(proxyScript, 'utf8') : '';
    if (isScriptAdapted(cur)) {
      const curLines = cur.split(/\r?\n/);
      const keptProxy = curLines.filter(l => /^set\s+["']?(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(l.trim()));
      const runMatch = cur.match(/--run\s+("[^"]+"|\S+)\s+%\*/i);
      const cleanTarget = (runMatch && runMatch[1]) ? runMatch[1] : 'agy.exe';
      const cleanScript = [
        '@echo off',
        'setlocal',
        ...keptProxy,
        `${cleanTarget} %*`,
        'exit /b %errorlevel%',
        ''
      ].join('\r\n');
      fs.writeFileSync(proxyScript, cleanScript, 'utf8');
      scriptRestored = true;
    }
  }

  // 恢复/清理 settings.json 中的 statusLine (若用户原先已配置，则无损原样恢复原配置)
  let statusLineRestored = false;
  const settingsPath = options.settingsPath || getCliSettingsPath(options);
  const originalStatusLineFile = options.originalStatusLineFile || path.join(path.dirname(settingsPath), '.original_statusline.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (parsed) {
        if (fs.existsSync(originalStatusLineFile)) {
          try {
            const originalStatusLine = JSON.parse(fs.readFileSync(originalStatusLineFile, 'utf8'));
            parsed.statusLine = originalStatusLine;
            fs.unlinkSync(originalStatusLineFile);
          } catch {
            delete parsed.statusLine;
          }
        } else {
          delete parsed.statusLine;
        }
        fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        statusLineRestored = true;
      }
    } catch {}
  }

  return {
    ok: true,
    scriptRestored,
    statusLineRestored,
    proxyScript,
    backupPath
  };
}

/**
 * 检查当前 CLI 常驻监控适配状态
 */
function statusCliAdapter(options = {}) {
  const chainInfo = resolveAgyLaunchChain(options);
  const proxyScript = chainInfo.proxyScript;
  let isAdapted = false;
  let backupExists = false;
  if (proxyScript && fs.existsSync(proxyScript)) {
    const content = fs.readFileSync(proxyScript, 'utf8');
    isAdapted = isScriptAdapted(content);
    backupExists = fs.existsSync(`${proxyScript}.bak`);
  }

  const settingsPath = options.settingsPath || getCliSettingsPath(options);
  let statusLineConfigured = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      statusLineConfigured = Boolean(parsed && parsed.statusLine);
    } catch {}
  }

  return {
    ok: true,
    isAdapted,
    backupExists,
    statusLineConfigured,
    proxyScript,
    chainInfo
  };
}

module.exports = {
  getShortPath,
  buildCompatibleStatusLineCommand,
  resolveAgyLaunchChain,
  getCliSettingsPath,
  isScriptAdapted,
  buildAdaptedProxyScript,
  installCliAdapter,
  restoreCliAdapter,
  statusCliAdapter
};
