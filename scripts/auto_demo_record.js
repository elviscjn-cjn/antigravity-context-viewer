'use strict';
/**
 * Antigravity Context & Token Viewer
 * 原生系统指针高精连贯演示录制引擎 (闭环校准 · 排练连贯版)
 *
 * 核心设计：
 * 1. 真实 Windows 硬件级系统指针：开启 Per-Monitor DPI Aware V2 + 1ms 高精度时钟，基于 Stopwatch 与五阶 Minimum-Jerk 生物力学缓动曲线驱动 240Hz 平滑轨迹，方便 Recordly 捕捉真实指针与自动缩放。
 * 2. 双点实测闭环校准 + 实时归位微调：在准备阶段利用真实鼠标移动与浏览器 mousemove 事件反解精确的屏幕-视口线性映射；每次点击/悬停到达后实时校验误差并微调至 0 像素偏差，彻底兼容任意系统 DPI 缩放与 Electron 页面 Zoom。
 * 3. 智能按需平滑滚动：同时检测元素在 window 视口及面板内部滚动容器中的可见性；已在可视区内绝不调用 scrollIntoView（零页面跳动）；需滚动时等待滚动动画完全停稳后再锁定坐标。
 * 4. 拒绝隐藏 DOM click 代点：正式演示完全依靠真实硬件鼠标点击触发，点击前检查可见性与遮挡，点击后轮询真实业务状态满足即继续，区分「等待界面就绪」与「观众阅读停留」。
 * 5. 完整覆盖 9 大场景，每步均展示「操作 + 实际结果」，并在结束后完整恢复用户的国家、订阅、颜色预设与主题等持久化设置。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { windowsTerminalPlacement } = require('../meter-cli-launcher');

// 集中化移动与停留节奏配置 (单位: ms)
const TIMINGS = {
  move: {
    micro: 120,      // 闭环微调对齐
    snappy: 300,     // 相邻控件短距移动
    standard: 460,   // 常规跨控件平滑移动
    calm: 650        // 跨面板/跨区域平稳移动
  },
  hold: {
    settle: 180,     // 界面动画/布局稳定缓冲
    transition: 380, // 简单切换短停
    inspect: 820,    // 常规状态/标签变化阅读停留
    read: 1200,      // 图表、气泡、明细卡片充分阅读停留
    feature: 1600,   // 重点成果展示停留 (如 CLI 启动完成)
    panoramic: 1800, // 开场与结尾完整窗口全景建立/定格停留
    cliReady: 4000  // 登录完成画面展示后再关闭终端
  },
  timeout: {
    cdp: 6000,       // 单次 CDP 请求超时
    mouseCmd: 5000,  // 单次鼠标驱动命令超时
    element: 5000,   // 等待元素可见可操作超时
    state: 3500,     // 等待点击后界面状态就绪超时
    update: 4500,    // 在线更新网络检查合理超时
    terminal: 15000, // 等待 CLI 终端窗口出现
    cliLogin: 90000  // 等待真实登录完成画面，超时保留终端
  }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cliLoginComplete(text) {
  const plain = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const explicitSuccess = /\bLogged in\b|\bSuccessfully authenticated\b|\bAuthentication successful\b|登录成功|已登录|身份验证成功/i.test(plain);
  // 当前 agy 直接显示账号、模型与可输入首页，不一定输出 “Logged in”.
  const signedInHome = /Antigravity CLI\s+\d/i.test(plain)
    && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(plain)
    && /Gemini\s+[\d.]+/i.test(plain)
    && /^\s*>\s*$/m.test(plain)
    && /\? for shortcuts/i.test(plain);
  return explicitSuccess || signedInHome;
}

// 仓库外独立日志与输出目录 (%LOCALAPPDATA%\AntigravityContextMeter\demo_logs)
const LOGS_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'AntigravityContextMeter',
  'demo_logs'
);
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runLogFile = path.join(LOGS_DIR, `demo_record_${runStamp}.log`);
const summaryJsonFile = path.join(LOGS_DIR, `demo_summary_${runStamp}.json`);

function writeLog(line) {
  const ts = new Date().toISOString().split('T')[1].slice(0, 12);
  const formatted = `[${ts}] ${line}`;
  try { fs.appendFileSync(runLogFile, formatted + '\n', 'utf8'); } catch {}
}

async function getCdpTarget() {
  const portFile = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) {
    throw new Error('未找到 Antigravity 调试端口文件 (DevToolsActivePort)，请确保 Antigravity 客户端正在运行。');
  }
  const cdpPort = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const pages = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('连接 Antigravity CDP 端口超时')));
  });
  const target = pages.find(x => x.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(x.url));
  if (!target) throw new Error('未在 Antigravity 中找到主工作区页面。');
  return { target, cdpPort };
}

function createNativeMouseDriver() {
  const psScript = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;

public class NativeMouse {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint uPeriod);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint uPeriod);

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static IntPtr TargetHwnd = IntPtr.Zero;

    public static void Init() {
        try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch {}
        try { SetProcessDpiAwareness(2); } catch {}
        try { SetProcessDPIAware(); } catch {}
        try { timeBeginPeriod(1); } catch {}
    }

    public static void Cleanup() {
        try { timeEndPeriod(1); } catch {}
    }

    public static void MinimizeConsole() {
        IntPtr cw = GetConsoleWindow();
        if (cw != IntPtr.Zero) {
            ShowWindow(cw, SW_MINIMIZE);
        }
    }

    public static void ForceForeground(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, SW_RESTORE);
            Thread.Sleep(220);
        }
        try {
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        } catch {}
        Thread.Sleep(80);
    }

    public static string FindAndFocusAntigravity() {
        TargetHwnd = IntPtr.Zero;
        int bestArea = 0;

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (!cls.ToString().StartsWith("Chrome_WidgetWin_")) return true;
            StringBuilder title = new StringBuilder(512);
            GetWindowText(hWnd, title, 512);
            string t = title.ToString();
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            bool isAntigravity = false;
            try { isAntigravity = Process.GetProcessById((int)pid).ProcessName.Equals("Antigravity", StringComparison.OrdinalIgnoreCase); } catch {}
            if (isAntigravity &&
                t.IndexOf("自动化演示录制", StringComparison.OrdinalIgnoreCase) < 0) {
                RECT cr;
                GetClientRect(hWnd, out cr);
                int w = cr.Right - cr.Left;
                int h = cr.Bottom - cr.Top;
                if (w > 400 && h > 300 && (w * h) > bestArea) {
                    bestArea = w * h;
                    TargetHwnd = hWnd;
                }
            }
            return true;
        }, IntPtr.Zero);

        if (TargetHwnd == IntPtr.Zero) return "NOT_FOUND";
        ForceForeground(TargetHwnd);
        return GetTargetClientMetrics();
    }

    public static string FocusTargetAgain() {
        if (TargetHwnd != IntPtr.Zero && IsWindow(TargetHwnd)) {
            ForceForeground(TargetHwnd);
            return GetTargetClientMetrics();
        }
        return FindAndFocusAntigravity();
    }

    public static string GetTargetClientMetrics() {
        try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch {}
        if (TargetHwnd == IntPtr.Zero || !IsWindow(TargetHwnd)) return "NOT_FOUND";
        RECT cr;
        GetClientRect(TargetHwnd, out cr);
        POINT pt = new POINT { X = 0, Y = 0 };
        ClientToScreen(TargetHwnd, ref pt);
        int w = cr.Right - cr.Left;
        int h = cr.Bottom - cr.Top;
        uint dpi = 96;
        try { dpi = GetDpiForWindow(TargetHwnd); if (dpi == 0) dpi = 96; } catch {}
        POINT cur;
        bool hasCur = GetCursorPos(out cur);
        return string.Format("RECT {0} {1} {2} {3} {4} {5}", pt.X, pt.Y, w, h, dpi, hasCur ? 1 : 0);
    }

    public static void MoveSmooth(int targetX, int targetY, int durationMs) {
        POINT start;
        if (!GetCursorPos(out start)) {
            throw new InvalidOperationException("GetCursorPos failed: no interactive desktop");
        }
        int sx = start.X;
        int sy = start.Y;
        int dx = targetX - sx;
        int dy = targetY - sy;
        if (Math.Abs(dx) <= 1 && Math.Abs(dy) <= 1) {
            // 同点连续操作只刷新 1 像素，避免每次目标移动前出现明显横向抖动.
            SetCursorPos(targetX + 1, targetY);
            Thread.Sleep(8);
            SetCursorPos(targetX, targetY);
            mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
            return;
        }
        if (durationMs <= 16) {
            SetCursorPos(targetX, targetY);
            mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
            return;
        }

        // 长距离移动自动放缓，保持起止速度、加速度均为零的五阶曲线.
        durationMs = Math.Max(durationMs, Math.Min(1150, (int)(220 + Math.Sqrt((double)dx * dx + (double)dy * dy) * 0.42)));
        Stopwatch sw = Stopwatch.StartNew();
        while (true) {
            double t = sw.Elapsed.TotalMilliseconds / (double)durationMs;
            if (t >= 1.0) break;
            // 五阶 Minimum-Jerk 自然手臂运动轨迹: 10*t^3 - 15*t^4 + 6*t^5
            double t2 = t * t;
            double t3 = t2 * t;
            double ease = t3 * (10.0 - 15.0 * t + 6.0 * t2);
            int cx = (int)Math.Round(sx + dx * ease);
            int cy = (int)Math.Round(sy + dy * ease);
            SetCursorPos(cx, cy);
            mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(4);
        }
        SetCursorPos(targetX, targetY);
        mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
    }

    public static void ClickLeft() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(45);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void WheelScroll(int wheelDelta) {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, wheelDelta, UIntPtr.Zero);
    }

    public static string GetAllTerminalWindows() {
        var list = new List<string>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            string c = cls.ToString();
            if (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS") {
                list.Add(((long)hWnd).ToString());
            }
            return true;
        }, IntPtr.Zero);
        return string.Join(",", list.ToArray());
    }

    public static string FindNewTerminalWindow(string beforeHwnds) {
        var beforeSet = new HashSet<string>(beforeHwnds.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries));
        IntPtr found = IntPtr.Zero;
        RECT foundRect = new RECT();
        uint foundDpi = 96;

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            string idStr = ((long)hWnd).ToString();
            if (beforeSet.Contains(idStr)) return true;

            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            string c = cls.ToString();
            bool isTerm = c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS";

            if (isTerm) {
                RECT r;
                GetWindowRect(hWnd, out r);
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w > 220 && h > 120) {
                    found = hWnd;
                    foundRect = r;
                    try { foundDpi = GetDpiForWindow(hWnd); if (foundDpi == 0) foundDpi = 96; } catch {}
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return "NONE";
        ForceForeground(found);
        if (!CliWindowPlacement.Center(found, TargetHwnd)) return "CENTER_FAILED";
        GetWindowRect(found, out foundRect);
        // 考虑 Windows 10/11 DWM 右侧约 7px 隐形阴影边框，计算右上角关闭按钮 (X) 中心物理坐标
        double scale = (double)foundDpi / 96.0;
        int dwmRightBorder = (int)Math.Round(7.0 * scale);
        int btnHalfWidth = (int)Math.Round(22.0 * scale);
        int titleHalfHeight = (int)Math.Round(16.0 * scale);
        int closeX = foundRect.Right - dwmRightBorder - btnHalfWidth;
        int closeY = foundRect.Top + titleHalfHeight;

        return string.Format("TERMINAL {0} {1} {2} {3} {4} {5} {6}",
            (long)found, foundRect.Left, foundRect.Top, foundRect.Right, foundRect.Bottom, closeX, closeY);
    }

    public static string CheckWindowAlive(long hwndVal) {
        IntPtr h = (IntPtr)hwndVal;
        return (IsWindow(h) && IsWindowVisible(h)) ? "ALIVE" : "CLOSED";
    }

    public static string SafeCloseWindow(long hwndVal) {
        IntPtr h = (IntPtr)hwndVal;
        if (IsWindow(h)) {
            PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
        return "OK";
    }
}
'@
$code += @'
${windowsTerminalPlacement.replace(/^using .*;$/gm, '')}
'@
[void](Add-Type -TypeDefinition $code -PassThru)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[NativeMouse]::Init()
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line.Split(' ')
    $cmd = $parts[0]
    # PowerShell may resume on another OS thread; apply the coordinate context on every command.
    [void][NativeMouse]::SetThreadDpiAwarenessContext([IntPtr](-4))
    $out = "OK"
    if ($cmd -eq 'PREPARE') {
        [NativeMouse]::MinimizeConsole()
        $out = [NativeMouse]::FindAndFocusAntigravity()
    } elseif ($cmd -eq 'METRICS') {
        $out = [NativeMouse]::GetTargetClientMetrics()
    } elseif ($cmd -eq 'FOCUS') {
        $out = [NativeMouse]::FocusTargetAgain()
    } elseif ($cmd -eq 'MOVE') {
        [NativeMouse]::MoveSmooth([int]$parts[1], [int]$parts[2], [int]$parts[3])
        $out = "OK"
    } elseif ($cmd -eq 'CLICK') {
        [NativeMouse]::ClickLeft()
        $out = "OK"
    } elseif ($cmd -eq 'WHEEL') {
        [NativeMouse]::WheelScroll([int]$parts[1])
        $out = "OK"
    } elseif ($cmd -eq 'GET_TERMS') {
        $res = [NativeMouse]::GetAllTerminalWindows()
        $out = "TERMS $res"
    } elseif ($cmd -eq 'FIND_NEW_TERM') {
        $before = if ($parts.Length -gt 1) { $parts[1] } else { "" }
        $out = [NativeMouse]::FindNewTerminalWindow($before)
    } elseif ($cmd -eq 'CHECK_WINDOW') {
        $out = [NativeMouse]::CheckWindowAlive([long]$parts[1])
    } elseif ($cmd -eq 'READ_TERM') {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$parts[1]))
            $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
            $texts = New-Object 'System.Collections.Generic.List[string]'
            foreach ($node in $nodes) {
                $pattern = $null
                if ($node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                    $text = $pattern.DocumentRange.GetText(65536)
                    if ($text -and -not $texts.Contains($text)) { $texts.Add($text) }
                }
            }
            $out = 'TEXT ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($texts -join [Environment]::NewLine)))
        } catch { $out = 'TEXT_ERROR' }
    } elseif ($cmd -eq 'CLOSE_WINDOW') {
        $out = [NativeMouse]::SafeCloseWindow([long]$parts[1])
    } elseif ($cmd -eq 'QUIT') {
        [NativeMouse]::Cleanup()
        break
    }
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
}
`;

  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  });

  const queue = [];
  let buffer = '';

  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && queue.length > 0) {
        const item = queue.shift();
        clearTimeout(item.timer);
        item.resolve(trimmed);
      }
    }
  });

  function sendCmd(cmdStr, timeoutMs = TIMINGS.timeout.mouseCmd) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = queue.findIndex(q => q.timer === timer);
        if (idx !== -1) queue.splice(idx, 1);
        reject(new Error(`鼠标驱动指令超时 (${timeoutMs}ms): ${cmdStr}`));
      }, timeoutMs);
      queue.push({ resolve, reject, timer });
      child.stdin.write(cmdStr + '\n');
    });
  }

  return {
    waitReady: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('初始化原生鼠标驱动超时')), 8000);
      queue.push({ resolve, reject, timer });
    }),
    prepareWindow: () => sendCmd('PREPARE'),
    getMetrics: () => sendCmd('METRICS'),
    focusTarget: () => sendCmd('FOCUS'),
    move: (x, y, durationMs = TIMINGS.move.standard) =>
      sendCmd(`MOVE ${Math.round(x)} ${Math.round(y)} ${Math.round(durationMs)}`, Math.max(5000, durationMs + 2000)),
    click: () => sendCmd('CLICK'),
    wheel: delta => sendCmd(`WHEEL ${Math.round(delta)}`),
    getAllTerminals: () => sendCmd('GET_TERMS'),
    findNewTerminal: beforeStr => sendCmd(`FIND_NEW_TERM ${beforeStr || ''}`),
    checkWindowAlive: hwnd => sendCmd(`CHECK_WINDOW ${hwnd}`),
    readTerminal: async hwnd => {
      const response = await sendCmd(`READ_TERM ${hwnd}`, 12000);
      if (!response.startsWith('TEXT ')) return '';
      return Buffer.from(response.slice(5), 'base64').toString('utf8');
    },
    closeWindowSafe: hwnd => sendCmd(`CLOSE_WINDOW ${hwnd}`),
    close: () => {
      try {
        child.stdin.write('QUIT\n');
        child.kill();
      } catch {}
    }
  };
}

async function main() {
  const argScene = (process.argv[2] || 'all').trim().toLowerCase();
  const isDryRun = process.argv.includes('--dry-run');
  const privacyMode = process.argv.includes('--privacy');

  console.log('================================================================');
  console.log('⚡ Antigravity Context Viewer 自动化产品演示录制引擎');
  console.log(`   运行模式: [${argScene === 'all' ? '全部 9 段完整连录' : '独立片段 #' + argScene}]${isDryRun ? ' [演练模式 DRY-RUN]' : ''}`);
  console.log(`   日志文件: ${runLogFile}`);
  console.log('================================================================\n');

  writeLog(`启动录制引擎: scene=${argScene}, dryRun=${isDryRun}`);

  const { target } = await getCdpTarget();
  const mouse = createNativeMouseDriver();
  await mouse.waitReady();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', err => { clearTimeout(t); reject(err); }, { once: true });
  });

  let reqId = 1;
  function callCdp(method, params = {}, timeoutMs = TIMINGS.timeout.cdp) {
    return new Promise((resolve, reject) => {
      const curId = ++reqId;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        reject(new Error(`CDP 请求超时 (${method})`));
      }, timeoutMs);
      const onMsg = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === curId) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (msg.error) reject(new Error(`CDP 错误 (${method}): ${msg.error.message}`));
            else resolve(msg.result);
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async function evaluate(expr) {
    const res = await callCdp('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      throw new Error(`页面脚本执行异常: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }

  // 紧急停止与清理信号处理
  let isCleaningUp = false;
  let backupSnapshot = null;
  let privacyConfigFile = null;

  async function installDemoPrivacy() {
    if (!privacyMode) return;
    await evaluate(`(() => {
      window.__demoPrivacy?.restore?.();
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      if (!sr) throw new Error('Privacy target missing');
      const originals = new Map();
      const emailPattern = /[a-zA-Z0-9.!#$%&'*+/=?^_\u0060{|}~-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
      const scrub = () => {
        const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (['STYLE', 'SCRIPT'].includes(node.parentElement?.tagName)) continue;
          const clean = node.data.replace(emailPattern, 'demo@example.com');
          if (clean !== node.data) { originals.set(node, node.data); node.data = clean; }
        }
      };
      const observer = new MutationObserver(scrub);
      scrub(); observer.observe(sr, { subtree: true, childList: true, characterData: true });
      delete window.__demoPrivateCliLaunch;
      window.__demoPrivacy = { restore() {
        observer.disconnect();
        sr.querySelector('#badge-cli')?.removeEventListener('click', window.__demoPrivateCliHandler, true);
        delete window.__demoPrivateCliHandler;
        delete window.__demoPrivateCliLaunch;
        for (const [node, value] of originals) if (node.isConnected) node.data = value;
        delete window.__demoPrivacy;
      } };
    })()`);
    writeLog('演示隐私模式已开启: 插件账号显示 demo@example.com');
  }

  async function preparePrivateCli() {
    if (!privacyMode || isDryRun) return null;
    const real = require('../meter-cli-launcher').resolveCliExecutable();
    if (!real.ok) throw new Error('无法找到真实 CLI，隐私模式禁止回退');
    if (/\.(cmd|bat)$/i.test(real.exePath)) {
      const wrapper = fs.readFileSync(real.exePath, 'utf8');
      const target = wrapper.match(/"([^"\r\n]*agy\.exe)"/i);
      if (!target) throw new Error('CLI 包装器中未找到真实可执行文件');
      real.exePath = path.resolve(target[1].replace(/%~dp0/gi, path.dirname(real.exePath) + path.sep));
    }
    if (!/\.exe$/i.test(real.exePath) || !fs.existsSync(real.exePath)) throw new Error('真实 CLI 路径无效，隐私模式禁止回退');
    const email = backupSnapshot?.email;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('未识别真实账号，无法安全建立 CLI 显示过滤');
    const dir = path.join(LOGS_DIR, 'privacy_runtime', runStamp);
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'demo-private-cli.exe');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -Path $env:DEMO_RELAY_SOURCE -OutputAssembly $env:DEMO_RELAY_EXE -OutputType ConsoleApplication"], {
      env: { ...process.env, DEMO_RELAY_SOURCE: path.join(__dirname, 'demo-private-cli.cs'), DEMO_RELAY_EXE: exe },
      windowsHide: true, encoding: 'utf8', timeout: 30000
    });
    if (result.error || result.status !== 0) throw new Error('CLI 隐私终端编译失败: ' + (result.error?.message || result.stderr));
    privacyConfigFile = exe + '.privacy-data.txt';
    fs.writeFileSync(privacyConfigFile, [real.exePath, email].map(x => Buffer.from(x).toString('base64')).join('\n'), { mode: 0o600 });
    return exe;
  }

  async function restoreUserSettings() {
    if (!backupSnapshot) return;
    writeLog('正在恢复用户原始持久化设置与界面状态...');
    try {
      await evaluate(`
        (async () => {
          try {
            const snap = ${JSON.stringify(backupSnapshot)};
            // 1. 恢复 localStorage 键值
            if (snap.localStorageMap) {
              const currentKeys = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('ag_')) currentKeys.push(k);
              }
              for (const k of currentKeys) {
                if (!(k in snap.localStorageMap)) localStorage.removeItem(k);
              }
              for (const [k, v] of Object.entries(snap.localStorageMap)) {
                if (typeof v === 'string') localStorage.setItem(k, v);
              }
            }
            // 2. 恢复宿主持久化订阅设置
            if (snap.hostSettings && typeof window.contextMeterAPI?.saveSettings === 'function') {
              const email = snap.email || 'default';
              if (snap.hostSettings.customPlan) {
                await window.contextMeterAPI.saveSettings({
                  email,
                  customPlan: snap.hostSettings.customPlan,
                  saveSeq: 999999
                });
              } else {
                await window.contextMeterAPI.saveSettings({
                  email,
                  clearPlan: true,
                  saveSeq: 999999
                });
              }
            }
            // 3. 恢复色阶预设、自定义颜色与主题显示
            const host = document.getElementById('ag-context-meter');
            const sr = host?.shadowRoot;
            if (host && snap.hostThemeAttr !== undefined) {
              if (snap.hostThemeAttr === null) host.removeAttribute('data-theme');
              else host.setAttribute('data-theme', snap.hostThemeAttr);
            }
            if (sr) {
              if (snap.savedPreset) {
                const presetBtn = sr.querySelector('.heat-preset-btn[data-heat-preset="' + snap.savedPreset + '"]');
                presetBtn?.click();
              } else {
                sr.querySelector('.heat-preset-btn[data-heat-preset="purple"]')?.click();
              }
              if (!snap.hasCustomColors) {
                sr.querySelector('#reset-all-colors-tokens')?.click();
              }
            }
          } catch {}
        })()
      `);
    } catch (e) {
      writeLog(`恢复用户设置时出现非致命警告: ${e.message}`);
    }
  }

  async function cleanupAndExit(code = 0) {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try { await resetPanelsClean(); } catch {}
    try { await restoreUserSettings(); } catch {}
    try { await evaluate(`window.__demoPrivacy?.restore?.()`); } catch {}
    try { if (privacyConfigFile) fs.unlinkSync(privacyConfigFile); } catch {}
    try { mouse.close(); } catch {}
    try { ws.close(); } catch {}
    process.exit(code);
  }

  process.on('SIGINT', () => {
    console.log('\n⚠️ 收到中断信号 (Ctrl+C)，正在恢复用户设置并安全退出...');
    writeLog('收到 SIGINT，执行紧急清理退出');
    void cleanupAndExit(130);
  });
  process.on('SIGTERM', () => {
    void cleanupAndExit(143);
  });

  // =========================================================================
  // 录制前准备阶段 (在倒计时开始前完成所有检查、备份、布局归位与真实鼠标闭环校准)
  // =========================================================================
  console.log('🔍 [准备阶段 1/5] 校验目标页面、插件挂载与必要数据就绪状态...');
  const readiness = await evaluate(`
    (() => {
      const oldFake = document.getElementById('ag-demo-cursor');
      if (oldFake) oldFake.remove();

      const host = document.getElementById('ag-context-meter');
      const sr = host?.shadowRoot;
      if (!sr) return { ok: false, reason: '未找到 #ag-context-meter ShadowRoot' };

      const requiredSelectors = [
        '#badge', '#badge-speed', '#badge-tokens', '#badge-cli',
        '#panel', '#panel-tokens', '#key-summary', '#speed-summary',
        '#btn-toggle-details', '#tok-view-tokens', '#tok-view-cost',
        '#h-tab-daily', '#h-tab-weekly', '#h-tab-monthly', '#h-tab-yearly', '#h-tab-cum',
        '#src-tab-all', '#src-tab-desktop', '#src-tab-cli',
        '#btn-plan-detail-toggle', '#direct-country-trigger', '#direct-region-trigger',
        '#btn-panel-tokens-palette', '#theme-toggle-tokens', '#btn-check-update'
      ];
      const missing = requiredSelectors.filter(s => !sr.querySelector(s));
      if (missing.length > 0) return { ok: false, reason: '缺失关键控件: ' + missing.join(', ') };

      // 安装高精度真实系统鼠标位置探针 (仅记录 e.isTrusted === true 的真实操作系统硬件鼠标事件)
      window.__realMouseProbe = { clientX: null, clientY: null, screenX: null, screenY: null, seq: 0, ts: 0 };
      if (!window.__realMouseProbeHandler) {
        window.__realMouseProbeHandler = e => {
          if (!e.isTrusted) return;
          window.__realMouseProbe = {
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
            seq: (window.__realMouseProbe?.seq || 0) + 1,
            ts: Date.now()
          };
        };
        window.addEventListener('mousemove', window.__realMouseProbeHandler, { capture: true, passive: true });
      }

      const pctText = sr.querySelector('#badge-pct-val')?.textContent?.trim() || '';
      const tokText = sr.querySelector('#token-amount')?.textContent?.trim() || '';
      return {
        ok: true,
        pctText,
        tokText
      };
    })()
  `);

  if (!readiness?.ok) {
    throw new Error(`录制前环境检查未通过: ${readiness?.reason || '未知原因'}`);
  }
  writeLog(`插件环境就绪: 上下文=${readiness.pctText}, Token=${readiness.tokText}`);

  console.log('🔍 [准备阶段 2/5] 备份用户当前持久化设置 (国家/订阅/颜色预设/主题)...');
  backupSnapshot = await evaluate(`
    (async () => {
      const host = document.getElementById('ag-context-meter');
      const sr = host?.shadowRoot;
      const localStorageMap = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ag_')) {
          localStorageMap[k] = localStorage.getItem(k);
        }
      }
      let hostSettings = null;
      try {
        if (typeof window.contextMeterAPI?.getSettings === 'function') {
          hostSettings = await window.contextMeterAPI.getSettings();
        }
      } catch {}
      const email = sr?.querySelector('#p-det-account')?.textContent?.trim() || 'default';
      const savedPreset = localStorage.getItem('ag_heat_preset_v1');
      const rawColors = localStorage.getItem('ag_custom_colors_v1');
      let hasCustomColors = false;
      try {
        if (rawColors) {
          const parsed = JSON.parse(rawColors);
          hasCustomColors = Object.entries(parsed).some(([k, v]) => k !== 'heatPreset' && Boolean(v));
        }
      } catch {}
      return {
        localStorageMap,
        hostSettings,
        email: (email && email !== '—') ? email : 'default',
        hostThemeAttr: host ? host.getAttribute('data-theme') : null,
        savedPreset,
        hasCustomColors
      };
    })()
  `);

  await installDemoPrivacy();

  // 彻底重置所有面板、抽屉、弹窗与滚动位置至初始干净构图
  async function resetPanelsClean() {
    await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        if (!sr) return;
        const pop = sr.querySelector('#update-popover');
        const cp = sr.querySelector('#color-picker-popover');
        const tip = sr.querySelector('#context-tooltip');
        const heatPop = sr.querySelector('#heat-pop');
        if (pop) pop.style.display = 'none';
        if (cp) cp.hidden = true;
        if (tip) tip.setAttribute('data-visible', 'false');
        if (heatPop) heatPop.style.opacity = '0';

        sr.querySelectorAll('.ag-dropdown-wrapper.is-open').forEach(w => w.classList.remove('is-open'));

        const drawerBody = sr.querySelector('#drawer-body');
        if (drawerBody && drawerBody.style.display !== 'none') {
          sr.querySelector('#btn-toggle-details')?.click();
        }
        const colorDrawer = sr.querySelector('#token-color-drawer-body');
        if (colorDrawer && colorDrawer.style.display !== 'none') {
          sr.querySelector('#btn-toggle-token-colors')?.click();
        }
        const planCard = sr.querySelector('#plan-detail-card');
        if (planCard && planCard.style.display !== 'none') {
          sr.querySelector('#btn-plan-detail-collapse-top')?.click();
        }
        const costPane = sr.querySelector('#cost-details-pane');
        if (costPane && costPane.style.display !== 'none') {
          sr.querySelector('#btn-cost-details-collapse')?.click();
        }

        const p1 = sr.querySelector('#panel');
        const p2 = sr.querySelector('#panel-tokens');
        if (p1) { p1.scrollTop = 0; if (!p1.hidden) sr.querySelector('#close')?.click(); }
        if (p2) { p2.scrollTop = 0; if (!p2.hidden) sr.querySelector('#close-tokens')?.click(); }
      })()
    `);
    await sleep(180);
  }

  console.log('🔍 [准备阶段 3/5] 重置初始面板状态、滚动条位置与窗口布局...');
  await resetPanelsClean();

  console.log('🔍 [准备阶段 4/5] 激活 Antigravity 窗口并执行真实鼠标双点闭环 DPI 校准...');
  const prepRes = await mouse.prepareWindow();
  await callCdp('Page.bringToFront');
  await sleep(220);

  let winPhysRect = null;
  let hasDesktopCursor = false;
  if (prepRes && prepRes.startsWith('RECT ')) {
    const p = prepRes.split(' ').map(Number);
    winPhysRect = { left: p[1], top: p[2], width: p[3], height: p[4], dpi: p[5] || 96 };
    hasDesktopCursor = p[6] === 1;
  }
  writeLog(`原生窗口诊断: ${prepRes}`);
  if (!hasDesktopCursor && !isDryRun) {
    await cleanupAndExit(1);
    throw new Error('无法读取真实系统指针. 请在已解锁的交互桌面终端运行此 Node 命令；正式模式禁止 CDP 代点. 原生诊断: ' + prepRes);
  }

  const vpInit = await evaluate(`({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    dpr: window.devicePixelRatio || 1
  })`);

  // 建立屏幕物理坐标映射模型：physX = calibOriginX + cssX * calibScaleX
  let calibScaleX = 1;
  let calibScaleY = 1;
  let calibOriginX = 0;
  let calibOriginY = 0;

  if (winPhysRect && winPhysRect.width > 0 && vpInit.innerWidth > 0) {
    // 客户区物理宽高 ÷ 页面 CSS 视口宽高 = 精确缩放比 (自动兼容系统 DPI 缩放 + Electron 页面 Zoom)
    calibScaleX = winPhysRect.width / vpInit.innerWidth;
    calibScaleY = winPhysRect.height / vpInit.innerHeight;
    calibOriginX = winPhysRect.left;
    calibOriginY = winPhysRect.top;
  } else if (vpInit.outerWidth > 0 && vpInit.innerWidth > 0) {
    calibScaleX = vpInit.outerWidth / vpInit.innerWidth;
    calibScaleY = vpInit.outerHeight / vpInit.innerHeight;
    calibOriginX = vpInit.screenX > -1000 ? vpInit.screenX : 0;
    calibOriginY = vpInit.screenY > -1000 ? vpInit.screenY : 0;
  }

  // 双点实测闭环校准：移动真实系统指针至窗口内两个测试点，根据浏览器收到的真实 mousemove 反解零误差映射
  if (hasDesktopCursor) {
    const c1X = Math.round(vpInit.innerWidth * 0.35);
    const c1Y = Math.round(vpInit.innerHeight * 0.35);
    const c2X = Math.round(vpInit.innerWidth * 0.65);
    const c2Y = Math.round(vpInit.innerHeight * 0.65);

    const testPhys1X = Math.round(calibOriginX + c1X * calibScaleX);
    const testPhys1Y = Math.round(calibOriginY + c1Y * calibScaleY);
    const testPhys2X = Math.round(calibOriginX + c2X * calibScaleX);
    const testPhys2Y = Math.round(calibOriginY + c2Y * calibScaleY);

    await mouse.move(testPhys1X, testPhys1Y, 70);
    await sleep(55);
    const probe1 = await evaluate(`window.__realMouseProbe`);

    await mouse.move(testPhys2X, testPhys2Y, 90);
    await sleep(55);
    const probe2 = await evaluate(`window.__realMouseProbe`);

    if (
      probe1 && probe2 &&
      probe1.clientX !== null && probe2.clientX !== null &&
      probe2.seq > probe1.seq &&
      Math.abs(probe2.clientX - probe1.clientX) > 40 &&
      Math.abs(probe2.clientY - probe1.clientY) > 40
    ) {
      calibScaleX = (testPhys2X - testPhys1X) / (probe2.clientX - probe1.clientX);
      calibScaleY = (testPhys2Y - testPhys1Y) / (probe2.clientY - probe1.clientY);
      calibOriginX = testPhys2X - probe2.clientX * calibScaleX;
      calibOriginY = testPhys2Y - probe2.clientY * calibScaleY;
      writeLog(
        `双点闭环校准成功: scale=(${calibScaleX.toFixed(4)}, ${calibScaleY.toFixed(4)}), origin=(${calibOriginX.toFixed(1)}, ${calibOriginY.toFixed(1)})`
      );
    } else if (probe2 && probe2.seq > (probe1?.seq || 0) && probe2.clientX !== null && Date.now() - probe2.ts < 1500) {
      calibOriginX += (c2X - probe2.clientX) * calibScaleX;
      calibOriginY += (c2Y - probe2.clientY) * calibScaleY;
      writeLog(
        `单点闭环校准成功: scale=(${calibScaleX.toFixed(4)}, ${calibScaleY.toFixed(4)}), origin=(${calibOriginX.toFixed(1)}, ${calibOriginY.toFixed(1)})`
      );
    } else {
      throw new Error('真实指针校准失败: 页面未收到本次移动事件，请检查窗口遮挡或交互桌面权限.');
    }
  } else {
    writeLog(`当前处于无硬件桌面沙箱环境 (hasDesktopCursor=false)，使用视口几何映射`);
  }

  function mapCssToPhysical(cssX, cssY) {
    return {
      x: Math.round(calibOriginX + cssX * calibScaleX),
      y: Math.round(calibOriginY + cssY * calibScaleY)
    };
  }

  // 预置鼠标到顶栏下方右侧安全起始位置 (不遮挡顶栏胶囊与核心内容)
  console.log('🔍 [准备阶段 5/5] 鼠标归位至开场安全起始点...');
  const startSafePt = mapCssToPhysical(Math.round(vpInit.innerWidth * 0.72), 88);
  await mouse.move(startSafePt.x, startSafePt.y, 120);
  await resetPanelsClean();

  console.log('\n👉 准备工作全部完成，倒计时 3 秒后正式进入连贯演示录制...');
  for (let i = 3; i >= 1; i--) {
    console.log(`   ⏱️ ${i}...`);
    await sleep(1000);
  }

  const overallStartTime = Date.now();
  const sceneStats = [];

  // =========================================================================
  // 核心定位、平滑滚动、闭环鼠标移动与状态等待工具函数
  // =========================================================================

  async function waitForCondition(checkFn, timeoutMs = TIMINGS.timeout.state, desc = '状态就绪') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await checkFn();
        if (ok) return true;
      } catch {}
      await sleep(45);
    }
    writeLog(`等待超时 (${timeoutMs}ms): ${desc}`);
    return false;
  }

  /**
   * 获取元素在视口与屏幕上的精确坐标
   * - 若元素已在视口及滚动父容器的可视范围内：绝不调用 scrollIntoView（彻底消除页面跳动）
   * - 若元素在可视范围外：平滑滚动至可视区，并等待元素位置完全稳定后再返回坐标
   */
  async function getElementScreenPoint(selector, options = {}) {
    const {
      timeout = TIMINGS.timeout.element,
      offsetX = 0,
      offsetY = 0,
      scrollBlock = 'center'
    } = options;
    const startT = Date.now();
    let lastStatus = null;

    while (Date.now() - startT < timeout) {
      const raw = await evaluate(`
        (async function() {
          try {
            const host = document.getElementById('ag-context-meter');
            const sr = host && host.shadowRoot;
            if (!sr) return { status: 'NO_SHADOW' };
            const el = sr.querySelector(${JSON.stringify(selector)});
            if (!el) return { status: 'NOT_FOUND' };

            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
              return { status: 'HIDDEN' };
            }

            let r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return { status: 'ZERO_SIZE' };

            // 检查是否在主视口及可滚动祖先容器的安全可视区域内 (留出 28px 边距防止落在 fixed 面板溢出底边)
            const margin = 28;
            let needScroll = (
              r.top < 8 ||
              r.bottom > window.innerHeight - margin ||
              r.left < 8 ||
              r.right > window.innerWidth - 8
            );

            if (!needScroll) {
              let p = el.parentElement;
              while (p && p !== sr && p !== document.body && p !== document.documentElement) {
                const pcs = window.getComputedStyle(p);
                if (/(auto|scroll)/.test(pcs.overflowY) && p.scrollHeight > p.clientHeight + 2) {
                  const pr = p.getBoundingClientRect();
                  const effBottom = Math.min(pr.bottom, window.innerHeight - 12);
                  if (r.top < pr.top + 8 || r.bottom > effBottom - 8) {
                    needScroll = true;
                    break;
                  }
                }
                p = p.parentElement;
              }
            }

            if (needScroll) {
              el.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(scrollBlock)}, inline: 'nearest' });
              // 轮询等待平滑滚动彻底停稳 (连续两帧位置变化 < 0.5px)
              let lastTop = el.getBoundingClientRect().top;
              let stableCount = 0;
              for (let i = 0; i < 18; i++) {
                await new Promise(res => setTimeout(res, 35));
                const curR = el.getBoundingClientRect();
                if (Math.abs(curR.top - lastTop) < 0.5) {
                  stableCount++;
                  if (stableCount >= 2) break;
                } else {
                  stableCount = 0;
                }
                lastTop = curR.top;
              }
              r = el.getBoundingClientRect();
            }

            const cx = Math.max(r.left + 3, Math.min(r.right - 3, r.left + r.width / 2 + (${Number(offsetX) || 0})));
            const cy = Math.max(r.top + 3, Math.min(r.bottom - 3, r.top + r.height / 2 + (${Number(offsetY) || 0})));

            return {
              status: 'OK',
              clientX: cx,
              clientY: cy,
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
            };
          } catch (e) {
            return { status: 'ERROR', error: e.message };
          }
        })()
      `);

      lastStatus = raw;
      if (raw && raw.status === 'OK') {
        const phys = mapCssToPhysical(raw.clientX, raw.clientY);
        return {
          clientX: raw.clientX,
          clientY: raw.clientY,
          rect: raw.rect,
          physX: phys.x,
          physY: phys.y
        };
      }
      await sleep(45);
    }
    const panelState = await evaluate(`(() => {
      const sr = document.getElementById('ag-context-meter')?.shadowRoot;
      const panel = sr?.querySelector('#panel');
      return { hidden: panel?.hidden, scrollTop: panel?.scrollTop,
        drawer: sr?.querySelector('#drawer-body')?.style.display };
    })()`);
    throw new Error(`[元素定位失败] ${selector}: ${JSON.stringify({ lastStatus, panelState })}`);
  }

  /**
   * 闭环移动真实系统指针到目标元素，并检验浏览器实际收到的指针坐标是否命中目标范围
   */
  async function moveMouseToElement(selector, options = {}) {
    const {
      moveMs = TIMINGS.move.standard,
      offsetX = 0,
      offsetY = 0,
      scrollBlock = 'center'
    } = options;

    let pt = await getElementScreenPoint(selector, { offsetX, offsetY, scrollBlock });
    await mouse.move(pt.physX, pt.physY, moveMs);

    // 布局变化或动画过渡后二次确认位置，并利用 __realMouseProbe 进行闭环零误差对齐
    const checkAndHome = await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const el = sr?.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cx = Math.max(r.left + 3, Math.min(r.right - 3, r.left + r.width / 2 + (${Number(offsetX) || 0})));
        const cy = Math.max(r.top + 3, Math.min(r.bottom - 3, r.top + r.height / 2 + (${Number(offsetY) || 0})));
        return {
          cx,
          cy,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          probe: window.__realMouseProbe || null
        };
      })()
    `);

    if (checkAndHome) {
      const targetCx = checkAndHome.cx;
      const targetCy = checkAndHome.cy;
      const pr = checkAndHome.probe;

      if (hasDesktopCursor && pr && pr.clientX !== null && Date.now() - pr.ts < 800) {
        const errX = targetCx - pr.clientX;
        const errY = targetCy - pr.clientY;
        const outsideRect = (
          pr.clientX < checkAndHome.rect.left + 1 ||
          pr.clientX > checkAndHome.rect.right - 1 ||
          pr.clientY < checkAndHome.rect.top + 1 ||
          pr.clientY > checkAndHome.rect.bottom - 1
        );
        if (outsideRect || Math.abs(errX) > 2.5 || Math.abs(errY) > 2.5) {
          calibOriginX += errX * calibScaleX;
          calibOriginY += errY * calibScaleY;
          const corrected = mapCssToPhysical(targetCx, targetCy);
          await mouse.move(corrected.x, corrected.y, TIMINGS.move.micro);
          pt = {
            clientX: targetCx,
            clientY: targetCy,
            rect: checkAndHome.rect,
            physX: corrected.x,
            physY: corrected.y
          };
        }
      } else {
        const freshPhys = mapCssToPhysical(targetCx, targetCy);
        if (Math.abs(freshPhys.x - pt.physX) > 3 || Math.abs(freshPhys.y - pt.physY) > 3) {
          await mouse.move(freshPhys.x, freshPhys.y, TIMINGS.move.micro);
          pt = {
            clientX: targetCx,
            clientY: targetCy,
            rect: checkAndHome.rect,
            physX: freshPhys.x,
            physY: freshPhys.y
          };
        }
      }
    }

    if (hasDesktopCursor) {
      // 每次移动后重新读取真实事件和命中元素；不允许把旧坐标或模拟事件当成对齐成功.
      let aligned = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(60);
        const hit = await evaluate(`(() => {
          const sr = document.getElementById('ag-context-meter')?.shadowRoot;
          const el = sr?.querySelector(${JSON.stringify(selector)});
          const p = window.__realMouseProbe;
          if (!el || !p || p.clientX === null || Date.now() - p.ts > 1200) return null;
          const r = el.getBoundingClientRect();
          const top = sr.elementFromPoint(p.clientX, p.clientY);
          return { x: p.clientX, y: p.clientY,
            cx: Math.max(r.left + 3, Math.min(r.right - 3, r.left + r.width / 2 + ${Number(offsetX) || 0})),
            cy: Math.max(r.top + 3, Math.min(r.bottom - 3, r.top + r.height / 2 + ${Number(offsetY) || 0})),
            hit: top === el || el.contains(top) };
        })()`);
        if (!hit) throw new Error('未收到真实指针位置: ' + selector);
        const dx = hit.cx - hit.x, dy = hit.cy - hit.y;
        if (hit.hit && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) { aligned = true; break; }
        calibOriginX += dx * calibScaleX;
        calibOriginY += dy * calibScaleY;
        const corrected = mapCssToPhysical(hit.cx, hit.cy);
        writeLog(`指针对齐 ${selector}: 偏差=(${dx.toFixed(1)},${dy.toFixed(1)}) 命中=${hit.hit}`);
        await mouse.move(corrected.x, corrected.y, TIMINGS.move.micro);
        pt = { ...pt, clientX: hit.cx, clientY: hit.cy, physX: corrected.x, physY: corrected.y };
      }
      if (!aligned) throw new Error('真实指针未对齐或目标被遮挡，取消点击: ' + selector);
    }
    return pt;
  }

  /**
   * 真实鼠标移动悬停并等待提示或阅读停留
   */
  async function realHover(selector, options = {}) {
    const {
      moveMs = TIMINGS.move.standard,
      holdMs = TIMINGS.hold.inspect,
      offsetX = 0,
      offsetY = 0,
      expectTooltip = null
    } = options;

    const pt = await moveMouseToElement(selector, { moveMs, offsetX, offsetY });
    writeLog(`hover -> ${selector} [screen=(${pt.physX},${pt.physY}), css=(${Math.round(pt.clientX)},${Math.round(pt.clientY)})]`);

    // 若运行在无硬件桌面的沙箱测试环境，补充悬停事件；真实桌面由系统鼠标自然触发，若组件依赖 mouseenter 也同步确保触发
    if (isDryRun && !hasDesktopCursor) await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const el = sr?.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: ${pt.clientX}, clientY: ${pt.clientY} }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: ${pt.clientX}, clientY: ${pt.clientY} }));
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${pt.clientX}, clientY: ${pt.clientY} }));
        }
      })()
    `);

    if (expectTooltip) {
      await waitForCondition(async () => {
        return await evaluate(`
          (() => {
            const sr = document.getElementById('ag-context-meter')?.shadowRoot;
            const tip = sr?.querySelector(${JSON.stringify(expectTooltip)});
            if (!tip) return false;
            const cs = window.getComputedStyle(tip);
            return (
              tip.getAttribute('data-visible') === 'true' ||
              tip.classList.contains('is-visible') ||
              (cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1)
            );
          })()
        `);
      }, 2000, `悬停提示显示 (${expectTooltip})`);
    }

    if (holdMs > 0) await sleep(holdMs);
    return pt;
  }

  /**
   * 真实系统鼠标左键点击并验证业务结果 (严禁隐藏 DOM click 冒充)
   */
  async function realClick(selector, options = {}) {
    const {
      moveMs = TIMINGS.move.standard,
      holdMs = TIMINGS.hold.inspect,
      offsetX = 0,
      offsetY = 0,
      expectedState = null,
      stateTimeout = TIMINGS.timeout.state
    } = options;

    let pt = await moveMouseToElement(selector, { moveMs, offsetX, offsetY });
    writeLog(`click -> ${selector} [screen=(${pt.physX},${pt.physY}), css=(${Math.round(pt.clientX)},${Math.round(pt.clientY)})]`);

    // 挂载一次性真实点击命中检测器
    await evaluate(`
      (() => {
        window.__lastDemoClickHit = false;
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const el = sr?.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.addEventListener('click', () => { window.__lastDemoClickHit = true; }, { once: true, capture: true });
        }
      })()
    `);

    await sleep(25);
    await mouse.click();

    // 若运行在无桌面的 CI/沙箱环境 (GetCursorPos=false)，仅在沙箱下发送底层 CDP 鼠标点击以便演练验证
    if (isDryRun && !hasDesktopCursor) {
      await callCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.clientX, y: pt.clientY });
      await callCdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: pt.clientX, y: pt.clientY });
      await sleep(30);
      await callCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: pt.clientX, y: pt.clientY });
    } else {
      // 在真实桌面环境下，检查 280ms 内真实物理点击是否命中目标；若因窗口刚被激活吞掉了首次点击，重新聚焦并真实重点一次
      const hitQuickly = await waitForCondition(async () => {
        if (expectedState) {
          const ok = await expectedState();
          if (ok) return true;
        }
        return await evaluate(`Boolean(window.__lastDemoClickHit)`);
      }, 320, `首次物理点击响应 (${selector})`);

      if (!hitQuickly) {
        writeLog(`首次物理点击未触发响应 (${selector})，正在重新聚焦窗口并执行二次真实物理点击校准...`);
        await mouse.focusTarget();
        pt = await moveMouseToElement(selector, { moveMs: TIMINGS.move.micro, offsetX, offsetY });
        await sleep(30);
        await mouse.click();
      }
    }

    if (expectedState && typeof expectedState === 'function') {
      const satisfied = await waitForCondition(expectedState, stateTimeout, `点击后目标状态就绪 (${selector})`);
      if (!satisfied) {
        throw new Error(`[点击结果验证失败] 点击 ${selector} 后未在 ${stateTimeout}ms 内达到预期界面状态`);
      }
    } else {
      await sleep(50);
    }

    if (holdMs > 0) await sleep(holdMs);
    return pt;
  }

  /**
   * 长面板分段平滑滚动函数
   */
  async function smoothScrollPanelBy(panelSelector, deltaY, durationMs = 360, holdMs = TIMINGS.hold.inspect) {
    writeLog(`scroll -> ${panelSelector} (deltaY=${deltaY})`);
    await evaluate(`
      (async () => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const container = sr?.querySelector(${JSON.stringify(panelSelector)});
        if (!container) return;
        const startTop = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxTop, startTop + (${Number(deltaY)})));
        const diff = targetTop - startTop;
        if (Math.abs(diff) < 2) return;
        const dur = ${Number(durationMs)};
        const t0 = performance.now();
        await new Promise(resolve => {
          function step(now) {
            const p = Math.min(1, (now - t0) / dur);
            const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
            container.scrollTop = startTop + diff * ease;
            if (p < 1) requestAnimationFrame(step);
            else resolve();
          }
          requestAnimationFrame(step);
        });
      })()
    `);
    if (holdMs > 0) await sleep(holdMs);
  }

  /**
   * 在输入框中模拟真实逐字输入并触发过滤/联动事件
   */
  async function realTypeInInput(selector, text, options = {}) {
    const { moveMs = TIMINGS.move.snappy, holdMs = TIMINGS.hold.inspect } = options;
    await realClick(selector, { moveMs, holdMs: 120 });
    writeLog(`type -> ${selector}: "${text}"`);
    await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const input = sr?.querySelector(${JSON.stringify(selector)});
        if (!input) return;
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    for (const ch of String(text)) {
      await evaluate(`
        (() => {
          const sr = document.getElementById('ag-context-meter')?.shadowRoot;
          const input = sr?.querySelector(${JSON.stringify(selector)});
          if (!input) return;
          input.value += ${JSON.stringify(ch)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);
      await sleep(55);
    }
    await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const input = sr?.querySelector(${JSON.stringify(selector)});
        if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    if (holdMs > 0) await sleep(holdMs);
  }

  async function ensureContextPanelOpen() {
    const isOpen = await evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel')?.hidden`);
    if (!isOpen) {
      await realClick('#badge', {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel')?.hidden`)
      });
    }
  }

  async function ensureTokensPanelOpen() {
    const isOpen = await evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel-tokens')?.hidden`);
    if (!isOpen) {
      await realClick('#badge-tokens', {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel-tokens')?.hidden`)
      });
      await sleep(TIMINGS.hold.settle);
    }
  }

  // =========================================================================
  // 场景 1: 顶栏与上下文 (完整窗口开场 -> 顶栏悬停提示 -> 打开上下文面板 -> 核心用量与生成速度)
  // =========================================================================
  async function scene1_ContextAndSpeed() {
    const t0 = Date.now();
    console.log('▶ [场景 1/9] 顶栏与上下文：完整窗口开场 -> 顶栏悬停气泡 -> 会话上下文面板 -> 核心用量与生成速度');
    writeLog('[Scene 1] 开始');

    await resetPanelsClean();

    // 1. 开头使用 Antigravity 完整窗口视角，顶栏入口清晰可见，保留约 1.8 秒建立画面
    await sleep(TIMINGS.hold.panoramic);

    // 2. 移动到顶栏上下文圆环胶囊，展示三层悬停提示气泡
    await realHover('#badge', {
      moveMs: TIMINGS.move.calm,
      holdMs: TIMINGS.hold.read,
      expectTooltip: '#context-tooltip'
    });

    // 3. 真实点击打开会话上下文面板 (#panel)
    await realClick('#badge', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel')?.hidden`)
    });

    // 4. 展示核心用量速览卡片 (指针停在卡片右侧区域，不遮挡核心数值)
    await realHover('#key-summary', {
      moveMs: TIMINGS.move.standard,
      offsetX: 110,
      offsetY: -10,
      holdMs: TIMINGS.hold.read
    });

    // 5. 展示最新生成速度与耗时指标卡片 (输出速度 tok/s、耗时、首字延迟、本次输出)
    await realHover('#speed-summary', {
      moveMs: TIMINGS.move.standard,
      offsetX: 110,
      offsetY: -10,
      holdMs: TIMINGS.hold.read
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 1, name: '顶栏与上下文', durationSec: dur });
    writeLog(`[Scene 1] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 2: 技术参数与附件 (展开明细 -> 分段平滑滚动 -> 重新扫描等待真实结果 -> 收起)
  // =========================================================================
  async function scene2_TechSpecsAndAttachments() {
    const t0 = Date.now();
    console.log('▶ [场景 2/9] 技术参数与附件：展开底层参数 -> 分段平滑滚动浏览 -> 重新扫描整段会话与附件');
    writeLog('[Scene 2] 开始');

    await ensureContextPanelOpen();

    // 1. 点击展开底层技术参数与附件审计抽屉
    if (!(await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#btn-toggle-details')?.getAttribute('aria-expanded') === 'true'`))) await realClick('#btn-toggle-details', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#btn-toggle-details')?.getAttribute('aria-expanded') === 'true'`)
    });

    // 2. 第一段平滑滚动：浏览「最近一次模型请求」参数
    await smoothScrollPanelBy('#panel', 190, 360, TIMINGS.hold.transition);
    await realHover('#actual', {
      moveMs: TIMINGS.move.standard,
      offsetX: 40,
      holdMs: TIMINGS.hold.read
    });

    // 3. 第二段平滑滚动：浏览「整个会话累计内容 · 本地估算」与「附件逐项检查」
    await smoothScrollPanelBy('#panel', 240, 380, TIMINGS.hold.transition);
    await realHover('#session-total', {
      moveMs: TIMINGS.move.standard,
      offsetX: 40,
      holdMs: TIMINGS.hold.read
    });

    // 4. 第三段平滑滚动到底部：真实点击「重新扫描整段会话与附件」并等待实际结果返回
    await smoothScrollPanelBy('#panel', 260, 360, 200);
    await realClick('#refresh', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => {
        return await evaluate(`
          (() => {
            const sr = document.getElementById('ag-context-meter')?.shadowRoot;
            const st = sr?.querySelector('#status')?.textContent?.trim() || '';
            const btn = sr?.querySelector('#refresh');
            return !!btn && btn.isConnected && !btn.disabled && !st.includes('正在核对') && !st.includes('正在扫描');
          })()
        `);
      }
    });

    // 5. 平滑滚回面板顶部并收起技术参数抽屉
    await ensureContextPanelOpen();
    // 刷新可能改变内容高度，固定 -800 无法保证回到顶部.
    const remainingScroll = await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel')?.scrollTop || 0`);
    await smoothScrollPanelBy('#panel', -remainingScroll, 360, TIMINGS.hold.settle);
    if (await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#btn-toggle-details')?.getAttribute('aria-expanded') === 'true'`)) await realClick('#btn-toggle-details', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#drawer-body')?.style.display === 'none'`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 2, name: '技术参数与附件', durationSec: dur });
    writeLog(`[Scene 2] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 3: Token 统计与图表 (统计卡片 -> 日/周/月/年/累计 5 视图 & 真实数据点提示 & 翻页)
  // =========================================================================
  async function scene3_TokensAndHeatmap() {
    const t0 = Date.now();
    console.log('▶ [场景 3/9] Token 统计与图表：统计卡片 -> 日/周/月/年/累计 5 视图切换 -> 活跃数据气泡与翻页');
    writeLog('[Scene 3] 开始');

    await ensureTokensPanelOpen();

    // 确保处于 Token 统计视图
    const inTokensView = await evaluate(`
      (() => {
        const mv = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#tokens-main-view');
        return mv && window.getComputedStyle(mv).display !== 'none';
      })()
    `);
    if (!inTokensView) {
      await realClick('#tok-view-tokens', {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#tokens-main-view')?.style.display !== 'none'`)
      });
    }

    // 1. 展示顶部四张核心统计卡片 (累计处理、今日使用、本月使用、年度使用)
    await realHover('#t-total-val', { moveMs: TIMINGS.move.standard, offsetX: 35, holdMs: TIMINGS.hold.inspect });
    await realHover('#t-today-val', { moveMs: TIMINGS.move.snappy, offsetX: 35, holdMs: TIMINGS.hold.inspect });

    // 2. 每天视图 (#h-tab-daily)：动态选择有实际数据的格子展示提示 (使用原生持久属性 data-date，不怕异步重绘)
    const isDailyActive = await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-tab-daily')?.classList.contains('active')`);
    if (!isDailyActive) {
      await realClick('#h-tab-daily', {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.transition,
        expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-tab-daily')?.classList.contains('active')`)
      });
    }

    const activeDailyDate = await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const cells = Array.from(sr?.querySelectorAll('#h-grid-cols .heat-cell') || []);
        const withData = cells.filter(c => Number(c.getAttribute('data-tokens') || 0) > 0 && !c.classList.contains('is-future'));
        if (withData.length > 0) {
          // 优先选择近期用量饱满的格子
          const pick = withData[Math.max(0, withData.length - 2)] || withData[withData.length - 1];
          return pick.getAttribute('data-date');
        }
        return cells[Math.max(0, cells.length - 8)]?.getAttribute('data-date') || null;
      })()
    `);
    if (activeDailyDate) {
      await realHover(`#h-grid-cols .heat-cell[data-date="${activeDailyDate}"]`, {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.read,
        expectTooltip: '#heat-pop'
      });
    }

    // 3. 每周视图 (#h-tab-weekly)：切换并选择有实际数据的周柱展示提示
    await realClick('#h-tab-weekly', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-weekly-box')?.style.display !== 'none'`)
    });
    const activeWeekStart = await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const cols = Array.from(sr?.querySelectorAll('#h-weekly-box .w-bar-col') || []);
        // 寻找高度 > 5% 的有数据周柱
        const nonEmpty = cols.filter(c => {
          const fill = c.querySelector('.w-bar-fill');
          const h = parseFloat(fill?.style?.height || '0');
          return h > 4;
        });
        const pick = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : cols[cols.length - 2];
        return pick?.getAttribute('data-week-start') || null;
      })()
    `);
    if (activeWeekStart) {
      await realHover(`#h-weekly-box .w-bar-col[data-week-start="${activeWeekStart}"]`, {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.read,
        expectTooltip: '#heat-pop'
      });
    }

    // 4. 每月视图 (#h-tab-monthly)：切换并选择有实际数据的月度格子展示提示 + 必要翻页展示
    await realClick('#h-tab-monthly', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-monthly-box')?.style.display !== 'none'`)
    });
    const activeMonthDate = await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const cells = Array.from(sr?.querySelectorAll('#h-monthly-box .heat-month-cell') || []);
        const withData = cells.filter(c => Number(c.getAttribute('data-tokens') || 0) > 0 && !c.classList.contains('is-future'));
        const pick = withData.length > 0 ? withData[withData.length - 1] : cells[0];
        return pick?.getAttribute('data-date') || null;
      })()
    `);
    if (activeMonthDate) {
      await realHover(`#h-monthly-box .heat-month-cell[data-date="${activeMonthDate}"]`, {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.read,
        expectTooltip: '#heat-pop'
      });
    }

    // 翻页操作：仅在按钮可用时展示 1 次向前与向后翻页
    const canPagePrev = await evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-page-prev')?.disabled`);
    if (canPagePrev) {
      await realClick('#h-page-prev', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.inspect });
      const canPageNext = await evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-page-next')?.disabled`);
      if (canPageNext) {
        await realClick('#h-page-next', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.inspect });
      }
    }

    // 5. 今年视图 (#h-tab-yearly)：展示年度月份气泡提示与订阅性价比
    await realClick('#h-tab-yearly', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-yearly-box')?.style.display !== 'none'`)
    });
    const peakBubbleIdx = await evaluate(`
      (() => {
        const sr = document.getElementById('ag-context-meter')?.shadowRoot;
        const groups = Array.from(sr?.querySelectorAll('#h-yearly-box .heat-yearly-bubble-group') || []);
        let bestIdx = -1;
        let maxR = -1;
        groups.forEach((g, idx) => {
          const c = g.querySelector('circle.bubble-main');
          const r = parseFloat(c?.getAttribute('r') || '0');
          const fill = c?.getAttribute('fill') || '';
          if (fill !== 'transparent' && r >= maxR) {
            maxR = r;
            bestIdx = idx + 1;
          }
        });
        return bestIdx > 0 ? bestIdx : null;
      })()
    `);
    if (peakBubbleIdx) {
      await realHover(`#h-yearly-box .heat-yearly-bubble-group:nth-child(${peakBubbleIdx})`, {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.read,
        expectTooltip: '#heat-pop'
      });
    }
    const hasSubRatio = await evaluate(`
      (() => {
        const w = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-sum-sub-ratio-wrap');
        return Boolean(w && window.getComputedStyle(w).display !== 'none');
      })()
    `);
    if (hasSubRatio) {
      await realHover('#h-sum-sub-ratio-wrap', { moveMs: TIMINGS.move.standard, holdMs: TIMINGS.hold.read });
    } else {
      await realHover('#h-summary-bar', { moveMs: TIMINGS.move.standard, holdMs: TIMINGS.hold.inspect });
    }

    // 6. 累计总量视图 (#h-tab-cum)：展示累计趋势曲线与区间合计
    await realClick('#h-tab-cum', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-cum-box')?.style.display !== 'none'`)
    });
    await realHover('#h-cum-canvas', {
      moveMs: TIMINGS.move.standard,
      offsetX: 80,
      holdMs: TIMINGS.hold.read,
      expectTooltip: '#heat-pop'
    });

    // 恢复至每天视图，方便后续场景衔接
    await realClick('#h-tab-daily', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#h-tab-daily')?.classList.contains('active')`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 3, name: 'Token统计与图表', durationSec: dur });
    writeLog(`[Scene 3] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 4: 来源筛选 (切换全部 / 桌面端 / CLI，展示对应统计变化后恢复)
  // =========================================================================
  async function scene4_SourceFilter() {
    const t0 = Date.now();
    console.log('▶ [场景 4/9] 来源筛选：切换桌面端 -> CLI -> 全部来源，展示统计与热力图数据变化');
    writeLog('[Scene 4] 开始');

    await ensureTokensPanelOpen();

    // 1. 切换到「桌面端」来源，停留展示统计卡片与热力图变化
    await realClick('#src-tab-desktop', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#src-tab-desktop')?.classList.contains('active')`)
    });

    // 2. 切换到「CLI」来源，停留展示 CLI 独立统计
    await realClick('#src-tab-cli', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#src-tab-cli')?.classList.contains('active')`)
    });

    // 3. 切回「全部」来源，为后续演示保持最完整的数据集
    await realClick('#src-tab-all', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#src-tab-all')?.classList.contains('active')`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 4, name: '来源筛选', durationSec: dur });
    writeLog(`[Scene 4] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 5: 国家、订阅地区与币种 (下拉搜索与选择 -> 价格/币种变化 -> 自定义订阅示例)
  // =========================================================================
  async function scene5_CountryAndSubscription() {
    const t0 = Date.now();
    console.log('▶ [场景 5/9] 国家、订阅地区与币种：下拉搜索选择 -> 价格币种联动 -> 自定义订阅设置示例');
    writeLog('[Scene 5] 开始');

    await ensureTokensPanelOpen();

    // 确保订阅详情面板展开
    const isPlanExpanded = await evaluate(`
      (() => {
        const card = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#plan-detail-card');
        return Boolean(card && card.style.display !== 'none');
      })()
    `);
    if (!isPlanExpanded) {
      await realClick('#btn-plan-detail-toggle', {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#plan-detail-card')?.style.display !== 'none'`)
      });
    }

    // 1. 账号所在地区下拉菜单：点击展开 -> 搜索框输入 "JP" -> 选择匹配项
    await realClick('#direct-country-trigger', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#direct-country-wrap')?.classList.contains('is-open')`)
    });
    await realTypeInInput('#direct-country-menu .ag-dropdown-search-input', 'JP', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect
    });
    await realClick('#direct-country-menu .ag-dropdown-item', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#direct-country-wrap')?.classList.contains('is-open')`)
    });

    // 2. 订阅国家下拉菜单：点击展开 -> 搜索框输入 "KR" -> 选择韩国并展示价格与币种联动变化
    await realClick('#direct-region-trigger', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#direct-region-wrap')?.classList.contains('is-open')`)
    });
    await realTypeInInput('#direct-region-menu .ag-dropdown-search-input', 'KR', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect
    });
    await realClick('#direct-region-menu .ag-dropdown-item', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#direct-region-wrap')?.classList.contains('is-open')`)
    });

    // 3. 展示联动更新后的订阅币种标签与顶栏价格折算胶囊
    await realHover('#direct-currency-trigger', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect
    });
    await realHover('#plan-summary-price-badge', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read
    });

    // 4. 展开「自定义订阅设置」表单，使用非敏感示例展示操作
    await realClick('#btn-edit-plan-custom', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#plan-custom-form')?.style.display !== 'none'`)
    });
    await realTypeInInput('#input-custom-acq-name', 'Pixel 11 Pro 赠送示例', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect
    });
    await realHover('#input-custom-paid', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect
    });

    // 5. 取消表单编辑并收起订阅详情卡片
    await realClick('#btn-custom-plan-cancel', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#plan-custom-form')?.style.display === 'none'`)
    });
    await realClick('#btn-plan-detail-collapse', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#plan-detail-card')?.style.display === 'none'`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 5, name: '国家、订阅地区与币种', durationSec: dur });
    writeLog(`[Scene 5] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 6: API 参考金额 (金额视图 -> 范围与估算方式切换 -> 输入/缓存/输出三栏明细)
  // =========================================================================
  async function scene6_ApiCostBreakdown() {
    const t0 = Date.now();
    console.log('▶ [场景 6/9] API 参考金额：金额视图 -> 统计范围与估值模式切换 -> 输入/缓存/输出三栏明细');
    writeLog('[Scene 6] 开始');

    await ensureTokensPanelOpen();

    // 1. 切换至「API 参考金额」视图
    await realClick('#tok-view-cost', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-estimate-card')?.style.display !== 'none'`)
    });

    // 2. 展示主要参考金额及「API折算 · 非实付」说明标识
    await realHover('#cost-non-paid-badge', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read
    });

    // 3. 展开费用详情面板
    await realClick('#btn-cost-details-toggle', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-details-pane')?.style.display !== 'none'`)
    });

    // 4. 切换统计范围：全量历史 <-> 本期
    await realClick('#cost-btn-scope-all', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-btn-scope-all')?.classList.contains('active')`)
    });
    await realClick('#cost-btn-scope-period', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-btn-scope-period')?.classList.contains('active')`)
    });

    // 5. 切换估值模式：混合模式 -> 仅已识别模型 -> 参考模型估算
    await realClick('#cost-btn-mode-hybrid', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-btn-mode-hybrid')?.classList.contains('active')`)
    });
    await realClick('#cost-btn-mode-identified', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-btn-mode-identified')?.classList.contains('active')`)
    });
    await realClick('#cost-btn-mode-ref', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-btn-mode-ref')?.classList.contains('active')`)
    });

    // 6. 依次展示输入、缓存读取、输出三栏明细卡片
    await realHover('#ref-cost-input-val', { moveMs: TIMINGS.move.standard, holdMs: TIMINGS.hold.inspect });
    await realHover('#ref-cost-cache-val', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.inspect });
    await realHover('#ref-cost-output-val', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.read });

    // 7. 收起详情并切回 Token 统计视图
    await realClick('#btn-cost-details-collapse', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#cost-details-pane')?.style.display === 'none'`)
    });
    await realClick('#tok-view-tokens', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#tokens-main-view')?.style.display !== 'none'`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 6, name: 'API参考金额', durationSec: dur });
    writeLog(`[Scene 6] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 7: 外观与主题 (色阶预设切换 -> 打开单档调色盘实际改色展示结果 -> 深浅主题切换与恢复)
  // =========================================================================
  async function scene7_ThemeAndPalette() {
    const t0 = Date.now();
    console.log('▶ [场景 7/9] 外观与主题：色阶预设切换 -> 单档调色盘实际改色与结果展示 -> 深浅主题切换');
    writeLog('[Scene 7] 开始');

    await ensureTokensPanelOpen();

    // 确保在 Token 统计主视图
    const inTokensView = await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#tokens-main-view')?.style.display !== 'none'`);
    if (!inTokensView) {
      await realClick('#tok-view-tokens', {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.transition,
        expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#tokens-main-view')?.style.display !== 'none'`)
      });
    }

    // 1. 展开热力图色阶与面板外观自定义抽屉
    const isPaletteOpen = await evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#token-color-drawer-body')?.style.display !== 'none'`);
    if (!isPaletteOpen) {
      await realClick('#btn-panel-tokens-palette', {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#token-color-drawer-body')?.style.display !== 'none'`)
      });
    }

    // 2. 切换有代表性的热力图预设 (绿色系 -> 黄色系 -> 蓝色系)，每次停留展示热力图颜色变化
    await realClick('.heat-preset-btn[data-heat-preset="green"]', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('.heat-preset-btn[data-heat-preset="green"]')?.getAttribute('data-active') === 'true'`)
    });
    await realClick('.heat-preset-btn[data-heat-preset="yellow"]', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('.heat-preset-btn[data-heat-preset="yellow"]')?.getAttribute('data-active') === 'true'`)
    });
    await realClick('.heat-preset-btn[data-heat-preset="blue"]', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('.heat-preset-btn[data-heat-preset="blue"]')?.getAttribute('data-active') === 'true'`)
    });

    // 3. 打开第 5 档单档调色盘 (#heat-leg-4)，实际修改颜色并展示热力图与色块变化结果
    await realClick('#heat-leg-4', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.inspect,
      expectedState: async () => evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#color-picker-popover')?.hidden`)
    });

    // 在调色盘内真实点击预设色点 (#ef4444 珊瑚红) 与 (#22c55e 翠绿)，并点击色相条展示实时调色结果
    await realClick('.cp-preset-dot[data-cp-hex="#ef4444"]', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read
    });
    await realClick('#cp-hue-wrap', {
      moveMs: TIMINGS.move.snappy,
      offsetX: -30,
      holdMs: TIMINGS.hold.read
    });

    // 关闭单档调色盘
    await realClick('#cp-close', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`Boolean(document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#color-picker-popover')?.hidden)`)
    });

    // 恢复 5 档预设并收起调色抽屉
    await realClick('#reset-heat-lvls', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.transition });
    await realClick('.heat-preset-btn[data-heat-preset="purple"]', { moveMs: TIMINGS.move.snappy, holdMs: TIMINGS.hold.transition });
    await realClick('#btn-toggle-token-colors', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#token-color-drawer-body')?.style.display === 'none'`)
    });
    await smoothScrollPanelBy('#panel-tokens', -600, 260, 150);

    // 4. 展示深浅主题切换，最后恢复原主题设置
    const initialThemeAttr = await evaluate(`document.getElementById('ag-context-meter')?.getAttribute('data-theme')`);
    await realClick('#theme-toggle-tokens', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.read
    });
    await realClick('#theme-toggle-tokens', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.read
    });
    // 确保主题回到初始状态 (light / dark / auto 三态循环)
    const afterThemeAttr = await evaluate(`document.getElementById('ag-context-meter')?.getAttribute('data-theme')`);
    if (afterThemeAttr !== initialThemeAttr) {
      await realClick('#theme-toggle-tokens', {
        moveMs: TIMINGS.move.snappy,
        holdMs: TIMINGS.hold.inspect
      });
    }

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 7, name: '外观与主题', durationSec: dur });
    writeLog(`[Scene 7] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 8: 更新检查 (单独展示检查入口与真实结果 -> 合理超时报告 -> 不执行真实升级)
  // =========================================================================
  async function scene8_UpdateCheck() {
    const t0 = Date.now();
    console.log('▶ [场景 8/9] 更新检查：点击检查更新入口 -> 等待并展示真实检测结果 -> 关闭浮层');
    writeLog('[Scene 8] 开始');

    await ensureTokensPanelOpen();

    // 1. 点击面板右上角检查插件更新按钮 (#btn-check-update)
    await realClick('#btn-check-update', {
      moveMs: TIMINGS.move.standard,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#update-popover')?.style.display !== 'none'`)
    });

    // 2. 等待真实网络检测结果返回 (不无限等待，超出合理时间明确报告)
    const updateReady = await waitForCondition(async () => {
      return await evaluate(`
        (() => {
          const body = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#up-pop-body');
          const txt = body?.textContent?.trim() || '';
          return txt.length > 0 && !txt.includes('正在检测最新版本');
        })()
      `);
    }, TIMINGS.timeout.update, '在线更新网络检查返回');

    if (!updateReady) {
      console.log(`   ⚠️ [更新检查提示] 网络请求超出 ${TIMINGS.timeout.update}ms 未返回最终结果，已按超时保护继续。`);
      writeLog(`更新检查网络等待超出 ${TIMINGS.timeout.update}ms，触发超时报告`);
    }

    // 鼠标停留在更新浮层旁展示真实结果 (不点击立即更新)
    await realHover('#up-pop-body', {
      moveMs: TIMINGS.move.snappy,
      offsetX: 60,
      holdMs: TIMINGS.hold.read
    });

    // 3. 关闭更新浮层
    await realClick('#btn-close-update-pop', {
      moveMs: TIMINGS.move.snappy,
      holdMs: TIMINGS.hold.transition,
      expectedState: async () => evaluate(`document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#update-popover')?.style.display === 'none'`)
    });

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 8, name: '更新检查', durationSec: dur });
    writeLog(`[Scene 8] 完成 (${dur}s)`);
  }

  // =========================================================================
  // 场景 9: CLI 启动与最终收尾 (必须为最后功能：点击顶栏 CLI -> 启动完成 -> 真实点击关闭终端 -> 回到全景)
  // =========================================================================
  async function scene9_CliLaunchAndFinalRestoration() {
    const t0 = Date.now();
    console.log('▶ [场景 9/9] CLI 启动与最终收尾：顶栏点击启动 CLI -> 等待终端启动完成 -> 真实点击关闭终端 -> 恢复 Antigravity 完整窗口全景');
    writeLog('[Scene 9] 开始');

    // 1. 若 Token 面板打开，先真实点击关闭按钮收起面板，使顶栏入口清晰可见
    const isTokensOpen = await evaluate(`!document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel-tokens')?.hidden`);
    if (isTokensOpen) {
      await realClick('#close-tokens', {
        moveMs: TIMINGS.move.standard,
        holdMs: TIMINGS.hold.inspect,
        expectedState: async () => evaluate(`Boolean(document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#panel-tokens')?.hidden)`)
      });
    } else {
      await resetPanelsClean();
    }

    // 2. 记录点击前已存在的终端窗口句柄集合，确保只关闭本次演示启动的终端窗口
    const beforeTermsRaw = await mouse.getAllTerminals();
    const cleanBeforeList = (beforeTermsRaw.replace(/^TERMS\s*/, '') || '').trim();
    const probeFile = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'AntigravityContextMeter',
      'last-cli-cwd.txt'
    );
    const beforeProbeMtime = fs.existsSync(probeFile) ? fs.statSync(probeFile).mtimeMs : 0;

    // 3. 将鼠标自然移动到 Antigravity 顶栏 CLI 入口 (#badge-cli)，真实点击
    await realHover('#badge-cli', { moveMs: TIMINGS.move.standard, holdMs: TIMINGS.hold.transition });

    if (isDryRun) {
      console.log('   🧪 [Dry-Run 演练模式] 已验证 #badge-cli 可见可点击，跳过实际拉起外部终端进程。');
      writeLog('[Scene 9] Dry-Run 跳过实际启动终端');
    } else {
      const privateCli = await preparePrivateCli();
      if (privateCli) await evaluate(`(() => {
        const button = document.getElementById('ag-context-meter')?.shadowRoot?.querySelector('#badge-cli');
        const handler = event => {
          event.stopImmediatePropagation();
          const context = window.__AGContextMeter?.snapshot?.() || {};
          window.__demoPrivateCliLaunch = window.contextMeterAPI.launchCli({
            cliPath: ${JSON.stringify(privateCli)}, cascadeId: context.route || undefined,
            cwd: context.scan?.workspacePath || undefined
          });
        };
        window.__demoPrivateCliHandler = handler;
        button.addEventListener('click', handler, { capture: true });
      })()`);
      await realClick('#badge-cli', {
        moveMs: TIMINGS.move.micro,
        holdMs: TIMINGS.hold.transition,
        expectedState: privateCli ? async () => evaluate('Boolean(window.__demoPrivateCliLaunch)') : null
      });
      if (privateCli) {
        const launch = await evaluate('window.__demoPrivateCliLaunch');
        if (!launch?.ok) throw new Error('CLI 隐私启动失败，未回退到普通窗口');
      }

      // 4. 等待本次启动的 CLI 终端窗口实际出现并完成启动 (同时监测新增窗口句柄与 probeFile 就绪)
      console.log('   ⏳ 等待本次启动的 CLI 终端窗口实际出现并完成初始化...');
      let termInfo = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < TIMINGS.timeout.terminal) {
        const probe = await mouse.findNewTerminal(cleanBeforeList);
        if (probe && probe.startsWith('TERMINAL ')) {
          const parts = probe.split(' ');
          termInfo = {
            hwnd: parts[1],
            left: Number(parts[2]),
            top: Number(parts[3]),
            right: Number(parts[4]),
            bottom: Number(parts[5]),
            closeX: Number(parts[6]),
            closeY: Number(parts[7])
          };
          // 进一步等待 runner 脚本写入工作目录探针并加载 agy 界面
          const probeUpdated = fs.existsSync(probeFile) && fs.statSync(probeFile).mtimeMs > beforeProbeMtime;
          if (probeUpdated || Date.now() - waitStart > 1800) {
            break;
          }
        }
        await sleep(120);
      }

      if (termInfo) {
        writeLog(`检测到本次启动的 CLI 终端窗口: HWND=${termInfo.hwnd}, 关闭按钮物理坐标=(${termInfo.closeX}, ${termInfo.closeY})`);
        // 工作目录探针只代表 runner 已启动，不能据此认定登录成功.
        console.log('   ⏳ 等待 CLI 登录完成画面（最长 90 秒）...');
        const loginStart = Date.now();
        let readySince = 0;
        let loginReady = false;
        while (Date.now() - loginStart < TIMINGS.timeout.cliLogin) {
          if (await mouse.checkWindowAlive(termInfo.hwnd) !== 'ALIVE') {
            throw new Error('CLI 登录完成前窗口已关闭，未执行自动关闭.');
          }
          const terminalText = await mouse.readTerminal(termInfo.hwnd);
          if (privacyMode && terminalText.includes(backupSnapshot.email)) throw new Error('隐私检查失败: 终端仍包含真实账号，停止演示');
          if (cliLoginComplete(terminalText)) {
            if (!readySince) readySince = Date.now();
            if (Date.now() - readySince >= 2000) { loginReady = true; break; }
          } else {
            readySince = 0;
          }
          await sleep(500);
        }
        if (!loginReady) {
          throw new Error('90 秒内未读到 CLI 登录成功画面（或终端文本不可读），保留本次终端，不提前关闭.');
        }
        writeLog('CLI 登录完成画面已连续确认 2 秒，展示 4 秒后关闭（不记录终端账号文本）');
        if (privacyMode) writeLog('CLI 隐私检查通过: 真实账号未出现在终端可读画面');
        await sleep(TIMINGS.hold.cliReady);

        // 5. 鼠标平滑移动到该终端窗口右上角的关闭按钮，真实点击关闭
        console.log('   🎯 鼠标移动到 CLI 终端窗口关闭按钮并真实点击关闭...');
        await mouse.move(termInfo.closeX, termInfo.closeY, TIMINGS.move.calm);
        await sleep(80);
        await mouse.click();

        // 验证该终端窗口是否已关闭
        const closedQuickly = await waitForCondition(async () => {
          const st = await mouse.checkWindowAlive(termInfo.hwnd);
          return st === 'CLOSED';
        }, 1000, 'CLI 终端窗口关闭确认');

        if (!closedQuickly) {
          writeLog(`右上角首次点击后窗口仍存在 (可能因 Windows Terminal 多标签确认或边框偏移)，对该 HWND 执行安全关闭收尾`);
          await mouse.closeWindowSafe(termInfo.hwnd);
          await sleep(200);
        }
      } else {
        throw new Error('未找到本次启动的 CLI 终端，无法确认登录完成，取消自动关闭.');
      }
    }

    // 6. 画面和焦点平滑回到 Antigravity 主窗口
    await mouse.focusTarget();
    await callCdp('Page.bringToFront');
    await sleep(200);

    // 7. 恢复开头的面板状态、滚动位置和构图，插件顶栏入口保持清晰可见
    await resetPanelsClean();

    // 8. 鼠标停在不遮挡内容的安全位置 (顶栏下方右侧空白区)，全景保留约 2 秒后结束
    const endVp = await evaluate(`({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })`);
    const safeEndPt = mapCssToPhysical(Math.round((endVp?.innerWidth || vpInit.innerWidth) * 0.72), 88);
    await mouse.move(safeEndPt.x, safeEndPt.y, TIMINGS.move.calm);
    await sleep(TIMINGS.hold.panoramic);

    const dur = Number(((Date.now() - t0) / 1000).toFixed(1));
    sceneStats.push({ scene: 9, name: 'CLI启动与最终收尾', durationSec: dur });
    writeLog(`[Scene 9] 完成 (${dur}s)`);
  }

  const SCENE_MAP = {
    '1': { name: '顶栏与上下文', fn: scene1_ContextAndSpeed },
    '2': { name: '技术参数与附件', fn: scene2_TechSpecsAndAttachments },
    '3': { name: 'Token统计与图表', fn: scene3_TokensAndHeatmap },
    '4': { name: '来源筛选', fn: scene4_SourceFilter },
    '5': { name: '国家、订阅地区与币种', fn: scene5_CountryAndSubscription },
    '6': { name: 'API参考金额', fn: scene6_ApiCostBreakdown },
    '7': { name: '外观与主题', fn: scene7_ThemeAndPalette },
    '8': { name: '更新检查', fn: scene8_UpdateCheck },
    '9': { name: 'CLI启动与最终收尾', fn: scene9_CliLaunchAndFinalRestoration }
  };

  try {
    if (SCENE_MAP[argScene]) {
      console.log(`\n🎬 [开始单段录制] 场景 #${argScene}: ${SCENE_MAP[argScene].name}\n`);
      await SCENE_MAP[argScene].fn();
    } else if (argScene === 'all') {
      console.log('\n🎬 [开始完整连录] 按顺序连续执行全部 9 个演示场景...\n');
      for (let s = 1; s <= 9; s++) {
        await SCENE_MAP[String(s)].fn();
      }
    } else {
      throw new Error(`未知的场景参数 "${argScene}"，支持参数: all 或 1~9`);
    }
  } catch (err) {
    console.error(`\n❌ 演示执行失败: ${err.message}`);
    writeLog(`执行异常中断: ${err.stack || err.message}`);
    await cleanupAndExit(1);
    return;
  }

  const totalDurationSec = Number(((Date.now() - overallStartTime) / 1000).toFixed(1));
  try {
    fs.writeFileSync(
      summaryJsonFile,
      JSON.stringify({ mode: argScene, isDryRun, totalDurationSec, scenes: sceneStats, logFile: runLogFile }, null, 2),
      'utf8'
    );
  } catch {}

  console.log('\n================================================================');
  console.log(`🎉 [演示录制完成] 实测总时长: ${totalDurationSec}s`);
  for (const item of sceneStats) {
    console.log(`   - 场景 ${item.scene} (${item.name}): ${item.durationSec}s`);
  }
  console.log(`📄 运行日志: ${runLogFile}`);
  console.log(`📊 耗时统计: ${summaryJsonFile}`);
  console.log('💡 说明: 脚本已将焦点、面板构图与顶栏入口恢复至开场全景状态；Recordly 镜头缩放回拉由录制工具自动缩放或后期合成完成。');
  console.log('================================================================');

  await cleanupAndExit(0);
}

main().catch(err => {
  console.error('❌ 致命错误:', err.message);
  process.exit(1);
});
