'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT_DIR = __dirname;
const { builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const { restore } = require('./restore');
const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
const { TAGS } = require('./modular-installer');
const { handleToggleModule } = require('./meter-main');
const { createI18nEngine } = require('./i18n/i18n-runtime');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makeMockDom() {
  const mkNode = (nodeType, tagName, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const el = {
      nodeType,
      tagName: tagName ? tagName.toUpperCase() : null,
      id: opts.id || '',
      className: opts.className || '',
      nodeValue: opts.nodeValue ?? '',
      children: [],
      childNodes: [],
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      parentElement: null,
      parentNode: null,
      isContentEditable: Boolean(opts.isContentEditable),
      style: {},
      get textContent() {
        if (this.nodeType === 3) return this.nodeValue;
        return this.childNodes.map(c => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      hasAttribute(k) { return attrs.has(k); },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      closest(selList) {
        const sels = String(selList || '').split(',').map(s => s.trim()).filter(Boolean);
        let cur = this.nodeType === 1 ? this : this.parentElement;
        while (cur && cur.nodeType === 1) {
          for (const s of sels) {
            if (s.startsWith('#') && cur.id === s.slice(1)) return cur;
            if (s.startsWith('.') && cur.className.split(/\s+/).includes(s.slice(1))) return cur;
            if (/^[a-z]+$/i.test(s) && cur.tagName === s.toUpperCase()) return cur;
            const am = s.match(/^([a-z]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/i);
            if (am) {
              const [, tg, at, vl] = am;
              if ((!tg || cur.tagName === tg.toUpperCase()) && cur.hasAttribute(at)) {
                if (vl === undefined || cur.getAttribute(at) === vl) return cur;
              }
            }
          }
          cur = cur.parentElement;
        }
        return null;
      },
      appendChild(c) {
        c.parentElement = this;
        c.parentNode = this;
        c.previousSibling = this.lastChild;
        if (this.lastChild) this.lastChild.nextSibling = c;
        else this.firstChild = c;
        this.lastChild = c;
        this.childNodes.push(c);
        if (c.nodeType === 1) this.children.push(c);
        return c;
      }
    };
    return el;
  };
  const body = mkNode(1, 'BODY');
  return {
    body,
    el: (tag, opts = {}) => mkNode(1, tag, opts),
    text: (val) => mkNode(3, null, { nodeValue: val })
  };
}

test('上游词典合并一致性、版权署名及 2.34.0 核心界面翻译与专用译法保留', () => {
  const rootDictRaw = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'zh-CN.json'), 'utf8');
  const srcDictRaw = fs.readFileSync(path.join(ROOT_DIR, 'src', 'i18n', 'zh-CN.json'), 'utf8');
  assert.equal(rootDictRaw, srcDictRaw, 'i18n/zh-CN.json 与 src/i18n/zh-CN.json 必须逐字节一致');

  const rootRtRaw = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'i18n-runtime.js'), 'utf8');
  const srcRtRaw = fs.readFileSync(path.join(ROOT_DIR, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');
  assert.equal(rootRtRaw, srcRtRaw, 'i18n/i18n-runtime.js 与 src/i18n/i18n-runtime.js 必须逐字节一致');

  const dict = JSON.parse(rootDictRaw);
  assert.ok(Object.keys(dict.exact || {}).length >= 6000, '合并后词条应保留独有并合入上游词条');
  assert.ok(Object.keys(dict.coreWords || {}).length >= 100, '应包含上游 coreWords 实词表');

  // 署名与完整 MIT 许可随包文件核查
  const noticeDoc = fs.readFileSync(path.join(ROOT_DIR, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const readmeZh = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(ROOT_DIR, 'README.en.md'), 'utf8');
  const relNotes = fs.readFileSync(path.join(ROOT_DIR, 'RELEASE_NOTES.md'), 'utf8');
  const pkgScript = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'package-release.js'), 'utf8');

  const creditZh = 'Antigravity 界面汉化基于 Antigravity-Chinese-Localization，感谢 aabbWei 与 antigravity-cn-community 贡献者';
  assert.ok(noticeDoc.includes(creditZh));
  assert.ok(noticeDoc.includes('https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization'));
  assert.ok(noticeDoc.includes('v2.34.0'));
  assert.ok(noticeDoc.includes('Copyright (c) 2026 aabbWei'));
  assert.ok(noticeDoc.includes('Copyright (c) 2026 antigravity-cn-community contributors'));
  assert.ok(noticeDoc.includes('Permission is hereby granted, free of charge'));
  assert.ok(readmeZh.includes('aabbWei') && readmeZh.includes('antigravity-cn-community'));
  assert.ok(readmeEn.includes('aabbWei') && readmeEn.includes('antigravity-cn-community'));
  assert.ok(relNotes.includes(creditZh));
  assert.ok(pkgScript.includes("'THIRD_PARTY_NOTICES.md'"));

  const engine = createI18nEngine(dict);

  // 设置、权限审批、分屏、Side Question、Orchestrator 与思考深度
  assert.equal(engine.translate('Settings'), '设置');
  assert.equal(engine.translate('Project-Specific Settings'), '项目专属设置');
  assert.equal(engine.translate('Runtime permission'), '运行时权限');
  assert.equal(engine.translate('Yes, allow this time'), '是，仅本次允许');
  assert.equal(engine.translate("Yes, and always allow 'npm test' in this conversation"), "是，并在当前对话中始终允许 'npm test'");
  assert.equal(engine.translate('Allow running this command outside the sandbox?'), '是否允许在沙盒外运行此命令？');
  assert.equal(engine.translate('Save rule to always allow running this command?'), '保存规则以始终允许运行此命令？');
  assert.equal(
    engine.translate('Recursively deleting the pre-existing directory C:\\temp\\foo permanently destroys files outside the workspace that cannot be locally recovered.'),
    '递归删除已有目录 C:\\temp\\foo 将永久销毁工作区外且无法在本地恢复的文件。'
  );
  assert.equal(engine.translate('No (tell the agent what to do instead)'), '否（告诉智能体改为执行什么操作）');
  assert.equal(engine.translate('Split Right'), '向右分屏');
  assert.equal(engine.translate('Split Down'), '向下分屏');
  assert.equal(engine.translate('Remove from Split'), '从分屏中移除');
  assert.equal(engine.translate('Side Question'), '侧边提问');
  assert.equal(engine.translate('Ask /btw'), '通过 /btw 提问');
  assert.equal(engine.translate('Edit side question title: Audit'), '编辑侧边提问标题：Audit');
  assert.ok([null, 'Orchestrator'].includes(engine.translate('Orchestrator')), 'Orchestrator 模式名应保留原文');
  assert.equal(engine.translate('Orchestrator Settings'), 'Orchestrator 设置');
  assert.equal(engine.translate('Orchestrator Model'), 'Orchestrator 模型');
  assert.equal(engine.translate('Executor Model'), '执行器模型');
  assert.equal(engine.translate('Extra High'), '极高');
  assert.equal(engine.translate('Extra High · 1M context'), '极高 · 1M context');
  assert.ok([null, 'Gemini 4 Neon Extra High'].includes(engine.translate('Gemini 4 Neon Extra High')), '模型全名不应被部分词拼译');
  assert.equal(engine.translate('Queue Message'), '排队发送消息');
  assert.equal(engine.translate('Customize Sidebar'), '自定义侧边栏');
  assert.equal(engine.translate('Modified in Workspace'), '已在 Workspace 中修改');

  // 保留 ContextMeter 已有专用译法（兼顾子视图检测）
  assert.equal(engine.translate('Customizations'), '自定义扩展');
  assert.equal(engine.translate('Marketplace'), '插件市场');
  assert.equal(engine.translate('Installed'), '已安装');
  assert.equal(engine.translate('Chat Settings'), '对话设置');
  assert.equal(engine.translate('Terminal Commands'), '终端命令权限');
});

test('Issue #58 物理隔离矩阵: UI 控件与思考药丸汉化，正文/Markdown/代码块/用户输入/终端与工具输出/插件自身全保留原文', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'zh-CN.json'), 'utf8'));
  const rtSrc = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'i18n-runtime.js'), 'utf8');
  const d = makeMockDom();

  // 正常应被汉化的宿主 UI
  const btnSettings = d.el('button');
  const txtSettings = d.text('Settings');
  btnSettings.appendChild(txtSettings);

  const btnSplit = d.el('button');
  const txtSplit = d.text('Split Right');
  btnSplit.appendChild(txtSplit);

  const btnTrigger = d.el('button', { attrs: { 'data-testid': 'thinking-collapsible-trigger' } });
  const txtTrigger = d.text('Thought for 4s');
  btnTrigger.appendChild(txtTrigger);

  // Issue #58 受保护区：助手正文、Markdown、代码块、用户输入、思考正文、终端、工具输出、ContextMeter 自身
  const wrapProtected = (tag, opts, innerText) => {
    const box = d.el(tag, opts);
    const span = d.el('span');
    const tn = d.text(innerText);
    span.appendChild(tn);
    box.appendChild(span);
    d.body.appendChild(box);
    return tn;
  };

  const tAssistant = wrapProtected('div', { attrs: { 'data-testid': 'assistant-message' } }, 'Settings');
  const tMarkdown = wrapProtected('div', { className: 'markdown-body' }, 'Planning');
  const tCode = wrapProtected('pre', {}, 'Split Right');
  const tInlineCode = wrapProtected('code', {}, 'Runtime permission');
  const tMonaco = wrapProtected('div', { className: 'monaco-editor' }, 'Extra High');
  const tUserMsg = wrapProtected('div', { attrs: { 'data-testid': 'user-message-content' } }, 'Allow once');
  const tInputEditable = wrapProtected('div', { isContentEditable: true, attrs: { contenteditable: 'true' } }, 'Orchestrator Settings');
  const tTextarea = wrapProtected('textarea', {}, 'Settings');
  const tThoughtBody = wrapProtected('div', { className: 'thought-content' }, 'Planning');
  const tXterm = wrapProtected('div', { className: 'xterm' }, 'Terminal Commands');
  const tToolOut = wrapProtected('div', { attrs: { 'data-testid': 'tool-output' } }, 'Side Question');
  const tMeterOwn = wrapProtected('div', { id: 'ag-context-meter' }, 'Settings');
  const tMeterFooter = wrapProtected('div', { className: 'ag-cm-turn-footer' }, 'Cache');

  d.body.appendChild(btnSettings);
  d.body.appendChild(btnSplit);
  d.body.appendChild(btnTrigger);

  const sandbox = {
    window: {
      __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN', brandTitle: 'english' },
      __AGY_I18N_DATA__: dict
    },
    document: { documentElement: d.body, body: d.body, readyState: 'complete' },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(rtSrc, sandbox);
  sandbox.window.__AGY_RUN_FULL_SCAN__();

  assert.equal(txtSettings.nodeValue, '设置');
  assert.equal(txtSplit.nodeValue, '向右分屏');
  assert.equal(txtTrigger.nodeValue, '已思考 4 秒');

  assert.equal(tAssistant.nodeValue, 'Settings');
  assert.equal(tMarkdown.nodeValue, 'Planning');
  assert.equal(tCode.nodeValue, 'Split Right');
  assert.equal(tInlineCode.nodeValue, 'Runtime permission');
  assert.equal(tMonaco.nodeValue, 'Extra High');
  assert.equal(tUserMsg.nodeValue, 'Allow once');
  assert.equal(tInputEditable.nodeValue, 'Orchestrator Settings');
  assert.equal(tTextarea.nodeValue, 'Settings');
  assert.equal(tThoughtBody.nodeValue, 'Planning');
  assert.equal(tXterm.nodeValue, 'Terminal Commands');
  assert.equal(tToolOut.nodeValue, 'Side Question');
  assert.equal(tMeterOwn.nodeValue, 'Settings');
  assert.equal(tMeterFooter.nodeValue, 'Cache');
});

