'use strict';

/**
 * Antigravity Context Meter - 独立 CLI 网页可视化看板服务 (ELV-59)
 * 仅监听 127.0.0.1 本地回环地址，脱离 Antigravity 桌面端也能独立运行与监控并发多 CLI 会话
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { getStateDir } = require('./asar-engine');
const core = require('./meter-core');
const { scanCliSessions, getSessionDetail, maskSessionId, queryCliUsage, saveCliModelContextPreference, resolveCliModelContextBudget } = require('./meter-cli-monitor');
const { PROJECT_VERSION, DISPLAY_VERSION } = require('./modules-config');

const DEFAULT_CLI_UI_PORT = 56780;
const MAX_PORT_ATTEMPTS = 20;

function getCliUiLockFilePath(stateDir = null) {
  const dir = stateDir || getStateDir();
  return path.join(dir, '.cli-ui-server.json');
}

function readRunningUiServer(stateDir = null) {
  try {
    const lockFile = getCliUiLockFilePath(stateDir);
    if (!fs.existsSync(lockFile)) return null;
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!raw || !raw.port || !raw.pid) return null;
    try {
      process.kill(raw.pid, 0);
      return raw;
    } catch {
      try { fs.unlinkSync(lockFile); } catch {}
      return null;
    }
  } catch {
    return null;
  }
}

function writeRunningUiServer(info, stateDir = null) {
  try {
    const lockFile = getCliUiLockFilePath(stateDir);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify(info, null, 2) + '\n', 'utf8');
  } catch {}
}

function clearRunningUiServer(stateDir = null) {
  try {
    const lockFile = getCliUiLockFilePath(stateDir);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch {}
}

function openUrlInDefaultBrowser(url) {
  if (process.env.AG_NO_BROWSER_OPEN === '1') return;
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

function renderDashboardHtml(initialData = {}) {
  const v = PROJECT_VERSION || '0.9.0';
  const dv = DISPLAY_VERSION || '0.9.0';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity CLI Dashboard · ${dv}</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(22, 27, 46, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --accent: #818cf8;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root[data-theme="auto"] {
        --bg: #f8fafc;
        --card-bg: rgba(255, 255, 255, 0.9);
        --card-border: rgba(0, 0, 0, 0.08);
        --text: #0f172a;
        --text-muted: #64748b;
        --primary: #0284c7;
        --primary-glow: rgba(2, 132, 199, 0.2);
        --card-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.05);
      }
    }
    :root[data-theme="light"] {
      --bg: #f8fafc;
      --card-bg: rgba(255, 255, 255, 0.9);
      --card-border: rgba(0, 0, 0, 0.08);
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #0284c7;
      --primary-glow: rgba(2, 132, 199, 0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 24px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, #0284c7, #818cf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      color: #fff;
      font-size: 16px;
    }
    .brand-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--primary);
      font-weight: 600;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    .btn-primary {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .btn-primary:hover {
      opacity: 0.9;
      color: #fff;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      backdrop-filter: blur(12px);
    }
    .kpi-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .kpi-value {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .session-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .session-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      backdrop-filter: blur(16px);
      transition: transform 0.15s ease, border-color 0.15s ease;
      position: relative;
      overflow: hidden;
    }
    .session-card:hover {
      border-color: rgba(56, 189, 248, 0.4);
      transform: translateY(-2px);
    }
    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .session-title-group {
      min-width: 0;
      flex: 1;
    }
    .session-workspace {
      font-size: 16px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .session-id {
      font-size: 12px;
      color: var(--text-muted);
      font-family: monospace;
      margin-top: 2px;
    }
    .status-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-active { background: rgba(52, 211, 153, 0.15); color: var(--success); border: 1px solid rgba(52, 211, 153, 0.3); }
    .status-idle { background: rgba(251, 191, 36, 0.15); color: var(--warning); border: 1px solid rgba(251, 191, 36, 0.3); }
    .status-stale { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.3); }
    .status-started { background: rgba(56, 189, 248, 0.15); color: var(--primary); border: 1px solid rgba(56, 189, 248, 0.3); }
    .model-badge {
      display: inline-block;
      font-size: 12px;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(129, 140, 248, 0.15);
      color: var(--accent);
      font-weight: 500;
      border: 1px solid rgba(129, 140, 248, 0.25);
    }
    .context-meter-box {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px;
    }
    .context-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .context-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
    }
    .context-percent {
      font-size: 20px;
      font-weight: 700;
      color: var(--primary);
    }
    .progress-bar-bg {
      height: 8px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .context-stats-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .secondary-metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      font-size: 13px;
    }
    .metric-pill {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 12px;
    }
    .metric-pill-label {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 2px;
    }
    .metric-pill-val {
      font-weight: 600;
    }
    .session-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
      padding-top: 12px;
      border-top: 1px solid var(--card-border);
    }
    .time-hint {
      font-size: 11px;
      color: var(--text-muted);
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      border: 1px dashed var(--card-border);
      border-radius: 16px;
      margin: 20px 0;
    }
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      width: 90%;
      max-width: 500px;
      padding: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 16px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-label {
      display: block;
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .form-input, .form-select {
      width: 100%;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }
    .form-input:focus, .form-select:focus {
      border-color: var(--primary);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
    }
    .timeline-modal-card {
      max-width: 720px;
      max-height: 82vh;
      display: flex;
      flex-direction: column;
    }
    .timeline-body {
      overflow-y: auto;
      max-height: 58vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-right: 4px;
    }
    .timeline-turn-box {
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(0, 0, 0, 0.18);
    }
    .timeline-turn-hdr {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--primary);
    }
    .timeline-call-row {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      padding: 6px 0;
      border-top: 1px dashed var(--card-border);
      color: var(--text-muted);
    }
    .filter-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-bottom: 14px;
      padding: 10px 14px;
      border-radius: 12px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
    }
    .filter-toolbar .form-input, .filter-toolbar .form-select {
      padding: 6px 10px;
      font-size: 12px;
      width: auto;
      min-width: 140px;
    }
    .modal-tab-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .modal-tab-btn {
      padding: 5px 10px;
      font-size: 12px;
      border-radius: 999px;
      border: 1px solid var(--card-border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
    }
    .modal-tab-btn.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: var(--primary);
      color: var(--primary);
      font-weight: 600;
    }
    .delta-chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(148, 163, 184, 0.14);
      color: var(--text-muted);
    }
    .delta-chip.up { background: rgba(245, 158, 11, 0.16); color: var(--warning); }
    .delta-chip.down { background: rgba(16, 185, 129, 0.16); color: var(--success); }
    .delta-chip.jump { border: 1px solid var(--danger); color: var(--danger); }
    .target-banner {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.12), rgba(129, 140, 248, 0.1));
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .target-banner.is-warn {
      background: rgba(251, 191, 36, 0.1);
      border-color: rgba(251, 191, 36, 0.45);
    }
    .target-banner-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .source-tag {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.2);
      color: var(--primary);
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .source-tag.desktop {
      background: rgba(129, 140, 248, 0.2);
      color: var(--accent);
      border-color: rgba(129, 140, 248, 0.4);
    }
    .progress-bar-fill.warn { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .progress-bar-fill.crit { background: linear-gradient(90deg, #ef4444, #f87171); }
    .cross-summary-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">&gt;_</div>
      <div>
        <span class="brand-title">Antigravity CLI 看板</span>
        <span class="brand-badge">${dv}</span>
      </div>
    </div>
    <div class="controls">
      <span id="auto-refresh-indicator" style="font-size: 12px; color: var(--success); display: flex; align-items: center; gap: 4px;">
        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--success);"></span> 实时同步中 (2s)
      </span>
      <button class="btn" id="btn-refresh">刷新</button>
      <button class="btn" id="btn-toggle-theme">切换主题</button>
    </div>
  </header>

  <section class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">活跃 CLI 会话数 <span>🖥️</span></div>
      <div class="kpi-value" id="kpi-active-sessions">--</div>
      <div class="kpi-sub" id="kpi-total-sessions">总会话: --</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">今日总 Token (All) <span>🛢</span></div>
      <div class="kpi-value" id="kpi-today-tokens">--</div>
      <div class="kpi-sub" id="kpi-month-tokens">本月: --</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">整体缓存读取占比 <span>⚡</span></div>
      <div class="kpi-value" id="kpi-cache-rate">--%</div>
      <div class="kpi-sub" id="kpi-cache-tokens">缓存读取 Token: --</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">来源分布 <span>📊</span></div>
      <div class="kpi-value" id="kpi-source-ratio" style="font-size: 18px; line-height: 1.4;">CLI: --<br>Desktop: --</div>
      <div class="kpi-sub">共用同一权威账本</div>
    </div>
  </section>

  <div id="targeted-session-host"></div>

  <div class="section-title">
    <span>💻 并发 CLI 会话实时看板 (ELV-59)</span>
    <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">(按会话 ID 严格区分，相同工作目录并发绝不串扰)</span>
  </div>

  <div class="filter-toolbar" id="session-filter-bar">
    <input type="text" class="form-input" id="filter-session-query" placeholder="搜索工作区、会话 ID 或模型…" style="flex:1;min-width:180px;">
    <select class="form-select" id="filter-session-status">
      <option value="all">全部状态</option>
      <option value="active">仅看运行中</option>
      <option value="idle">仅看空闲</option>
      <option value="stale">已结束/历史</option>
    </select>
    <select class="form-select" id="sort-session-by">
      <option value="recent">排序: 最近活跃</option>
      <option value="context_desc">排序: 上下文占用降序</option>
      <option value="tokens_desc">排序: 累计 Token 降序</option>
    </select>
    <div id="cross-session-stats" class="cross-summary-strip"></div>
    <span id="filter-session-count" style="font-size:12px;color:var(--text-muted);white-space:nowrap;">—</span>
  </div>

  <div id="session-container" class="session-grid">
    <div class="empty-state">正在扫描本机 CLI 会话状态...</div>
  </div>

  <!-- 按模型上下文配置弹窗 -->
  <div id="context-modal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-title" id="modal-model-title">配置模型上下文上限</div>
      <input type="hidden" id="modal-model-id" value="">
      <div class="form-group">
        <label class="form-label">调整模式</label>
        <select class="form-select" id="modal-mode-select">
          <option value="fixed">固定上限 (Fixed Token Budget)</option>
          <option value="default">官方原版默认 (Default 128K)</option>
        </select>
      </div>
      <div class="form-group" id="group-limit-tokens">
        <label class="form-label">上下文上限 Tokens</label>
        <select class="form-select" id="modal-preset-select" style="margin-bottom: 8px;">
          <option value="128000">128K (128,000)</option>
          <option value="256000">256K (256,000)</option>
          <option value="512000">512K (512,000)</option>
          <option value="900000">900K (900,000)</option>
          <option value="custom">自定义数值...</option>
        </select>
        <input type="number" class="form-input" id="modal-limit-input" placeholder="输入整数 Token 数" value="128000">
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">
        💡 保存后立即写入共享磁盘配置. CLI 进程在下一次启动或新开会话后读取新上限.
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-btn-clear" style="margin-right:auto">恢复默认</button>
        <button class="btn" id="modal-btn-cancel">取消</button>
        <button class="btn btn-primary" id="modal-btn-save">立即保存</button>
      </div>
    </div>
  </div>

  <!-- 会话请求时间线与历史弹窗 -->
  <div id="timeline-modal" class="modal-overlay">
    <div class="modal-card timeline-modal-card">
      <div class="modal-title" id="timeline-modal-title">请求时间线与历史</div>
      <div id="timeline-modal-meta" style="font-size:12px;color:var(--text-muted);margin-bottom:8px"></div>
      <div class="modal-tab-bar" id="timeline-modal-tabs">
        <button class="modal-tab-btn active" data-tab="turns" type="button">轮次与 Δ</button>
        <button class="modal-tab-btn" data-tab="timing" type="button">阶段耗时</button>
        <button class="modal-tab-btn" data-tab="files" type="button">文件活动</button>
        <button class="modal-tab-btn" data-tab="commands" type="button">命令执行</button>
        <button class="modal-tab-btn" data-tab="fleet" type="button">Agent 家族</button>
      </div>
      <div id="timeline-modal-body" class="timeline-body">
        <div class="empty-state">加载中...</div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="timeline-btn-close">关闭</button>
      </div>
    </div>
  </div>

  <script>
    function formatTokens(n) {
      if (n === null || n === undefined || isNaN(n)) return '未知';
      const num = Number(n);
      if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
      if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
      if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
      return String(Math.round(num));
    }

    function escAttr(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function timeAgo(ms) {
      if (!ms) return '未知';
      const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (sec < 10) return '刚刚';
      if (sec < 60) return sec + ' 秒前';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
      return Math.floor(sec / 3600) + ' 小时前';
    }

    async function fetchApi(endpoint) {
      try {
        const res = await fetch(endpoint);
        return await res.json();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    let activeSessions = [];
    let currentTimelineData = null;
    let currentTimelineTab = 'turns';
    let urlParams = new URLSearchParams(window.location.search || '');
    let targetSessionId = (urlParams.get('sessionId') || '').trim();
    let targetSessionSource = (urlParams.get('source') || '').trim();
    let targetSessionDetail = null;
    let targetAutoModalOpened = false;

    function buildSessionShareUrl(sid, src) {
      const u = new URL(window.location.href);
      u.search = '';
      if (sid) u.searchParams.set('sessionId', sid);
      if (src) u.searchParams.set('source', src);
      return u.toString();
    }

    function copyTextFallback(txt) {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(txt).catch(() => {});
        return;
      }
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }

    function clearTargetedSession() {
      targetSessionId = '';
      targetSessionSource = '';
      targetSessionDetail = null;
      targetAutoModalOpened = false;
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('sessionId');
        cleanUrl.searchParams.delete('source');
        window.history.replaceState({}, '', cleanUrl.toString());
      } catch {}
      renderTargetedSessionBanner();
    }

    function renderTargetedSessionBanner() {
      const hostEl = document.getElementById('targeted-session-host');
      if (!hostEl) return;
      if (!targetSessionId) {
        hostEl.innerHTML = '';
        return;
      }
      const res = targetSessionDetail;
      if (!res) {
        hostEl.innerHTML = '<div class="target-banner"><div class="target-banner-hdr"><span>正在按精确 ID 定位会话: <code>' + escAttr(targetSessionId) + '</code>...</span><button class="btn" onclick="clearTargetedSession()">取消定位</button></div></div>';
        return;
      }
      if (!res.ok) {
        hostEl.innerHTML = \`
          <div class="target-banner is-warn" id="missing-session-alert">
            <div class="target-banner-hdr">
              <div>
                <strong>⚠️ 未找到目标会话详情</strong>
                <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">请求 ID: <code>\${escAttr(targetSessionId)}</code>\${targetSessionSource ? ' · 来源: ' + escAttr(targetSessionSource) : ''}</span>
              </div>
              <button class="btn" onclick="clearTargetedSession()">关闭提示</button>
            </div>
            <div style="font-size:12px;color:var(--text-muted);">
              \${escAttr(res.error || '本地尚无该会话的 transcript 或账本记录.')} 已保留完整 CLI 会话列表供手动查看，未替您自动选择其他会话.
            </div>
          </div>\`;
        return;
      }
      const s = res;
      const pct = s.contextPercent !== null ? s.contextPercent : 0;
      const pctDisplay = s.contextPercent !== null ? s.contextPercent + '%' : '未知';
      const fillCls = pct >= 90 ? 'crit' : (pct >= 75 ? 'warn' : '');
      const srcLabel = s.source === 'desktop' ? '🖥️ 桌面会话' : '💻 CLI 会话';
      const srcTagCls = s.source === 'desktop' ? 'source-tag desktop' : 'source-tag';
      const speed = (s.speedTokPerSec !== null && s.speedTokPerSec !== undefined) ? (s.speedTokPerSec + ' tok/s') : '— tok/s';
      const cacheHit = s.cacheHitRate !== undefined && s.cacheHitRate !== null ? (s.cacheHitRate + '%') : '--%';
      const modelLabel = s.modelLabel || s.model || '未识别模型';
      const usedStr = s.contextUsedTokens !== null ? formatTokens(s.contextUsedTokens) : '暂无用量';
      const limitStr = s.contextLimitTokens !== null ? formatTokens(s.contextLimitTokens) : '未知';
      const remainStr = s.contextRemainingTokens !== null ? formatTokens(s.contextRemainingTokens) : '未知';
      const shareUrl = buildSessionShareUrl(s.sessionId, s.source);

      hostEl.innerHTML = \`
        <div class="target-banner" id="targeted-session-banner" data-session-id="\${escAttr(s.sessionId)}" data-source="\${escAttr(s.source)}">
          <div class="target-banner-hdr">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="\${srcTagCls}">\${srcLabel}</span>
              <strong style="font-size:15px;">\${escAttr(s.titlePreview || (s.cwd ? s.cwd.split(/[\\\\/]/).pop() : '当前定位会话'))}</strong>
              <span style="font-family:monospace;font-size:12px;color:var(--text-muted);" title="\${escAttr(s.sessionId)}">ID: \${escAttr(s.maskedId || s.shortId)}</span>
              <span class="model-badge">\${escAttr(modelLabel)}</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-primary" onclick="openTimelineModal('\${escAttr(s.sessionId)}', '\${escAttr(s.shortId)}', '\${escAttr(s.cwd || '')}', '\${escAttr(s.source || '')}')">📋 查看时间线与 5 维洞察</button>
              <button class="btn" onclick="copyTextFallback('\${escAttr(shareUrl)}')">🔗 复制定位链接</button>
              <button class="btn" onclick="loadTargetedSession()">刷新定位</button>
              <button class="btn" onclick="clearTargetedSession()">关闭定位</button>
            </div>
          </div>
          <div class="context-meter-box" style="padding:10px 12px;">
            <div class="context-header" style="margin-bottom:6px;">
              <span class="context-title">当前定位会话上下文 (\${escAttr(s.contextLimitSource || '未知')})</span>
              <span class="context-percent" style="font-size:16px;">\${pctDisplay}</span>
            </div>
            <div class="progress-bar-bg">
              <div class="progress-bar-fill \${fillCls}" style="width: \${Math.min(100, pct)}%;"></div>
            </div>
            <div class="context-stats-row">
              <span>已用: <b>\${usedStr}</b> / 上限: <b>\${limitStr}</b> · 剩余: <b>\${remainStr}</b></span>
              <span>累计: <b>\${formatTokens(s.sessionTotalTokens)}</b> · 缓存命中: <b>\${cacheHit}</b> · 速度: <b>\${speed}</b> · \${s.turnCount || 0} 轮 \${s.stepCount || 0} 步</span>
            </div>
          </div>
        </div>\`;
    }

    async function loadTargetedSession() {
      if (!targetSessionId) return;
      renderTargetedSessionBanner();
      const qs = 'sessionId=' + encodeURIComponent(targetSessionId) + (targetSessionSource ? ('&source=' + encodeURIComponent(targetSessionSource)) : '');
      const detail = await fetchApi('/api/session-detail?' + qs);
      targetSessionDetail = detail;
      renderTargetedSessionBanner();
      if (!targetAutoModalOpened && urlParams.get('modal') !== '0' && detail && detail.ok && detail.timeline) {
        targetAutoModalOpened = true;
        document.getElementById('timeline-modal-title').innerText = '会话时间线与历史 · ' + (detail.shortId || detail.sessionId);
        document.getElementById('timeline-modal-meta').innerText = (detail.cwd ? ('工作目录: ' + detail.cwd + ' | ') : '') + '会话 ID: ' + detail.sessionId + (detail.source ? (' | 来源: ' + detail.source) : '');
        currentTimelineData = detail.timeline;
        currentTimelineTab = 'turns';
        document.getElementById('timeline-modal').classList.add('open');
        renderTimelineModalBody();
      }
    }

    function renderSessionsGrid() {
      const container = document.getElementById('session-container');
      const countEl = document.getElementById('filter-session-count');
      const q = (document.getElementById('filter-session-query')?.value || '').trim().toLowerCase();
      const statusFilter = document.getElementById('filter-session-status')?.value || 'all';
      const sortBy = document.getElementById('sort-session-by')?.value || 'recent';

      if (!Array.isArray(activeSessions) || activeSessions.length === 0) {
        container.innerHTML = '<div class="empty-state">当前未发现活跃或历史 CLI 会话. 请在终端运行 <code>agy</code> 后自动显示.</div>';
        if (countEl) countEl.innerText = '0 / 0 会话';
        return;
      }

      let filtered = activeSessions.filter(s => {
        if (statusFilter !== 'all' && String(s.status || 'stale') !== statusFilter) return false;
        if (q) {
          const hay = [s.cwd, s.sessionId, s.shortId, s.modelLabel, s.model].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      filtered = filtered.slice().sort((a, b) => {
        if (sortBy === 'context_desc') return (Number(b.contextPercent ?? -1)) - (Number(a.contextPercent ?? -1));
        if (sortBy === 'tokens_desc') return (Number(b.sessionTotalTokens ?? 0)) - (Number(a.sessionTotalTokens ?? 0));
        return (Number(b.lastActiveMs ?? 0)) - (Number(a.lastActiveMs ?? 0));
      });

      if (countEl) countEl.innerText = '显示 ' + filtered.length + ' / ' + activeSessions.length + ' 会话';
      const crossStatsEl = document.getElementById('cross-session-stats');
      if (crossStatsEl) {
        const sumTok = filtered.reduce((acc, item) => acc + Number(item.sessionTotalTokens || 0), 0);
        const sumInp = filtered.reduce((acc, item) => acc + Number(item.sessionInputTokens || 0), 0);
        const sumCap = filtered.reduce((acc, item) => acc + Number(item.sessionCacheTokens || 0), 0);
        const avgHit = (sumInp + sumCap) > 0 ? ((sumCap / (sumInp + sumCap)) * 100).toFixed(1) + '%' : '--%';
        crossStatsEl.innerHTML = '<span>筛选合计: <b>' + formatTokens(sumTok) + '</b></span><span>平均缓存命中: <b>' + avgHit + '</b></span>';
      }
      if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">当前筛选条件下无匹配会话. 请尝试清空关键词或放宽状态筛选.</div>';
        return;
      }

      container.innerHTML = filtered.map(s => {
        const cwdName = s.cwd ? s.cwd.split(/[\\\\/]/).pop() || s.cwd : '独立会话';
        const pct = s.contextPercent !== null ? s.contextPercent : 0;
        const pctDisplay = s.contextPercent !== null ? s.contextPercent + '%' : '未知';
        const usedDisplay = formatTokens(s.contextUsedTokens);
        const limitDisplay = formatTokens(s.contextLimitTokens);
        const remainDisplay = s.contextRemainingTokens !== null ? formatTokens(s.contextRemainingTokens) : (s.contextLimitTokens && s.contextUsedTokens !== null ? formatTokens(Math.max(0, s.contextLimitTokens - s.contextUsedTokens)) : '未知');
        const statusClass = 'status-' + (s.status || 'stale');
        const statusLabel = s.status === 'active' ? '🟢 运行中' : (s.status === 'idle' ? '🟡 空闲' : (s.status === 'started' ? '🔵 刚启动' : '⚪ 已结束'));
        const modelLabel = s.modelLabel || s.model || '未识别模型';
        const turns = s.turnCount || 0;
        const steps = s.stepCount || s.requestCount || 0;
        const speed = (s.speedTokPerSec !== null && s.speedTokPerSec !== undefined) ? (s.speedTokPerSec + ' tok/s') : '— tok/s';
        const cacheHit = s.cacheHitRate !== undefined && s.cacheHitRate !== null ? (s.cacheHitRate + '%') : '--%';
        const limitSrcLabel = s.contextLimitSource ? (s.contextLimitSource.startsWith('per_model_pref') ? '偏好' : (s.contextLimitSource === 'cli_settings_contextWindow' ? '设置' : s.contextLimitSource)) : '未知';
        const fillCls = pct >= 90 ? 'crit' : (pct >= 75 ? 'warn' : '');
        const shareUrl = buildSessionShareUrl(s.sessionId, 'cli');

        return \`
          <div class="session-card">
            <div class="session-header">
              <div class="session-title-group">
                <div class="session-workspace" title="\${s.cwd || s.sessionId}">
                  📁 \${cwdName}
                </div>
                <div class="session-id">ID: \${s.shortId} \${s.isSubagent ? '(子代理)' : ''}</div>
              </div>
              <span class="status-pill \${statusClass}">\${statusLabel}</span>
            </div>

            <div>
              <span class="model-badge">\${modelLabel}</span>
            </div>

            <div class="context-meter-box">
              <div class="context-header">
                <span class="context-title">当前会话上下文已用</span>
                <span class="context-percent">\${pctDisplay}</span>
              </div>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill \${fillCls}" style="width: \${Math.min(100, pct)}%;"></div>
              </div>
              <div class="context-stats-row">
                <span>已用: <b>\${usedDisplay}</b> / 上限: <b>\${limitDisplay}</b> <span style="opacity:0.7">(\${limitSrcLabel})</span></span>
                <span>剩余: <b>\${remainDisplay}</b></span>
              </div>
            </div>

            <div class="secondary-metrics">
              <div class="metric-pill">
                <div class="metric-pill-label">累计处理 Token</div>
                <div class="metric-pill-val">🛢 \${formatTokens(s.sessionTotalTokens)}</div>
              </div>
              <div class="metric-pill">
                <div class="metric-pill-label">缓存读取占比</div>
                <div class="metric-pill-val">⚡ \${cacheHit}</div>
              </div>
              <div class="metric-pill">
                <div class="metric-pill-label">轮次与步数</div>
                <div class="metric-pill-val">⏱ \${turns} 轮 \${steps} 步</div>
              </div>
              <div class="metric-pill">
                <div class="metric-pill-label">流式速度</div>
                <div class="metric-pill-val">\${speed}</div>
              </div>
            </div>

            <div class="session-footer">
              <span class="time-hint">最后活跃: \${timeAgo(s.lastActiveMs)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn" onclick="openTimelineModal('\${escAttr(s.sessionId)}', '\${escAttr(s.shortId)}', '\${escAttr(s.cwd || '')}', 'cli')">
                  📋 时间线与历史
                </button>
                <button class="btn" title="复制本会话精确链接" onclick="copyTextFallback('\${escAttr(shareUrl)}')">🔗</button>
                <button class="btn" onclick="openContextModal('\${escAttr(s.model || s.modelLabel || '')}', '\${escAttr(s.modelLabel || s.model || '')}', \${s.contextLimitTokens || 128000})">
                  ⚙️ 上下文配置
                </button>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function loadData() {
      const [sessionsRes, usageRes] = await Promise.all([
        fetchApi('/api/sessions'),
        fetchApi('/api/usage'),
        targetSessionId ? loadTargetedSession() : Promise.resolve(null)
      ]);

      if (usageRes && usageRes.ok && usageRes.totals) {
        document.getElementById('kpi-today-tokens').innerText = formatTokens(usageRes.totals.totalTokens);
        document.getElementById('kpi-month-tokens').innerText = '本月/全量: ' + formatTokens(usageRes.totals.totalTokens);
        const inp = Number(usageRes.totals.inputTokens || 0);
        const cap = Number(usageRes.totals.cacheTokens || 0);
        const rate = (inp + cap) > 0 ? ((cap / (inp + cap)) * 100).toFixed(1) : 0;
        document.getElementById('kpi-cache-rate').innerText = rate + '%';
        document.getElementById('kpi-cache-tokens').innerText = '缓存读取: ' + formatTokens(cap);
        if (usageRes.sourceBreakdown) {
          document.getElementById('kpi-source-ratio').innerHTML =
            'CLI: ' + formatTokens(usageRes.sourceBreakdown.cli) + '<br>Desktop: ' + formatTokens(usageRes.sourceBreakdown.desktop);
        }
      }

      if (!sessionsRes || !sessionsRes.ok || !sessionsRes.sessions || sessionsRes.sessions.length === 0) {
        activeSessions = [];
        document.getElementById('kpi-active-sessions').innerText = '0';
        document.getElementById('kpi-total-sessions').innerText = '总会话: 0';
        renderSessionsGrid();
        return;
      }

      activeSessions = sessionsRes.sessions;
      const activeCount = activeSessions.filter(s => s.status === 'active' || s.status === 'started').length;
      const staleCount = activeSessions.filter(s => s.status === 'stale').length;
      document.getElementById('kpi-active-sessions').innerText = String(activeCount);
      document.getElementById('kpi-total-sessions').innerText = '总会话: ' + activeSessions.length + ' · 已结束: ' + staleCount;
      renderSessionsGrid();
    }

    function fmtDeltaChip(d, isMaxJump = false) {
      if (d === null || d === undefined || isNaN(d)) return '';
      const cls = d > 0 ? (isMaxJump ? 'up jump' : 'up') : (d < 0 ? 'down' : '');
      const sign = d > 0 ? '+' : (d < 0 ? '-' : '');
      const jumpTag = isMaxJump ? ' 最大跃升' : '';
      return '<span class="delta-chip ' + cls + '">Δ ' + sign + formatTokens(Math.abs(d)) + jumpTag + '</span>';
    }

    function renderTimelineModalBody() {
      const bodyEl = document.getElementById('timeline-modal-body');
      const data = currentTimelineData;
      if (!data || !data.ok) {
        bodyEl.innerHTML = '<div class="empty-state">读取时间线失败: ' + escAttr(data?.error || '未知错误') + '</div>';
        return;
      }

      document.querySelectorAll('#timeline-modal-tabs .modal-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === currentTimelineTab);
      });

      if (currentTimelineTab === 'turns') {
        const turns = Array.isArray(data.turns) && data.turns.length > 0
          ? data.turns
          : (Array.isArray(data.calls) && data.calls.length > 0 ? [{ turnIndex: 1, preview: '请求明细', calls: data.calls }] : []);
        if (turns.length === 0) {
          bodyEl.innerHTML = '<div class="empty-state">当前会话暂无已记录的模型调用历史.</div>';
          return;
        }
        const deltaSum = data.contextDeltaSummary;
        const deltaHdr = (deltaSum && deltaSum.latestContextTokens != null)
          ? '<div class="timeline-turn-box" style="padding:8px 12px;font-size:12px;color:var(--text-muted)">上下文演化: 首帧 <b>' + formatTokens(deltaSum.initialContextTokens) + '</b> → 最新 <b>' + formatTokens(deltaSum.latestContextTokens) + '</b> ' + fmtDeltaChip(deltaSum.netDeltaTokens) + '</div>'
          : '';
        const mbList = Array.isArray(data.modelBreakdown) ? data.modelBreakdown : [];
        const mbTot = data.sessionTokenTotals;
        const mbHtml = mbList.length > 0
          ? '<div class="timeline-turn-box">' +
            '<div class="timeline-turn-hdr"><span>按实际执行模型汇总</span><span>' + (mbTot ? (mbTot.callCount + ' 次 · ' + formatTokens(mbTot.totalTokens) + (mbTot.isConsistent ? ' · 守恒✓' : '')) : '') + '</span></div>' +
            mbList.map(m => '<div class="timeline-call-row"><span><b>' + escAttr(m.modelLabel || m.modelKey || '未知模型') + '</b> (' + m.callCount + ' 次 · ' + (m.pct ?? 0) + '%)</span><span>In ' + formatTokens(m.inputTokens) + ' / Cache ' + formatTokens(m.cacheReadTokens) + ' / Out ' + formatTokens(m.outputTokens) + ' · 总 <b>' + formatTokens(m.totalTokens) + '</b></span></div>').join('') +
            '</div>'
          : '';
        bodyEl.innerHTML = deltaHdr + mbHtml + turns.map(t => {
          const rows = (t.calls || []).map(c => {
            const modelName = escAttr(c.attributedModelLabel || c.modelLabel || (c.model && !/^unknown$/i.test(c.model) ? c.model : '') || '未知模型');
            const speedVal = c.streamingTps ?? c.speedTokPerSec ?? c.tps;
            const speedTxt = speedVal != null ? (speedVal + ' tok/s') : '—';
            const durTxt = c.durationSec != null ? (c.durationSec + 's') : '—';
            const tsTxt = c.created_at ? escAttr(String(c.created_at).replace('T', ' ').slice(0, 19)) : '—';
            const dBadge = fmtDeltaChip(c.deltaFromPrevStep, Boolean(c.isMaxContextJump));
            return '<div class="timeline-call-row">' +
              '<span><b>' + modelName + '</b> (Step ' + (c.stepIndex ?? '?') + ') ' + dBadge + '</span>' +
              '<span>In ' + formatTokens(c.inputTokens) + ' / Cache ' + formatTokens(c.cacheReadTokens) + ' / Out ' + formatTokens(c.outputTokens) + '</span>' +
              '<span>耗时 ' + durTxt + ' · ' + speedTxt + ' · ' + tsTxt + '</span>' +
              '</div>';
          }).join('');
          const turnDelta = fmtDeltaChip(t.deltaFromPrevTurn);
          return '<div class="timeline-turn-box">' +
            '<div class="timeline-turn-hdr"><span>第 ' + t.turnIndex + ' 轮 · ' + escAttr((t.preview || '').slice(0, 48)) + ' ' + turnDelta + '</span><span>' + (t.calls || []).length + ' 次调用</span></div>' +
            rows +
            '</div>';
        }).join('');
        return;
      }

      if (currentTimelineTab === 'timing') {
        const tm = data.timingSummary;
        if (!tm || tm.activeWallSec <= 0) {
          bodyEl.innerHTML = '<div class="empty-state">当前会话暂无可用的阶段耗时指标.</div>';
          return;
        }
        bodyEl.innerHTML = '<div class="timeline-turn-box">' +
          '<div class="timeline-turn-hdr"><span>活跃阶段总耗时: ' + tm.activeWallSec + 's</span><span>调用 ' + tm.durationCount + ' 次 · 工具 ' + tm.toolExecCount + ' 次</span></div>' +
          '<div class="timeline-call-row"><span>首字等待 (TTFT, ' + tm.ttftCount + ' 次)</span><b>' + tm.totalTtftSec + 's (' + tm.ttftPct + '%)</b></div>' +
          '<div class="timeline-call-row"><span>模型流式输出 (' + tm.streamingCount + ' 次)</span><b>' + tm.totalStreamingSec + 's (' + tm.streamingPct + '%)</b></div>' +
          '<div class="timeline-call-row"><span>工具执行开销' + (tm.toolExecEstimated ? ' (步间估算)' : '') + '</span><b>' + tm.totalToolExecSec + 's (' + tm.toolExecPct + '%)</b></div>' +
          '</div>';
        return;
      }

      if (currentTimelineTab === 'files') {
        const files = Array.isArray(data.fileActivities) ? data.fileActivities : [];
        const fsSum = data.fileActivitySummary || {};
        if (files.length === 0) {
          bodyEl.innerHTML = '<div class="empty-state">当前会话暂无可识别的文件读写或搜索记录.</div>';
          return;
        }
        bodyEl.innerHTML = '<div class="timeline-turn-box" style="font-size:12px;">共涉及 <b>' + (fsSum.uniqueFiles || files.length) + '</b> 个文件 · 读 ' + (fsSum.readCount || 0) + ' / 改 ' + (fsSum.writeCount || 0) + ' / 搜 ' + (fsSum.searchCount || 0) + ' (+' + (fsSum.totalAddedLines || 0) + '/-' + (fsSum.totalRemovedLines || 0) + ' 行)</div>' +
          files.slice(0, 80).map(f => {
            const ops = [f.readCount ? '读 ' + f.readCount : '', f.writeCount ? '改 ' + f.writeCount : '', f.searchCount ? '搜 ' + f.searchCount : ''].filter(Boolean).join(' · ');
            const linesTxt = (f.addedLines || f.removedLines) ? (' · +' + f.addedLines + '/-' + f.removedLines + '行') : '';
            const turnTxt = Array.isArray(f.turnNumbers) && f.turnNumbers.length ? ('T' + f.turnNumbers.join(',')) : '';
            return '<div class="timeline-call-row"><span title="' + escAttr(f.path) + '"><b>' + escAttr(f.basename) + '</b> <span style="opacity:0.7">' + escAttr(f.path) + '</span></span><span>' + ops + linesTxt + (turnTxt ? ' · ' + turnTxt : '') + '</span></div>';
          }).join('');
        return;
      }

      if (currentTimelineTab === 'commands') {
        const cmds = Array.isArray(data.commandExecutions) ? data.commandExecutions : [];
        const cs = data.commandSummary || {};
        if (cmds.length === 0) {
          bodyEl.innerHTML = '<div class="empty-state">当前会话暂无命令执行记录.</div>';
          return;
        }
        bodyEl.innerHTML = '<div class="timeline-turn-box" style="font-size:12px;">共执行 <b>' + (cs.totalCount || cmds.length) + '</b> 条命令 · 失败 ' + (cs.failedCount || 0) + ' · 慢命令 ' + (cs.slowCount || 0) + ' · 后台 ' + (cs.backgroundCount || 0) + ' (已自动脱敏凭据)</div>' +
          cmds.slice().reverse().slice(0, 80).map(c => {
            const flags = [c.status === 'failed' ? '失败' : '', c.isSlow ? '慢命令' : '', c.isBackground ? '后台' : ''].filter(Boolean).join('/');
            return '<div class="timeline-call-row"><span><b>[' + escAttr(c.program) + ']</b> <code>' + escAttr(c.command) + '</code></span><span>' + (flags ? flags + ' · ' : '') + (c.durationSec != null ? c.durationSec + 's · ' : '') + (c.turnNumber != null ? 'T' + c.turnNumber + ' ' : '') + 'S' + (c.stepIndex ?? '?') + '</span></div>';
          }).join('');
        return;
      }

      if (currentTimelineTab === 'fleet') {
        const fleet = data.agentFleetSummary;
        if (!fleet || !fleet.mainAgent) {
          bodyEl.innerHTML = '<div class="empty-state">暂无 Agent 家族归属统计.</div>';
          return;
        }
        const m = fleet.mainAgent;
        const mainHtml = '<div class="timeline-turn-box"><div class="timeline-turn-hdr"><span>主会话自身 (' + escAttr((m.models || []).join(', ') || '默认') + ')</span><span>' + m.callCount + ' 次调用 · ' + formatTokens(m.totalTokens) + '</span></div></div>';
        const subHtml = (fleet.subagents || []).map(sa =>
          '<div class="timeline-turn-box"><div class="timeline-turn-hdr"><span>子代理 · ' + escAttr(sa.type || sa.role || sa.childCid) + ' (' + escAttr(sa.confidence || '') + ')</span><span>' + sa.callCount + ' 次调用 · ' + formatTokens(sa.totalTokens) + '</span></div></div>'
        ).join('');
        const unlinkedHtml = fleet.unlinkedCount > 0 ? '<div class="timeline-turn-box" style="font-size:12px;">存在 ' + fleet.unlinkedCount + ' 次父级不明调用 (' + formatTokens(fleet.unlinkedTotalTokens) + '), 未盲目合并.</div>' : '';
        const collabList = Array.isArray(fleet.collaborationTimeline) ? fleet.collaborationTimeline : [];
        const collabHtml = collabList.length > 0
          ? '<div class="timeline-turn-box"><div class="timeline-turn-hdr"><span>主子协作时间线</span><span>' + collabList.length + ' 条节点</span></div>' +
            collabList.slice(0, 40).map(ev => '<div class="timeline-call-row"><span>Step ' + (ev.stepIndex ?? '?') + ' · [' + escAttr(ev.role || ev.kind) + '] ' + escAttr(ev.detail || '') + '</span><span>' + escAttr(ev.modelLabel || '') + '</span></div>').join('') + '</div>'
          : '';
        const tasks = Array.isArray(fleet.taskEvents) ? fleet.taskEvents : [];
        const taskHtml = '<div class="timeline-turn-box"><div class="timeline-turn-hdr"><span>任务与调度记录</span><span>' + tasks.length + ' 条 · 任务依赖 DAG: 宿主暂未提供</span></div>' +
          (tasks.length > 0 ? tasks.slice(0, 30).map(te => '<div class="timeline-call-row"><span>Step ' + (te.stepIndex ?? '?') + ' · [' + escAttr(te.toolName) + '] ' + escAttr(te.summary || '') + '</span><span>' + escAttr(te.status || 'completed') + '</span></div>').join('') : '<div style="font-size:12px;color:var(--text-muted)">暂无显式任务或调度调用.</div>') +
          '</div>';
        bodyEl.innerHTML = '<div class="timeline-turn-box" style="font-size:12px;">主会话独占 <b>' + formatTokens(fleet.mainOnlyTotalTokens) + '</b> · 家族总计 <b>' + formatTokens(fleet.fleetCombinedTotalTokens) + '</b> (去重守恒: ' + (fleet.dedupVerified ? '通过' : '否') + ')</div>' + mainHtml + subHtml + unlinkedHtml + collabHtml + taskHtml;
      }
    }

    async function openTimelineModal(sessionId, shortId, cwd, src) {
      document.getElementById('timeline-modal-title').innerText = '会话时间线与历史 · ' + (shortId || sessionId);
      document.getElementById('timeline-modal-meta').innerText = (cwd ? ('工作目录: ' + cwd + ' | ') : '') + '会话 ID: ' + sessionId + (src ? (' | 来源: ' + src) : '');
      const bodyEl = document.getElementById('timeline-modal-body');
      bodyEl.innerHTML = '<div class="empty-state">正在读取请求历史...</div>';
      currentTimelineData = null;
      currentTimelineTab = 'turns';
      document.getElementById('timeline-modal').classList.add('open');

      const qs = 'sessionId=' + encodeURIComponent(sessionId) + (src ? ('&source=' + encodeURIComponent(src)) : '');
      const data = await fetchApi('/api/session-timeline?' + qs);
      currentTimelineData = data;
      renderTimelineModalBody();
    }

    document.getElementById('filter-session-query')?.addEventListener('input', renderSessionsGrid);
    document.getElementById('filter-session-status')?.addEventListener('change', renderSessionsGrid);
    document.getElementById('sort-session-by')?.addEventListener('change', renderSessionsGrid);
    document.querySelectorAll('#timeline-modal-tabs .modal-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTimelineTab = btn.getAttribute('data-tab') || 'turns';
        renderTimelineModalBody();
      });
    });

    document.getElementById('timeline-btn-close').onclick = () => {
      document.getElementById('timeline-modal').classList.remove('open');
    };

    function openContextModal(modelId, modelLabel, currentLimit) {
      document.getElementById('modal-model-title').innerText = '配置 ' + (modelLabel || modelId || '当前模型') + ' 上下文上限';
      document.getElementById('modal-model-id').value = modelId;
      document.getElementById('modal-limit-input').value = currentLimit || 128000;
      document.getElementById('context-modal').classList.add('open');
    }

    document.getElementById('modal-btn-cancel').onclick = () => {
      document.getElementById('context-modal').classList.remove('open');
    };

    document.getElementById('modal-preset-select').onchange = (e) => {
      if (e.target.value !== 'custom') {
        document.getElementById('modal-limit-input').value = e.target.value;
      }
    };

    document.getElementById('modal-btn-save').onclick = async () => {
      const modelId = document.getElementById('modal-model-id').value;
      const mode = document.getElementById('modal-mode-select').value;
      const limit = Number(document.getElementById('modal-limit-input').value);
      if (!modelId) {
        alert('无法识别目标模型标识');
        return;
      }
      const res = await fetch('/api/context-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, mode, limitTokens: limit, syncCliSettings: false })
      }).then(r => r.json());

      if (res && res.ok) {
        alert('✅ 上下文偏好已立即保存至磁盘！\\n生效说明: ' + (res.effectiveTiming?.explanation || '重启 CLI 或新开会话生效'));
        document.getElementById('context-modal').classList.remove('open');
        loadData();
      } else {
        alert('❌ 保存失败: ' + (res?.error || '未知错误'));
      }
    };

    document.getElementById('modal-btn-clear').onclick = async () => {
      const modelId = document.getElementById('modal-model-id').value;
      if (!modelId) return;
      const res = await fetch('/api/context-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, clear: true, syncCliSettings: false })
      }).then(r => r.json());
      if (res && res.ok) {
        document.getElementById('context-modal').classList.remove('open');
        loadData();
      } else {
        alert('❌ 清除失败: ' + (res?.error || '未知错误'));
      }
    };

    document.getElementById('btn-refresh').onclick = loadData;
    document.getElementById('btn-toggle-theme').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
    };

    loadData();
    setInterval(loadData, 2000);
  </script>
</body>
</html>`;
}

/**
 * 只读聚合单个 CLI 会话的请求时间线与历史调用明细（严格隔离会话，绝不修改磁盘）
 */
