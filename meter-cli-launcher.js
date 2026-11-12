'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawn, spawnSync, execFile } = require('child_process');
const { buildCliProxyEnv } = require('./meter-proxy');

const windowsTerminalPlacement = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CliWindowPlacement {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Point {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MonitorInfo {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public uint dwFlags;
    }

    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point pt, uint dwFlags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point lpPoint);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo lpmi);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    const int SW_RESTORE = 9;
    const int SW_SHOW = 5;
    const uint SWP_SHOWWINDOW = 0x0040;
    const int STARTF_USEPOSITION = 0x00000004;
    const int STARTF_USESIZE = 0x00000002;
    const uint CREATE_NEW_CONSOLE = 0x00000010;
    const uint MONITOR_DEFAULTTONEAREST = 2;

    public static int LaunchCenteredCmd(string commandLine, string workingDir, IntPtr host) {
        IntPtr prevDpi = SetThreadDpiAwarenessContext((IntPtr)(-4));
        try {
            Point pt = new Point();
            IntPtr hMon = IntPtr.Zero;
            if (GetCursorPos(out pt)) {
                hMon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
            }
            if (hMon == IntPtr.Zero && host != IntPtr.Zero && IsWindowVisible(host)) {
                hMon = MonitorFromWindow(host, MONITOR_DEFAULTTONEAREST);
            }

            MonitorInfo mi = new MonitorInfo();
            mi.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
            if (!GetMonitorInfo(hMon, ref mi)) {
                mi.rcWork = new Rect { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };
            }

            int workW = mi.rcWork.Right - mi.rcWork.Left;
            int workH = mi.rcWork.Bottom - mi.rcWork.Top;

            int targetW = Math.Min(1050, Math.Max(400, workW * 8 / 10));
            int targetH = Math.Min(680, Math.Max(300, workH * 8 / 10));

            int targetX = mi.rcWork.Left + (workW - targetW) / 2;
            int targetY = mi.rcWork.Top + (workH - targetH) / 2;

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = STARTF_USEPOSITION | STARTF_USESIZE;
            si.dwX = targetX;
            si.dwY = targetY;
            si.dwXSize = targetW;
            si.dwYSize = targetH;

            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

            bool ok = CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_NEW_CONSOLE,
                IntPtr.Zero,
                workingDir,
                ref si,
                out pi
            );

            if (ok) return pi.dwProcessId;
            return 0;
        } finally {
            if (prevDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(prevDpi);
        }
    }

    public static IntPtr[] Terminals() {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, data) => {
            if (!IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            string cls = name.ToString();
            if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS" || cls == "VirtualConsoleClass") {
                windows.Add(hwnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static uint GetProcessId(IntPtr hwnd) {
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }

    public static bool PositionAndActivate(IntPtr terminal, IntPtr host) {
        if (terminal == IntPtr.Zero) return false;
        IntPtr previous = SetThreadDpiAwarenessContext((IntPtr)(-4));
        try {
            if (IsZoomed(terminal)) ShowWindow(terminal, SW_RESTORE);

            Rect child = new Rect();
            if (!GetWindowRect(terminal, out child)) return false;
            int childWidth = child.Right - child.Left;
            int childHeight = child.Bottom - child.Top;
            if (childWidth < 80 || childHeight < 60) return false;

            // 1. 确定当前操作所在的显示器（优先以鼠标光标位置或宿主窗口为准）
            IntPtr hMon = IntPtr.Zero;
            Point cursorPt = new Point();
            if (GetCursorPos(out cursorPt)) {
                hMon = MonitorFromPoint(cursorPt, MONITOR_DEFAULTTONEAREST);
            }
            if (hMon == IntPtr.Zero && host != IntPtr.Zero && IsWindowVisible(host)) {
                hMon = MonitorFromWindow(host, MONITOR_DEFAULTTONEAREST);
            }
            if (hMon == IntPtr.Zero) {
                hMon = MonitorFromWindow(terminal, MONITOR_DEFAULTTONEAREST);
            }

            // 2. 获取该显示器的可用工作区（排除任务栏）
            MonitorInfo mi = new MonitorInfo();
            mi.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
            Rect workArea = new Rect();
            if (GetMonitorInfo(hMon, ref mi)) {
                workArea = mi.rcWork;
            } else {
                workArea = new Rect { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };
            }

            int workWidth = workArea.Right - workArea.Left;
            int workHeight = workArea.Bottom - workArea.Top;

            // 终端窗口尺寸限制（若超出工作区则缩至 90%）
            int finalW = Math.Min(childWidth, Math.Max(200, workWidth * 9 / 10));
            int finalH = Math.Min(childHeight, Math.Max(150, workHeight * 9 / 10));

            // 3. 计算在当前显示器工作区的正中心位置
            int targetX = workArea.Left + (workWidth - finalW) / 2;
            int targetY = workArea.Top + (workHeight - finalH) / 2;

            // 边界绝对保护（绝不出屏或压进任务栏）
            if (targetX < workArea.Left) targetX = workArea.Left;
            if (targetX + finalW > workArea.Right) targetX = workArea.Right - finalW;
            if (targetY < workArea.Top) targetY = workArea.Top;
            if (targetY + finalH > workArea.Bottom) targetY = workArea.Bottom - finalH;

            // 4. 定位并置于顶层（HWND_TOP = IntPtr.Zero，非永久置顶）
            bool ok = SetWindowPos(terminal, IntPtr.Zero, targetX, targetY, finalW, finalH, SWP_SHOWWINDOW);

            // 5. 突破 Windows 前台锁定，将终端窗口带到前台并激活输入焦点
            try {
                IntPtr curFg = GetForegroundWindow();
                uint curFgPid = 0;
                uint curFgThread = GetWindowThreadProcessId(curFg, out curFgPid);
                uint myThread = GetCurrentThreadId();

                if (curFgThread != 0 && curFgThread != myThread) {
                    AttachThreadInput(myThread, curFgThread, true);
                }

                ShowWindow(terminal, SW_SHOW);
                BringWindowToTop(terminal);
                SetForegroundWindow(terminal);
                SetFocus(terminal);

                if (curFgThread != 0 && curFgThread != myThread) {
                    AttachThreadInput(myThread, curFgThread, false);
                }
            } catch {}

            return ok;
        } finally {
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
        }
    }

    public static bool Center(IntPtr terminal, IntPtr host) {
        return PositionAndActivate(terminal, host);
    }
}
`;

const LAUNCHER_VERSION = '0.8.2-helper-v2';

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
 * 解析 Windows 系统核心可执行工具路径，避免宿主 Electron PATH 残缺导致找不到 cmd.exe / reg.exe / powershell.exe
 */
function resolveWindowsSystemTools(env = process.env, fsImpl = fs) {
  const sysRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const system32 = path.join(sysRoot, 'System32');
  const psDir = path.join(system32, 'WindowsPowerShell', 'v1.0');
  const pick = (candidate, fallback) => {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch {}
    return fallback;
  };
  return {
    sysRoot,
    system32,
    psDir,
    cmdExe: pick(path.join(system32, 'cmd.exe'), 'cmd.exe'),
    powershellExe: pick(path.join(psDir, 'powershell.exe'), 'powershell.exe'),
    regExe: pick(path.join(system32, 'reg.exe'), 'reg.exe')
  };
}

/**
 * 展开 Windows 路径中的 %VAR% 环境变量占位符
 */
function expandWindowsEnvVars(raw, env = process.env, extra = {}) {
  const lookup = new Map();
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== undefined && v !== null) lookup.set(String(k).toUpperCase(), String(v));
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null) lookup.set(String(k).toUpperCase(), String(v));
  }
  return String(raw || '').replace(/%([^%]+)%/g, (m, name) => {
    const val = lookup.get(String(name).toUpperCase());
    return val !== undefined ? val : m;
  });
}

/**
 * 拆解并去重 PATH 目录列表，自动去除外层双引号
 */
function splitPathEntries(rawPath, platform = process.platform, delimiter = path.delimiter) {
  const sep = platform === 'win32' ? ';' : delimiter;
  const out = [];
  const seen = new Set();
  for (const part of String(rawPath || '').split(sep)) {
    const cleaned = part.trim().replace(/^"+|"+$/g, '');
    if (!cleaned) continue;
    const key = platform === 'win32' ? cleaned.toLowerCase() : cleaned;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * 将额外的 Windows 工具目录合并进子进程 PATH（兼容 Path / PATH 大小写）
 */
function ensureWindowsSpawnPath(env, extraDirs = []) {
  const currentRaw = env.PATH || env.Path || '';
  const merged = [];
  const seen = new Set();
  for (const dir of [...extraDirs, ...splitPathEntries(currentRaw, 'win32')]) {
    const cleaned = String(dir || '').trim().replace(/^"+|"+$/g, '');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cleaned);
  }
  delete env.Path;
  env.PATH = merged.join(';');
  return env.PATH;
}

/**
 * 读取 Windows 注册表用户级与系统级 Path（应对桌面端未重启导致 PATH 过期或被精简）
 */
function readWindowsRegistryPathDirs(env = process.env, fsImpl = fs, spawnSyncImpl = spawnSync) {
  const home = env.USERPROFILE || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const winTools = resolveWindowsSystemTools(env, fsImpl);
  const extraVars = {
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    SystemRoot: winTools.sysRoot,
    ProgramFiles: env.ProgramFiles || 'C:\\Program Files',
    'ProgramFiles(x86)': env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  };
  const hives = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  ];
  const dirs = [];
  const seen = new Set();
  for (const hive of hives) {
    try {
      const res = spawnSyncImpl(winTools.regExe, ['query', hive, '/v', 'Path'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true
      });
      if (res.status !== 0 || !res.stdout) continue;
      for (const line of String(res.stdout).split(/\r?\n/)) {
        const m = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
        if (!m || !m[1]) continue;
        const expanded = expandWindowsEnvVars(m[1].trim(), env, extraVars);
        for (const d of splitPathEntries(expanded, 'win32')) {
          const key = d.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            dirs.push(d);
          }
        }
      }
    } catch {}
  }
  return dirs;
}

/**
 * 从 .cmd / .bat 包装脚本中解析真实的 agy.exe 目标路径
 */
function resolveBatchWrapperTarget(filePath, fsImpl = fs) {
  let exePath = filePath;
  const lower = String(filePath || '').toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return exePath;
  try {
    const content = fsImpl.readFileSync(filePath, 'utf8');
    const m = content.match(/"([^"]*agy\.exe)"/i);
    if (m && m[1]) {
      const resolvedM = m[1].replace(/%~dp0/gi, path.dirname(filePath) + path.sep);
      if (fsImpl.existsSync(resolvedM)) return path.resolve(resolvedM);
    }
    const sib = path.join(path.dirname(filePath), 'agy.exe');
    if (fsImpl.existsSync(sib)) return sib;
  } catch {}
  return exePath;
}

/**
 * 在目录列表中按顺序探测指定文件名列表，并统一解析 .cmd/.bat 目标
 */
function findExecutableInDirs(dirs, binNames, source, fsImpl = fs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const bin of binNames) {
      const full = path.join(dir, bin);
      try {
        if (fsImpl.existsSync(full) && fsImpl.statSync(full).isFile()) {
          return {
            ok: true,
            cliPath: full,
            exePath: resolveBatchWrapperTarget(full, fsImpl),
            source
          };
        }
      } catch {}
    }
  }
  return null;
}

/**
 * 读取用户在插件设置中保存的自定义 CLI 路径
 */
function readSavedCliPath(env = process.env, home = os.homedir(), fsImpl = fs) {
  try {
    const baseDir = env.AG_DIR || path.join(home, '.gemini', 'antigravity');
    const cfgPath = path.join(baseDir, 'custom_plan_v1.json');
    if (!fsImpl.existsSync(cfgPath)) return null;
    const raw = JSON.parse(fsImpl.readFileSync(cfgPath, 'utf8'));
    const candidate = raw?.uiPreferences?.cliPath || raw?.cliPath;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 生成未找到 CLI 时的平台安装指引
 */
function getCliInstallHint(platform = process.platform) {
  if (platform === 'win32') {
    return {
      installCommand: 'irm https://antigravity.google/cli/install.ps1 | iex',
      error: '未找到已安装的 Antigravity CLI (agy)。Antigravity 桌面版不会自动附带命令行工具，请在 PowerShell 运行 "irm https://antigravity.google/cli/install.ps1 | iex" 安装（默认位于 %LOCALAPPDATA%\\agy\\bin\\agy.exe），或通过环境变量 AG_CLI_PATH 指定 agy.exe。'
    };
  }
  return {
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    error: '未找到已安装的 Antigravity CLI (agy)。可运行 "curl -fsSL https://antigravity.google/cli/install.sh | bash" 安装，或将其加入 PATH / 通过 AG_CLI_PATH 指定可执行文件。'
  };
}

/**
 * 探测 Antigravity CLI (agy) 可执行文件路径
 */
function resolveCliExecutable(customCliPath, options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homeDir || env.USERPROFILE || env.HOME || os.homedir();
  const execPath = options.execPath !== undefined ? options.execPath : process.execPath;

  if (customCliPath !== undefined && customCliPath !== null && String(customCliPath).trim() !== '') {
    const cleanedExplicit = String(customCliPath).trim().replace(/^"+|"+$/g, '');
    if (cleanedExplicit) {
      const explicit = path.resolve(cleanedExplicit);
      try {
        if (fsImpl.existsSync(explicit) && fsImpl.statSync(explicit).isFile()) {
          return {
            ok: true,
            cliPath: explicit,
            exePath: resolveBatchWrapperTarget(explicit, fsImpl),
            source: 'explicit'
          };
        }
      } catch {}
      return {
        ok: false,
        code: 'CLI_NOT_FOUND',
        cliPath: explicit,
        ...getCliInstallHint(platform),
        error: `指定的 Antigravity CLI 路径不存在或不可用: ${explicit}`
      };
    }
  }

  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programData = env.ProgramData || 'C:\\ProgramData';
  const savedCliPath = options.settingsCliPath !== undefined ? options.settingsCliPath : readSavedCliPath(env, home, fsImpl);

  const directCandidates = [];
  if (env.AG_CLI_PATH) directCandidates.push({ p: env.AG_CLI_PATH, src: 'env_AG_CLI_PATH' });
  if (env.ANTIGRAVITY_CLI_PATH) directCandidates.push({ p: env.ANTIGRAVITY_CLI_PATH, src: 'env_ANTIGRAVITY_CLI_PATH' });
  if (savedCliPath) directCandidates.push({ p: savedCliPath, src: 'saved_settings' });

  const binNames = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];
  const candidateDirs = [];

  if (platform === 'win32') {
    candidateDirs.push(
      { dir: path.join(localAppData, 'agy', 'bin'), src: 'localappdata_agy_bin' },
      { dir: path.join(home, '.gemini', 'antigravity', 'bin'), src: 'gemini_bin' },
      { dir: path.join(home, '.gemini', 'antigravity-cli', 'bin'), src: 'gemini_cli_bin' },
      { dir: path.join(appData, 'Antigravity', 'bin'), src: 'appdata_bin' },
      { dir: path.join(localAppData, 'Programs', 'Antigravity', 'bin'), src: 'programs_antigravity_bin' },
      { dir: path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin'), src: 'ide_bin' },
      { dir: path.join(localAppData, 'Programs', 'agy', 'bin'), src: 'programs_agy_bin' },
      { dir: path.join(localAppData, 'Antigravity', 'bin'), src: 'localappdata_antigravity_bin' },
      { dir: path.join(localAppData, 'Antigravity IDE', 'bin'), src: 'localappdata_ide_bin' }
    );
    if (env.ANTIGRAVITY_HOME) {
      candidateDirs.push(
        { dir: path.join(env.ANTIGRAVITY_HOME, 'bin'), src: 'antigravity_home_bin' },
        { dir: env.ANTIGRAVITY_HOME, src: 'antigravity_home' }
      );
    }
    if (execPath) {
      const execDir = path.dirname(execPath);
      candidateDirs.push(
        { dir: path.join(execDir, 'bin'), src: 'exec_dir_bin' },
        { dir: execDir, src: 'exec_dir' }
      );
    }
    candidateDirs.push(
      { dir: path.join(programFiles, 'agy', 'bin'), src: 'pf_agy_bin' },
      { dir: path.join(programFiles, 'Antigravity', 'bin'), src: 'pf_antigravity_bin' },
      { dir: path.join(programFiles, 'Antigravity IDE', 'bin'), src: 'pf_ide_bin' },
      { dir: path.join(programFiles, 'Google', 'Antigravity', 'bin'), src: 'pf_google_antigravity_bin' },
      { dir: path.join(programFiles, 'Google Antigravity', 'bin'), src: 'pf_google_space_bin' },
      { dir: path.join(programFilesX86, 'Antigravity', 'bin'), src: 'pf86_antigravity_bin' },
      { dir: path.join(home, '.local', 'bin'), src: 'local_bin' },
      { dir: path.join(home, '.agy', 'bin'), src: 'home_agy_bin' },
      { dir: path.join(home, '.antigravity', 'bin'), src: 'home_antigravity_bin' },
      { dir: path.join(home, 'bin'), src: 'home_bin' },
      { dir: path.join(localAppData, 'Microsoft', 'WinGet', 'Links'), src: 'winget_links' },
      { dir: path.join(home, 'scoop', 'shims'), src: 'scoop_shims' },
      { dir: path.join(programData, 'chocolatey', 'bin'), src: 'choco_bin' },
      { dir: path.join(appData, 'npm'), src: 'npm_bin' },
      { dir: path.join(localAppData, 'pnpm'), src: 'pnpm_bin' }
    );
  } else {
    candidateDirs.push(
      { dir: path.join(home, '.gemini', 'antigravity', 'bin'), src: 'gemini_bin' },
      { dir: path.join(home, '.gemini', 'antigravity-cli', 'bin'), src: 'gemini_cli_bin' },
      { dir: path.join(home, '.local', 'bin'), src: 'local_bin' },
      { dir: path.join(home, '.agy', 'bin'), src: 'home_agy_bin' },
      { dir: path.join(home, 'bin'), src: 'home_bin' },
      { dir: '/opt/homebrew/bin', src: 'homebrew_bin' },
      { dir: '/usr/local/bin', src: 'usr_local_bin' },
      { dir: '/usr/bin', src: 'usr_bin' }
    );
    if (execPath) {
      const execDir = path.dirname(execPath);
      candidateDirs.push(
        { dir: path.join(execDir, 'bin'), src: 'exec_dir_bin' },
        { dir: path.resolve(execDir, '..', 'Resources', 'app', 'bin'), src: 'app_bundle_bin' }
      );
    }
  }

  for (const item of directCandidates) {
    try {
      const cleaned = String(item.p || '').trim().replace(/^"+|"+$/g, '');
      if (!cleaned) continue;
      const candidatePath = path.resolve(cleaned);
      if (candidatePath && fsImpl.existsSync(candidatePath) && fsImpl.statSync(candidatePath).isFile()) {
        return {
          ok: true,
          cliPath: item.launcher && fsImpl.existsSync(item.launcher) ? item.launcher : candidatePath,
          exePath: resolveBatchWrapperTarget(candidatePath, fsImpl),
          source: item.src
        };
      }
    } catch {}
  }

  for (const entry of candidateDirs) {
    const hit = findExecutableInDirs([entry.dir], binNames, entry.src, fsImpl);
    if (hit) return hit;
  }

  // 回退扫描系统 PATH（兼容 Windows Env 大小写与引号）
  const rawPathEnv = env.PATH || env.Path || '';
  const pathDirs = splitPathEntries(rawPathEnv, platform);
  const pathHit = findExecutableInDirs(pathDirs, binNames, 'PATH', fsImpl);
  if (pathHit) return pathHit;

  // Windows 下桌面端进程可能携带过期或精简后的 PATH，补充读取注册表 User/System Path
  if (platform === 'win32' && options.skipRegistry !== true) {
    const regDirs = Array.isArray(options.registryPathDirs)
      ? options.registryPathDirs
      : readWindowsRegistryPathDirs(env, fsImpl, options.spawnSync || spawnSync);
    const regHit = findExecutableInDirs(regDirs, binNames, 'registry_PATH', fsImpl);
    if (regHit) return regHit;
  }

  return {
    ok: false,
    code: 'CLI_NOT_FOUND',
    cliPath: null,
    ...getCliInstallHint(platform)
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
 * 安全转义 POSIX 命令行参数（免疫 Shell 注入）
 */
function escapePosixArg(arg) {
  if (arg === undefined || arg === null) return "''";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * 探测与解析原生定位辅助程序 cli-window-helper.exe
 * 严格按照合法顺序：显式注入 > 生产部署状态目录 > 宿主 bin 目录 > 仓库开发/解压目录
 */
function resolveHelperExecutable(options = {}) {
  // 1. 显式选项指定 helperPath（测试注入或外部强制指定），不存在则明确失败
  if (options.helperPath !== undefined && options.helperPath !== null && String(options.helperPath).trim() !== '') {
    const explicit = path.resolve(String(options.helperPath).trim());
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
        const crypto = require('crypto');
        const helperSha = crypto.createHash('sha256').update(fs.readFileSync(explicit)).digest('hex');
        return {
          ok: true,
          helperPath: explicit,
          helperSha256: helperSha,
          source: 'explicit'
        };
      }
    } catch {}
    return {
      ok: false,
      helperPath: explicit,
      helperSha256: null,
      error: `指定的辅助程序路径不存在或不可用: ${explicit}`
    };
  }

  const candidates = [];

  // 环境变量注入
  if (process.env.AG_HELPER_PATH) {
    candidates.push({ p: path.resolve(process.env.AG_HELPER_PATH.trim()), src: 'env_AG_HELPER_PATH' });
  }

  // 2. 生产环境已安装部署的状态目录 (%LOCALAPPDATA%\AntigravityContextMeter)
  if (options.stateDir) {
    candidates.push({ p: path.join(path.resolve(options.stateDir), 'cli-window-helper.exe'), src: 'custom_stateDir' });
  } else if (process.platform === 'win32') {
    const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push({ p: path.join(localBase, 'AntigravityContextMeter', 'cli-window-helper.exe'), src: 'installed_stateDir' });
  }

  // 3. 宿主资源 bin 目录 (resources/bin)
  if (process.resourcesPath) {
    candidates.push({ p: path.join(process.resourcesPath, 'bin', 'cli-window-helper.exe'), src: 'host_resources_bin' });
  }

  // 4. 仓库源码或解压包目录中的 scripts/cli-window-helper.exe
  candidates.push(
    { p: path.join(__dirname, 'scripts', 'cli-window-helper.exe'), src: 'local_scripts' },
    { p: path.join(path.dirname(__dirname), 'scripts', 'cli-window-helper.exe'), src: 'parent_scripts' }
  );

  for (const item of candidates) {
    try {
      if (item.p && fs.existsSync(item.p) && fs.statSync(item.p).isFile()) {
        const crypto = require('crypto');
        const helperSha = crypto.createHash('sha256').update(fs.readFileSync(item.p)).digest('hex');
        return {
          ok: true,
          helperPath: item.p,
          helperSha256: helperSha,
          source: item.src
        };
      }
    } catch {}
  }

  return {
    ok: false,
    helperPath: null,
    helperSha256: null,
    error: '未找到原生辅助定位程序 cli-window-helper.exe'
  };
}

/**
 * 组装启动环境并调度启动 Antigravity CLI 会话
 */
async function launchCliSession(options = {}, ownerHwnd = 0) {
  const baseEnv = options.env && typeof options.env === 'object' ? options.env : process.env;
  const cliInfo = resolveCliExecutable(options.cliPath, {
    env: baseEnv,
    platform: options.platform,
    homeDir: options.homeDir,
    execPath: options.execPath,
    skipRegistry: options.skipRegistry
  });
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
  const env = buildCliProxyEnv(baseEnv);
  const winTools = process.platform === 'win32' ? resolveWindowsSystemTools(baseEnv) : null;
  // 恢复 Windows 交互式 CLI 子进程环境的原生彩虹渐变 Logo 与颜色能力（隔离宿主环境的 NO_COLOR/dumb）
  if (process.platform === 'win32') {
    delete env.NO_COLOR;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    ensureWindowsSpawnPath(env, [
      path.dirname(cliInfo.exePath),
      path.dirname(cliInfo.cliPath),
      winTools.system32,
      winTools.psDir
    ]);
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
      cmdExe: winTools ? winTools.cmdExe : undefined,
      powershellExe: winTools ? winTools.powershellExe : undefined,
      env: {
        NO_COLOR: env.NO_COLOR,
        TERM: env.TERM,
        COLORTERM: env.COLORTERM,
        HTTP_PROXY: env.HTTP_PROXY,
        HTTPS_PROXY: env.HTTPS_PROXY,
        PATH: env.PATH
      }
    };
  }

  try {
    if (process.platform === 'win32') {
      const localBase = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const stateDir = path.join(localBase, 'AntigravityContextMeter');
      fs.mkdirSync(stateDir, { recursive: true });
      const runnerBat = path.join(stateDir, 'launch-cli-runner.cmd');
      const probeFile = path.join(stateDir, 'last-cli-cwd.txt');
      try { if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile); } catch {}

      const extraArgsStr = extraArgs.map(a => `"${String(a).replace(/"/g, '')}"`).join(' ');
      const isBatchTarget = /\.(cmd|bat)$/i.test(cliInfo.exePath);
      const invokeLine = `${isBatchTarget ? 'call ' : ''}"${cliInfo.exePath}" --model "${model}" ${extraArgsStr}`;
      const batContent = [
        '@echo off',
        'if defined AG_CLI_PROBE_FILE (',
        '  > "%AG_CLI_PROBE_FILE%" echo %CD%',
        ')',
        invokeLine
      ].join('\r\n') + '\r\n';
      fs.writeFileSync(runnerBat, batContent, 'ascii');

      env.AG_CLI_TARGET_EXE = cliInfo.exePath;
      env.AG_CLI_TARGET_MODEL = model;
      env.AG_CLI_TARGET_CWD = cwd;
      env.AG_CLI_RUNNER_BAT = runnerBat;
      env.AG_CLI_PROBE_FILE = probeFile;
      env.AG_CLI_EXTRA_ARGS = extraArgs.map(a => `"${String(a).replace(/"/g, '')}"`).join(' ');

      const resolvedOwnerHwnd = String(options.ownerHwnd || ownerHwnd || 0);
      env.AG_CLI_OWNER_HWND = resolvedOwnerHwnd;
      if (options.hostBounds && typeof options.hostBounds === 'object') {
        try {
          env.AG_CLI_HOST_BOUNDS = JSON.stringify(options.hostBounds);
        } catch {}
      } else {
        delete env.AG_CLI_HOST_BOUNDS;
      }

      const helperResolution = resolveHelperExecutable(options);
      const helperExe = helperResolution.ok ? helperResolution.helperPath : null;
      const helperSha = helperResolution.helperSha256;

      if (helperExe) {
        const helperArgs = ['--cmd', runnerBat, '--cwd', cwd];
        if (resolvedOwnerHwnd && resolvedOwnerHwnd !== '0') {
          helperArgs.push('--owner', resolvedOwnerHwnd);
        }

        // 纯异步非阻塞调用，绝不挂起 Electron 主事件循环
        const helperResult = await new Promise((resolve) => {
          execFile(helperExe, helperArgs, {
            cwd,
            env,
            timeout: 5500,
            windowsHide: false
          }, (error, stdout, stderr) => {
            let parsed = null;
            const rawOut = (stdout || '').trim();
            const rawErr = (stderr || '').trim();
            if (rawOut) {
              try {
                parsed = JSON.parse(rawOut);
              } catch {
                const m = rawOut.match(/\{[\s\S]*\}/);
                if (m) {
                  try { parsed = JSON.parse(m[0]); } catch {}
                }
              }
            }

            if (parsed && typeof parsed === 'object') {
              // 优先采纳 helper 输出的标准结构化结果
              if (error && parsed.ok === undefined) {
                parsed.ok = false;
              }
              if (error && !parsed.error) {
                parsed.error = error.message;
              }
              resolve(parsed);
            } else if (error) {
              resolve({
                ok: false,
                terminalSpawned: false,
                error: error.message,
                stderr: rawErr,
                stdout: rawOut
              });
            } else {
              resolve({
                ok: false,
                terminalSpawned: false,
                error: '解析辅助程序输出失败',
                stdout: rawOut
              });
            }
          });
        });

        const runtimeInfo = {
          launcherModulePath: __filename,
          launcherVersion: LAUNCHER_VERSION,
          helperPath: helperExe,
          helperSha256: helperSha,
          timestamp: new Date().toISOString()
        };

        // 如果终端进程已经创建成功（cmdPid > 0 或 terminalSpawned 为 true）
        if (helperResult.terminalSpawned === true || (helperResult.cmdPid && helperResult.cmdPid > 0)) {
          if (helperResult.ok === true) {
            return {
              ok: true,
              nativePlacement: true,
              fallback: false,
              terminalSpawned: true,
              cliAlive: helperResult.cliAlive !== false,
              windowLocated: helperResult.windowLocated !== false,
              isCentered: helperResult.isCentered === true,
              isForeground: helperResult.isForeground === true,
              pid: helperResult.cmdPid || helperResult.windowPid || null,
              probeFile,
              cliPath: cliInfo.cliPath,
              exePath: cliInfo.exePath,
              cliSource: cliInfo.source,
              cwd,
              cwdSource: wsInfo.source,
              model,
              args: cliArgs,
              telemetry: helperResult,
              runtimeInfo
            };
          }

          // 终端已成功创建，但窗口定位或前台激活未完全达标：严禁盲目降级重试弹新窗口！
          return {
            ok: false,
            code: 'WINDOW_PLACEMENT_PARTIAL',
            nativePlacement: true,
            fallback: false,
            terminalSpawned: true,
            cliAlive: helperResult.cliAlive !== false,
            windowLocated: helperResult.windowLocated === true,
            isCentered: helperResult.isCentered === true,
            isForeground: helperResult.isForeground === true,
            error: helperResult.error || '终端已启动，但窗口定位或前台激活未达标',
            pid: helperResult.cmdPid || helperResult.windowPid || null,
            probeFile,
            cliPath: cliInfo.cliPath,
            exePath: cliInfo.exePath,
            cwd,
            telemetry: helperResult,
            runtimeInfo
          };
        }

        // 终端未能通过 helper 创建成功，执行明确的降级并返回详细诊断
        const fallbackChild = spawn(winTools.cmdExe, ['/d', '/k', runnerBat], {
          cwd,
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        fallbackChild.unref();

        return {
          ok: true,
          fallback: true,
          nativePlacement: false,
          terminalSpawned: true,
          windowLocated: false,
          isCentered: false,
          isForeground: false,
          fallbackReason: `原生辅助定位失败 (${helperResult.error || helperResult.stderr || '未知错误'})，已自动降级启动标准控制台`,
          pid: fallbackChild.pid || null,
          probeFile,
          cliPath: cliInfo.cliPath,
          exePath: cliInfo.exePath,
          cliSource: cliInfo.source,
          cwd,
          cwdSource: wsInfo.source,
          model,
          args: cliArgs,
          telemetry: helperResult,
          runtimeInfo
        };
      }

      // 未找到 helper 时的兜底降级方案：纯异步 spawn cmd.exe（绝不使用 spawnSync 阻塞主进程）
      const child = spawn(winTools.cmdExe, ['/d', '/k', runnerBat], {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();

      return {
        ok: true,
        fallback: true,
        nativePlacement: false,
        terminalSpawned: true,
        windowLocated: false,
        isCentered: false,
        isForeground: false,
        fallbackReason: '未检测到原生定位辅助程序 (cli-window-helper.exe)，已降级启动标准控制台',
        pid: child.pid || null,
        probeFile,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs,
        runtimeInfo: {
          launcherModulePath: __filename,
          launcherVersion: LAUNCHER_VERSION,
          helperPath: null,
          fallback: true
        }
      };
    } else if (process.platform === 'darwin') {
      // macOS: 通过 osascript 在 Terminal.app 中打开交互会话
      const safeCwd = escapePosixArg(cwd);
      const safeCli = escapePosixArg(cliInfo.exePath);
      const safeArgs = cliArgs.map(escapePosixArg).join(' ');
      const bashCmd = `cd ${safeCwd} && ${safeCli} ${safeArgs}; exec bash`;
      const escapedScriptCmd = bashCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const appleScript = `tell application "Terminal"\n  do script "${escapedScriptCmd}"\n  activate\nend tell`;

      const child = spawn('osascript', ['-e', appleScript], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      return {
        ok: true,
        nativePlacement: false,
        fallback: false,
        terminal: 'Terminal.app',
        pid: child.pid || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    } else if (process.platform === 'linux') {
      // Linux: 探测系统可用的图形终端模拟器
      const candidateTerminals = [
        { bin: 'x-terminal-emulator', buildArgs: cmd => ['-e', `bash -c ${escapePosixArg(cmd + '; exec bash')}`] },
        { bin: 'gnome-terminal', buildArgs: cmd => ['--', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'konsole', buildArgs: cmd => ['-e', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'xfce4-terminal', buildArgs: cmd => ['-x', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'xterm', buildArgs: cmd => ['-e', 'bash', '-c', `${cmd}; exec bash`] }
      ];

      const safeCwd = escapePosixArg(cwd);
      const safeCli = escapePosixArg(cliInfo.exePath);
      const safeArgs = cliArgs.map(escapePosixArg).join(' ');
      const targetCommand = `cd ${safeCwd} && ${safeCli} ${safeArgs}`;

      let foundTerm = null;
      const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const t of candidateTerminals) {
        for (const dir of pathDirs) {
          const full = path.join(dir, t.bin);
          if (fs.existsSync(full)) {
            foundTerm = { full, t };
            break;
          }
        }
        if (foundTerm) break;
      }

      if (!foundTerm) {
        return {
          ok: false,
          code: 'NO_TERMINAL_EMULATOR',
          error: '未在系统中检测到支持的图形终端模拟器（需安装 x-terminal-emulator、gnome-terminal、konsole 或 xterm）',
          cliPath: cliInfo.cliPath,
          cwd
        };
      }

      const termArgs = foundTerm.t.buildArgs(targetCommand);
      const child = spawn(foundTerm.full, termArgs, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      return {
        ok: true,
        nativePlacement: false,
        fallback: false,
        terminal: foundTerm.t.bin,
        pid: child.pid || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    } else {
      return {
        ok: false,
        code: 'PLATFORM_UNSUPPORTED',
        error: `不支持的操作系统平台: ${process.platform}`,
        cliPath: cliInfo.cliPath,
        cwd
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
  windowsTerminalPlacement,
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveWindowsSystemTools,
  expandWindowsEnvVars,
  splitPathEntries,
  ensureWindowsSpawnPath,
  resolveBatchWrapperTarget,
  resolveCliExecutable,
  resolveCliWorkspace,
  resolveHelperExecutable,
  escapePosixArg,
  launchCliSession
};
