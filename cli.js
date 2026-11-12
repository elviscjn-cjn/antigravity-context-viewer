#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI
 * Cross-platform installer, live CDP hot-injector, and lifecycle manager
 * Format aligned with antigravity-chinese for one-command human & AI Agent execution.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { loadAsarEngine, getStateDir } = require('./asar-engine');
const { install, findAsarPath, tryHotInject } = require('./install');
const { restore } = require('./restore');
const { resolvePython } = require('./meter-collector');
const { analyzeBinary, analyzeBinaryAsync, applyUnlock, restoreUnlock, AUTHOR_INFO } = require('./meter-context-unlock');

const asar = loadAsarEngine();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function getDevToolsPort() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

async function queryLiveWindow() {
  const port = getDevToolsPort();
  if (!port) return { running: false };
  try {
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const target = pages.find(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    if (!target) return { running: true, cdpPort: port, pageFound: false };
    const origin = new URL(target.url).origin;

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('message', ev => {
        const d = JSON.parse(ev.data);
        if (d.id === 1) {
          clearTimeout(timer);
          resolve(d.result?.result?.value || null);
        }
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const s = window.__AGContextMeter?.snapshot();
            const root = document.getElementById('ag-context-meter')?.shadowRoot;
            return {
              active: Boolean(window.__AGContextMeter),
              version: window.__AGContextMeter?.version || null,
              hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli && window.contextMeterAPI?.getContextUnlockStatus),
              badgeText: root?.getElementById('amount')?.textContent || null,
              route: s?.route || null,
              latest: s?.latest || null
            };
          })()`,
          returnByValue: true
        }
      }));
    });
    ws.close();
    return { running: true, cdpPort: port, pageFound: true, origin, ...status };
  } catch (e) {
    return { running: false, error: e.message };
  }
}

async function ensureLiveBridgeIfNeeded() {
  const live = await queryLiveWindow();
  if (!live.running || !live.pageFound || live.hasIpcBridge) return;
  const stateDir = getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  const liveSessionPath = fs.existsSync(statePath) ? statePath : legacyPath;

  let alive = false;
  let existingInfo = null;
  if (fs.existsSync(liveSessionPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
      existingInfo = info;
      process.kill(info.pid, 0);
      if (!live.origin || info.origin === live.origin) {
        alive = true;
      }
    } catch {}
  }
  if (!alive) {
    if (existingInfo?.pid) {
      try { process.kill(existingInfo.pid); } catch {}
    }
    try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch {}
    try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath); } catch {}

    const child = spawn(process.execPath, [path.join(__dirname, 'live-host.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    const maxWaitMs = 5000;
    const intervalMs = 150;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      const checkPath = fs.existsSync(statePath) ? statePath : (fs.existsSync(legacyPath) ? legacyPath : null);
      if (checkPath) {
        try {
          const info = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
          if (info && info.pid && (!live.origin || info.origin === live.origin)) {
            process.kill(info.pid, 0);
            alive = true;
            break;
          }
        } catch {}
      }
    }
  }
}

async function cmdStatus(customPath) {
  let asarPath = null;
  let version = null;
  let asarPatched = false;
  try {
    asarPath = findAsarPath(customPath);
    version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    const utilsSource = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    asarPatched = utilsSource.includes('installContextMeter(win)');
  } catch {}

  const live = await queryLiveWindow();
  const py = resolvePython();
  const report = {
    asarPath,
    antigravityVersion: version,
    asarPatched,
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function cmdCheck(customPath) {
  console.log('🔍 [Antigravity 对话上下文查看器] 正在执行环境预检...');
  console.log(`  - Node.js 运行时: ${process.version} (${process.execPath})`);
  try {
    const asarPath = findAsarPath(customPath);
    const version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    console.log(`  - Antigravity 路径: ${asarPath} (v${version})`);
  } catch (e) {
    console.error(`  ❌ Antigravity 路径探测失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const py = resolvePython();
  console.log(`  - Python 附件深度解析器: ${py || '未检测到（基础上下文统计不受影响）'}`);
  const live = await queryLiveWindow();
  console.log(`  - 运行中窗口 CDP 状态: ${live.running ? `已连接 (端口 ${live.cdpPort})` : '客户端未运行或未开启调试端口'}`);
  console.log('✅ 环境预检通过！');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args.find(a => !a.startsWith('-')) || 'install').toLowerCase();
  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;
  const backupIdx = args.indexOf('--backup');
  const customBackup = backupIdx >= 0 ? args[backupIdx + 1] : null;
  const isForce = args.includes('--force');

  if (cmd === 'install') {
    const meterVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`🚀 [Antigravity 对话上下文查看器 v${meterVersion}] 正在安装上下文可视化组件...`);
    await ensureLiveBridgeIfNeeded();
    const manifest = await install({ path: customPath, backup: customBackup, force: isForce });
    await tryHotInject();
    console.log(`✅ 插件 v${manifest.meterVersion} 安装完成 (Antigravity 宿主 v${manifest.version})`);
    console.log(`✅ ASAR 持久化注入完成: ${manifest.installed} (校验 ${manifest.originalFilesVerified} 个原文件)`);
    console.log(`✅ 运行中窗口热挂载状态: ${manifest.liveInjected ? '已即时生效（无需重启）' : '将在下次启动 Antigravity 时自动生效'}`);
  } else if (cmd === 'live') {
    await ensureLiveBridgeIfNeeded();
    const ok = await tryHotInject();
    if (!ok) throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js install。');
    console.log('✅ 已通过 CDP 热注入当前运行的 Antigravity 窗口！');
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    const res = await restore({ path: customPath, force: isForce });
    console.log(`✅ 已无损还原官方包: ${res.restored}`);
  } else if (cmd === 'unlock-status') {
    console.log('🔍 正在检测 Antigravity 后端上下文加长状态...');
    const st = await analyzeBinaryAsync(customPath);
    console.log(`- 目标文件: ${st.targetPath || '未检测到'}`);
    console.log(`- 目标架构: ${st.arch || '未知'} (${st.format || '未知'}, ${st.mode || '未知'})`);
    console.log(`- 解锁状态: [${st.statusText || st.status}] ${st.details || st.reason || ''}`);
    if (st.backupInfo) {
      console.log(`- 备份文件: ${st.backupInfo.backupPath}`);
    }
    console.log(`- ${st.author?.credit || AUTHOR_INFO.credit} (${st.author?.url || AUTHOR_INFO.url})`);
  } else if (cmd === 'unlock') {
    console.log('⚡ 正在执行 Antigravity 后端上下文加长解锁...');
    console.log(`ℹ ${AUTHOR_INFO.credit} (${AUTHOR_INFO.url})`);
    console.log(`⚠️  ${AUTHOR_INFO.disclaimer}`);
    const res = applyUnlock({ targetPath: customPath });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '解锁成功！'}`);
    if (res.backupPath) console.log(`📁 原版备份已安全保存至: ${res.backupPath}`);
  } else if (cmd === 'unlock-restore') {
    console.log('🔄 正在恢复 Antigravity 官方原版后端二进制...');
    const res = restoreUnlock({ targetPath: customPath });
    if (!res.ok) {
      throw new Error(res.error);
    }
    console.log(`✅ ${res.message || '恢复完成！'}`);
  } else if (cmd === 'status') {
    await cmdStatus(customPath);
  } else if (cmd === 'check') {
    await cmdCheck(customPath);
  } else {
    console.log(`用法:
  node cli.js install [--path <app.asar>]   一键持久化安装并热注入当前运行窗口
  node cli.js live                          免改盘 CDP 热挂载到当前运行窗口
  node cli.js status                        查看安装状态与当前对话实时上下文用量
  node cli.js check                         执行前置环境健康检查
  node cli.js restore                       一键无损卸载并恢复备份
  node cli.js unlock-status [--path <bin>]  检查 Antigravity 后端上下文加长状态
  node cli.js unlock [--path <bin>]         执行上下文加长解锁（解除 256K 限制）
  node cli.js unlock-restore [--path <bin>] 恢复官方原版二进制`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { cmdStatus, cmdCheck };