function getCliSessionTimeline({ sessionId, source = null, agCliDir = null, agDir = null } = {}) {
  const cleanSid = String(sessionId || '').trim();
  if (!cleanSid || /[/\\]|\.\./.test(cleanSid)) {
    return { ok: false, error: '无效会话 ID' };
  }
  const home = os.homedir();
  const resolvedCliDir = agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');
  const resolvedAgDir = agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');

  const collector = require('./meter-collector');
  const cliTranscript = path.join(resolvedCliDir, 'brain', cleanSid, '.system_generated', 'logs', 'transcript.jsonl');
  const desktopTranscript = path.join(resolvedAgDir, 'brain', cleanSid, '.system_generated', 'logs', 'transcript.jsonl');
  const reqSrc = source ? String(source).trim().toLowerCase() : '';
  const useDesktop = reqSrc === 'desktop' || (reqSrc !== 'cli' && !fs.existsSync(cliTranscript) && fs.existsSync(desktopTranscript));
  const transcriptPath = useDesktop ? desktopTranscript : (fs.existsSync(cliTranscript) ? cliTranscript : desktopTranscript);
  const actualSource = useDesktop ? 'desktop' : 'cli';
  const convDir = path.join(path.dirname(path.dirname(path.dirname(path.dirname(transcriptPath)))), 'conversations');
  const parsed = typeof collector.parseTranscriptForSessionTimeline === 'function'
    ? collector.parseTranscriptForSessionTimeline(transcriptPath, cleanSid, convDir, actualSource)
    : { turns: [], calls: [], subagentLinks: [], rawSteps: [], toolEntries: [] };

  const ledger = collector.loadPricingLedger(resolvedAgDir, { readOnly: true });
  const allLedgerCalls = (ledger && !ledger.__corrupted && !ledger.__unreadable && ledger.calls)
    ? Object.values(ledger.calls).filter(c => c && typeof c === 'object')
    : [];
  const ledgerCalls = allLedgerCalls.filter(c => String(c.cascadeId || '').trim() === cleanSid);

  const subagentInfo = typeof collector.collectVerifiedSubagentCallsForSessionSync === 'function'
    ? collector.collectVerifiedSubagentCallsForSessionSync({
        cascadeId: cleanSid,
        rootEntries: useDesktop
          ? [{ dir: resolvedAgDir, source: 'desktop' }, { dir: resolvedCliDir, source: 'cli' }]
          : [{ dir: resolvedCliDir, source: 'cli' }, { dir: resolvedAgDir, source: 'desktop' }],
        initialLinks: parsed.subagentLinks || [],
        ledgerCalls: allLedgerCalls
      })
    : { subagentCalls: [] };

  const rawMergedCalls = [...(parsed.calls || []), ...ledgerCalls, ...(subagentInfo.subagentCalls || [])];
  const prelimTurns = [...(parsed.turns || [])]
    .sort((a, b) => ((a.stepIndex ?? 0) - (b.stepIndex ?? 0)) || ((a.timestamp || 0) - (b.timestamp || 0)))
    .map((t, idx) => ({ ...t, turnIndex: idx + 1 }));
  const toolInsights = typeof collector.extractSessionToolInsights === 'function'
    ? collector.extractSessionToolInsights(parsed.toolEntries || [], prelimTurns)
    : { fileActivities: [], fileActivitySummary: null, commandExecutions: [], commandSummary: null, taskEvents: [], toolExecEvents: [] };

  const grouped = typeof core.groupSessionCallsByTurns === 'function'
    ? core.groupSessionCallsByTurns(parsed.turns || [], rawMergedCalls, {
        cascadeId: cleanSid,
        toolExecEvents: toolInsights.toolExecEvents,
        taskEvents: toolInsights.taskEvents
      })
    : { turns: [], calls: rawMergedCalls, totalCalls: rawMergedCalls.length };
  const flatCalls = [
    ...(grouped.turns || []).flatMap(t => t.calls || []),
    ...(grouped.unlinkedSubagentCalls || [])
  ];
  const contextChangeEvents = typeof core.detectContextChangeEvents === 'function'
    ? core.detectContextChangeEvents(parsed.rawSteps || [], flatCalls, { cascadeId: cleanSid })
    : [];

  return {
    ok: true,
    sessionId: cleanSid,
    totalCalls: grouped.totalCalls ?? flatCalls.length,
    mainCallsCount: grouped.mainCallsCount ?? flatCalls.filter(c => c.agentRole !== 'subagent').length,
    subagentCallsCount: grouped.subagentCallsCount ?? flatCalls.filter(c => c.agentRole === 'subagent').length,
    turns: grouped.turns || [],
    calls: flatCalls,
    modelBreakdown: grouped.modelBreakdown || [],
    sessionTokenTotals: grouped.sessionTokenTotals || null,
    contextChangeEvents,
    contextDeltaSummary: grouped.contextDeltaSummary || null,
    timingSummary: grouped.timingSummary || null,
    agentFleetSummary: grouped.agentFleetSummary || null,
    fileActivities: toolInsights.fileActivities || [],
    fileActivitySummary: toolInsights.fileActivitySummary || null,
    commandExecutions: toolInsights.commandExecutions || [],
    commandSummary: toolInsights.commandSummary || null
  };
}

