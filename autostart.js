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
  <false/>
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
    try {
      exec('launchctl', ['bootout', `gui/${uid}/${target.label}`]);
    } catch {
      // 未加载时 bootout 一定失败，忽略即可
    }
    let warning = null;
    try {
      exec('launchctl', ['bootstrap', `gui/${uid}`, target.file]);
    } catch (error) {
      // plist 已写入，登录时仍会生效；此处仅提示本次未能立即加载
      warning = `launchctl bootstrap 失败，登录后仍会生效: ${error && error.message ? error.message : error}`;
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

module.exports = {
  LABEL,
  WINDOWS_RUN_KEY,
  WINDOWS_VALUE_NAME,
  resolveAutostartTarget,
  resolveNodePath,
  buildWatchArgs,
  buildLaunchAgentPlist,
  buildWindowsRunCommand,
  readLaunchAgentProgramArguments,
  getAutostartStatus,
  enableAutostart,
  disableAutostart
};
