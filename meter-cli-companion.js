'use strict';

/**
 * Antigravity Context Meter - CLI 终端伴随监视守护模块 (meter-cli-companion.js)
 * 伴随 agy 终端会话运行，实时在控制台窗口标题栏刷新当前会话上下文读数
 * 精准绑定当前终端对应的会话，绑定未建立时显示等待提示，绝不借用其他会话读数
 * 当 agy 进程退出或被中断时，自动清理并恢复原控制台标题，绝不残留孤儿进程
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { scanCliSessions, formatCliStatusLine } = require('./meter-cli-monitor');
const { getStateDir } = require('./asar-engine');

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessRegistryPath(stateDir = null) {
  const dir = stateDir || getStateDir();
  return path.join(dir, '.cli-process-sessions.json');
}

function readProcessRegistry(stateDir = null) {
  try {
    const regPath = getProcessRegistryPath(stateDir);
    if (!fs.existsSync(regPath)) return {};
    return JSON.parse(fs.readFileSync(regPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function recordProcessSessionBinding({ pid, sessionId, cwd = null, stateDir = null }) {
  if (!pid || !sessionId) return;
  try {
    const regPath = getProcessRegistryPath(stateDir);
    fs.mkdirSync(path.dirname(regPath), { recursive: true });
    const reg = readProcessRegistry(stateDir);
    // 清理已死进程的旧记录
    for (const p of Object.keys(reg)) {
      if (!isPidAlive(p)) delete reg[p];
    }
    reg[String(pid)] = {
      pid: Number(pid),
      sessionId: String(sessionId).trim(),
      cwd: cwd ? path.resolve(cwd) : null,
      updatedAt: Date.now()
    };
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  } catch {}
}

function getProcessSessionBinding(pid, { stateDir = null } = {}) {
  if (!pid) return null;
  const reg = readProcessRegistry(stateDir);
  return reg[String(pid)] || null;
}

function removeProcessSessionBinding(pid, { stateDir = null } = {}) {
  if (!pid) return;
  try {
    const regPath = getProcessRegistryPath(stateDir);
    if (!fs.existsSync(regPath)) return;
    const reg = readProcessRegistry(stateDir);
    if (reg[String(pid)]) {
      delete reg[String(pid)];
      fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    }
  } catch {}
}

function setTerminalTitle(title) {
  if (!title) return;
  try {
    // 优先采用 ANSI OSC 0 转义序列（Windows 10/11 控制台、Windows Terminal 及各类终端原生支持）
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${title}\x07`);
    } else if (process.stderr.isTTY) {
      process.stderr.write(`\x1b]0;${title}\x07`);
    } else if (process.platform === 'win32') {
      // 备用兼容方案：非 TTY 管道环境通过 cmd title 刷新窗口标题
      spawnSync('cmd.exe', ['/c', 'title', title], { stdio: 'ignore', windowsHide: true, timeout: 1000 });
    }
  } catch {}
}

function parseCompanionArgs(argv = process.argv.slice(2)) {
  const opts = {
    targetPid: null,
    parentPid: null,
    cwd: process.cwd(),
    interval: 1000,
    stateDir: null,
    agCliDir: null,
    agDir: null,
    once: false,
    runTarget: null,
    runArgs: []
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run' && i + 1 < argv.length) {
      opts.runTarget = argv[++i];
      opts.runArgs = argv.slice(i + 1);
      break;
    } else if (a === '--target-pid' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) opts.targetPid = n;
    } else if (a === '--parent-pid' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) opts.parentPid = n;
    } else if (a === '--cwd' && i + 1 < argv.length) {
      opts.cwd = argv[++i];
    } else if (a === '--interval' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n >= 200) opts.interval = n;
    } else if (a === '--state-dir' && i + 1 < argv.length) {
      opts.stateDir = argv[++i];
    } else if (a === '--ag-cli-dir' && i + 1 < argv.length) {
      opts.agCliDir = argv[++i];
    } else if (a === '--ag-dir' && i + 1 < argv.length) {
      opts.agDir = argv[++i];
    } else if (a === '--once') {
      opts.once = true;
    }
  }

  return opts;
}

/**
 * 精准绑定当前终端专属会话：
 * 1. 优先通过 PID 注册表查找属于 targetPid 的绑定会话；
 * 2. 查找在当前进程启动时间 (startTime) 之后激活且属于当前工作区的会话；
 * 3. 绑定尚未建立时严格返回 null，绝不借用其他会话的数字！
 */