/**
 * 启动或复用本地独立的 CLI 看板服务
 */
async function startCliUiServer(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const existing = readRunningUiServer(stateDir);
  const preferredPort = Number(options.port) || DEFAULT_CLI_UI_PORT;

  if (existing && existing.port && (!options.port || Number(options.port) === existing.port)) {
    const isAlive = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${existing.port}/api/status`, { timeout: 800 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (isAlive) {
      const baseUrl = `http://127.0.0.1:${existing.port}`;
      const qsParts = [];
      if (options.sessionId) qsParts.push(`sessionId=${encodeURIComponent(String(options.sessionId).trim())}`);
      if (options.source) qsParts.push(`source=${encodeURIComponent(String(options.source).trim())}`);
      const url = qsParts.length ? `${baseUrl}/?${qsParts.join('&')}` : baseUrl;
      if (options.open !== false && !options.noOpen) {
        openUrlInDefaultBrowser(url);
      }
      return {
        ok: true,
        reused: true,
        port: existing.port,
        pid: existing.pid,
        baseUrl,
        url
      };
    }
  }

  let server = null;
  let allocatedPort = preferredPort;
  let attempts = 0;

  while (attempts < MAX_PORT_ATTEMPTS) {
    try {
      const testPort = preferredPort + attempts;
      const srv = http.createServer(async (req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${testPort}`);
        const pathname = reqUrl.pathname;

        // 统一 CORS 响应头，仅放行本机回环 Origin，拒绝通配 *
        const reqOrigin = String(req.headers?.origin || '').trim();
        if (reqOrigin && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(reqOrigin)) {
          res.setHeader('Access-Control-Allow-Origin', reqOrigin);
          res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (pathname === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            version: PROJECT_VERSION || '0.9.0',
            displayVersion: DISPLAY_VERSION || '0.9.0',
            port: testPort,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            now: new Date().toISOString()
          }));
          return;
        }

        if (pathname === '/api/sessions') {
          try {
            const scan = scanCliSessions({
              stateDir: options.stateDir,
              agCliDir: options.agCliDir,
              agDir: options.agDir
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(scan));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        if (pathname === '/api/usage') {
          try {
            const period = reqUrl.searchParams.get('period') || 'all';
            const usage = await queryCliUsage({
              period,
              stateDir: options.stateDir,
              agCliDir: options.agCliDir,
              agDir: options.agDir,
              readOnly: true
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(usage));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        if (pathname === '/api/session-timeline') {
          try {
            const sessionId = reqUrl.searchParams.get('sessionId') || '';
            const source = reqUrl.searchParams.get('source') || '';
            const timeline = getCliSessionTimeline({
              sessionId,
              source,
              agCliDir: options.agCliDir,
              agDir: options.agDir
            });
            res.writeHead(timeline.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(timeline));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        if (pathname === '/api/session-detail') {
          try {
            const sessionId = reqUrl.searchParams.get('sessionId') || '';
            const source = reqUrl.searchParams.get('source') || '';
            const detail = getSessionDetail({
              sessionId,
              source,
              stateDir: options.stateDir,
              agCliDir: options.agCliDir,
              agDir: options.agDir
            });
            const status = detail.ok ? 200 : (detail.code === 'SESSION_NOT_FOUND' ? 404 : 400);
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(detail));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        if (pathname === '/api/context-set' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}');
              const saveRes = saveCliModelContextPreference({
                model: parsed.model,
                mode: parsed.mode || 'fixed',
                limitTokens: parsed.limitTokens ? Number(parsed.limitTokens) : null,
                clear: Boolean(parsed.clear),
                syncCliSettings: parsed.syncCliSettings !== false,
                stateDir: options.stateDir,
                agCliDir: options.agCliDir
              });
              res.writeHead(saveRes.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(saveRes));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '无效请求 JSON: ' + err.message }));
            }
          });
          return;
        }

        if (pathname === '/' || pathname === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderDashboardHtml());
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      });

      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(testPort, '127.0.0.1', () => {
          server = srv;
          allocatedPort = testPort;
          resolve();
        });
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        attempts++;
        continue;
      }
      throw e;
    }
  }

  if (!server) {
    throw new Error(`无法在 127.0.0.1 分配端口 (${preferredPort}~${preferredPort + attempts}) 启动独立看板`);
  }

  const baseUrl = `http://127.0.0.1:${allocatedPort}`;
  const qsParts = [];
  if (options.sessionId) qsParts.push(`sessionId=${encodeURIComponent(String(options.sessionId).trim())}`);
  if (options.source) qsParts.push(`source=${encodeURIComponent(String(options.source).trim())}`);
  const url = qsParts.length ? `${baseUrl}/?${qsParts.join('&')}` : baseUrl;
  writeRunningUiServer({
    port: allocatedPort,
    pid: process.pid,
    url: baseUrl,
    startedAt: new Date().toISOString()
  }, stateDir);

  const cleanup = () => {
    clearRunningUiServer(stateDir);
    try {
      if (server) {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        server.close();
        if (typeof server.unref === 'function') server.unref();
      }
    } catch {}
  };
  process.once('exit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  if (options.open !== false && !options.noOpen) {
    openUrlInDefaultBrowser(url);
  }

  return {
    ok: true,
    reused: false,
    port: allocatedPort,
    pid: process.pid,
    baseUrl,
    url,
    server,
    close: cleanup
  };
}

module.exports = {
  DEFAULT_CLI_UI_PORT,
  getCliUiLockFilePath,
  readRunningUiServer,
  writeRunningUiServer,
  clearRunningUiServer,
  getCliSessionTimeline,
  renderDashboardHtml,
  startCliUiServer
};
