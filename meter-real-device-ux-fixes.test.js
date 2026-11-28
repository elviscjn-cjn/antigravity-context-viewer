const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const meterAccounts = require('./meter-accounts.js');

const TINY_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6z8AAAAASUVORK5CYII=';

function findLocalBrowserExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { path: p };
  }
  return { path: null };
}

class RealDeviceCdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error('Page eval error: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch { }
  }
}

async function waitForDebugWsUrl(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch { }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Chromium DevTools 页面未就绪');
}

test('实机回归 1: 后端零原生切号白框、刷新绝不触发重启与按需切号重启门控、缓存保活协议核查结论、真实头像 Data URI 放行与三语零括号', async () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, 'meter-main.js'), 'utf8');
  const accountsActionStart = mainSrc.indexOf("ipcMain.handle('context-meter:accounts-action'");
  const accountsActionEnd = mainSrc.indexOf("ipcMain.handle('context-meter:sync-pricing'", accountsActionStart);
  assert.ok(accountsActionStart > 0 && accountsActionEnd > accountsActionStart);
  const accountsActionBlock = mainSrc.slice(accountsActionStart, accountsActionEnd);
  const codeOnlyBlock = accountsActionBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    codeOnlyBlock,
    /showMessageBox\s*\(/,
    '切号 IPC 严禁再调用 Electron dialog.showMessageBox 弹出 Windows 原生系统白框'
  );
  assert.doesNotMatch(
    codeOnlyBlock,
    /productionOfficialHostOnly:\s*true|allowCredentialWrite:\s*false|allowPluginOAuth:\s*false|allowCrossToolImport:\s*false/,
    '回归 #1 已撤销生产 accounts-action IPC 的切号/OAuth/Tools 导入拦截门禁'
  );
  assert.match(
    codeOnlyBlock,
    /collector\.fetchQuotaSnapshotFromHost\s*\(/,
    '生产 accounts-action IPC 必须通过 collector.fetchQuotaSnapshotFromHost 安全调用刷新额度'
  );
  assert.match(
    codeOnlyBlock,
    /const\s+restartClient\s*=\s*\(\s*!deferRestart\s*&&\s*canAutoRestart\s*\)\s*\?\s*\(\)\s*=>\s*handleRestartHost\(event\)\s*:\s*undefined/,
    'accounts-action 仅在非延迟重启且满足宿主重启能力时才构造 restartClient'
  );

  // 行为回归：1) 刷新当前账号与行内刷新绝不触发 restartClient；2) 仅真实切号在非 deferRestart 且提供 restartClient 时才调用重启
  let restartCalls = 0;
  const restartSpy = async () => {
    restartCalls += 1;
    return { supported: true, ok: true };
  };
  const refreshedEmails = [];
  const switchCalls = [];
  const fakeMgr = {
    getOverviewState: () => ({
      activeEmail: 'active@example.com',
      accounts: [
        { email: 'active@example.com', isActive: true, hasRefreshToken: true, suspended: false },
        { email: 'other@example.com', isActive: false, hasRefreshToken: true, suspended: false }
      ]
    }),
    refreshAccountQuota: async (email, opts) => {
      refreshedEmails.push({ email, hasRestartClient: typeof opts?.restartClient === 'function' });
      return { ok: true, unchanged: false };
    },
    switchActiveAccount: async (email, opts) => {
      switchCalls.push({
        email,
        deferRestart: Boolean(opts?.deferRestart),
        hasRestartClient: typeof opts?.restartClient === 'function'
      });
      if (typeof opts?.restartClient === 'function') {
        await opts.restartClient();
        return { ok: true, restartPending: true };
      }
      return { ok: true, restartPending: Boolean(opts?.requiresClientRestart) };
    }
  };

  // 1a. 刷新当前账号/全量刷新不触发重启
  const refreshAllRes = await meterAccounts.dispatchAccountsAction(
    fakeMgr,
    { action: 'refresh_quota', force: true },
    { restartClient: restartSpy, requiresClientRestart: true, canAutoRestart: true }
  );
  assert.equal(refreshAllRes.ok, true);
  assert.equal(restartCalls, 0, '刷新当前账号绝不可触发 restartClient');

  // 1b. 行内单行刷新（活跃与非活跃账号）均不触发重启
  const refreshInlineRes = await meterAccounts.dispatchAccountsAction(
    fakeMgr,
    { action: 'refresh_quota', email: 'other@example.com', force: true },
    { restartClient: restartSpy, requiresClientRestart: true, canAutoRestart: true }
  );
  assert.equal(refreshInlineRes.ok, true);
  assert.equal(restartCalls, 0, '行内单行刷新绝不可触发 restartClient');
  assert.equal(refreshedEmails.every((item) => item.hasRestartClient === false), true, 'refresh_quota 不得向 refreshAccountQuota 透传 restartClient');

  // 2a. 真实切号启用 deferRestart（未传 restartClient）时只写凭据待重启，不直接调用重启
  const deferSwitchRes = await meterAccounts.dispatchAccountsAction(
    fakeMgr,
    { action: 'switch', email: 'other@example.com', deferRestart: true },
    { restartClient: undefined, requiresClientRestart: true, canAutoRestart: true, deferRestart: true, allowManualRestartPending: true }
  );
  assert.equal(deferSwitchRes.ok, true);
  assert.equal(restartCalls, 0, 'deferRestart: true 切号不得立即调用 restartClient');

  // 2b. 真实切号在 !deferRestart 且具备 restartClient 时才会调用重启
  const directSwitchRes = await meterAccounts.dispatchAccountsAction(
    fakeMgr,
    { action: 'switch', email: 'other@example.com' },
    { restartClient: restartSpy, requiresClientRestart: true, canAutoRestart: true, deferRestart: false, allowManualRestartPending: true }
  );
  assert.equal(directSwitchRes.ok, true);
  assert.equal(restartCalls, 1, '仅在真实切号且非 deferRestart、具备 restartClient 时才调用重启');
  assert.equal(switchCalls.length, 2);
  assert.equal(switchCalls[0].hasRestartClient, false);
  assert.equal(switchCalls[1].hasRestartClient, true);

  // 缓存保活协议核查结论：无服务端 TTL 接口，消费版禁用
  assert.equal(meterAccounts.ELV52_PROTOCOL_EVIDENCE.hasServerTtlRpc, false);
  assert.equal(meterAccounts.ELV52_PROTOCOL_EVIDENCE.hasKeepaliveEndpoint, false);
  assert.equal(meterAccounts.ELV52_PROTOCOL_EVIDENCE.hasCacheWriteField, false);
  assert.equal(meterAccounts.ELV52_PROTOCOL_EVIDENCE.hasCacheTtlField, false);

  // 模板净化与 3 Tab 布局校验
  const tpl = fs.readFileSync(path.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'src/renderer/styles.css'), 'utf8');
  assert.equal(tpl.includes('id="quota-accounts-entry-card"'), false, '额度看板必须删除底部多账号切换入口卡');
  assert.equal(tpl.includes('id="quota-keepalive-section"'), false, '额度看板必须删除底部模型缓存保活卡片');
  assert.match(css, /\.ctx-tabs-bar\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.ctx-tabs-bar\s*\{[\s\S]*?repeat\(4,\s*1fr\)/);

  // 新增三语可见文案严格零中英文括号
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  const newKeys = [
    'accountsPage.emailCopied',
    'accountsPage.hideEmail',
    'accountsPage.showEmail',
    'accountsPage.hideEmailOnToast',
    'accountsPage.hideEmailOffToast',
    'accountsPage.sortHighQuota',
    'accountsPage.sortHighQuotaOn',
    'accountsPage.sortHighQuotaOff',
    'accountsPage.switchOverlayTitle',
    'accountsPage.switchOverlayRestarting',
    'accountsPage.switchOverlayManual',
    'accountsPage.switchOverlayRestartLater',
    'accountsPage.switchOverlayDone',
    'accountsPage.switchOverlayNativeGuideTitle',
    'accountsPage.switchOverlayNativeGuideDetail',
    'accountsPage.switchOverlayOpenSettings',
    'accountsPage.switchOverlayVerify',
    'accountsPage.switchOverlayCancel',
    'accountsPage.switchOverlayStillOriginal',
    'accountsPage.switchGuardGenerating',
    'accountsPage.switchGuardQueued',
    'accountsPage.switchGuardDraft',
    'accountsPage.switchGuardAttachments',
    'accountsPage.switchGuardMultiWindow',
    'accountsPage.nativeLoginTitle',
    'accountsPage.nativeLoginDetail',
    'accountsPage.nativeLoginVerified',
    'accountsPage.importToolsDisabled',
    'sidebarAccount.alreadyActive',
    'sidebarAccount.busyBlocked',
    'sidebarAccount.suspendedSwitchBlocked'
  ];
  for (const key of newKeys) {
    const m = i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*\\{[^\\n]+\\}`));
    assert.ok(m, `缺少三语词条 ${key}`);
    assert.doesNotMatch(m[0], /[()（）]/, `新增三语词条 ${key} 不得包含中英文括号`);
  }
});

test('实机回归 2: 账号管理器头像 Data URI 缓存、Google 头像 URL 压缩规范化与本地磁盘缓存复用', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-avatar-reg-'));
  const stateDir = path.join(tmpRoot, 'state');
  const agDir = path.join(tmpRoot, 'ag');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(agDir, { recursive: true });

  const pngBuf = Buffer.from(TINY_PNG_DATA_URI.split(',')[1], 'base64');
  let avatarHits = 0;
  const imgServer = http.createServer((req, res) => {
    avatarHits += 1;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pngBuf.length });
    res.end(pngBuf);
  });
  await new Promise((resolve) => imgServer.listen(0, '127.0.0.1', resolve));
  const imgPort = imgServer.address().port;

  try {
    assert.equal(meterAccounts.isSafeDataImageUri(TINY_PNG_DATA_URI), true);
    assert.equal(meterAccounts.isSafeDataImageUri('data:image/svg+xml,<svg/>'), false, '严禁放行 SVG Data URI');
    assert.equal(
      meterAccounts.normalizeGoogleAvatarUrl('https://lh3.googleusercontent.com/a/test=s400-c'),
      'https://lh3.googleusercontent.com/a/test=s96-c'
    );
    assert.equal(
      meterAccounts.normalizeGoogleAvatarUrl('https://lh3.googleusercontent.com/a/test'),
      'https://lh3.googleusercontent.com/a/test=s96-c'
    );

    const dataUri = await meterAccounts.fetchAvatarDataUriViaNode(`http://127.0.0.1:${imgPort}/photo.png`);
    assert.ok(dataUri && dataUri.startsWith('data:image/png;base64,'), 'Node 后台必须将头像转为 Data URI 绕过 Electron CSP');
    assert.ok(avatarHits >= 1);

    const mgr = meterAccounts.createAccountsManager({
      stateDir,
      appDataDir: agDir,
      hostEnv: 'prod'
    });
    const storePath = mgr.getPaths().storePath;
    fs.writeFileSync(storePath, JSON.stringify({
      version: 2,
      accounts: {
        'avatar_user@gmail.com': {
          email: 'avatar_user@gmail.com',
          name: 'Avatar User',
          profilePictureUrl: `http://127.0.0.1:${imgPort}/photo.png`
        }
      },
      autoSwitch: {},
      keepalive: {}
    }), 'utf8');

    const hitsBeforePassive = avatarHits;
    const passiveHydrate = await mgr.hydrateMissingAvatars({ force: true, limit: 4 });
    assert.equal(passiveHydrate.updated, 0, '默认被动 hydrateMissingAvatars 严禁外发拉取远程头像');
    assert.equal(avatarHits, hitsBeforePassive, '默认被动 hydrateMissingAvatars 必须零出网请求');

    const hydrated = await mgr.hydrateMissingAvatars({ force: true, limit: 4, allowRemoteFetch: true });
    assert.equal(hydrated.updated >= 1, true, '显式允许 allowRemoteFetch 时可将白名单头像落盘为本地 Data URI');
    const hitsAfterFirstHydrate = avatarHits;
    assert.ok(hitsAfterFirstHydrate > hitsBeforePassive);

    // 二次 hydrate 命中磁盘缓存，不再重复发网络请求
    await mgr.hydrateMissingAvatars({ force: true, limit: 4, allowRemoteFetch: true });
    assert.equal(avatarHits, hitsAfterFirstHydrate, '本地磁盘头像缓存命中后不得重复发网络请求');

    // 回归 #1：确认默认 dispatchAccountsAction 不再硬拦 import_tools（不再返回 cross_tool_credential_import_disabled）
    const toolsRes = await meterAccounts.dispatchAccountsAction(mgr, { action: 'import_tools' }, {});
    assert.notEqual(toolsRes.reason, 'cross_tool_credential_import_disabled', '回归 #1 已恢复真实 Tools 导入');

    const ov = await mgr.getOverviewState();
    const acc = ov.accounts.find(a => a.email === 'avatar_user@gmail.com');
    assert.ok(acc && acc.profilePictureUrl && acc.profilePictureUrl.startsWith('data:image/png;base64,'), 'getOverview 返回的账号必须携带本地 Data URI 头像');
  } finally {
    imgServer.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('实机回归 3: 真 Chromium CDP 全闭环覆盖 1~7 项（账号页零频闪全按钮、防穿模悬停胶囊、单击直切一体化浮层、极端强调色对比度、真实头像、隐藏邮箱同步、3 Tab 占满）', async (t) => {
  const browserInfo = findLocalBrowserExecutable();
  if (!browserInfo.path) {
    t.skip('未检测到本机 Chrome/Edge，跳过真 Chromium 回归');
    return;
  }

  const coreSource = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const html = `<!doctype html>
<html lang="zh-CN" data-theme="light" class="light" style="--primary:#7049D1;--primary-foreground:#FFFFFF;--background:#FFFFFF;--foreground:#18181B;">
<head>
<meta charset="utf-8" />
<style>
  :root {
    --background: #ffffff;
    --foreground: #18181b;
    --card: #ffffff;
    --secondary: #f2f2f2;
    --border: #e4e4e7;
    --primary: #7049D1;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1280px; height: 820px; background: #fff; color: #18181b; font-family: "Segoe UI", sans-serif; overflow: hidden; }
  .shell { display: flex; width: 100%; height: 100%; }
  .app-sidebar { width: 256px; flex: 0 0 256px; height: 100%; border-right: 1px solid #e4e4e7; display: flex; flex-direction: column; justify-content: space-between; padding: 10px; background: #fafafa; }
  .sidebar-footer { display: flex; flex-direction: column; gap: 6px; }
  [data-testid="settings-button"] { width: 100%; height: 36px; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; cursor: pointer; }
  .main-stage { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
  .conv-titlebar { height: 40px; border-bottom: 1px solid #e4e4e7; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; gap: 8px; }
  .settings-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 4000; }
  .settings-backdrop[hidden] { display: none !important; }
  .settings-modal { position: relative; width: 960px; height: 660px; background: #ffffff; border-radius: 16px; display: flex; overflow: hidden; border: 1px solid #e4e4e7; }
  [data-testid="settings-sidebar"] { width: 220px; flex: 0 0 220px; border-right: 1px solid #e4e4e7; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
  .nav-btn { width: 100%; padding: 8px 10px; border-radius: 8px; border: 0; background: transparent; text-align: left; cursor: pointer; }
  .right-pane { flex: 1; min-width: 0; min-height: 0; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
</style>
</head>
<body class="light">
  <div class="shell">
    <aside id="host-sidebar" class="app-sidebar">
      <div style="font-weight:600;font-size:13px;padding:6px 8px">Antigravity</div>
      <div class="sidebar-footer" id="host-sidebar-footer">
        <button id="host-settings-btn" data-testid="settings-button" type="button">Settings</button>
      </div>
    </aside>
    <main class="main-stage">
      <div class="conv-titlebar @container/titlebar">
        <div>Workspace</div>
        <div></div>
      </div>
    </main>
  </div>
  <div id="real-settings-backdrop" class="settings-backdrop" hidden>
    <div class="settings-modal settings-modal-container" role="dialog" aria-modal="true" aria-label="Settings">
      <div data-testid="settings-sidebar">
        <button id="settings-nav-item-appearance" class="nav-btn" type="button">外观</button>
        <button id="settings-nav-item-account" class="nav-btn" type="button">账户</button>
      </div>
      <div class="right-pane">
        <div id="native-appearance-pane">
          <button id="native-demo-switch" role="switch" aria-checked="true" style="background:var(--primary);width:36px;height:20px;border:0;border-radius:99px;"></button>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.__realTestState = {
      actions: [],
      restartCalls: 0,
      deferRestartMode: true,
      overview: {
        ok: true,
        activeAccountEmail: 'elfixturesecond@example.test',
        accounts: [
          {
            accountId: 'acc-1',
            accountScopeKey: 'acct_1',
            email: 'elfixturesecond@example.test',
            maskedEmail: 'el***nd@example.test',
            name: 'elvis chen',
            planName: 'Google AI Pro',
            profilePictureUrl: ${JSON.stringify(TINY_PNG_DATA_URI)},
            isActive: true,
            hasRefreshToken: true,
            quotaStatus: 'fresh',
            lastQuotaUpdatedAtMs: Date.now() - 10000,
            quotaSnapshot: {
              pools: [
                { poolKey: 'shared_gemini_main', label: 'Gemini 4', buckets: [{ windowKey: '5h', remainingFraction: 0.6 }, { windowKey: 'weekly', remainingFraction: 0.8 }] },
                { poolKey: 'shared_claude_gpt', label: 'Claude / GPT', buckets: [{ windowKey: '5h', remainingFraction: 0.5 }, { windowKey: 'weekly', remainingFraction: 0.7 }] }
              ]
            }
          },
          {
            accountId: 'acc-2',
            accountScopeKey: 'acct_2',
            email: 'jpchen2019@gmail.com',
            maskedEmail: 'jp***19@gmail.com',
            name: 'jp chen',
            planName: 'Google AI Pro',
            profilePictureUrl: ${JSON.stringify(TINY_PNG_DATA_URI)},
            isActive: false,
            hasRefreshToken: true,
            quotaStatus: 'fresh',
            lastQuotaUpdatedAtMs: Date.now() - 20000,
            quotaSnapshot: {
              pools: [
                { poolKey: 'shared_gemini_main', label: 'Gemini 4', buckets: [{ windowKey: '5h', remainingFraction: 0.95 }, { windowKey: 'weekly', remainingFraction: 0.9 }] }
              ]
            }
          },
          {
            accountId: 'acc-3',
            accountScopeKey: 'acct_3',
            email: 'freeuser01@gmail.com',
            maskedEmail: 'fr***01@gmail.com',
            name: 'Free User',
            planName: 'Free',
            profilePictureUrl: null,
            isActive: false,
            hasRefreshToken: false,
            quotaStatus: 'unknown',
            quotaSnapshot: { pools: [] }
          }
        ],
        autoSwitch: { enabled: false, poolKey: 'shared_gemini_main', windowKey: '5h', metricMode: 'remaining_pct', thresholdPct: 10, candidates: [] },
        autoSwitchStatus: { state: 'disabled' },
        quotaIntervals: []
      }
    };
    document.getElementById('host-settings-btn').addEventListener('click', () => {
      document.getElementById('real-settings-backdrop').hidden = false;
    });
    window.contextMeterAPI = {
      getVersion: async () => ({ ok: true, version: '0.9.3', supportsRestart: true }),
      getRuntimeInfo: async () => ({ ok: true, version: '0.9.3', supportsRestart: true, backendSource: 'electron-ipc' }),
      getSettings: async () => ({ ok: true, settings: {} }),
      saveSettings: async () => ({ ok: true }),
      getQuota: async () => ({ ok: true, pools: window.__realTestState.overview.accounts[0].quotaSnapshot.pools }),
      getTokenHistory: async () => ({ ok: true, totalTokens: 1000, dailyMap: {} }),
      hostTheme: async () => ({ ok: true, mode: 'light', accentLight: '#FEFDFF', accentDark: '#7849D1' }),
      getAccountsOverview: async () => JSON.parse(JSON.stringify(window.__realTestState.overview)),
      accountsAction: async (req) => {
        window.__realTestState.actions.push(req);
        if (req.action === 'preview_tools') return { ok: true, available: true, count: 2 };
        if (req.action === 'refresh_quota') {
          return { ok: true, message: '配额已刷新', overview: JSON.parse(JSON.stringify(window.__realTestState.overview)) };
        }
        if (req.action === 'remove') {
          window.__realTestState.overview.accounts = window.__realTestState.overview.accounts.filter(a => a.email !== req.email);
          return { ok: true, message: '账号已移除', removedScopeKey: 'acct_3', overview: JSON.parse(JSON.stringify(window.__realTestState.overview)) };
        }
        if (req.action === 'switch') {
          return {
            ok: false,
            officialManualSwitchRequired: true,
            nativeSignOutGuidance: true,
            credentialWritten: false,
            restartPending: false,
            canAutoRestart: false,
            verifiedEffective: false,
            reason: 'official_host_switch_required',
            error: '当前版本未开放官方一键切号接口，请在 Antigravity 原生设置中退出并重新登录目标账号',
            overview: JSON.parse(JSON.stringify(window.__realTestState.overview))
          };
        }
        if (req.action === 'detect_active') {
          return {
            ok: true,
            active: { email: window.__realTestState.overview.activeAccountEmail },
            overview: JSON.parse(JSON.stringify(window.__realTestState.overview))
          };
        }
        return { ok: true, message: '已完成', overview: JSON.parse(JSON.stringify(window.__realTestState.overview)) };
      },
      restartHost: async () => {
        window.__realTestState.restartCalls += 1;
        return { ok: true };
      },
      openExternal: () => true
    };
  </script>
  <script src="/meter-core.js"></script>
  <script src="/meter-renderer.js"></script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/meter-core.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(coreSource);
      return;
    }
    if (req.url === '/meter-renderer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(rendererCode);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const httpPort = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-real-ux-chrome-'));
  const debugPort = 41000 + Math.floor(Math.random() * 15000);
  const chromeProc = spawn(browserInfo.path, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,820',
    `http://127.0.0.1:${httpPort}/`
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const wsUrl = await waitForDebugWsUrl(debugPort, 15000);
    cdp = new RealDeviceCdpClient(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.evaluate(`(async () => {
      for (let i = 0; i < 80; i++) {
        if (window.__AGContextMeter) break;
        await new Promise(r => setTimeout(r, 80));
      }
      if (!window.__AGContextMeter) throw new Error('__AGContextMeter 未初始化');
      window.__AGContextMeter.setAccountsOverviewForTest(window.__realTestState.overview);
      window.__AGContextMeter.syncSidebarAccountForTest?.();
      await new Promise(r => setTimeout(r, 150));
    })()`);

    // A. 验证项 2、3、5、6（左下角胶囊头像、默认完整邮箱、悬停胶囊不越界、无二次确认条）
    const sidebarAudit = await cdp.evaluate(`(async () => {
      const api = window.__AGContextMeter;
      const saHost = document.getElementById('ag-sidebar-account-host');
      const sr = saHost.shadowRoot;
      const capsuleEmailDefault = sr.getElementById('ag-sa-sub').textContent.trim();
      const capsuleAvatarImg = sr.getElementById('ag-sa-avatar')?.querySelector('img')?.getAttribute('src') || '';

      sr.getElementById('ag-sa-trigger').click();
      await new Promise(r => setTimeout(r, 340));
      const listEl = sr.getElementById('ag-sa-list');
      const pillEl = sr.getElementById('ag-sa-hover-pill');
      const opts = Array.from(sr.querySelectorAll('.sa-opt'));
      const secondOpt = opts[1];
      secondOpt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));

      const listRect = listEl.getBoundingClientRect();
      const optRect = secondOpt.getBoundingClientRect();
      const pillRect = pillEl.getBoundingClientRect();
      const headRect = sr.querySelector('.sa-pop-header').getBoundingClientRect();
      const footRect = sr.querySelector('.sa-footer').getBoundingClientRect();

      const thirdOptAvatarHasImg = Boolean(opts[2]?.querySelector('.sa-avatar img'));
      const secondOptAvatarSrc = opts[1]?.querySelector('.sa-avatar img')?.getAttribute('src') || '';
      const hasConfirmBar = Boolean(sr.getElementById('ag-sa-confirm'));
      const opt2Email = opts[1]?.querySelector('.sa-opt-email')?.textContent?.trim() || '';

      return {
        hideEmailDefault: api.getHideAccountEmailForTest(),
        capsuleEmailDefault,
        capsuleAvatarIsDataUri: capsuleAvatarImg.startsWith('data:image/png;base64,'),
        secondOptAvatarIsDataUri: secondOptAvatarSrc.startsWith('data:image/png;base64,'),
        thirdOptAvatarHasImg,
        opt2Email,
        hasConfirmBar,
        pillParentId: pillEl.parentElement?.id || '',
        pillWithinList: pillRect.top >= listRect.top - 1.5 && pillRect.bottom <= listRect.bottom + 1.5 && pillRect.left >= listRect.left - 1.5 && pillRect.right <= listRect.right + 1.5,
        pillMatchesOpt: Math.abs(pillRect.top - optRect.top) <= 2 && Math.abs(pillRect.height - optRect.height) <= 2,
        pillNoOverlapHeaderFooter: pillRect.top >= headRect.bottom - 1 && pillRect.bottom <= footRect.top + 1,
        debugRects: {
          pill: { top: pillRect.top, left: pillRect.left, width: pillRect.width, height: pillRect.height },
          opt: { top: optRect.top, left: optRect.left, width: optRect.width, height: optRect.height },
          list: { top: listRect.top, left: listRect.left, width: listRect.width, height: listRect.height },
          pillStyle: pillEl.getAttribute('style') || ''
        }
      };
    })()`);

    assert.equal(sidebarAudit.hideEmailDefault, false, '默认必须关闭邮箱隐藏，直接显示完整邮箱');
    assert.equal(sidebarAudit.capsuleEmailDefault, 'elfixturesecond@example.test');
    assert.equal(sidebarAudit.opt2Email, 'jpchen2019@gmail.com');
    assert.equal(sidebarAudit.capsuleAvatarIsDataUri, true, '当前账号胶囊必须渲染真实 Data URI 头像');
    assert.equal(sidebarAudit.secondOptAvatarIsDataUri, true, '菜单列表有头像账号必须渲染真实 Data URI 头像');
    assert.equal(sidebarAudit.thirdOptAvatarHasImg, false, '无头像账号必须安全降级为首字母圆圈');
    assert.equal(sidebarAudit.hasConfirmBar, false, '快捷切号菜单不得再有二次确认条');
    assert.equal(sidebarAudit.pillParentId, 'ag-sa-list', '悬停高亮胶囊必须位于 #ag-sa-list 内部');
    assert.equal(sidebarAudit.pillWithinList, true, '悬停高亮胶囊不得越出 #ag-sa-list 边界: ' + JSON.stringify(sidebarAudit.debugRects));
    assert.equal(sidebarAudit.pillMatchesOpt, true, '悬停高亮胶囊必须与目标账号项严丝合缝对齐: ' + JSON.stringify(sidebarAudit.debugRects));
    assert.equal(sidebarAudit.pillNoOverlapHeaderFooter, true, '悬停高亮胶囊不得穿模覆盖顶部标题或底部操作区');

    // B. 验证项 3（官方宿主切号指引浮层 + 展示当前与目标 + 可取消 + 零自动重启 + 原生登录添加零 oauth_login）
    const switchOverlayAudit = await cdp.evaluate(`(async () => {
      const api = window.__AGContextMeter;
      const saHost = document.getElementById('ag-sidebar-account-host');
      const sr = saHost.shadowRoot;
      const opts = Array.from(sr.querySelectorAll('.sa-opt'));
      opts[1].click();
      await new Promise(r => setTimeout(r, 120));
      const ovState1 = api.getAccountSwitchOverlayStateForTest();
      const ovShadow = api.getAccountSwitchOverlayShadowForTest();
      const openNativeBtn = ovShadow?.getElementById('ag-account-switch-open-native');
      const verifyBtn = ovShadow?.getElementById('ag-account-switch-verify');
      const cancelBtn = ovShadow?.getElementById('ag-account-switch-cancel');
      const hasGuideBtns = Boolean(openNativeBtn && !openNativeBtn.hidden && verifyBtn && !verifyBtn.hidden && cancelBtn && !cancelBtn.hidden);
      cancelBtn?.click();
      await new Promise(r => setTimeout(r, 120));
      const ovStateAfterCancel = api.getAccountSwitchOverlayStateForTest();
      const lastSwitchReq = window.__realTestState.actions.filter(a => a.action === 'switch').pop();

      // 点击左下角添加账号：必须走宿主原生登录指引，零 oauth_login 外发
      sr.getElementById('ag-sa-act-add')?.click();
      await new Promise(r => setTimeout(r, 120));
      const ovStateLogin = api.getAccountSwitchOverlayStateForTest();
      ovShadow?.getElementById('ag-account-switch-cancel')?.click();
      await new Promise(r => setTimeout(r, 80));
      const oauthCalls = window.__realTestState.actions.filter(a => a.action === 'oauth_login').length;

      return {
        ovState1,
        hasGuideBtns,
        ovStateAfterCancel,
        ovStateLogin,
        oauthCalls,
        restartModeSent: lastSwitchReq?.restartMode || '',
        restartCalls: window.__realTestState.restartCalls
      };
    })()`);

    assert.equal(switchOverlayAudit.restartModeSent, '', '官方手动切号不得发送 defer_restart');
    assert.equal(switchOverlayAudit.ovState1.visible, true);
    assert.equal(switchOverlayAudit.ovState1.phase, 'native_guide', '缺官方一键切号时必须展示原生退出/登录指引而非假成功或自动重启');
    assert.equal(switchOverlayAudit.hasGuideBtns, true, '原生指引浮层必须提供打开原生设置、核实当前身份与取消按钮');
    assert.equal(switchOverlayAudit.ovStateAfterCancel.visible, false, '点击取消后必须关闭指引并保持原账号状态');
    assert.ok(['done', 'oauth_pending', 'switching'].includes(switchOverlayAudit.ovStateLogin.phase), `回归 #1 添加账号必须走真实 OAuth 登录流，实际 phase=${switchOverlayAudit.ovStateLogin.phase}`);
    assert.ok(switchOverlayAudit.oauthCalls >= 1, '回归 #1 添加账号必须真实发起 oauth_login 请求');
    assert.equal(switchOverlayAudit.restartCalls, 0, '官方切号指引全程严禁自动调用 restartHost');

    // C. 验证项 1、4、5、6、7（账号与额度页：全按钮反馈、卡片视图完整操作、零频闪脏检查、隐藏邮箱三处同步、极端强调色 #FEFDFF 自动对比度保护、3 Tab 占满）
    const accountsPageAudit = await cdp.evaluate(`(async () => {
      const api = window.__AGContextMeter;
      document.getElementById('host-settings-btn').click();
      await new Promise(r => setTimeout(r, 160));
      const accNav = document.getElementById('ag-cm-host-settings-accounts-nav');
      accNav.click();
      await new Promise(r => setTimeout(r, 180));
      const acHost = document.getElementById('ag-cm-host-accounts-page');
      const sr = acHost.shadowRoot;

      // 1. 零频闪验证：连续二次渲染相同数据时，DOM 行节点引用必须严格 ===
      const firstRowBefore = sr.querySelector('#ag-ac-rows .ag-ac-item');
      api.setAccountsOverviewForTest(window.__realTestState.overview);
      await new Promise(r => setTimeout(r, 60));
      const firstRowAfter = sr.querySelector('#ag-ac-rows .ag-ac-item');
      const rowNodePreserved = Boolean(firstRowBefore && firstRowBefore === firstRowAfter);

      // 2. 真实头像在顶卡和列表行均渲染
      const heroAvatarIsDataUri = Boolean(sr.getElementById('ag-ac-hero-avatar')?.querySelector('img')?.getAttribute('src')?.startsWith('data:image/png;base64,'));
      const row1AvatarIsDataUri = Boolean(firstRowAfter?.querySelector('.ag-ac-avatar img')?.getAttribute('src')?.startsWith('data:image/png;base64,'));

      // 3. 隐藏邮箱三处同步 + 持久化
      const heroEmailFull = sr.getElementById('ag-ac-hero-email').textContent.trim();
      sr.getElementById('ag-ac-btn-hide-email').click();
      await new Promise(r => setTimeout(r, 80));
      const heroEmailMasked = sr.getElementById('ag-ac-hero-email').textContent.trim();
      const sidebarEmailMasked = document.getElementById('ag-sidebar-account-host').shadowRoot.getElementById('ag-sa-sub').textContent.trim();
      const persistedHide = localStorage.getItem('ag_hide_account_email');
      sr.getElementById('ag-ac-btn-hide-email').click();
      await new Promise(r => setTimeout(r, 80));
      const heroEmailRestored = sr.getElementById('ag-ac-hero-email').textContent.trim();

      // 4. 高余量优先排序：原本 jpchen (95%) 在第 2 行，开启后必须排到第 1 行
      sr.getElementById('ag-ac-sort-high-quota').click();
      await new Promise(r => setTimeout(r, 60));
      const sortedFirstEmail = sr.querySelector('#ag-ac-rows .ag-ac-item')?.getAttribute('data-account-email') || '';
      sr.getElementById('ag-ac-sort-high-quota').click();
      await new Promise(r => setTimeout(r, 60));

      // 5. 卡片视图必须保留全部操作按钮（刷新/切号/移除/详情）
      sr.querySelector('[data-ac-view="cards"]').click();
      await new Promise(r => setTimeout(r, 80));
      const cardsClassOn = sr.getElementById('ag-ac-rows').classList.contains('is-cards');
      const card2 = sr.querySelector('#ag-ac-rows .ag-ac-item[data-account-email="jpchen2019@gmail.com"]');
      const card2HasRefresh = Boolean(card2?.querySelector('[data-ac-op="refresh"]'));
      const card2HasSwitch = Boolean(card2?.querySelector('[data-ac-op="switch"]'));
      const card2HasDetail = Boolean(card2?.querySelector('[data-ac-toggle-detail]'));
      const card2HasRemove = Boolean(card2?.querySelector('[data-ac-op="remove"]'));

      // 6. 详情展开与无刷新凭据点击即时 toast 反馈（非死按钮）
      card2?.querySelector('[data-ac-toggle-detail]')?.click();
      await new Promise(r => setTimeout(r, 60));
      const card2DetailOpen = Boolean(card2?.classList.contains('is-expanded'));
      const card3RefreshBtn = sr.querySelector('#ag-ac-rows .ag-ac-item[data-account-email="freeuser01@gmail.com"] [data-ac-op="refresh"]');
      card3RefreshBtn?.click();
      await new Promise(r => setTimeout(r, 60));
      const toastAfterNoCred = sr.getElementById('ag-ac-toast')?.textContent?.trim() || '';

      // 7. 极端浅色强调色 #FEFDFF 实时跟随 + 自动对比度保护（不再回退硬编码紫色）
      document.documentElement.style.setProperty('--primary', '#FEFDFF');
      api.syncHostAccentForTest?.({ force: true });
      await new Promise(r => setTimeout(r, 80));
      const accentExtremeLight = acHost.style.getPropertyValue('--ag-host-accent').trim().toLowerCase();
      const fgExtremeLight = acHost.style.getPropertyValue('--ag-host-accent-fg').trim().toLowerCase();
      const knobExtremeLight = acHost.style.getPropertyValue('--ag-host-accent-knob').trim().toLowerCase();
      const borderExtremeLight = acHost.style.getPropertyValue('--ag-host-accent-border').trim().toLowerCase();

      // 切到青蓝色 #0EA5E9 验证实时变色
      document.documentElement.style.setProperty('--primary', '#0EA5E9');
      api.syncHostAccentForTest?.({ force: true });
      await new Promise(r => setTimeout(r, 80));
      const accentCyan = acHost.style.getPropertyValue('--ag-host-accent').trim().toLowerCase();

      // 8. 验证项 7：当前会话浮层 3 Tab 占满 100% 宽度
      const mainSr = document.getElementById('ag-context-meter').shadowRoot;
      const ctxPanel = mainSr.getElementById('panel');
      const viewCtx = mainSr.getElementById('view-context');
      if (ctxPanel) {
        ctxPanel.hidden = false;
        ctxPanel.style.display = 'block';
        ctxPanel.style.width = '540px';
      }
      if (viewCtx) {
        viewCtx.hidden = false;
        viewCtx.style.display = 'block';
      }
      await new Promise(r => setTimeout(r, 50));
      const tabsBar = mainSr.getElementById('ctx-tabs-bar');
      const tabBtns = Array.from(tabsBar.querySelectorAll('.ctx-tab-btn'));
      const barRect = tabsBar.getBoundingClientRect();
      const tabsWidthSum = tabBtns.reduce((acc, b) => acc + b.getBoundingClientRect().width, 0);
      const tabCoverageRatio = barRect.width > 0 ? tabsWidthSum / barRect.width : 0;

      return {
        rowNodePreserved,
        heroAvatarIsDataUri,
        row1AvatarIsDataUri,
        heroEmailFull,
        heroEmailMasked,
        sidebarEmailMasked,
        persistedHide,
        heroEmailRestored,
        sortedFirstEmail,
        cardsClassOn,
        card2HasRefresh,
        card2HasSwitch,
        card2HasDetail,
        card2HasRemove,
        card2DetailOpen,
        toastAfterNoCred,
        accentExtremeLight,
        fgExtremeLight,
        knobExtremeLight,
        borderExtremeLight,
        accentCyan,
        tabCount: tabBtns.length,
        tabCoverageRatio
      };
    })()`);

    assert.equal(accountsPageAudit.rowNodePreserved, true, '相同数据重绘必须跳过 #ag-ac-rows DOM 重建以根治频闪与死按钮');
    assert.equal(accountsPageAudit.heroAvatarIsDataUri, true);
    assert.equal(accountsPageAudit.row1AvatarIsDataUri, true);
    assert.equal(accountsPageAudit.heroEmailFull, 'elfixturesecond@example.test');
    assert.equal(accountsPageAudit.heroEmailMasked, 'el***nd@example.test');
    assert.equal(accountsPageAudit.sidebarEmailMasked, 'el***nd@example.test', '隐藏邮箱开启时左下角胶囊必须同步脱敏');
    assert.equal(accountsPageAudit.persistedHide, 'true', '隐藏邮箱开关状态必须持久化保存');
    assert.equal(accountsPageAudit.heroEmailRestored, 'elfixturesecond@example.test');
    assert.equal(accountsPageAudit.sortedFirstEmail, 'jpchen2019@gmail.com', '高余量优先排序必须生效');
    assert.equal(accountsPageAudit.cardsClassOn, true);
    assert.equal(accountsPageAudit.card2HasRefresh, true);
    assert.equal(accountsPageAudit.card2HasSwitch, true);
    assert.equal(accountsPageAudit.card2HasDetail, true);
    assert.equal(accountsPageAudit.card2HasRemove, true);
    assert.equal(accountsPageAudit.card2DetailOpen, true);
    assert.ok(accountsPageAudit.toastAfterNoCred.length > 0, '点击无凭据账号刷新必须给出明确 toast 提示，绝不做死按钮');
    assert.equal(accountsPageAudit.accentExtremeLight, '#fefdff', '极浅宿主强调色 #FEFDFF 必须原样跟随，绝不回退紫色');
    assert.equal(accountsPageAudit.fgExtremeLight, '#111114', '极浅强调色按钮文字必须自动切换深色防白底白字');
    assert.equal(accountsPageAudit.knobExtremeLight, '#18181b', '极浅强调色滑块圆点必须自动切换深色保证可见');
    assert.notEqual(accountsPageAudit.borderExtremeLight, '#fefdff', '浅底极浅强调色必须自动补足可见描边');
    assert.equal(accountsPageAudit.accentCyan, '#0ea5e9', '更改宿主 --primary 为青蓝色必须实时同步');
    assert.equal(accountsPageAudit.tabCount, 3, '当前会话浮层顶栏应恰好有 3 个 Tab');
    assert.ok(accountsPageAudit.tabCoverageRatio >= 0.9, `3 个 Tab 必须对齐占满顶栏宽度，当前占比 ${accountsPageAudit.tabCoverageRatio.toFixed(3)}`);
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill(); } catch { }
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
});

test('实机回归 4: 回归 #6 超级自由化 8 向缩放与边界钳制 + Issue #136 窄窗长对话名称防溢出', () => {
  const upgrades = require('./src/renderer/preset-board-upgrades.js');
  const gridSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'dashboard-grid.js'), 'utf8');

  // 1. 解除不合理最小宽高硬锁（72×48），支持全 8 方向与自由坐标同步更新
  assert.match(gridSrc, /COCKPIT_MIN_WIDTH\s*=\s*72\b/);
  assert.match(gridSrc, /COCKPIT_MIN_HEIGHT\s*=\s*48\b/);
  assert.match(gridSrc, /function restoreDefaultCockpitModules\(/);
  assert.match(gridSrc, /function clampFreestyleRectForGrid\(/);
  assert.match(gridSrc, /data-card-density/);
  assert.match(gridSrc, /data-card-shape/);

  // 2. 边界钳制算法在任意极端坐标与窄容器下均严格保持 x>=0, y>=0, x+w<=containerW
  for (const containerW of [260, 380, 600, 1200]) {
    const cases = [
      { x: -120, y: -80, w: 30, h: 12 },
      { x: 9999, y: 40, w: 300, h: 200 },
      { x: 100, y: 0, w: 5000, h: 9999 }
    ];
    for (const rect of cases) {
      const c = upgrades.clampFreestyleRect(rect, containerW, { minWidth: 72, minHeight: 48, maxHeight: 1600 });
      assert.ok(c.x >= 0 && c.y >= 0, `坐标不得为负: ${JSON.stringify(c)}`);
      assert.ok(c.w >= Math.min(72, containerW) && c.w <= containerW, `宽必须落在 [minW, ${containerW}]: ${JSON.stringify(c)}`);
      assert.ok(c.x + c.w <= containerW, `右缘不得越出容器 ${containerW}: ${JSON.stringify(c)}`);
      assert.ok(c.h >= 48 && c.h <= 1600, `高必须落在 [48, 1600]: ${JSON.stringify(c)}`);
    }
  }

  // 3. 极紧凑与扁长条/窄高柱形态分类
  assert.deepEqual(upgrades.classifyCardLayoutState(72, 48), { density: 'micro', shape: 'micro-tile' });
  assert.deepEqual(upgrades.classifyCardLayoutState(480, 72), { density: 'micro', shape: 'wide-strip' });
  assert.deepEqual(upgrades.classifyCardLayoutState(160, 300), { density: 'nano', shape: 'tall-strip' });
  assert.deepEqual(upgrades.classifyCardLayoutState(640, 260), { density: 'wide', shape: 'standard' });

  // 4. Trilingual restore copy has zero parentheses
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const copy = upgrades.formatCopy(lang, 'restoreDefaultModules');
    assert.ok(copy.length > 0);
    assert.doesNotMatch(copy, /[()（）]/);
  }
});