function resolveSessionForCwd(scan, cwd, options = {}) {
  if (!scan || !Array.isArray(scan.sessions) || scan.sessions.length === 0) {
    return null;
  }

  const targetPid = options.targetPid || null;
  const stateDir = options.stateDir || null;
  const startTime = options.startTime || 0;

  // 1. 优先根据 PID 注册表精确绑定（兼容 targetPid 与 companionPid 跨子壳层传递）
  const pidCandidates = [targetPid, options.companionPid].filter(Boolean);
  for (const pidCand of pidCandidates) {
    const binding = getProcessSessionBinding(pidCand, { stateDir });
    if (binding && binding.sessionId) {
      const matched = scan.sessions.find(s => s.sessionId === binding.sessionId);
      if (matched) return matched;
    }
  }

  // 2. 若指定了工作区，且存在在启动之后被激活更新的新会话
  const normTarget = cwd ? path.resolve(cwd).toLowerCase() : null;
  if (normTarget && startTime > 0) {
    // 找出属于当前工作区且在启动后有活动的会话
    const candidates = scan.sessions.filter(s => {
      const sameCwd = s.cwd && path.resolve(s.cwd).toLowerCase() === normTarget;
      const activeAfterStart = s.lastActiveMs >= (startTime - 3000);
      return sameCwd && activeAfterStart;
    });

    if (candidates.length === 1) {
      // 仅当唯一确切匹配时绑定，并持久化至进程注册表
      const s = candidates[0];
      if (targetPid) {
        recordProcessSessionBinding({ pid: targetPid, sessionId: s.sessionId, cwd, stateDir });
      }
      return s;
    }
  }

  // 严格安全保护：绑定尚未建立时返回 null，绝不随意回退到 scan.sessions[0]！
  return null;
}

function runCompanion(options = {}) {
  const opts = { ...parseCompanionArgs(), ...options };

  // 若以 --run 模式执行，则作为主控包装器启动目标二进制，精准托管生命周期
  if (opts.runTarget) {
    return runAsWrapper(opts);
  }

  return runAsWatcher(opts);
}

