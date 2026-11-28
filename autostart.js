'use strict';
/**
 * 登录自启管理 (autostart.js)
 * 职责：
 * 1. macOS 写 ~/Library/LaunchAgents/<label>.plist，登录后自动执行 `node cli.js watch`；
 * 2. Windows 写 HKCU Run 键，登录后自动执行同一条命令；
 * 3. 提供只读状态查询与幂等启用/停用，全程不触碰 app.asar。
 *
 * 为什么需要：免改盘 watch 模式是独立进程，客户端退出后它随之退出，
 * 用户重新登录或手动打开客户端时看板不会自动挂上。由系统登录项负责拉起即可闭环。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.elviscjn.antigravity-context-meter';
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WINDOWS_VALUE_NAME = 'AntigravityContextMeter';
const DEFAULT_MAC_LAUNCHER_NAME = 'Antigravity (Context Meter)';
const MAC_LAUNCHER_BUNDLE_ID = 'com.elviscjn.antigravity-context-meter.launcher';
const MAC_LAUNCHER_EXECUTABLE = 'launch-antigravity-meter';

function resolveAutostartTarget(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'darwin') {
    const dir = path.join(homeDir, 'Library', 'LaunchAgents');
    return { platform, kind: 'launchagent', label: LABEL, dir, file: path.join(dir, `${LABEL}.plist`) };
  }
  if (platform === 'win32') {
    return { platform, kind: 'run-key', label: WINDOWS_VALUE_NAME, dir: null, file: null };
  }
  return { platform, kind: 'unsupported', label: LABEL, dir: null, file: null };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveScriptPath(scriptPath) {
  if (!scriptPath) return path.join(__dirname, 'cli.js');
  const value = String(scriptPath);
  // 跨平台测试与自定义路径：Windows 绝对路径在 posix 环境下 path.isAbsolute 为 false，需单独识别
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) return value;
  return path.resolve(__dirname, value);
}

function resolveNodePath(nodePath) {
  if (nodePath) return nodePath;
  // Homebrew / 系统包管理的 symbol 路径比 Cellar 内的版本化真实路径更耐升级
  if (process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 权限异常时回退到当前进程
      }
    }
  }
  return process.execPath;
}

/**
 * 生成 watch 守护进程的启动参数。
 * 不固定端口时交由 watch 自行选择默认调试端口，避免与用户已开的实例抢占。
 */
function buildWatchArgs(options = {}) {
  const scriptPath = resolveScriptPath(options.scriptPath);
  const args = [scriptPath, 'watch'];
  if (options.persistent === true) args.push('--persistent');
  if (options.port) args.push('--port', String(options.port));
  return args;
}

