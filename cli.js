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
const { getKernelStatus, applyKernelPatch } = require('./meter-patcher');
const { getI18nStatus, normalizeLocale, normalizeBrandTitle, saveI18nConfig } = require('./meter-i18n');

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
              hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli && window.contextMeterAPI?.getKernelStatus && window.contextMeterAPI?.getI18nStatus),
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
      if ((!live.origin || info.origin === live.origin) && info.bridgeVersion === 3) {
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
          if (info && info.pid && info.bridgeVersion === 3 && (!live.origin || info.origin === live.origin)) {
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
  const kernel = getKernelStatus();
  const i18n = getI18nStatus({ asarPath });
  const report = {
    asarPath,
    antigravityVersion: version,
    asarPatched,
    i18n: {
      locale: i18n.locale,
      localeLabel: i18n.localeLabel,
      brandTitle: i18n.brandTitle,
      brandTitleLabel: i18n.brandTitleLabel,
      dictEntryCount: i18n.dictEntryCount
    },
    kernelPatch: kernel.supported ? kernel.summary : { supported: false, reason: kernel.reason },
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function parseI18nArgs(args) {
  let locale = null;
  let brandTitle = null;
  let noLive = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tw') locale = 'zh-TW';
    else if (a === '--en') locale = 'en';
    else if (a === '--cn' || a === '--zh') locale = 'zh-CN';
    else if (a === '--no-live') noLive = true;
    else if (a === '--locale' || a === '-l') locale = args[++i];
    else if (a.startsWith('--locale=')) locale = a.split('=')[1];
    else if (a === '--brand-title' || a === '--brand') brandTitle = args[++i];
    else if (a.startsWith('--brand-title=')) brandTitle = a.split('=')[1];
  }
  return { locale, brandTitle, noLive };
}

function parsePatchArgs(args) {
  let promptTier = null;
  let contextMode = null;
  let chineseTitle = null;
  let restartLanguageServer = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--recommended' || a === '--full') {
      promptTier = '4';
      contextMode = '900k';
      chineseTitle = 'on';
    } else if (a === '--restore' || a === '--reset') {
      promptTier = '0';
      contextMode = 'stock';
      chineseTitle = 'off';
    } else if (a === '--restart') {
      restartLanguageServer = true;
    } else if (a === '--prompt' || a === '-p') {
      promptTier = args[++i];
    } else if (a.startsWith('--prompt=')) {
      promptTier = a.split('=')[1];
    } else if (a === '--context' || a === '-c') {
      contextMode = args[++i];
    } else if (a.startsWith('--context=')) {
      contextMode = a.split('=')[1];
    } else if (a === '--chinese-title' || a === '--title') {
      chineseTitle = args[++i];
    } else if (a.startsWith('--chinese-title=')) {
      chineseTitle = a.split('=')[1];
    }
  }
  return { promptTier, contextMode, chineseTitle, restartLanguageServer };
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

  if (cmd === 'install') {
    const i18nOpts = parseI18nArgs(args);
    console.log('🚀 [Antigravity 对话上下文查看器] 正在安装上下文可视化与客户端增强组件...');
    await ensureLiveBridgeIfNeeded();
    const manifest = await install({
      path: customPath,
      locale: i18nOpts.locale,
      brandTitle: i18nOpts.brandTitle
    });
    await tryHotInject();
    console.log(`✅ ASAR 持久化注入完成: ${manifest.installed} (Antigravity v${manifest.version}, 校验 ${manifest.originalFilesVerified} 个原文件, 界面语言: ${manifest.i18n?.locale || 'zh-CN'})`);
    console.log(`✅ 运行中窗口热挂载状态: ${manifest.liveInjected ? '已即时生效（无需重启）' : '将在下次启动 Antigravity 时自动生效'}`);
  } else if (cmd === 'i18n' || cmd === 'localize') {
    const i18nOpts = parseI18nArgs(args.slice(1));
    const loc = normalizeLocale(i18nOpts.locale);
    const brand = normalizeBrandTitle(i18nOpts.brandTitle);
    if (loc === undefined) throw new Error(`无效的语言参数: ${i18nOpts.locale}（可选 zh-CN / zh-TW / en）`);
    if (brand === undefined) throw new Error(`无效的品牌参数: ${i18nOpts.brandTitle}（可选 english / hidden / translated）`);
    const saved = saveI18nConfig({ locale: loc, brandTitle: brand, pluginSourceDir: __dirname });
    const manifest = await install({
      path: customPath,
      locale: saved.locale,
      brandTitle: saved.brandTitle,
      skipHotInject: true,
      liveRefreshI18n: !i18nOpts.noLive
    });
    console.log(`✅ 客户端界面语言已更新: ${manifest.i18n.locale} (品牌显示: ${manifest.i18n.brandTitle})`);
  } else if (cmd === 'live') {
    await ensureLiveBridgeIfNeeded();
    const ok = await tryHotInject();
    if (!ok) throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js install。');
    console.log('✅ 已通过 CDP 热注入当前运行的 Antigravity 窗口！');
  } else if (cmd === 'patch') {
    const patchOpts = parsePatchArgs(args.slice(1));
    const res = applyKernelPatch(patchOpts);
    if (!res.ok) {
      throw new Error(res.error || '内核补丁应用失败');
    }
    for (const line of res.logs || []) {
      console.log(`  ${line}`);
    }
    console.log('✅ 内核补丁已落盘！（若未附带 --restart，新配置将在下次启动或重启语言服务后生效）');
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    if (args.includes('--all')) {
      const kRes = applyKernelPatch({ promptTier: '0', contextMode: 'stock', chineseTitle: 'off' });
      if (kRes.ok) {
        console.log('✅ 已还原内核提示词、上下文窗口与会话标题至官方默认');
      }
    }
    const res = await restore();
    console.log(`✅ 已无损还原官方包: ${res.restored}`);
  } else if (cmd === 'status') {
    await cmdStatus(customPath);
  } else if (cmd === 'check') {
    await cmdCheck(customPath);
  } else {
    console.log(`用法:
  node cli.js install [--locale zh-CN|zh-TW|en] [--brand-title english|hidden|translated]
  node cli.js i18n --locale <zh-CN|zh-TW|en> [--brand-title <english|hidden|translated>]
  node cli.js live                          免改盘 CDP 热挂载到当前运行窗口
  node cli.js status                        查看安装状态、汉化配置、内核档位与实时用量
  node cli.js patch --recommended           一键应用 4 档提示词 + 900K 上下文 + 自动中文标题
  node cli.js patch --prompt <0..4> --context <stock|512k|900k> --chinese-title <on|off> [--restart]
  node cli.js patch --restore               单独将内核提示词、上下文与标题恢复官方默认
  node cli.js check                         执行前置环境健康检查
  node cli.js restore [--all]               一键无损卸载前端包（--all 同时还原内核）`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { cmdStatus, cmdCheck };
