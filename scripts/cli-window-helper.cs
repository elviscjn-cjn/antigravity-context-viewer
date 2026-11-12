using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class Program {
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

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    delegate bool EnumDesktopWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point pt, uint dwFlags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point lpPoint);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo lpmi);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);

    static readonly IntPtr HWND_TOPMOST = (IntPtr)(-1);
    static readonly IntPtr HWND_NOTOPMOST = (IntPtr)(-2);
    const uint SWP_SHOWWINDOW = 0x0040;
    const int SW_RESTORE = 9;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint GENERIC_ALL = 0x10000000;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint GA_ROOT = 2;

    static string EscapeJson(string str) {
        if (str == null) return "";
        return str.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
    }

    static bool IsProcessTreeRelated(uint windowPid, uint launchedPid) {
        if (windowPid == 0 || launchedPid == 0) return false;
        if (windowPid == launchedPid) return true;

        var parentMap = new Dictionary<uint, uint>();
        IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snap != IntPtr.Zero && snap.ToInt64() != -1) {
            PROCESSENTRY32 pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snap, ref pe)) {
                do {
                    parentMap[pe.th32ProcessID] = pe.th32ParentProcessID;
                } while (Process32Next(snap, ref pe));
            }
            CloseHandle(snap);
        }

        // 向上追溯 launchedPid 的父进程链（如 cmd.exe -> OpenConsole.exe -> WindowsTerminal.exe）
        uint curr = launchedPid;
        int depth = 0;
        while (curr != 0 && parentMap.ContainsKey(curr) && depth < 10) {
            uint parent = parentMap[curr];
            if (parent == windowPid) return true;
            curr = parent;
            depth++;
        }

        // 向上追溯 windowPid（如窗口进程是 launchedPid 的子进程）
        curr = windowPid;
        depth = 0;
        while (curr != 0 && parentMap.ContainsKey(curr) && depth < 10) {
            uint parent = parentMap[curr];
            if (parent == launchedPid) return true;
            curr = parent;
            depth++;
        }

        return false;
    }

    static void ForceForeground(IntPtr targetHwnd, uint targetPid) {
        try {
            AllowSetForegroundWindow((int)targetPid);
            AllowSetForegroundWindow(-1);

            // 模拟短 Alt 键脉冲解除 Windows 前台锁定超时
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

            IntPtr curFg = GetForegroundWindow();
            uint curFgPid = 0;
            uint curFgThread = GetWindowThreadProcessId(curFg, out curFgPid);
            uint myThread = GetCurrentThreadId();

            if (curFgThread != 0 && curFgThread != myThread) {
                AttachThreadInput(myThread, curFgThread, true);
            }

            if (IsIconic(targetHwnd)) {
                ShowWindow(targetHwnd, SW_RESTORE);
            }

            SetForegroundWindow(targetHwnd);
            BringWindowToTop(targetHwnd);
            SwitchToThisWindow(targetHwnd, true);

            if (curFgThread != 0 && curFgThread != myThread) {
                AttachThreadInput(myThread, curFgThread, false);
            }
        } catch {}
    }

    public static int Main(string[] args) {
        Console.OutputEncoding = Encoding.UTF8;
        IntPtr prevDpi = SetThreadDpiAwarenessContext((IntPtr)(-4));

        string runnerBat = "";
        string cwd = "";
        long ownerHwndVal = 0;
        int customWidth = 0;
        int customHeight = 0;

        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--cmd" && i + 1 < args.Length) runnerBat = args[++i];
            else if (args[i] == "--cwd" && i + 1 < args.Length) cwd = args[++i];
            else if (args[i] == "--owner" && i + 1 < args.Length) long.TryParse(args[++i], out ownerHwndVal);
            else if (args[i] == "--width" && i + 1 < args.Length) int.TryParse(args[++i], out customWidth);
            else if (args[i] == "--height" && i + 1 < args.Length) int.TryParse(args[++i], out customHeight);
        }

        if (string.IsNullOrEmpty(runnerBat) || !File.Exists(runnerBat)) {
            Console.WriteLine("{\"ok\":false,\"terminalSpawned\":false,\"error\":\"runner script not found: " + EscapeJson(runnerBat) + "\"}");
            return 1;
        }

        if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd)) {
            cwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        IntPtr hDesk = OpenDesktop("Default", 0, false, GENERIC_ALL);
        if (hDesk != IntPtr.Zero) {
            SetThreadDesktop(hDesk);
        }

        AllowSetForegroundWindow(-1);

        string sessionTag = "AGCLI_" + Guid.NewGuid().ToString("N").Substring(0, 10);

        // 1. 快照当前已存在的终端窗口（避免混淆）
        var existingHwnds = new HashSet<IntPtr>();
        EnumDesktopWindows(hDesk, (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sbClass = new StringBuilder(128);
            GetClassName(hWnd, sbClass, 128);
            string cls = sbClass.ToString();
            if (cls == "CASCADIA_HOSTING_WINDOW_CLASS" || cls == "ConsoleWindowClass") {
                existingHwnds.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);

        // 2. 启动终端 cmd
        string cmdArgs = string.Format("/d /k \"title Antigravity CLI [{0}] & \"{1}\"\"", sessionTag, runnerBat);
        ProcessStartInfo psi = new ProcessStartInfo {
            FileName = "cmd.exe",
            Arguments = cmdArgs,
            WorkingDirectory = cwd,
            UseShellExecute = true
        };

        Stopwatch sw = Stopwatch.StartNew();
        Process proc = null;
        try {
            proc = Process.Start(psi);
        } catch (Exception ex) {
            Console.WriteLine("{\"ok\":false,\"terminalSpawned\":false,\"error\":\"Process.Start failed: " + EscapeJson(ex.Message) + "\"}");
            return 2;
        }

        int launchedPid = proc != null ? proc.Id : 0;
        if (launchedPid == 0) {
            Console.WriteLine("{\"ok\":false,\"terminalSpawned\":false,\"error\":\"Process.Start returned empty PID\"}");
            return 2;
        }

        // 3. 轮询查找目标顶级可见窗口（最长 4.5 秒）
        IntPtr targetHwnd = IntPtr.Zero;
        uint targetPid = 0;
        string targetClass = "";
        string targetTitle = "";
        string matchReason = "";

        for (int i = 0; i < 90; i++) {
            Thread.Sleep(50);
            EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                StringBuilder sbClass = new StringBuilder(128);
                GetClassName(hWnd, sbClass, 128);
                string cls = sbClass.ToString();
                if (cls != "CASCADIA_HOSTING_WINDOW_CLASS" && cls != "ConsoleWindowClass") return true;

                StringBuilder sbTitle = new StringBuilder(256);
                GetWindowText(hWnd, sbTitle, 256);
                string title = sbTitle.ToString();

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);

                // 优先 1：唯一会话标识精确匹配（最强特征）
                if (title.Contains(sessionTag)) {
                    targetHwnd = hWnd;
                    targetPid = pid;
                    targetClass = cls;
                    targetTitle = title;
                    matchReason = "session_tag_match";
                    return false;
                }

                // 优先 2：新出现且具备严谨的进程树血缘关联（绝不仅凭新窗口盲目认领）
                if (!existingHwnds.Contains(hWnd) && targetHwnd == IntPtr.Zero) {
                    if (IsProcessTreeRelated(pid, (uint)launchedPid)) {
                        targetHwnd = hWnd;
                        targetPid = pid;
                        targetClass = cls;
                        targetTitle = title;
                        matchReason = "process_tree_relationship";
                    }
                }
                return true;
            }, IntPtr.Zero);

            if (targetHwnd != IntPtr.Zero && matchReason == "session_tag_match") {
                break;
            }
        }

        long findElapsedMs = sw.ElapsedMilliseconds;

        if (targetHwnd == IntPtr.Zero) {
            // 终端已创建但窗口查找超时
            Console.WriteLine(string.Format("{{\"ok\":false,\"terminalSpawned\":true,\"cliAlive\":true,\"windowLocated\":false,\"error\":\"timeout waiting for terminal window\",\"elapsedMs\":{0},\"cmdPid\":{1}}}",
                findElapsedMs, launchedPid));
            return 3;
        }

        string targetProcName = "unknown";
        try {
            targetProcName = Process.GetProcessById((int)targetPid).ProcessName;
        } catch {}

        // 4. 确定当前操作所在的显示器工作区
        Point pt;
        IntPtr hMon = IntPtr.Zero;
        if (GetCursorPos(out pt)) {
            hMon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        }
        if (hMon == IntPtr.Zero && ownerHwndVal != 0) {
            hMon = MonitorFromWindow((IntPtr)ownerHwndVal, MONITOR_DEFAULTTONEAREST);
        }
        if (hMon == IntPtr.Zero) {
            hMon = MonitorFromWindow(targetHwnd, MONITOR_DEFAULTTONEAREST);
        }

        MonitorInfo mi = new MonitorInfo();
        mi.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
        if (!GetMonitorInfo(hMon, ref mi)) {
            mi.rcWork = new Rect { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };
        }

        int workW = mi.rcWork.Right - mi.rcWork.Left;
        int workH = mi.rcWork.Bottom - mi.rcWork.Top;

        int finalW = customWidth > 0 ? customWidth : Math.Min(1100, Math.Max(700, (int)(workW * 0.65)));
        int finalH = customHeight > 0 ? customHeight : Math.Min(700, Math.Max(450, (int)(workH * 0.65)));
        finalW = Math.Min(finalW, (int)(workW * 0.90));
        finalH = Math.Min(finalH, (int)(workH * 0.90));

        int targetX = mi.rcWork.Left + (workW - finalW) / 2;
        int targetY = mi.rcWork.Top + (workH - finalH) / 2;

        if (IsIconic(targetHwnd)) {
            ShowWindow(targetHwnd, SW_RESTORE);
        }

        // 5. TOPMOST 置顶并移动到精确居中位置
        bool swp1 = SetWindowPos(targetHwnd, HWND_TOPMOST, targetX, targetY, finalW, finalH, SWP_SHOWWINDOW);

        // 6. 撤销 TOPMOST，变为普通顶层窗口（允许后续被其他正常窗口遮挡）
        bool swp2 = SetWindowPos(targetHwnd, HWND_NOTOPMOST, targetX, targetY, finalW, finalH, SWP_SHOWWINDOW);

        // 7. 强力激活前台与键盘输入焦点
        ForceForeground(targetHwnd, targetPid);

        // 8. 测量实际位置与中心偏差
        Rect actualRect;
        bool rectOk = GetWindowRect(targetHwnd, out actualRect);
        int actualW = actualRect.Right - actualRect.Left;
        int actualH = actualRect.Bottom - actualRect.Top;
        int actualCenterX = actualRect.Left + actualW / 2;
        int actualCenterY = actualRect.Top + actualH / 2;
        int workCenterX = mi.rcWork.Left + workW / 2;
        int workCenterY = mi.rcWork.Top + workH / 2;
        int deltaX = actualCenterX - workCenterX;
        int deltaY = actualCenterY - workCenterY;

        // 居中偏差容差为 25 像素
        bool isCentered = rectOk && (Math.Abs(deltaX) <= 25) && (Math.Abs(deltaY) <= 25);

        // 9. 检验前台状态（检验顶级窗口或其输入根窗口是否为目标窗口）
        Thread.Sleep(80);
        IntPtr fgHwnd1 = GetForegroundWindow();
        Thread.Sleep(150);
        IntPtr fgHwnd2 = GetForegroundWindow();

        bool isFgFinal = (fgHwnd2 == targetHwnd) || (GetAncestor(fgHwnd2, GA_ROOT) == targetHwnd);
        long totalElapsedMs = sw.ElapsedMilliseconds;

        // 10. 检查 CLI 进程存活状态
        bool cliAlive = false;
        try {
            Process p = Process.GetProcessById(launchedPid);
            cliAlive = !p.HasExited;
        } catch {}

        // 综合判定成功：API 正常、居中达标、前台激活、CLI 存活
        bool placementOk = rectOk && (swp1 || swp2) && isCentered;
        bool allOk = placementOk && isFgFinal && cliAlive;

        List<string> issues = new List<string>();
        if (!rectOk) issues.Add("GetWindowRect failed");
        if (!swp1 && !swp2) issues.Add("SetWindowPos failed");
        if (!isCentered) issues.Add(string.Format("Window not centered (dx={0}, dy={1})", deltaX, deltaY));
        if (!isFgFinal) issues.Add("Foreground activation failed");
        if (!cliAlive) issues.Add("CLI process exited prematurely");

        string errorMsg = issues.Count > 0 ? string.Join("; ", issues.ToArray()) : "";

        // 输出结构化 JSON
        string json = string.Format(
            "{{" +
            "\"ok\":{0}," +
            "\"terminalSpawned\":true," +
            "\"cliAlive\":{1}," +
            "\"windowLocated\":true," +
            "\"isCentered\":{2}," +
            "\"isForeground\":{3}," +
            "\"posSuccess\":{4}," +
            "\"error\":{5}," +
            "\"sessionTag\":\"{6}\"," +
            "\"matchReason\":\"{7}\"," +
            "\"cmdPid\":{8}," +
            "\"windowHwnd\":\"0x{9:X8}\"," +
            "\"windowHwndVal\":{10}," +
            "\"windowPid\":{11}," +
            "\"processName\":\"{12}\"," +
            "\"className\":\"{13}\"," +
            "\"title\":\"{14}\"," +
            "\"workArea\":{{\"left\":{15},\"top\":{16},\"right\":{17},\"bottom\":{18},\"width\":{19},\"height\":{20}}}," +
            "\"targetRect\":{{\"left\":{21},\"top\":{22},\"width\":{23},\"height\":{24}}}," +
            "\"actualRect\":{{\"left\":{25},\"top\":{26},\"width\":{27},\"height\":{28}}}," +
            "\"centerOffset\":{{\"dx\":{29},\"dy\":{30}}}," +
            "\"foregroundHwnd\":\"0x{31:X8}\"," +
            "\"findElapsedMs\":{32}," +
            "\"totalElapsedMs\":{33}" +
            "}}",
            allOk ? "true" : "false",
            cliAlive ? "true" : "false",
            isCentered ? "true" : "false",
            isFgFinal ? "true" : "false",
            (swp1 || swp2) ? "true" : "false",
            string.IsNullOrEmpty(errorMsg) ? "null" : "\"" + EscapeJson(errorMsg) + "\"",
            sessionTag,
            matchReason,
            launchedPid,
            targetHwnd.ToInt64(),
            targetHwnd.ToInt64(),
            targetPid,
            EscapeJson(targetProcName),
            EscapeJson(targetClass),
            EscapeJson(targetTitle),
            mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom, workW, workH,
            targetX, targetY, finalW, finalH,
            actualRect.Left, actualRect.Top, actualW, actualH,
            deltaX, deltaY,
            fgHwnd2.ToInt64(),
            findElapsedMs,
            totalElapsedMs
        );

        Console.WriteLine(json);

        if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
        if (prevDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(prevDpi);

        return allOk ? 0 : 10;
    }
}
