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

const LAUNCHER_VERSION = '0.8.1-helper-v2';

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

      const extraArgsStr = extraArgs.map(a => `"${String(a).replace(/"/g, '')}"`).join(' ');
      const batContent = [
        '@echo off',
        'if defined AG_CLI_PROBE_FILE (',
        '  > "%AG_CLI_PROBE_FILE%" echo %CD%',
        ')',
        `"${cliInfo.exePath}" --model "${model}" ${extraArgsStr}`
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
        const fallbackChild = spawn('cmd.exe', ['/d', '/k', runnerBat], {
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
      const child = spawn('cmd.exe', ['/d', '/k', runnerBat], {
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
  resolveCliExecutable,
  resolveCliWorkspace,
  resolveHelperExecutable,
  escapePosixArg,
  launchCliSession
};