test('生命周期闭环: 2.34.0 宿主的开启/关闭/冷启动持久化/卸载还原与 ContextMeter 面板可用性', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-i18n-e2e-'));
  const stateDir = path.join(tmpRoot, 'state');
  const hostSrcDir = path.join(tmpRoot, 'host-src');
  const hostAsar = path.join(tmpRoot, 'app.asar');
  const prevEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = stateDir;

  try {
    fs.mkdirSync(path.join(hostSrcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(hostSrcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    fs.writeFileSync(
      path.join(hostSrcDir, 'dist', 'utils.js'),
      '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager) {\n    void loadHubWindowUrl(win, url, { skipBootstrapMint: false });\n}\n'
    );
    fs.writeFileSync(path.join(hostSrcDir, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n');
    await builtinAsar.createPackageWithOptions(hostSrcDir, hostAsar, {});
    const cleanOrigSha = sha256File(hostAsar);

    // 1. 开启汉化安装，生成唯一 ASAR
    await install({ path: hostAsar, modules: { chinese: { enabled: true } } });
    const diskOn = inspectDiskModules(hostAsar, { forceRefresh: true });
    assert.equal(diskOn.meterReady, true);
    assert.equal(diskOn.chineseReady, true);
    assert.equal(diskOn.chineseStatus, 'ready');

    const injectedPreload = builtinAsar.extractFile(hostAsar, 'dist/preload.js').toString('utf8');
    assert.equal(injectedPreload.split(TAGS.CHINESE_START).length - 1, 1, '绝不可注入两套汉化引擎');

    // 2. 模拟冷启动运行注入后 dist/preload.js (enabled: true)
    const runPreloadColdStart = () => {
      const cfgNow = loadModulesConfig({ stateDir });
      const d = makeMockDom();
      const uiNode = d.text('Orchestrator Settings');
      const uiBtn = d.el('button');
      uiBtn.appendChild(uiNode);
      const mdText = d.text('Planning');
      const mdBox = d.el('div', { className: 'markdown-body' });
      mdBox.appendChild(mdText);
      d.body.appendChild(uiBtn);
      d.body.appendChild(mdBox);

      const exposedApis = {};
      const winObj = {
        document: { documentElement: d.body, body: d.body, readyState: 'complete' },
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: () => 1
      };
      winObj.window = winObj;
      winObj.globalThis = winObj;

      const electronMock = {
        webFrame: { executeJavaScript: async () => {} },
        contextBridge: { exposeInMainWorld: (k, v) => { exposedApis[k] = v; } },
        ipcRenderer: {
          sendSync: (ch) => {
            if (ch === 'context-meter:get-chinese-config-sync') {
              return {
                resolved: true,
                enabled: cfgNow.modules.chinese.enabled,
                language: cfgNow.modules.chinese.language,
                brandTitle: cfgNow.modules.chinese.brandTitle
              };
            }
            return null;
          },
          on: () => {},
          invoke: async () => ({ ok: true })
        }
      };
      const preloadSandbox = {
        electron_1: electronMock,
        require: (id) => (id === 'electron' ? electronMock : (id === 'fs' ? fs : (id === 'path' ? path : (id === 'os' ? os : {})))),
        process,
        window: winObj,
        document: winObj.document,
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: () => 1
      };
      preloadSandbox.globalThis = preloadSandbox;
      vm.runInNewContext(injectedPreload, preloadSandbox);
      return { uiNode, mdText, exposedApis };
    };

    const bootOn = runPreloadColdStart();
    assert.equal(bootOn.uiNode.nodeValue, 'Orchestrator 设置', '开启态冷启动必须汉化 UI 控件');
    assert.equal(bootOn.mdText.nodeValue, 'Planning', '开启态冷启动正文中英文保持原样');
    assert.equal(typeof bootOn.exposedApis.contextMeterAPI?.openDashboardBrowser, 'function', 'ContextMeter 面板桥接正常暴露');

    // 3. 在客户端切换关闭汉化并模拟第二次冷启动验证持久化
    const fakeEvt = { senderFrame: { url: 'https://127.0.0.1:42000/' }, sender: { getURL: () => 'https://127.0.0.1:42000/' } };
    const offRes = await handleToggleModule(fakeEvt, 'chinese', false, { language: 'en', asarPath: hostAsar });
    assert.equal(offRes.ok, true);
    assert.equal(offRes.restartRequired, true);

    const bootOff = runPreloadColdStart();
    assert.equal(bootOff.uiNode.nodeValue, 'Orchestrator Settings', '关闭汉化后冷启动必须保持英文原样');
    assert.equal(bootOff.mdText.nodeValue, 'Planning');
    assert.equal(typeof bootOff.exposedApis.contextMeterAPI?.scan, 'function', '关闭汉化后 ContextMeter 面板桥接仍完整可用');

    // 4. 卸载还原逐字节恢复原版 ASAR
    await restore({ path: hostAsar });
    assert.equal(sha256File(hostAsar), cleanOrigSha, '卸载后必须逐字节恢复原版 ASAR');
    const diskRestored = inspectDiskModules(hostAsar, { forceRefresh: true });
    assert.equal(diskRestored.meter, false);
    assert.equal(diskRestored.chinese, false);
  } finally {
    if (prevEnv !== undefined) process.env.AG_METER_STATE_DIR = prevEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('性能回归: 3000+ 节点模拟设置弹窗 O(N) 单趟翻译 <50ms 且 pointerenter 不对大容器全树重扫', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'zh-CN.json'), 'utf8'));
  const rtSrc = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'i18n-runtime.js'), 'utf8');
  const d = makeMockDom();

  // 构造深层嵌套容器 + 3,200+ 个模拟设置弹窗节点 + Issue #58 受保护正文节点
  const modal = d.el('div', { className: 'agy-dialog settings-modal-container', attrs: { role: 'dialog' } });
  const nav = d.el('div');
  modal.appendChild(nav);
  const sampleLabels = [];
  for (let i = 0; i < 650; i++) {
    const row = d.el('div', { className: 'settings-row' });
    const wrap = d.el('div', { className: 'settings-cell' });
    const lbl = d.el('span');
    const txt = d.text(i % 2 === 0 ? 'General' : 'Settings');
    lbl.appendChild(txt);
    const btn = d.el('button');
    btn.appendChild(d.text('Save'));
    wrap.appendChild(lbl);
    wrap.appendChild(btn);
    row.appendChild(wrap);
    nav.appendChild(row);
    if (i < 5) sampleLabels.push(txt);
  }
  const mdGuard = d.el('div', { className: 'markdown-body' });
  const mdText = d.text('Settings');
  mdGuard.appendChild(mdText);
  d.body.appendChild(modal);
  d.body.appendChild(mdGuard);

  const listeners = {};
  const docMock = {
    documentElement: d.body,
    body: d.body,
    readyState: 'complete',
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    }
  };
  const sandbox = {
    window: {
      __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN', brandTitle: 'english' },
      __AGY_I18N_DATA__: dict
    },
    document: docMock,
    performance,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1
  };
  sandbox.window.document = docMock;
  vm.runInNewContext(rtSrc, sandbox);

  const t0 = performance.now();
  sandbox.window.__AGY_TRANSLATE_EL__(modal);
  const scanMs = performance.now() - t0;

  assert.ok(scanMs < 150, `3250+ 节点单次 O(N) 扫描耗时 ${scanMs.toFixed(2)}ms 应显著低于卡顿阈值`);
  for (const tn of sampleLabels) {
    assert.ok(tn.nodeValue === '通用' || tn.nodeValue === '设置', '设置项必须正确汉化');
  }

  // 验证 Issue #58 受保护节点仍严格不翻译
  sandbox.window.__AGY_TRANSLATE_EL__(mdGuard);
  assert.equal(mdText.nodeValue, 'Settings');

  // 验证高频 pointerenter 落在大型容器 (childElementCount > 12) 时直接跳过整树递归
  const origNavChild = d.el('button');
  const untouchedTxt = d.text('Save');
  origNavChild.appendChild(untouchedTxt);
  nav.appendChild(origNavChild);
  nav.childElementCount = nav.children.length;
  modal.childElementCount = modal.children.length;
  for (const fn of (listeners.pointerenter || [])) {
    fn({ target: nav });
  }
  assert.equal(untouchedTxt.nodeValue, 'Save', 'pointerenter 落在大型容器时禁止重扫整棵大子树');
});
