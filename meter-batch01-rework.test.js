const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const asarEngine = require('./asar-engine.js');
const meterAccounts = require('./meter-accounts.js');
const localApi = require('./local-api.js');
const meterCore = require('./meter-core.js');

/**
 * 探测本机可用的 Chrome / Edge 可执行文件（独立实现，避免加载其他测试文件）
 */
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

/**
 * 简易 CDP 客户端（用于本批真 Chromium 实机交互测试）
 */
class Batch01CdpClient {
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
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chromium DevTools 页面未在超时时间内就绪');
}

async function createFakeHostAsarDir(rootDir, label = '2.35.2') {
  const resDir = path.join(rootDir, 'resources');
  const unpackedDir = path.join(resDir, 'app.asar.unpacked');
  fs.mkdirSync(unpackedDir, { recursive: true });
  const stageDir = path.join(rootDir, '_stage_asar');
  fs.mkdirSync(path.join(stageDir, 'out', 'vs', 'workbench'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({
    name: 'antigravity',
    version: label,
    main: './out/main.js'
  }), 'utf8');
  fs.writeFileSync(path.join(stageDir, 'dist', 'utils.js'), 'module.exports = {};\n', 'utf8');
  fs.writeFileSync(path.join(stageDir, 'out', 'main.js'), 'console.log("antigravity host");\n', 'utf8');
  fs.writeFileSync(path.join(stageDir, 'out', 'vs', 'workbench', 'workbench.html'), '<html><body>workbench</body></html>', 'utf8');
  const asarPath = path.join(resDir, 'app.asar');
  const engine = asarEngine.loadAsarEngine();
  await engine.createPackage(stageDir, asarPath);
  fs.rmSync(stageDir, { recursive: true, force: true });
  return { rootDir, resDir, asarPath, unpackedDir };
}

test('第 01 批 / #118 + #58：工具步骤独立短动作词精准汉化且零误翻正文/代码/思考/输入/文件名，双份运行时逐字节一致', () => {
  const srcRuntime = fs.readFileSync(path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');
  const distRuntime = fs.readFileSync(path.join(__dirname, 'i18n', 'i18n-runtime.js'), 'utf8');
  assert.equal(srcRuntime, distRuntime, 'src/i18n/i18n-runtime.js 与 i18n/i18n-runtime.js 必须逐字节一致');

  function makeEl(tag, opts = {}) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className: opts.className || '',
      parentElement: null,
      childNodes: [],
      children: [],
      hasAttribute: (k) => attrs.has(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      querySelectorAll: () => [],
      get textContent() {
        return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('');
      },
      closest(sel) {
        let cur = this;
        const parts = sel.split(',').map((s) => s.trim());
        while (cur) {
          for (const p of parts) {
            if (p.startsWith('[') && p.endsWith(']')) {
              const inner = p.slice(1, -1);
              const eqIdx = inner.indexOf('=');
              if (eqIdx > 0) {
                const k = inner.slice(0, eqIdx);
                const v = inner.slice(eqIdx + 1).replace(/^"|"$/g, '');
                if (cur.getAttribute(k) === v) return cur;
              } else if (cur.hasAttribute(inner)) {
                return cur;
              }
            } else if (p.startsWith('.')) {
              const cls = p.slice(1);
              if ((cur.className || '').split(/\s+/).includes(cls)) return cur;
            } else if (cur.tagName && cur.tagName.toLowerCase() === p.toLowerCase()) {
              return cur;
            }
          }
          cur = cur.parentElement;
        }
        return null;
      }
    };
    el.firstChild = null;
    el.nextSibling = null;
    if (opts.text) {
      const tn = { nodeType: 3, nodeValue: opts.text, parentElement: el, nextSibling: null };
      el.childNodes.push(tn);
      el.firstChild = tn;
    }
    return el;
  }
  function append(parent, child) {
    child.parentElement = parent;
    child.nextSibling = null;
    if (parent.childNodes.length > 0) {
      parent.childNodes[parent.childNodes.length - 1].nextSibling = child;
    } else {
      parent.firstChild = child;
    }
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
  }

  // 在隔离沙盒中运行真实 i18n-runtime.js，挂载 __AGY_TRANSLATE_EL__
  const docBody = makeEl('body');
  const fakeDoc = {
    body: docBody,
    documentElement: docBody,
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => { },
    createTreeWalker(rootNode) {
      const list = [];
      const walk = (n) => {
        for (const c of (n.childNodes || [])) {
          if (c.nodeType === 3) list.push(c);
          else if (c.nodeType === 1) walk(c);
        }
      };
      walk(rootNode);
      let idx = -1;
      return {
        nextNode() {
          idx += 1;
          return idx < list.length ? list[idx] : null;
        }
      };
    }
  };
  const sb = {
    window: null,
    document: fakeDoc,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() { } disconnect() { } },
    setTimeout: () => 0,
    clearTimeout: () => { },
    console
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.__AGY_I18N_CONFIG__ = { enabled: true, language: 'zh-CN', brandTitle: 'english' };
  sb.__AGY_I18N_DATA__ = {
    exact: {
      Ran: '已运行',
      Analyzed: '已分析',
      Edited: '已编辑',
      Settings: '设置'
    },
    patterns: []
  };
  vm.runInNewContext(srcRuntime, sb);
  assert.equal(typeof sb.__AGY_TRANSLATE_EL__, 'function', 'i18n-runtime 必须暴露 __AGY_TRANSLATE_EL__');

  const toolStep = makeEl('div', { attrs: { 'data-testid': 'mcp-tool-step' } });
  const ranLabel = append(toolStep, makeEl('span', { text: 'Ran' }));
  const analyzedLabel = append(toolStep, makeEl('span', { text: 'Analyzed' }));
  const editedLabel = append(toolStep, makeEl('span', { text: 'Edited' }));
  const fileNameSpan = append(toolStep, makeEl('span', { text: 'Ran.ts' }));
  const codeBlock = append(toolStep, makeEl('code', { text: 'Edited' }));

  const assistantMsg = makeEl('div', { attrs: { 'data-role': 'assistant' } });
  const mdBody = append(assistantMsg, makeEl('div', { className: 'markdown-body' }));
  const bodyPara = append(mdBody, makeEl('p', { text: 'Edited' }));
  const proseLong = append(mdBody, makeEl('p', { text: 'Analyzed the repository layout' }));
  const thinkingBox = append(assistantMsg, makeEl('div', { className: 'thinking-content' }));
  const thinkingWord = append(thinkingBox, makeEl('span', { text: 'Ran' }));
  const inputBox = makeEl('textarea', { text: 'Edited' });

  sb.__AGY_TRANSLATE_EL__(toolStep);
  sb.__AGY_TRANSLATE_EL__(assistantMsg);
  sb.__AGY_TRANSLATE_EL__(inputBox);

  assert.equal(ranLabel.childNodes[0].nodeValue, '已运行', 'mcp-tool-step 内独立动作词 Ran 应汉化');
  assert.equal(analyzedLabel.childNodes[0].nodeValue, '已分析', 'mcp-tool-step 内独立动作词 Analyzed 应汉化');
  assert.equal(editedLabel.childNodes[0].nodeValue, '已编辑', 'mcp-tool-step 内独立动作词 Edited 应汉化');
  assert.equal(fileNameSpan.childNodes[0].nodeValue, 'Ran.ts', '文件名 Ran.ts 必须保留原文');
  assert.equal(codeBlock.childNodes[0].nodeValue, 'Edited', '代码块内文本必须保留原文');
  assert.equal(bodyPara.childNodes[0].nodeValue, 'Edited', '助手 Markdown 正文段落必须保留原文 (#58 保护)');
  assert.equal(proseLong.childNodes[0].nodeValue, 'Analyzed the repository layout', '助手长句必须保留原文');
  assert.equal(thinkingWord.childNodes[0].nodeValue, 'Ran', '思考正文内容必须保留原文');
  assert.equal(inputBox.childNodes[0].nodeValue, 'Edited', '用户输入区域必须保留原文');
});

test('第 01 批 / #109 + #116 + #113：非默认盘含空格中文路径自定义 Antigravity 安装目录读写、优先级、校验与清除闭环', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-batch01-custom-path-'));
  const origStateEnv = process.env.AG_METER_STATE_DIR;
  const origAsarEnv = process.env.AG_ASAR_PATH;
  try {
    const stateDir = path.join(tmpBase, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.AG_METER_STATE_DIR = stateDir;
    delete process.env.AG_ASAR_PATH;

    // 模拟非默认盘含空格与中文的安装目录，以及第二个安装目录（用于测试 --path 覆盖优先）
    const customApp = await createFakeHostAsarDir(path.join(tmpBase, 'F盘模拟 Apps', 'Antigravity 测试'), '2.35.2');
    const cliOverrideApp = await createFakeHostAsarDir(path.join(tmpBase, 'G盘模拟', 'Antigravity Override'), '2.35.9');

    // 1. 校验无效目标必须明确失败并附带原因
    const badInspect = asarEngine.inspectCustomAsarPath(path.join(tmpBase, 'not-exists'));
    assert.equal(badInspect.ok, false, '不存在路径必须校验失败');
    assert.ok(badInspect.error, '无效路径必须给出明确错误原因');

    // 2. 传入安装根目录自动解析到 resources/app.asar 并读取宿主版本
    const dirInspect = asarEngine.inspectCustomAsarPath(customApp.rootDir);
    assert.equal(dirInspect.ok, true, '安装根目录应能自动规范化为 resources/app.asar');
    assert.equal(asarEngine.normalizeTargetPathForCompare(dirInspect.asarPath), asarEngine.normalizeTargetPathForCompare(customApp.asarPath));
    assert.equal(dirInspect.hostVersion, '2.35.2');
    assert.equal(asarEngine.normalizeTargetPathForCompare(asarEngine.deriveHostResourcesDirFromAsar(dirInspect.asarPath).resourcesDir), asarEngine.normalizeTargetPathForCompare(customApp.resDir));

    // 3. 保存自定义路径并核对持久化 + resolveAsarTarget 优先级
    const saved = asarEngine.saveConfiguredCustomAsarPath(customApp.rootDir);
    assert.equal(saved.ok, true);
    assert.equal(asarEngine.normalizeTargetPathForCompare(asarEngine.getConfiguredCustomAsarPath()), asarEngine.normalizeTargetPathForCompare(customApp.asarPath));

    const resolvedFromConfig = asarEngine.resolveAsarTarget(null, {});
    assert.equal(resolvedFromConfig.source, 'configured_custom_path');
    assert.equal(asarEngine.normalizeTargetPathForCompare(resolvedFromConfig.asarPath), asarEngine.normalizeTargetPathForCompare(customApp.asarPath));
    assert.equal(resolvedFromConfig.ok, true);

    // 4. 环境变量 AG_ASAR_PATH 高于已保存配置，显式 --path 高于环境变量
    process.env.AG_ASAR_PATH = cliOverrideApp.asarPath;
    const resolvedFromEnv = asarEngine.resolveAsarTarget(null, {});
    assert.match(resolvedFromEnv.source, /env/i);
    assert.equal(asarEngine.normalizeTargetPathForCompare(resolvedFromEnv.asarPath), asarEngine.normalizeTargetPathForCompare(cliOverrideApp.asarPath));

    const resolvedFromExplicit = asarEngine.resolveAsarTarget(customApp.asarPath, {});
    assert.equal(resolvedFromExplicit.source, 'explicit_path');
    assert.equal(asarEngine.normalizeTargetPathForCompare(resolvedFromExplicit.asarPath), asarEngine.normalizeTargetPathForCompare(customApp.asarPath));
    delete process.env.AG_ASAR_PATH;

    // 5. 清除已保存配置后回到自动探测
    const cleared = asarEngine.clearConfiguredCustomAsarPath();
    assert.equal(cleared.ok, true);
    assert.equal(asarEngine.getConfiguredCustomAsarPath(), null);
  } finally {
    if (origStateEnv === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = origStateEnv;
    if (origAsarEnv === undefined) delete process.env.AG_ASAR_PATH;
    else process.env.AG_ASAR_PATH = origAsarEnv;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('第 01 批 / 全客户端主题同步：local-api.js HOST_THEME_ENUM_MAP 与 JetboxWriteState 写入回读确认', async () => {
  assert.equal(localApi.HOST_THEME_ENUM_MAP.auto.enumCode, 1);
  assert.equal(localApi.HOST_THEME_ENUM_MAP.light.enumCode, 2);
  assert.equal(localApi.HOST_THEME_ENUM_MAP.dark.enumCode, 3);
  assert.equal(localApi.normalizeHostThemeValue(2).mode, 'light');
  assert.equal(localApi.normalizeHostThemeValue(3).mode, 'dark');
  assert.equal(localApi.normalizeHostThemeValue(1).mode, 'auto');
  assert.equal(localApi.normalizeHostThemeValue('THEME_MODE_LIGHT').mode, 'light');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-batch01-theme-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ userSettings: { themeMode: 3 } }), 'utf8');
  try {
    let writtenPayload = null;
    const res = await localApi.writeHostThemeMode('light', {
      configPath: cfgPath,
      _callRpc: async (method, body) => {
        assert.match(method, /JetboxWriteState/i);
        writtenPayload = body;
        // 模拟宿主已持久化新 themeMode 到 config.json
        fs.writeFileSync(cfgPath, JSON.stringify({ userSettings: { themeMode: 2 } }), 'utf8');
        return { ok: true, status: 200 };
      }
    });
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'light');
    assert.equal(res.verifiedOnDisk, true);
    assert.ok(writtenPayload, '必须经 JetboxWriteState 下发写入载荷');

    const readBack = localApi.readHostThemeConfig({ configPath: cfgPath });
    assert.equal(readBack.mode, 'light');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('第 01 批 / 第 4 节安全边界：消费版禁止自动切号派发与保活外发、停用账号即刻阻断、官方支持外链放行', async () => {
  assert.equal(meterAccounts.GOOGLE_ANTIGRAVITY_SUPPORT_URL, 'https://antigravity.google/support');
  assert.equal(meterCore.isValidExternalUrl('https://antigravity.google/support'), true, '必须放行 Google 官方支持链接');

  // 停用信号识别：明确 ToS 停用返回 suspended，普通 401/403/429 返回 null 不得误判
  const tosHit = meterAccounts.detectAccountSuspendedSignal({ message: 'Your account has been suspended due to Terms of Service violation', statusCode: 403 });
  assert.equal(tosHit?.suspended, true);
  assert.equal(meterAccounts.detectAccountSuspendedSignal({ message: 'Forbidden', statusCode: 403 }), null, '单凭普通 403 不得标账号停用');
  assert.equal(meterAccounts.detectAccountSuspendedSignal({ message: 'Too Many Requests', statusCode: 429 }), null, '普通 429 限流不得标账号停用');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-batch01-sec-'));
  const prevStateDirEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpDir;
  try {
    const storeFile = path.join(tmpDir, 'accounts_v1.json');
    // 预置旧版升级遗留的 enabled: true 自动切号与保活配置
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 1,
      accounts: [
        {
          id: 'acct-a',
          email: 'alpha.user@gmail.com',
          name: 'Alpha User',
          tierName: 'Google AI Ultra',
          isActive: true,
          lastUsedAtMs: Date.now() - 1000,
          quota: {
            groups: {
              shared_gemini_main: { remainingPct: 4, weeklyRemainingPct: 12 },
              shared_3p_pool: { remainingPct: 80, weeklyRemainingPct: 90 }
            }
          }
        },
        {
          id: 'acct-b',
          email: 'beta.user@gmail.com',
          name: 'Beta User',
          tierName: 'Google AI Pro',
          isActive: false,
          lastUsedAtMs: Date.now() - 86400000,
          quota: {
            groups: {
              shared_gemini_main: { remainingPct: 95, weeklyRemainingPct: 98 },
              shared_3p_pool: { remainingPct: 95, weeklyRemainingPct: 95 }
            }
          }
        }
      ],
      autoSwitch: {
        enabled: true,
        targetKey: 'shared_gemini_main:5h',
        metric: 'remaining_pct',
        thresholdPct: 20,
        candidateEmails: ['alpha.user@gmail.com', 'beta.user@gmail.com']
      },
      keepalive: {
        enabled: true,
        intervalMinutes: 15
      }
    }), 'utf8');

    let switchDispatched = 0;
    let keepaliveDispatched = 0;
    const mgr = meterAccounts.createAccountsManager({
      stateDir: tmpDir,
      homeDir: tmpDir,
      productionAlertOnly: true,
      switchExecutor: async () => { switchDispatched += 1; return { ok: true }; },
      keepaliveExecutor: async () => { keepaliveDispatched += 1; return { ok: true }; }
    });

    // 1. 生产态即使旧配置 enabled:true，也不得自动派发切号或保活外发
    const evalRes = await mgr.evaluateAutoSwitch({ reason: 'upgrade_check', productionAlertOnly: true });
    assert.equal(switchDispatched, 0, '消费版生产态严禁触发自动切号后台派发');
    assert.equal(evalRes?.switched || false, false);
    const kaRes = await mgr.evaluateKeepaliveTick({ productionAlertOnly: true });
    assert.equal(keepaliveDispatched, 0, '消费版生产态严禁触发缓存保活外发');
    assert.equal(kaRes?.ran || false, false);

    // 2. 标记停用后立即阻断刷新与切号，保留本地只读历史，允许显式手动 verify_account 核验
    const markRes = await meterAccounts.dispatchAccountsAction(mgr, {
      action: 'mark_suspended',
      email: 'alpha.user@gmail.com',
      reason: 'Your account has been suspended due to Terms of Service violation'
    });
    assert.equal(markRes.ok, true);
    const ovSuspended = await mgr.getOverviewState();
    const alpha = ovSuspended.accounts.find((a) => a.email === 'alpha.user@gmail.com');
    assert.equal(alpha.suspended, true);
    assert.equal(alpha.supportUrl, 'https://antigravity.google/support');

    const switchBlocked = await meterAccounts.dispatchAccountsAction(mgr, {
      action: 'switch',
      email: 'alpha.user@gmail.com'
    });
    assert.equal(switchBlocked.ok, false, '停用账号不得执行切号');

    const verifyRes = await meterAccounts.dispatchAccountsAction(mgr, {
      action: 'verify_account',
      email: 'alpha.user@gmail.com'
    });
    assert.ok(verifyRes && typeof verifyRes === 'object', '必须支持显式手动核验动作');
  } finally {
    if (prevStateDirEnv === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDirEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('第 01 批 / 三语文案规范：新增与修改三语词条严格零中英文括号，且周期统一 5H / 7D', () => {
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
  const keysToAudit = [
    'mod.zh.badgeOffReady',
    'mod.zh.badgeNotInstalled',
    'mod.zh.badgeActive',
    'settings.quotaBadgeMode.5h',
    'settings.quotaBadgeMode.weekly',
    'settings.quotaBadgeMode.both',
    'accounts.target.gemini5h',
    'accounts.target.gemini7d',
    'accounts.target.claude5h',
    'accounts.target.claude7d',
    'sidebarAccount.quickSwitch',
    'sidebarAccount.addAccount',
    'sidebarAccount.settings',
    'sidebarAccount.planUnknown',
    'sidebarAccount.alreadyActive',
    'accountsPage.navLabel',
    'accountsPage.heading',
    'accountsPage.subtitle',
    'accountsPage.secRules',
    'accountsPage.secPools',
    'accountsPage.secCompare',
    'ns.installPath.browse',
    'ns.installPath.detectedLine',
    'ns.installPath.savedOk',
    'ns.installPath.clearedOk'
  ];

  const lines = i18nSrc.split(/\r?\n/);
  for (const key of keysToAudit) {
    const line = lines.find((l) => l.includes(`'${key}':`));
    assert.ok(line, `必须定义三语词条 ${key}`);
    const valuesPart = line.slice(line.indexOf('{'));
    assert.equal(/[()（）]/.test(valuesPart), false, `词条 ${key} 不得包含任何中英文括号: ${valuesPart}`);
  }
  assert.match(lines.find((l) => l.includes("'mod.zh.badgeOffReady':")), /当前是英语客户端/);
  assert.match(lines.find((l) => l.includes("'mod.zh.badgeActive':")), /当前是中文客户端/);
  assert.match(lines.find((l) => l.includes("'accounts.target.gemini5h':")), /5H/);
  assert.match(lines.find((l) => l.includes("'accounts.target.claude7d':")), /7D/);
});

test('第 01 批 / 真 Chromium CDP 全闭环：底栏账号胶囊、#123/#124/#106、Accent --primary、自绘色板、5/5 候选账号页、开关去冗余、圆球退场与主题同步', async (t) => {
  const browser = findLocalBrowserExecutable();
  if (!browser.path) {
    t.skip('未检测到本机 Chrome/Edge 可执行文件');
    return;
  }

  const coreSource = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

  const fixtureHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>Antigravity 2.35.2 Batch 01 Rework Fixture</title>
<style>
  :root {
    --background: #181818;
    --foreground: #f4f4f4;
    --card: #181818;
    --secondary: #222222;
    --secondary-foreground: #e5e5e5;
    --muted: #1b1b1b;
    --muted-foreground: #969696;
    --border: #262626;
    --input: #141414;
    --accent: #2c2c30; /* 模拟真实宿主 --accent 是中性灰悬停底色 */
    --primary: #ba5f59; /* 模拟真实宿主 --primary 是真实强调色 */
  }
  html.light-theme, html[data-theme="light"] {
    --background: #ffffff;
    --foreground: #141414;
    --card: #ffffff;
    --secondary: #f2f2f2;
    --secondary-foreground: #222222;
    --muted: #f3f3f3;
    --muted-foreground: #666666;
    --border: #e4e4e4;
    --input: #ffffff;
    --accent: #ececef;
    --primary: #ba5f59;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:100vw; height:100vh; overflow:hidden; background:var(--background); color:var(--foreground); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .shell { display:flex; width:100%; height:100%; }
  .app-sidebar { width:240px; flex:0 0 240px; display:flex; flex-direction:column; justify-content:space-between; border-right:1px solid var(--border); padding:10px; background:var(--background); }
  .app-sidebar.collapsed { width:56px; flex:0 0 56px; padding:10px 6px; }
  .sidebar-footer { display:flex; flex-direction:column; gap:6px; }
  [data-testid="settings-button"] { display:flex; align-items:center; gap:8px; width:100%; height:36px; padding:0 10px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--foreground); cursor:pointer; }
  .main-stage { flex:1; display:flex; flex-direction:column; position:relative; }
  .tmb { height:32px; display:flex; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid var(--border); }
  .conv-titlebar { height:40px; display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid var(--border); }
  .settings-backdrop { position:fixed; inset:0; z-index:4000; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,0.52); }
  .settings-backdrop[hidden] { display:none !important; }
  .settings-modal { position:relative; width:960px; max-width:96vw; height:640px; max-height:calc(100vh - 48px); background:var(--background); border:1px solid var(--border); border-radius:16px; display:flex; overflow:hidden; }
  [data-testid="settings-sidebar"] { width:220px; flex:0 0 220px; border-right:1px solid var(--border); padding:12px 8px; display:flex; flex-direction:column; gap:2px; }
  .nav-btn { width:100%; display:flex; align-items:center; gap:8px; padding:8px 10px; border:0; border-radius:8px; background:transparent; color:var(--foreground); cursor:pointer; font-size:13px; text-align:left; }
  .nav-btn.bg-sidebar-secondary { background:var(--secondary); font-weight:600; }
  .right-pane { flex:1; min-width:0; min-height:0; height:100%; overflow:hidden; display:flex; flex-direction:column; }
  .native-pane { max-width:672px; width:100%; margin:0 auto; padding:24px; }
  .confirm-dialog { position:fixed; top:20px; right:20px; z-index:4500; width:300px; padding:16px; border-radius:12px; background:var(--secondary); border:1px solid var(--border); }
</style>
</head>
<body>
  <div class="shell">
    <aside id="host-sidebar" class="app-sidebar">
      <div class="sidebar-top">
        <div style="font-weight:600;font-size:13px;padding:6px 8px">Antigravity</div>
      </div>
      <div class="sidebar-footer" id="host-sidebar-footer">
        <button id="host-settings-btn" data-testid="settings-button" type="button">Settings</button>
      </div>
    </aside>
    <main class="main-stage">
      <div data-testid="title-menu-bar" class="tmb">
        <div data-testid="title-menu-bar-item">File</div>
        <div data-testid="title-menu-bar-item">Edit</div>
      </div>
      <div class="conv-titlebar @container/titlebar">
        <div>Workspace</div>
        <div data-testid="titlebar-service-announcement-slot" style="flex:1"></div>
        <div data-testid="pane-titlebar-toolbar" class="shrink-0" style="display:flex;align-items:center;gap:6px">
          <button type="button">Open IDE</button>
        </div>
      </div>
    </main>
  </div>

  <!-- P0 #124 普通确认弹窗（含干扰词 General / Browser 但绝非真实 Settings 弹窗） -->
  <div id="fake-normal-dialog" class="confirm-dialog" role="dialog" aria-label="Confirm Action">
    <div>General Browser confirmation</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button">Continue</button>
      <button type="button">Cancel</button>
    </div>
  </div>

  <!-- 真实宿主 Settings 弹窗 -->
  <div id="real-settings-backdrop" class="settings-backdrop" hidden>
    <div id="real-settings-modal" class="settings-modal" role="dialog" aria-label="Settings">
      <div data-testid="settings-sidebar" id="real-settings-sidebar">
        <div id="nav-group">
          <button id="nav-general" data-testid="settings-nav-item-General" class="nav-btn" type="button"><span>General</span></button>
          <button id="nav-browser" data-testid="settings-nav-item-Browser" class="nav-btn bg-sidebar-secondary" type="button"><span>Browser</span></button>
          <button id="nav-models" data-testid="settings-nav-item-Models" class="nav-btn" type="button"><span>Models &amp; Usage</span></button>
        </div>
      </div>
      <div class="right-pane" id="real-right-pane">
        <div id="native-browser-pane" class="native-pane">
          <h1 id="native-browser-title" style="margin:0 0 6px;font-size:20px;font-weight:600">Browser</h1>
          <p style="margin:0 0 18px;font-size:13px;color:var(--muted-foreground)">Configure how embedded links open</p>
          <div id="native-browser-card" style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--card)">Open links in</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    window.__hostState = {
      nativeSettingsOpens: 0,
      themeWrites: [],
      hostThemeMode: 'dark',
      savedSettings: [],
      savedRules: [],
      oauthCalls: 0,
      switchCalls: [],
      customInstallPath: null,
      accounts: [
        {
          accountId: 'acc-1',
          email: 'jp00019@gmail.com',
          maskedEmail: 'jp***19@gmail.com',
          name: 'Elvis Ultra',
          tierName: 'Google AI Ultra',
          isActive: true,
          hasRefreshToken: true,
          lastUsedAtMs: Date.now() - 60000,
          quotaSnapshot: {
            fetchedAtMs: Date.now() - 30000,
            pools: [
              { poolKey: 'shared_gemini_main', title: 'Gemini', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.95, resetTime: new Date(Date.now() + 7200000).toISOString() }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.93 }] },
              { poolKey: 'shared_3p_pool', title: 'Claude / GPT', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.82 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.76 }] }
            ]
          }
        },
        {
          accountId: 'acc-2',
          email: 'dev.pro@gmail.com',
          maskedEmail: 'de***ro@gmail.com',
          name: 'Dev Pro',
          tierName: 'Google AI Pro',
          isActive: false,
          hasRefreshToken: true,
          lastUsedAtMs: Date.now() - 3600000,
          quotaSnapshot: {
            fetchedAtMs: Date.now() - 120000,
            pools: [
              { poolKey: 'shared_gemini_main', title: 'Gemini', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.70 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.60 }] },
              { poolKey: 'shared_3p_pool', title: 'Claude / GPT', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.50 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.45 }] }
            ]
          }
        },
        {
          accountId: 'acc-3',
          email: 'backup.free@gmail.com',
          maskedEmail: 'ba***ee@gmail.com',
          name: 'Backup Free',
          tierName: 'Free',
          isActive: false,
          hasRefreshToken: true,
          lastUsedAtMs: Date.now() - 7200000,
          quotaSnapshot: {
            fetchedAtMs: Date.now() - 240000,
            pools: [
              { poolKey: 'shared_gemini_main', title: 'Gemini', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.10 }] }
            ]
          }
        },
        {
          accountId: 'acc-4',
          email: 'pending.sync@gmail.com',
          maskedEmail: 'pe***nc@gmail.com',
          name: 'Pending Sync',
          tierName: null,
          isActive: false,
          hasRefreshToken: true,
          lastUsedAtMs: null,
          quotaSnapshot: null
        },
        {
          accountId: 'acc-5',
          email: 'alt.pro@gmail.com',
          maskedEmail: 'al***ro@gmail.com',
          name: 'Alt Pro',
          tierName: 'Google AI Pro',
          isActive: false,
          hasRefreshToken: true,
          lastUsedAtMs: Date.now() - 10800000,
          quotaSnapshot: {
            fetchedAtMs: Date.now() - 300000,
            pools: [
              { poolKey: 'shared_gemini_main', title: 'Gemini', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.88 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.84 }] },
              { poolKey: 'shared_3p_pool', title: 'Claude / GPT', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.91 }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.89 }] }
            ]
          }
        }
      ],
      autoSwitch: {
        enabled: false,
        productionAlertOnly: true,
        poolKey: 'primary', // 模拟 accounts_v1.json 旧 primary 规则空占位
        windowKey: '5h',
        metricMode: 'remaining_pct',
        thresholdPct: 20,
        candidates: ['jp00019@gmail.com', 'dev.pro@gmail.com', 'backup.free@gmail.com']
      }
    };

    document.getElementById('host-settings-btn').addEventListener('click', () => {
      window.__hostState.nativeSettingsOpens += 1;
      document.getElementById('real-settings-backdrop').hidden = false;
    });
    for (const navId of ['nav-general', 'nav-browser', 'nav-models']) {
      document.getElementById(navId).addEventListener('click', () => {
        document.querySelectorAll('#real-settings-sidebar .nav-btn').forEach((b) => b.classList.remove('bg-sidebar-secondary'));
        document.getElementById(navId).classList.add('bg-sidebar-secondary');
        document.getElementById('native-browser-pane').hidden = false;
      });
    }

    window.__buildOverview = function buildOverview() {
      const activeAcc = window.__hostState.accounts.find((a) => a.isActive) || window.__hostState.accounts[0];
      return {
        ok: true,
        activeAccountEmail: activeAcc ? activeAcc.email : null,
        accounts: window.__hostState.accounts.map((a) => ({ ...a })),
        autoSwitch: { ...window.__hostState.autoSwitch },
        sharedPools: [
          { poolKey: 'shared_gemini_main', label: 'Gemini 主共享池', remainingPct: 95, weeklyRemainingPct: 93, resetAt: new Date(Date.now() + 7200000).toISOString() },
          { poolKey: 'shared_3p_pool', label: 'Claude / GPT 共享池', remainingPct: 82, weeklyRemainingPct: 76, resetAt: new Date(Date.now() + 14400000).toISOString() }
        ],
        compareHistory: [
          { poolLabel: 'Gemini 5H', beforePct: 99.91, afterPct: 92.61, localCalls: 19, updatedAtMs: Date.now() - 120000 }
        ]
      };
    }

    window.contextMeterAPI = {
      getRuntimeInfo: async () => ({ ok: true, backendVersion: '0.9.3', backendSource: 'electron-ipc', hostSupportsRestart: true }),
      getSettings: async () => ({
        ok: true,
        uiPreferences: {
          panelLanguage: 'zh-CN',
          themeMode: 'auto',
          radialOrb: true,
          radialTopbar: true,
          radialBottombar: true,
          hideTopbar: false,
          showComposerQuotaSummary: true,
          showTurnFooterStats: true,
          autoCheckUpdate: true,
          allowBetaUpdates: false,
          hostGuardEnabled: true
        }
      }),
      saveSettings: async (patch) => {
        window.__hostState.savedSettings.push(patch);
        return { ok: true, data: patch };
      },
      getUsage: async () => ({ ok: true, data: { sessions: [], totals: { totalTokens: 0 } } }),
      getTokenHistory: async () => ({ ok: true, data: { daily: [], totals: { totalTokens: 0 } } }),
      getModulesStatus: async () => ({
        ok: true,
        data: { modules: { chinese: { enabled: false, language: 'en' }, proxy: { enabled: false }, hostInstall: { customPath: window.__hostState.customInstallPath } } },
        disk: { chinese: true, chineseReady: true, proxy: true, proxyReady: true },
        runtime: { chineseActive: false, chineseNeedsRestart: false, proxyActive: false }
      }),
      hostTheme: async (payload = {}) => {
        if (payload.action === 'set') {
          const mode = payload.mode || 'auto';
          window.__hostState.themeWrites.push(mode);
          window.__hostState.hostThemeMode = mode;
          const resolved = mode === 'auto' ? 'dark' : mode;
          document.documentElement.setAttribute('data-theme', resolved);
          document.documentElement.classList.toggle('light-theme', resolved === 'light');
          return { ok: true, mode, targetMode: mode, verifiedOnDisk: true };
        }
        return { ok: true, mode: window.__hostState.hostThemeMode };
      },
      getHostInstallPath: async () => ({
        ok: true,
        customPath: window.__hostState.customInstallPath,
        resolvedPath: window.__hostState.customInstallPath || 'C:/Users/demo/AppData/Local/Programs/antigravity/resources/app.asar',
        source: window.__hostState.customInstallPath ? 'saved_config' : 'default',
        hostVersion: '2.35.2'
      }),
      saveHostInstallPath: async (p) => {
        window.__hostState.customInstallPath = p;
        return { ok: true, customPath: p, resolvedPath: p, source: 'saved_config', hostVersion: '2.35.2' };
      },
      clearHostInstallPath: async () => {
        window.__hostState.customInstallPath = null;
        return { ok: true, customPath: null, resolvedPath: 'C:/Users/demo/AppData/Local/Programs/antigravity/resources/app.asar', source: 'default', hostVersion: '2.35.2' };
      },
      getAccountsOverview: async () => window.__buildOverview(),
      accountsAction: async (payload) => {
        if (!window.__hostState.refreshCalls) window.__hostState.refreshCalls = [];
        if (!window.__hostState.removeCalls) window.__hostState.removeCalls = [];
        if (!window.__hostState.importCurrentCalls) window.__hostState.importCurrentCalls = 0;
        if (!window.__hostState.importToolsCalls) window.__hostState.importToolsCalls = 0;
        if (payload.action === 'preview_tools') {
          return { ok: true, available: true, count: 2 };
        }
        if (payload.action === 'save_auto_switch' || payload.action === 'update_auto_switch') {
          window.__hostState.autoSwitch = { ...window.__hostState.autoSwitch, ...payload.config, legacyPrimary: false };
          window.__hostState.savedRules.push(payload.config);
          return { ok: true, overview: window.__buildOverview() };
        }
        if (payload.action === 'refresh_quota') {
          window.__hostState.refreshCalls.push(payload);
          await new Promise((r) => setTimeout(r, 120));
          const target = window.__hostState.accounts.find((a) => a.email === payload.email);
          if (target) {
            target.lastQuotaUpdatedAtMs = Date.now();
            target.quotaSnapshot = {
              fetchedAtMs: Date.now(),
              pools: [
                { poolKey: 'shared_gemini_main', title: 'Gemini', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.72, resetTime: new Date(Date.now() + 5400000).toISOString() }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.64, resetTime: new Date(Date.now() + 432000000).toISOString() }] },
                { poolKey: 'shared_3p_pool', title: 'Claude / GPT', buckets: [{ windowKey: '5h', windowShort: '5h', remainingFraction: 0.58, resetTime: new Date(Date.now() + 7200000).toISOString() }, { windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.45, resetTime: new Date(Date.now() + 360000000).toISOString() }] },
                { poolKey: 'shared_gemini_argon', title: 'Gemini 4 Argon', buckets: [{ windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.85, resetTime: new Date(Date.now() + 518400000).toISOString() }] }
              ]
            };
          }
          const ov = window.__buildOverview();
          return { ok: true, overview: ov, message: '配额已刷新' };
        }
        if (payload.action === 'remove') {
          window.__hostState.removeCalls.push(payload);
          window.__hostState.accounts = window.__hostState.accounts.filter((a) => a.email !== payload.email);
          const ov = window.__buildOverview();
          return { ok: true, overview: ov, removedScopeKey: String(payload.email || '').toLowerCase() };
        }
        if (payload.action === 'import_current') {
          window.__hostState.importCurrentCalls += 1;
          return { ok: true, overview: window.__buildOverview(), message: '已导入当前账号' };
        }
        if (payload.action === 'import_tools') {
          window.__hostState.importToolsCalls += 1;
          return { ok: true, overview: window.__buildOverview(), message: '已导入 2 个 Tools 账号' };
        }
        if (payload.action === 'switch') {
          window.__hostState.switchCalls.push(payload);
          window.__hostState.accounts.forEach((a) => { a.isActive = (a.email === payload.email); });
          const ov = window.__buildOverview();
          return { ok: true, switched: true, overview: ov, ...ov, message: '已确认切换至 ' + payload.email, tone: 'info' };
        }
        if (payload.action === 'oauth_login') {
          window.__hostState.oauthCalls += 1;
          return { ok: false, cancelled: true, error: '用户已取消官方登录' };
        }
        return { ok: true, overview: window.__buildOverview() };
      },
      getQuotaSummary: async () => ({ ok: true, data: {} }),
      getHostGuardStatus: async () => ({ ok: true, data: { enabled: true, active: true, status: 'running' } }),
      openExternal: async () => ({ ok: true })
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
    } else if (req.url === '/meter-renderer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(rendererSource);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const httpPort = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-b01-cdp-'));
  const debugPort = 43000 + Math.floor(Math.random() * 10000);
  const chromeProc = spawn(browser.path, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,820',
    `http://127.0.0.1:${httpPort}/`
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const wsUrl = await waitForDebugWsUrl(debugPort);
    cdp = new Batch01CdpClient(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 900));

    // 1. P0 #124 验证：普通弹窗（带 General/Browser 干扰词）绝不被误挂设置导航；同时验证 #106 标题栏拖窗样式无破坏
    const fakeDialogCheck = await cdp.evaluate(`(() => {
      const fake = document.getElementById('fake-normal-dialog');
      const tmb = document.querySelector('[data-testid="title-menu-bar"]');
      const tmbItem = document.querySelector('[data-testid="title-menu-bar-item"]');
      return {
        hasNavInFake: Boolean(fake.querySelector('#ag-cm-host-settings-nav, #ag-cm-host-settings-accounts-nav')),
        globalNavCount: document.querySelectorAll('#ag-cm-host-settings-nav').length,
        tmbAppRegion: getComputedStyle(tmb).webkitAppRegion || getComputedStyle(tmb).appRegion || '',
        tmbItemAppRegion: getComputedStyle(tmbItem).webkitAppRegion || getComputedStyle(tmbItem).appRegion || ''
      };
    })()`);
    assert.equal(fakeDialogCheck.hasNavInFake, false, '#124 普通确认弹窗绝不可被误挂载设置导航');
    assert.equal(fakeDialogCheck.globalNavCount, 0, '真实 Settings 未打开前不得误挂载导航');
    assert.notEqual(fakeDialogCheck.tmbItemAppRegion, 'drag', '#106 标题菜单项不可被错误设为 drag 导致无法点击');

    // 2. 底栏账号胶囊：挂载、原 Settings 按钮隐藏、点胶囊/箭头上拉、快捷切号确认、添加账号取消、折叠态、从菜单打开原生 Settings
    const sidebarCheck = await cdp.evaluate(`(async () => {
      const api = window.__AGContextMeter;
      api.syncSidebarAccountForTest?.();
      await new Promise((r) => setTimeout(r, 120));
      const st0 = api.getSidebarAccountStateForTest();
      const saHost = document.getElementById('ag-sidebar-account-host');
      const sr = saHost.shadowRoot;
      const name0 = sr.getElementById('ag-sa-name').textContent.trim();
      const plan0 = sr.getElementById('ag-sa-plan').textContent.trim();

      // 点胶囊打开菜单
      sr.getElementById('ag-sa-trigger').click();
      const open1 = !sr.getElementById('ag-sa-popover').hidden;
      // 悬停列表项验证动效 1 磁吸滑动高亮胶囊定位
      const hoverPill = sr.getElementById('ag-sa-hover-pill');
      const secondOpt = sr.querySelectorAll('.sa-opt')[1] || sr.querySelector('.sa-opt');
      if (secondOpt) secondOpt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      const hoverPillVisible = Boolean(hoverPill && Number(hoverPill.style.opacity) > 0 && parseFloat(hoverPill.style.height) > 0);

      // Esc 关闭菜单（等待 195ms 收起动效完成后验证 hidden）
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const expandedAfterEsc = sr.getElementById('ag-sa-trigger').getAttribute('aria-expanded');
      await new Promise((r) => setTimeout(r, 260));
      const closedAfterEsc = sr.getElementById('ag-sa-popover').hidden;

      // 点箭头区打开同一个菜单
      sr.getElementById('ag-sa-chevron').click();
      const open2 = !sr.getElementById('ag-sa-popover').hidden;

      // 点「刷新当前账号」验证菜单内快捷刷新真实接入后端
      const refreshBtnMenu = sr.getElementById('ag-sa-act-refresh');
      if (refreshBtnMenu) {
        refreshBtnMenu.click();
        await new Promise((r) => setTimeout(r, 220));
      }
      const refreshCallsAfterMenu = (window.__hostState.refreshCalls || []).length;

      // 点「添加账号」验证进入宿主原生登录指引（零自建 oauth_login 外发），并在取消时保持原账号
      if (sr.getElementById('ag-sa-popover').hidden) sr.getElementById('ag-sa-trigger').click();
      sr.getElementById('ag-sa-act-add').click();
      await new Promise((r) => setTimeout(r, 120));
      const ovLoginPhase = api.getAccountSwitchOverlayStateForTest?.()?.phase || '';
      api.getAccountSwitchOverlayShadowForTest?.()?.getElementById('ag-account-switch-cancel')?.click();
      await new Promise((r) => setTimeout(r, 60));
      const oauthCallsAfterAdd = window.__hostState.oauthCalls;
      const activeAfterCancel = sr.getElementById('ag-sa-name').textContent.trim();

      // 快捷切号：单击目标账号直接平滑发起切换（无多余的底部二次确认条），验证更新为 Dev Pro / Google AI Pro
      if (sr.getElementById('ag-sa-popover').hidden) sr.getElementById('ag-sa-trigger').click();
      const items = Array.from(sr.querySelectorAll('.sa-opt'));
      const devBtn = items.find((b) => (b.textContent || '').includes('Dev Pro'));
      const confirmRemoved = !sr.getElementById('ag-sa-confirm');
      const hoverPillInsideList = Boolean(hoverPill && hoverPill.parentElement && hoverPill.parentElement.id === 'ag-sa-list');
      devBtn.click();
      await new Promise((r) => setTimeout(r, 240));
      const nameAfterSwitch = sr.getElementById('ag-sa-name').textContent.trim();
      const planAfterSwitch = sr.getElementById('ag-sa-plan').textContent.trim();

      // 侧栏折叠窄宽验证纯头像态
      const sidebarEl = document.getElementById('host-sidebar');
      sidebarEl.classList.add('collapsed');
      api.syncSidebarAccountForTest?.();
      await new Promise((r) => setTimeout(r, 80));
      const compactAttr = saHost.getAttribute('data-compact');
      sidebarEl.classList.remove('collapsed');
      api.syncSidebarAccountForTest?.();

      // 通过菜单「设置」打开原生 Settings
      if (sr.getElementById('ag-sa-popover').hidden) sr.getElementById('ag-sa-trigger').click();
      sr.getElementById('ag-sa-act-settings').click();
      await new Promise((r) => setTimeout(r, 200));

      return {
        st0,
        name0,
        plan0,
        open1,
        hoverPillVisible,
        hoverPillInsideList,
        expandedAfterEsc,
        closedAfterEsc,
        open2,
        refreshCallsAfterMenu,
        ovLoginPhase,
        oauthCallsAfterAdd,
        activeAfterCancel,
        confirmRemoved,
        nameAfterSwitch,
        planAfterSwitch,
        compactAttr,
        nativeSettingsOpens: window.__hostState.nativeSettingsOpens,
        settingsModalVisible: !document.getElementById('real-settings-backdrop').hidden
      };
    })()`);

    assert.equal(sidebarCheck.st0.mounted, true, '底栏账号胶囊必须成功挂载');
    assert.equal(sidebarCheck.st0.origSettingsHidden, true, '确认可用后必须隐藏原生 settings-button');
    assert.equal(sidebarCheck.name0, 'Elvis Ultra');
    assert.equal(sidebarCheck.plan0, 'Google AI Ultra');
    assert.equal(sidebarCheck.open1, true, '点击胶囊必须打开上拉菜单');
    assert.equal(sidebarCheck.hoverPillVisible, true, '动效 1 磁吸高亮胶囊在悬停项时必须显现');
    assert.equal(sidebarCheck.hoverPillInsideList, true, '磁吸高亮胶囊必须严格约束在 #ag-sa-list 列表容器内部防越界');
    assert.equal(sidebarCheck.expandedAfterEsc, 'false', '按 Esc 必须立即切换 aria-expanded="false" 进入收起动画');
    assert.equal(sidebarCheck.closedAfterEsc, true, '按 Esc 收起动画结束后必须 hidden');
    assert.equal(sidebarCheck.open2, true, '点击小箭头必须打开同一个上拉菜单');
    assert.ok(sidebarCheck.refreshCallsAfterMenu >= 1, '菜单内「刷新当前账号」必须走真实后端 refresh_quota');
    assert.ok(sidebarCheck.oauthCallsAfterAdd >= 1, '回归 #1: 点击添加账号必须发起真实 oauth_login');
    assert.equal(sidebarCheck.activeAfterCancel, 'Elvis Ultra', '登录取消必须保留原账号');
    assert.equal(sidebarCheck.confirmRemoved, true, '快捷切号菜单必须移除多余的底部二次确认条，支持单击直切');
    assert.equal(sidebarCheck.nameAfterSwitch, 'Dev Pro', '宿主确认切号后胶囊名称必须同步更新');
    assert.equal(sidebarCheck.planAfterSwitch, 'Google AI Pro', '宿主确认切号后胶囊套餐必须同步更新');
    assert.equal(sidebarCheck.compactAttr, 'true', '侧栏折叠窄宽必须切换为头像入口态');
    assert.ok(sidebarCheck.nativeSettingsOpens >= 1, '菜单「设置」与原生登录指引必须打开原生 Settings');
    assert.equal(sidebarCheck.settingsModalVisible, true);

    // 3. Settings 打开时悬浮圆球退场，核对 Accent --primary 实时同步、自绘色板、开关去冗余与全客户端主题状态机（含外部改主题保护）
    const settingsAndOrbCheck = await cdp.evaluate(`(async () => {
      const api = window.__AGContextMeter;
      const orbEl = document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('ctx-radial-orb');
      const orbHiddenInSettings = orbEl ? (orbEl.hidden || getComputedStyle(orbEl).display === 'none' || orbEl.getAttribute('data-settings-hidden') === 'true') : true;
      const cmNav = document.getElementById('ag-cm-host-settings-nav');
      const accNav = document.getElementById('ag-cm-host-settings-accounts-nav');
      cmNav.click();
      await new Promise((r) => setTimeout(r, 120));
      const pg = document.getElementById('ag-cm-host-settings-page');
      const sr = pg.shadowRoot;
      const hostAccent1 = pg.style.getPropertyValue('--ag-host-accent').trim().toLowerCase();

      // 检查所有 11 个开关稳态下 [data-ag-ns-sw-status] 均无冗余“已开启/已关闭”文本
      const swStatuses = Array.from(sr.querySelectorAll('[data-ag-ns-sw-status]')).map((el) => ({
        key: el.getAttribute('data-ag-ns-sw-status'),
        text: (el.textContent || '').trim()
      }));

      // #127 派生禁用：关闭底栏显示 -> radialBottombar 禁用
      const swBottom = sr.getElementById('ag-ns-sw-showComposerBar');
      swBottom.click();
      await new Promise((r) => setTimeout(r, 80));
      const radialBottomDisabled = sr.getElementById('ag-ns-sw-radialBottombar').disabled;

      // 动态切换宿主 --primary 为 #2f855a，验证 Accent 实时联动（忽略灰色 --accent）
      document.documentElement.style.setProperty('--primary', '#2f855a');
      api.setThemeModeForTest?.('auto');
      await new Promise((r) => setTimeout(r, 120));
      const hostAccent2 = pg.style.getPropertyValue('--ag-host-accent').trim().toLowerCase();

      // 点击色块验证唤起自绘顶层 #color-picker-popover 而非系统弹窗
      const swatch = sr.querySelector('[data-ag-ns-swatch="panelBg"]');
      let pickerOpened = false;
      if (swatch) {
        swatch.click();
        await new Promise((r) => setTimeout(r, 80));
        const portalHost = document.getElementById('ag-context-meter-modal-host') || document.getElementById('ag-context-meter');
        const pop = portalHost?.shadowRoot?.getElementById('color-picker-popover');
        pickerOpened = Boolean(pop && !pop.hidden && getComputedStyle(pop).display !== 'none');
        if (pop) pop.style.display = 'none';
      }

      // 全客户端主题同步：auto -> light -> dark -> auto（还原接管前模式），再验证用户自改宿主后切 auto 不覆盖用户选择
      await api.setThemeModeAndSyncForTest('light');
      const afterLight = document.documentElement.getAttribute('data-theme');
      await api.setThemeModeAndSyncForTest('dark');
      const afterDark = document.documentElement.getAttribute('data-theme');
      await api.setThemeModeAndSyncForTest('auto');
      // 再次切浅色，然后模拟用户在宿主里手动改成了 dark，再点跟随宿主，宿主应维持 dark 不被强写回
      await api.setThemeModeAndSyncForTest('light');
      const writesBeforeUserOverride = window.__hostState.themeWrites.length;
      window.__hostState.hostThemeMode = 'dark';
      document.documentElement.setAttribute('data-theme', 'dark');
      await api.setThemeModeAndSyncForTest('auto');
      const writesAfterUserOverride = window.__hostState.themeWrites.length;
      const hostThemeKeptAfterUserOverride = window.__hostState.hostThemeMode;

      return {
        orbHiddenInSettings,
        hasCmNav: Boolean(cmNav),
        hasAccNav: Boolean(accNav),
        hostAccent1,
        hostAccent2,
        swStatuses,
        radialBottomDisabled,
        pickerOpened,
        afterLight,
        afterDark,
        themeWrites: [...window.__hostState.themeWrites],
        writesDeltaAfterUserOverride: writesAfterUserOverride - writesBeforeUserOverride,
        hostThemeKeptAfterUserOverride
      };
    })()`);

    assert.equal(settingsAndOrbCheck.orbHiddenInSettings, true, '打开 Settings 时悬浮圆球必须退场隐藏');
    assert.equal(settingsAndOrbCheck.hasCmNav, true);
    assert.equal(settingsAndOrbCheck.hasAccNav, true);
    assert.equal(settingsAndOrbCheck.hostAccent1, '#ba5f59', '必须优先读取宿主 --primary (#ba5f59) 而非灰色 --accent');
    assert.equal(settingsAndOrbCheck.hostAccent2, '#2f855a', '宿主 --primary 变更必须实时联动设置页');
    assert.equal(settingsAndOrbCheck.radialBottomDisabled, true, '隐藏底栏后底栏径向开关必须自动派生禁用 (#127)');
    assert.equal(settingsAndOrbCheck.pickerOpened, true, '设置页颜色色块必须唤起自绘主题一致的 #color-picker-popover');
    assert.equal(settingsAndOrbCheck.afterLight, 'light', '选浅色必须同步整个 Antigravity 宿主变浅');
    assert.equal(settingsAndOrbCheck.afterDark, 'dark', '选深色必须同步整个 Antigravity 宿主变深');
    assert.equal(settingsAndOrbCheck.writesDeltaAfterUserOverride, 0, '用户主动更改宿主主题后切回跟随宿主不得覆盖用户新选择');
    assert.equal(settingsAndOrbCheck.hostThemeKeptAfterUserOverride, 'dark');
    const redundantSwitches = settingsAndOrbCheck.swStatuses.filter((s) => /已开启|已关闭|已启用|Enabled|Disabled/i.test(s.text));
    assert.deepEqual(redundantSwitches, [], '稳定态所有开关旁不得出现冗余已开启/已关闭文案');

    // 4. 独立问题 2 & 3 + P0 #123：同级「账号与额度」页 5/5 候选账号、独立展开、5H/7D、旧规则首项点击与刷新插队不丢点
    const accountsPageCheck = await cdp.evaluate(`(async () => {
      document.getElementById('ag-cm-host-settings-accounts-nav').click();
      await new Promise((r) => setTimeout(r, 150));
      const accPg = document.getElementById('ag-cm-host-accounts-page');
      const sr = accPg.shadowRoot;

      // 页首身份卡
      const heroName = sr.getElementById('ag-ac-hero-name').textContent.trim();
      const heroPlan = sr.getElementById('ag-ac-hero-plan-pill').textContent.trim();

      // 验证去重：无底部冗余「共享额度池」区块、无原始内部字段名或反代字样
      const pageFullText = sr.getElementById('ag-ac-root').textContent || '';
      const hasLegacySharedPoolsSec = Boolean(sr.getElementById('ag-ac-sec-pools'));
      const leaksRawFieldOrProxy = /gemini_generic_main|shared_gemini_main|反代已禁用|优先级:|经典款/.test(pageFullText);

      // 独立展开两个账号，切卡片视图再切回列表仍按稳定 accountId 保持展开
      const expandBtns = Array.from(sr.querySelectorAll('[data-ac-toggle-detail]'));
      expandBtns[0].click();
      expandBtns[1].click();
      const expandedBeforeSwitch = sr.querySelectorAll('.ag-ac-detail:not([hidden])').length;
      sr.querySelector('[data-ac-view="cards"]').click();
      await new Promise((r) => setTimeout(r, 60));
      const expandedAfterSwitch = sr.querySelectorAll('.ag-ac-detail:not([hidden])').length;
      sr.querySelector('[data-ac-view="list"]').click();

      // 动效 2 + 真实单行刷新闭环：点击当前账号刷新按钮 -> 观测退潮阶段 -> 850ms 后观测充能完成并更新为 72% 且出现 Argon 通栏条
      const firstRow = sr.querySelector('.ag-ac-item[data-account-email="dev.pro@gmail.com"]') || sr.querySelector('.ag-ac-item');
      const rowRefreshBtn = firstRow.querySelector('[data-ac-op="refresh"]');
      rowRefreshBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      const motionDuringDrain = window.__AGContextMeter.getAccountsMotionStateForTest?.(firstRow.getAttribute('data-account-email'));
      await new Promise((r) => setTimeout(r, 850));
      const refreshedRow = sr.querySelector('.ag-ac-item[data-account-email="dev.pro@gmail.com"]') || sr.querySelector('.ag-ac-item');
      const refreshedRowText = refreshedRow ? (refreshedRow.textContent || '') : '';
      const hasArgonAfterRefresh = Boolean(refreshedRow && refreshedRow.querySelector('.ag-ac-pool-capsule.is-full-row.is-argon'));
      const has72PctAfterRefresh = refreshedRowText.includes('72%');

      // 行内移除账号二次确认闭环：移除第 5 个账号 alt.pro@gmail.com
      const rowsBeforeRemove = sr.querySelectorAll('.ag-ac-item').length;
      const altRow = sr.querySelector('.ag-ac-item[data-account-email="alt.pro@gmail.com"]');
      if (altRow) {
        altRow.querySelector('[data-ac-op="remove"]').click();
        await new Promise((r) => setTimeout(r, 40));
        const confirmGo = sr.querySelector('.ag-ac-item[data-account-email="alt.pro@gmail.com"] [data-ac-confirm-go]');
        if (confirmGo) confirmGo.click();
        await new Promise((r) => setTimeout(r, 120));
      }
      const rowsAfterRemove = sr.querySelectorAll('.ag-ac-item').length;
      const removeCallsCount = (window.__hostState.removeCalls || []).length;

      // 顶部导入当前与导入 Tools 按钮真实调用验证
      const btnImpCur = sr.getElementById('ag-ac-btn-import-current');
      if (btnImpCur) { btnImpCur.click(); await new Promise((r) => setTimeout(r, 80)); }
      const btnImpTools = sr.getElementById('ag-ac-btn-import-tools');
      const toolsBtnVisible = Boolean(btnImpTools && !btnImpTools.hidden);
      if (toolsBtnVisible) { btnImpTools.click(); await new Promise((r) => setTimeout(r, 80)); }
      const importCurrentCalls = window.__hostState.importCurrentCalls || 0;
      const importToolsCalls = window.__hostState.importToolsCalls || 0;

      // 展开页尾历史规则区：核对剩余 4/4 全部已登记账号进入候选区（含当前账号标「当前」）
      const rulesSec = sr.getElementById('ag-ns-sec-accounts');
      rulesSec.open = true;
      await new Promise((r) => setTimeout(r, 60));
      const candChips = Array.from(sr.querySelectorAll('#ag-ns-autoswitch-candidates .ag-ns-cand-chip'));
      const candCount = candChips.length;
      const activeCandMarked = candChips.some((c) => (c.textContent || '').includes('当前'));

      // P0 #123：旧规则空占位时，点击首项 shared_gemini_main:5h 强制派发 change；并在 mousedown 与 click 之间插入同步刷新仍不重建 DOM
      const sel = sr.getElementById('ag-ns-sel-autoSwitchTarget');
      let changeCount = 0;
      sel.addEventListener('change', () => { changeCount += 1; });
      const trigger = sr.getElementById('ag-ns-sel-autoSwitchTarget-trigger');
      const menu = sr.getElementById('ag-ns-sel-autoSwitchTarget-menu');
      trigger.click();
      const firstItemBefore = menu.querySelector('.ag-ns-dd-item[data-value="shared_gemini_main:5h"]');
      firstItemBefore.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.__AGContextMeter.setAccountsOverviewForTest?.(window.__buildOverview());
      const firstItemAfter = menu.querySelector('.ag-ns-dd-item[data-value="shared_gemini_main:5h"]');
      const sameDomNodeAfterRefresh = firstItemBefore === firstItemAfter;
      firstItemAfter.click();
      await new Promise((r) => setTimeout(r, 80));
      const valAfterFirst = sel.value;

      // 继续选第 4 项验证完整四项切换
      trigger.click();
      menu.querySelector('.ag-ns-dd-item[data-value="shared_3p_pool:7d"]').click();
      await new Promise((r) => setTimeout(r, 80));
      const valAfterFourth = sel.value;

      // 关闭 Settings 后验证悬浮圆球恢复 + dispose 后底栏原 Settings 按钮完整恢复
      document.getElementById('real-settings-backdrop').hidden = true;
      await new Promise((r) => setTimeout(r, 120));
      const saTrigger = document.getElementById('ag-sidebar-account-host').shadowRoot.getElementById('ag-sa-trigger');
      saTrigger.focus();
      window.__AGContextMeter.disposeSidebarAccountForTest();
      const origBtn = document.getElementById('host-settings-btn');
      const origRestored = !origBtn.hidden && getComputedStyle(origBtn).display !== 'none';

      return {
        heroName,
        heroPlan,
        hasLegacySharedPoolsSec,
        leaksRawFieldOrProxy,
        expandedBeforeSwitch,
        expandedAfterSwitch,
        motionPhaseDuringDrain: motionDuringDrain?.phase || null,
        hasArgonAfterRefresh,
        has72PctAfterRefresh,
        rowsBeforeRemove,
        rowsAfterRemove,
        removeCallsCount,
        toolsBtnVisible,
        importCurrentCalls,
        importToolsCalls,
        candCount,
        activeCandMarked,
        sameDomNodeAfterRefresh,
        changeCount,
        valAfterFirst,
        valAfterFourth,
        origRestored
      };
    })()`);

    assert.equal(accountsPageCheck.heroName, 'Dev Pro', '账号页首紧凑身份卡必须实时同步当前生效账号');
    assert.equal(accountsPageCheck.heroPlan, 'Google AI Pro');
    assert.equal(accountsPageCheck.hasLegacySharedPoolsSec, false, '底部重复的共享额度池区块必须已移除');
    assert.equal(accountsPageCheck.leaksRawFieldOrProxy, false, '账号页严禁暴露原始内部字段名或反代概念标签');
    assert.equal(accountsPageCheck.expandedBeforeSwitch, 2, '支持多个账号同时独立展开详情');
    assert.equal(accountsPageCheck.expandedAfterSwitch, 2, '切换卡片视图后按稳定 accountId 保持展开态');
    assert.ok(['draining', 'waiting'].includes(accountsPageCheck.motionPhaseDuringDrain), '手动刷新必须触发动效 2 阶段 1 退潮归零');
    assert.equal(accountsPageCheck.has72PctAfterRefresh, true, '刷新充能完成后必须显示最新真实配额 72%');
    assert.equal(accountsPageCheck.hasArgonAfterRefresh, true, '刷新返回 Argon 独立池时必须展示第 3 行通栏配额条');
    assert.equal(accountsPageCheck.rowsBeforeRemove, 5);
    assert.equal(accountsPageCheck.rowsAfterRemove, 4, '行内二次确认移除账号后列表必须实时同步减少');
    assert.equal(accountsPageCheck.removeCallsCount, 1, '移除账号必须走真实后端 remove 链路');
    assert.equal(accountsPageCheck.toolsBtnVisible, true, '回归 #1：检测到 Tools 账号时导入 Tools 按钮必须显示');
    assert.equal(accountsPageCheck.importCurrentCalls, 1, '导入当前必须走真实后端 import_current');
    assert.ok(accountsPageCheck.importToolsCalls >= 1, '回归 #1：点击导入 Tools 必须触发真实后端 import_tools');
    assert.equal(accountsPageCheck.candCount, 4, '全部剩余 4/4 已登记账号必须完整进入候选区');
    assert.equal(accountsPageCheck.activeCandMarked, true, '当前账号在候选区必须明确标注「当前」');
    assert.equal(accountsPageCheck.sameDomNodeAfterRefresh, true, 'P0 #123：下拉展开且选项未变时刷新不得重建菜单选项 DOM');
    assert.ok(accountsPageCheck.changeCount >= 2, 'P0 #123：旧规则空占位选首项与切第四项均必须触发真实 change');
    assert.equal(accountsPageCheck.valAfterFirst, 'shared_gemini_main:5h');
    assert.equal(accountsPageCheck.valAfterFourth, 'shared_3p_pool:7d');
    assert.equal(accountsPageCheck.origRestored, true, '插件退场后原生 settings-button 必须完整恢复可见');
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill(); } catch { }
    server.close();
    await new Promise((r) => setTimeout(r, 150));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
});