function runAsWrapper(opts) {
  const startTime = Date.now();
  let originalTitleRestored = false;
  let timer = null;

  const restoreTitle = () => {
    if (originalTitleRestored) return;
    originalTitleRestored = true;
    setTerminalTitle('Antigravity CLI');
  };

  // 设置启动初期的临时标题，提示等待会话就绪
  setTerminalTitle('◔ 上下文: 等待当前会话就绪… | agy');

  // 启动目标二进制，stdio: 'inherit' 原生保留所有控制台交互与颜色；透传 AG_METER_COMPANION_PID 供 statusline 跨子壳层绑定同一会话
  const child = spawn(opts.runTarget, opts.runArgs, {
    stdio: 'inherit',
    cwd: opts.cwd,
    env: {
      ...process.env,
      AG_METER_COMPANION_PID: String(process.pid)
    },
    windowsHide: false
  });

  const targetPid = child.pid;

  // 若命令行参数中显式指定了 --conversation，立即记录与 targetPid / companionPid 的预绑定关系，首屏直接对齐对应会话
  if (targetPid && opts.runArgs && opts.runArgs.includes('--conversation')) {
    const cIdx = opts.runArgs.indexOf('--conversation');
    const resumeId = opts.runArgs[cIdx + 1];
    if (resumeId) {
      recordProcessSessionBinding({
        pid: targetPid,
        sessionId: String(resumeId).trim(),
        cwd: opts.cwd,
        stateDir: opts.stateDir
      });
      recordProcessSessionBinding({
        pid: process.pid,
        sessionId: String(resumeId).trim(),
        cwd: opts.cwd,
        stateDir: opts.stateDir
      });
    }
  }

  const cleanup = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (targetPid) {
      removeProcessSessionBinding(targetPid, { stateDir: opts.stateDir });
    }
    removeProcessSessionBinding(process.pid, { stateDir: opts.stateDir });
    restoreTitle();
  };

  const tick = () => {
    if (!isPidAlive(targetPid)) {
      cleanup();
      return;
    }
    try {
      const scan = scanCliSessions({
        stateDir: opts.stateDir,
        agCliDir: opts.agCliDir,
        agDir: opts.agDir
      });
      const session = resolveSessionForCwd(scan, opts.cwd, {
        targetPid,
        companionPid: process.pid,
        stateDir: opts.stateDir,
        startTime
      });
      if (session) {
        const line = formatCliStatusLine(session, { columns: 100 });
        setTerminalTitle(`${line} | agy`);
      } else {
        setTerminalTitle('◔ 上下文: 等待当前会话就绪… | agy');
      }
    } catch {}
  };

  // 启动后尽快尝试一次刷新，并保持周期刷新
  setTimeout(tick, 300).unref?.();
  timer = setInterval(tick, opts.interval);

  child.on('exit', (code, signal) => {
    cleanup();
    const exitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
    process.exit(exitCode);
  });

  child.on('error', (err) => {
    cleanup();
    console.error('❌ 启动 agy 失败:', err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    // 信号已通过 inherit 发往子进程，等待子进程退出
  });
  process.on('SIGTERM', () => {
    try { child.kill('SIGTERM'); } catch {}
  });

  return { child, stop: cleanup, tick };
}

function runAsWatcher(opts) {
  const startTime = Date.now();
  let timer = null;
  let running = true;
  let originalTitleRestored = false;

  const restoreTitle = () => {
    if (originalTitleRestored) return;
    originalTitleRestored = true;
    setTerminalTitle('Antigravity CLI');
  };

  const cleanup = () => {
    if (!running) return;
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (opts.targetPid) {
      removeProcessSessionBinding(opts.targetPid, { stateDir: opts.stateDir });
    }
    restoreTitle();
  };

  const tick = () => {
    // 检查宿主进程存活：若指定了 targetPid 或 parentPid 且目标进程已退出，立即自毁退出
    if (opts.targetPid && !isPidAlive(opts.targetPid)) {
      cleanup();
      process.exit(0);
    }
    if (opts.parentPid && !isPidAlive(opts.parentPid)) {
      cleanup();
      process.exit(0);
    }

    try {
      const scan = scanCliSessions({
        stateDir: opts.stateDir,
        agCliDir: opts.agCliDir,
        agDir: opts.agDir
      });
      const session = resolveSessionForCwd(scan, opts.cwd, {
        targetPid: opts.targetPid || opts.parentPid,
        stateDir: opts.stateDir,
        startTime
      });
      if (session) {
        const line = formatCliStatusLine(session, { columns: 80 });
        setTerminalTitle(`${line} | agy`);
      } else {
        setTerminalTitle('◔ 上下文: 等待当前会话就绪… | agy');
      }
    } catch {}

    if (opts.once) {
      cleanup();
    }
  };

  // 立即触发首次刷新
  tick();

  if (!opts.once) {
    // 保持事件循环活跃：绝不调用 unref()，确保持续跨周期轮询
    timer = setInterval(tick, opts.interval);

    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', () => { restoreTitle(); });
  }

  return { stop: cleanup, tick };
}

if (require.main === module) {
  runCompanion();
}

module.exports = {
  isPidAlive,
  setTerminalTitle,
  parseCompanionArgs,
  recordProcessSessionBinding,
  getProcessSessionBinding,
  removeProcessSessionBinding,
  resolveSessionForCwd,
  runCompanion
};