function buildLaunchAgentPlist(options = {}) {
  const nodePath = resolveNodePath(options.nodePath);
  const args = [nodePath, ...buildWatchArgs(options)];
  const homeDir = options.homeDir || os.homedir();
  const logPath = options.logPath || path.join(homeDir, 'Library', 'Logs', 'antigravity-context-meter.log');
  const label = options.label || LABEL;
  const envPath = options.envPath || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const keepAliveTag = options.persistent === true ? '<true/>' : '<false/>';
  const throttleBlock = options.persistent === true
    ? `\n  <key>ThrottleInterval</key>\n  <integer>10</integer>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  ${keepAliveTag}${throttleBlock}
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function quoteWindowsArg(value) {
  const s = String(value ?? '');
  return /\s/.test(s) ? `"${s}"` : s;
}

function buildWindowsRunCommand(options = {}) {
  return [quoteWindowsArg(resolveNodePath(options.nodePath)), ...buildWatchArgs(options).map(quoteWindowsArg)].join(' ');
}

function defaultExec(file, args, opts) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function readLaunchAgentProgramArguments(plist) {
  const match = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

function parseWindowsRunValue(output) {
  const match = String(output || '').match(/REG_SZ\s+(.*)$/m);
  return match ? match[1].trim() : null;
}

function getAutostartStatus(options = {}) {
  const target = resolveAutostartTarget(options);
  const exec = options.exec || defaultExec;
  const platform = target.platform;

  if (target.kind === 'launchagent') {
    if (!fs.existsSync(target.file)) {
      return { enabled: false, supported: true, platform, kind: target.kind, file: target.file, command: null };
    }
    let args = [];
    try {
      args = readLaunchAgentProgramArguments(fs.readFileSync(target.file, 'utf8'));
    } catch {
      args = [];
    }
    return { enabled: true, supported: true, platform, kind: target.kind, file: target.file, command: args.join(' ') };
  }

  if (target.kind === 'run-key') {
    let command = null;
    try {
      const out = exec('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE_NAME]);
      command = parseWindowsRunValue(out);
    } catch {
      command = null;
    }
    return { enabled: Boolean(command), supported: true, platform, kind: target.kind, file: null, command };
  }

  return { enabled: false, supported: false, platform, kind: 'unsupported', file: null, command: null, reason: '当前平台暂不支持登录自启 · 仅支持 macOS 与 Windows' };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientBootstrapError(error) {
  const msg = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
  return /Bootstrap failed:\s*5\b|Input\/output error|service already loaded|in progress/i.test(msg);
}

async function waitForLaunchAgentUnloaded(exec, domainTarget, options = {}) {
  const pollMs = options._pollIntervalMs ?? 100;
  const timeoutMs = options._bootoutWaitTimeoutMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let stillLoaded = false;
    try {
      const out = exec('launchctl', ['print', domainTarget]);
      // 真实 macOS launchctl print 在服务尚未卸载完毕时会返回包含状态信息的非空文本；
      // 简单单测 stub 返回空串时直接视为已卸载，避免空等。
      stillLoaded = Boolean(out && /\bstate\s*=|\bpid\s*=|\bactive count\s*=/i.test(String(out)));
    } catch {
      stillLoaded = false;
    }
    if (!stillLoaded) return true;
    await sleepMs(pollMs);
  }
  return false;
}

async function enableAutostart(options = {}) {
  const target = resolveAutostartTarget(options);
  const exec = options.exec || defaultExec;
  const status = getAutostartStatus(options);
  if (!status.supported) {
    return { ok: false, action: 'unsupported', ...status };
  }
  if (status.enabled && !options.force) {
    return { ok: true, action: 'already_enabled', ...status };
  }

  if (target.kind === 'launchagent') {
    fs.mkdirSync(target.dir, { recursive: true });
    const plist = buildLaunchAgentPlist(options);
    fs.writeFileSync(target.file, plist, 'utf8');
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const domain = `gui/${uid}`;
    const serviceTarget = `${domain}/${target.label}`;
    let bootoutAttempted = false;
    try {
      exec('launchctl', ['bootout', serviceTarget]);
      bootoutAttempted = true;
    } catch {
      // 未加载时 bootout 一定失败，忽略即可
    }
    if (bootoutAttempted) {
      await waitForLaunchAgentUnloaded(exec, serviceTarget, options);
    }
    try {
      exec('launchctl', ['enable', serviceTarget]);
    } catch {
      // 某些旧版 macOS 或未禁用状态忽略 enable 失败
    }
    const maxAttempts = Math.max(1, Number(options._bootstrapMaxAttempts ?? 5));
    const retryBaseMs = Math.max(0, Number(options._bootstrapRetryMs ?? 200));
    let warning = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        exec('launchctl', ['bootstrap', domain, target.file]);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isTransientBootstrapError(error)) {
          try {
            exec('launchctl', ['bootout', serviceTarget]);
          } catch {
            // 忽略重复 bootout 报错
          }
          await waitForLaunchAgentUnloaded(exec, serviceTarget, {
            ...options,
            _bootoutWaitTimeoutMs: Math.min(options._bootoutWaitTimeoutMs ?? 4000, 1500)
          });
          if (retryBaseMs > 0) await sleepMs(retryBaseMs * attempt);
          continue;
        }
        break;
      }
    }
    if (lastError) {
      // plist 已写入，登录时仍会生效；此处仅提示本次未能立即加载
      warning = `launchctl bootstrap 失败，登录后仍会生效: ${lastError && lastError.message ? lastError.message : lastError}`;
    }
    return { ok: true, action: status.enabled ? 'updated' : 'enabled', warning, ...getAutostartStatus(options) };
  }

  // Windows Run 键
  exec('reg', [
    'add', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE_NAME, '/t', 'REG_SZ', '/d', buildWindowsRunCommand(options), '/f'
  ]);
  return { ok: true, action: status.enabled ? 'updated' : 'enabled', ...getAutostartStatus(options) };
}

async function disableAutostart(options = {}) {
  const target = resolveAutostartTarget(options);
  const exec = options.exec || defaultExec;
  const status = getAutostartStatus(options);
  if (!status.supported) {
    return { ok: false, action: 'unsupported', ...status };
  }
  if (!status.enabled) {
    return { ok: true, action: 'already_disabled', ...status };
  }

  if (target.kind === 'launchagent') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    try {
      exec('launchctl', ['bootout', `gui/${uid}/${target.label}`]);
    } catch {
      // 只在已加载时需要 bootout，失败不影响删除 plist
    }
    try {
      fs.unlinkSync(target.file);
    } catch {
      // 已不存在
    }
    return { ok: true, action: 'disabled', ...getAutostartStatus(options) };
  }

  exec('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE_NAME, '/f']);
  return { ok: true, action: 'disabled', ...getAutostartStatus(options) };
}

function shellQuotePosix(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function sanitizeMacLauncherName(name) {
  const cleaned = String(name || DEFAULT_MAC_LAUNCHER_NAME)
    .replace(/[<>:"/\\|?*\r\n\0]/g, '')
    .replace(/\.app$/i, '')
    .trim();
  return cleaned || DEFAULT_MAC_LAUNCHER_NAME;
}

function resolveMacLauncherTarget(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const appName = sanitizeMacLauncherName(options.appName || options.name);
  const appDir = options.outDir ? path.resolve(options.outDir) : path.join(homeDir, 'Applications');
  const appPath = path.join(appDir, `${appName}.app`);
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  return {
    platform,
    supported: platform === 'darwin',
    appName,
    appDir,
    appPath,
    contentsDir,
    macosDir,
    resourcesDir,
    plistPath: path.join(contentsDir, 'Info.plist'),
    execPath: path.join(macosDir, MAC_LAUNCHER_EXECUTABLE),
    iconPath: path.join(resourcesDir, 'AppIcon.icns'),
    bundleId: options.bundleId || MAC_LAUNCHER_BUNDLE_ID
  };
}

function buildMacLauncherInfoPlist(options = {}) {
  const target = resolveMacLauncherTarget(options);
  const version = String(options.version || '0.9.4').trim().split(/[-+]/)[0] || '0.9.4';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(target.appName)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(MAC_LAUNCHER_EXECUTABLE)}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(target.bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapeXml(target.appName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapeXml(version)}</string>
  <key>CFBundleVersion</key>
  <string>${escapeXml(version)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function buildMacLauncherScript(options = {}) {
  const nodePath = resolveNodePath(options.nodePath);
  const cliPath = resolveScriptPath(options.scriptPath);
  const homeDir = options.homeDir || os.homedir();
  const logPath = options.logPath || path.join(homeDir, 'Library', 'Logs', 'antigravity-context-meter-launcher.log');
  const runArgs = ['launcher:run'];
  if (options.port) runArgs.push('--port', String(options.port));
  if (options.asarPath) runArgs.push('--path', String(options.asarPath));
  if (options.noRelaunch === true) runArgs.push('--no-relaunch');
  const quotedRunArgs = runArgs.map(shellQuotePosix).join(' ');

  return `#!/bin/sh
# Antigravity Context Meter macOS Dock Launcher (Zero-Patch CDP + Watch)
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
LOG_FILE=${shellQuotePosix(logPath)}
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

CLI_PATH=${shellQuotePosix(cliPath)}
NODE_BIN=${shellQuotePosix(nodePath)}

if [ ! -x "$NODE_BIN" ]; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      NODE_BIN="$cand"
      break
    fi
  done
fi

if [ ! -x "$NODE_BIN" ]; then
  printf '[%s] ERROR: Node.js not found\\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
  /usr/bin/osascript -e 'display alert "Antigravity Context Meter" message "未找到 Node.js (>= 22.4)，请先安装 Node.js 后重试。" as critical' >/dev/null 2>&1 || true
  exit 1
fi

if [ ! -f "$CLI_PATH" ]; then
  printf '[%s] ERROR: cli.js not found at %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$CLI_PATH" >> "$LOG_FILE"
  /usr/bin/osascript -e 'display alert "Antigravity Context Meter" message "未找到插件入口 cli.js，请重新运行 node cli.js launcher:install 生成启动器。" as critical' >/dev/null 2>&1 || true
  exit 1
fi

printf '[%s] Dock launcher invoked: %s %s %s%s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$NODE_BIN" "$CLI_PATH" ${shellQuotePosix(runArgs.join(' '))} "\${*:+ $*}" >> "$LOG_FILE"
exec "$NODE_BIN" "$CLI_PATH" ${quotedRunArgs} "$@" >> "$LOG_FILE" 2>&1
`;
}

function resolveDockPlistPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  return options.dockPlistPath || path.join(homeDir, 'Library', 'Preferences', 'com.apple.dock.plist');
}

function runMacDockPlistHelper(action, appPath, options = {}) {
  const exec = options.exec || defaultExec;
  const dockPlistPath = resolveDockPlistPath(options);
  const pyScript = [
    'import json, os, plistlib, sys, urllib.parse',
    'action, plist_path, app_path = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])',
    'def norm(p): return os.path.normpath(p).rstrip("/")',
    'target_norm = norm(app_path)',
    'def extract_path(entry):',
    '  td = entry.get("tile-data") if isinstance(entry, dict) else None',
    '  fd = td.get("file-data") if isinstance(td, dict) else None',
    '  raw = fd.get("_CFURLString") if isinstance(fd, dict) else None',
    '  if not raw: return ""',
    '  u = urllib.parse.urlparse(raw)',
    '  p = urllib.parse.unquote(u.path) if u.scheme == "file" else raw',
    '  return norm(p)',
    'if not os.path.exists(plist_path):',
    '  print(json.dumps({"ok": True, "present": False, "changed": False, "missingPlist": True}))',
    '  sys.exit(0)',
    'with open(plist_path, "rb") as f:',
    '  data = plistlib.load(f)',
    'apps = data.get("persistent-apps")',
    'if not isinstance(apps, list): apps = []',
    'matches = [i for i, e in enumerate(apps) if extract_path(e) == target_norm]',
    'if action == "check":',
    '  print(json.dumps({"ok": True, "present": len(matches) > 0, "index": matches[0] if matches else -1}))',
    '  sys.exit(0)',
    'changed = False',
    'if action == "add":',
    '  if not matches:',
    '    url = "file://" + urllib.parse.quote(target_norm + "/", safe="/")',
    '    entry = {"tile-data": {"file-data": {"_CFURLString": url, "_CFURLStringType": 15}}, "tile-type": "file-tile"}',
    '    apps.append(entry)',
    '    data["persistent-apps"] = apps',
    '    changed = True',
    'elif action == "remove":',
    '  if matches:',
    '    data["persistent-apps"] = [e for i, e in enumerate(apps) if i not in set(matches)]',
    '    changed = True',
    'if changed:',
    '  tmp = plist_path + ".ag-tmp"',
    '  with open(tmp, "wb") as f:',
    '    plistlib.dump(data, f, fmt=plistlib.FMT_BINARY)',
    '  os.replace(tmp, plist_path)',
    'print(json.dumps({"ok": True, "present": action == "add" or (action != "remove" and len(matches) > 0), "changed": changed}))'
  ].join('\n');
  const pythonBin = options.pythonPath || (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
  const raw = exec(pythonBin, ['-c', pyScript, action, dockPlistPath, appPath]);
  return JSON.parse(String(raw || '{}').trim() || '{}');
}

function isAppInMacDock(appPath, options = {}) {
  try {
    const res = runMacDockPlistHelper('check', appPath, options);
    return Boolean(res && res.present);
  } catch {
    return false;
  }
}

function addAppToMacDock(appPath, options = {}) {
  const exec = options.exec || defaultExec;
  try {
    const res = runMacDockPlistHelper('add', appPath, options);
    if (res.changed && options.restartDock !== false) {
      try {
        exec('killall', ['Dock']);
      } catch {
        // Dock 重启失败不阻断安装结果
      }
    }
    return { ok: true, added: Boolean(res.changed), alreadyInDock: !res.changed && Boolean(res.present) };
  } catch (error) {
    return { ok: false, added: false, alreadyInDock: false, error: error?.message || String(error) };
  }
}

function removeAppFromMacDock(appPath, options = {}) {
  const exec = options.exec || defaultExec;
  try {
    const res = runMacDockPlistHelper('remove', appPath, options);
    if (res.changed && options.restartDock !== false) {
      try {
        exec('killall', ['Dock']);
      } catch { }
    }
    return { ok: true, removed: Boolean(res.changed) };
  } catch (error) {
    return { ok: false, removed: false, error: error?.message || String(error) };
  }
}

function getMacDockLauncherStatus(options = {}) {
  const target = resolveMacLauncherTarget(options);
  if (!target.supported) {
    return {
      supported: false,
      installed: false,
      inDock: false,
      platform: target.platform,
      appPath: null,
      reason: 'Dock 启动器仅支持 macOS'
    };
  }
  const installed = fs.existsSync(target.appPath) && fs.existsSync(target.execPath) && fs.existsSync(target.plistPath);
  const inDock = installed ? isAppInMacDock(target.appPath, options) : false;
  return {
    supported: true,
    installed,
    inDock,
    platform: target.platform,
    appName: target.appName,
    appPath: target.appPath,
    execPath: target.execPath,
    plistPath: target.plistPath,
    iconPresent: fs.existsSync(target.iconPath)
  };
}

function installMacDockLauncher(options = {}) {
  const target = resolveMacLauncherTarget(options);
  const exec = options.exec || defaultExec;
  if (!target.supported) {
    return { ok: false, supported: false, platform: target.platform, reason: 'Dock 启动器仅支持 macOS' };
  }

  fs.mkdirSync(target.macosDir, { recursive: true });
  fs.mkdirSync(target.resourcesDir, { recursive: true });

  const plistContent = buildMacLauncherInfoPlist(options);
  const scriptContent = buildMacLauncherScript(options);
  fs.writeFileSync(target.plistPath, plistContent, 'utf8');
  fs.writeFileSync(target.execPath, scriptContent, 'utf8');
  fs.chmodSync(target.execPath, 0o755);

  let iconCopied = false;
  const sourceAppPath = options.sourceAppPath || '/Applications/Antigravity.app';
  const sourceIconCandidates = [
    path.join(sourceAppPath, 'Contents', 'Resources', 'icon.icns'),
    path.join(sourceAppPath, 'Contents', 'Resources', 'electron.icns'),
    path.join(sourceAppPath, 'Contents', 'Resources', 'AppIcon.icns')
  ];
  for (const cand of sourceIconCandidates) {
    try {
      if (fs.existsSync(cand)) {
        fs.copyFileSync(cand, target.iconPath);
        iconCopied = true;
        break;
      }
    } catch { }
  }

  try {
    exec('xattr', ['-dr', 'com.apple.quarantine', target.appPath]);
  } catch { }

  let signed = false;
  let signWarning = null;
  if (options.sign !== false) {
    try {
      exec('codesign', ['--force', '--sign', '-', target.appPath]);
      signed = true;
    } catch (err) {
      signWarning = err?.message || String(err);
    }
  }

  let dockResult = { ok: true, added: false, alreadyInDock: isAppInMacDock(target.appPath, options) };
  if (options.addToDock === true) {
    dockResult = addAppToMacDock(target.appPath, options);
  }

  return {
    ok: true,
    supported: true,
    installed: true,
    platform: target.platform,
    appName: target.appName,
    appPath: target.appPath,
    execPath: target.execPath,
    plistPath: target.plistPath,
    iconCopied,
    signed,
    signWarning,
    inDock: Boolean(dockResult.added || dockResult.alreadyInDock),
    addedToDock: Boolean(dockResult.added),
    alreadyInDock: Boolean(dockResult.alreadyInDock),
    dockError: dockResult.ok ? null : (dockResult.error || null)
  };
}

function removeMacDockLauncher(options = {}) {
  const target = resolveMacLauncherTarget(options);
  if (!target.supported) {
    return { ok: false, supported: false, platform: target.platform, reason: 'Dock 启动器仅支持 macOS' };
  }
  const existed = fs.existsSync(target.appPath);
  let dockRemoved = false;
  if (options.removeFromDock !== false) {
    const dockRes = removeAppFromMacDock(target.appPath, options);
    dockRemoved = Boolean(dockRes.removed);
  }
  if (existed) {
    fs.rmSync(target.appPath, { recursive: true, force: true });
  }
  return {
    ok: true,
    supported: true,
    existed,
    removed: existed,
    dockRemoved,
    appPath: target.appPath
  };
}

module.exports = {
  LABEL,
  WINDOWS_RUN_KEY,
  WINDOWS_VALUE_NAME,
  DEFAULT_MAC_LAUNCHER_NAME,
  MAC_LAUNCHER_BUNDLE_ID,
  MAC_LAUNCHER_EXECUTABLE,
  resolveAutostartTarget,
  resolveNodePath,
  buildWatchArgs,
  buildLaunchAgentPlist,
  buildWindowsRunCommand,
  readLaunchAgentProgramArguments,
  getAutostartStatus,
  enableAutostart,
  disableAutostart,
  resolveMacLauncherTarget,
  buildMacLauncherInfoPlist,
  buildMacLauncherScript,
  isAppInMacDock,
  addAppToMacDock,
  removeAppFromMacDock,
  getMacDockLauncherStatus,
  installMacDockLauncher,
  removeMacDockLauncher
};
