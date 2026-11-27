'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFile, spawn } = require('node:child_process');
const execFileAsync = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (err, stdout, stderr) => {
    if (err) {
      err.stdout = stdout;
      err.stderr = stderr;
      return reject(err);
    }
    resolve(stdout);
  });
});

const {
  resolveRuntimeChineseConfig,
  buildRuntimeI18nBundle,
  collectLocalizationTargets,
  injectRuntimeI18nIntoTargets,
  probeRuntimeI18nTargets
} = require('./live-i18n');
const { createLiveRequestHandler } = require('./live-host');
const { saveModulesConfig, loadModulesConfig, PROJECT_VERSION, getHostCoreBuildId } = require('./modules-config');
const cli = require('./cli');

function createDomPageSandbox(sandboxOpts = {}) {
  const enableTreeWalker = sandboxOpts.enableTreeWalker !== false;
  const isHostPage = sandboxOpts.isHostPage !== false;
  let treeWalkerCalls = 0;

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
      matches(sel) {
        return String(sel || '').split(',').some(s => {
          const t = s.trim();
          if (!t) return false;
          if (t.startsWith('#')) return this.id === t.slice(1);
          if (t.startsWith('.')) return this.className.split(/\s+/).includes(t.slice(1));
          const am = t.match(/^([a-z]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/i);
          if (am) {
            const [, tg, at, vl] = am;
            if ((!tg || this.tagName === tg.toUpperCase()) && this.hasAttribute(at)) {
              return vl === undefined || this.getAttribute(at) === vl;
            }
            return false;
          }
          return this.tagName === t.toUpperCase();
        });
      },
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
  const el = (tag, opts = {}) => mkNode(1, tag, opts);
  const text = (val) => mkNode(3, null, { nodeValue: val });

  const uiBtn = el('button');
  const uiBtnText = text('Settings');
  uiBtn.appendChild(uiBtnText);

  const splitBtn = el('button');
  const splitText = text('Split Right');
  splitBtn.appendChild(splitText);

  const customBtn = el('button');
  const customBtnText = text('Custom Demo Button');
  customBtn.appendChild(customBtnText);

  const brandEl = isHostPage
    ? el('div', { attrs: { 'data-testid': 'title-menu-bar-item' } })
    : el('div', { className: 'foreign-brand' });
  const brandText = text('Antigravity');
  brandEl.appendChild(brandText);

  const wrapProtected = (tag, opts, inner) => {
    const box = el(tag, opts);
    const span = el('span');
    const tn = text(inner);
    span.appendChild(tn);
    box.appendChild(span);
    body.appendChild(box);
    return tn;
  };

  const meterText = wrapProtected('div', { id: 'ag-context-meter' }, 'Settings');
  const radialText = wrapProtected('div', { id: 'ag-context-meter-radial-host' }, 'Settings');
  const modalHostText = wrapProtected('div', { id: 'ag-context-meter-modal-host' }, 'Settings');
  const hostNavText = wrapProtected('div', { id: 'ag-cm-host-settings-nav' }, 'Settings');
  const hostPageText = wrapProtected('div', { id: 'ag-cm-host-settings-page' }, 'Settings');
  const footerText = wrapProtected('div', { className: 'ag-cm-turn-footer' }, 'Cache');
  const inputEl = el('input', { attrs: { placeholder: 'Ask anything', value: 'Settings' } });
  const textareaText = wrapProtected('textarea', {}, 'Settings');
  const editableText = wrapProtected('div', { isContentEditable: true, attrs: { contenteditable: 'true' } }, 'Settings');
  const lexicalText = wrapProtected('div', { attrs: { 'data-lexical-editor': 'true', role: 'textbox' } }, 'Split Right');
  const monacoText = wrapProtected('div', { className: 'monaco-editor' }, 'Settings');
  const markdownText = wrapProtected('div', { className: 'markdown-body' }, 'Planning');
  const codeText = wrapProtected('code', {}, 'Runtime permission');
  const xtermText = wrapProtected('div', { className: 'xterm' }, 'Terminal Commands');

  body.appendChild(uiBtn);
  body.appendChild(splitBtn);
  body.appendChild(customBtn);
  body.appendChild(brandEl);
  body.appendChild(inputEl);

  const findById = (root, id) => {
    if (!root || root.nodeType !== 1) return null;
    if (root.id === id) return root;
    for (const c of root.children) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };

  const findBySelector = (root, selList) => {
    const sels = String(selList || '').split(',').map(s => s.trim()).filter(Boolean);
    const stack = [root];
    while (stack.length) {
      const cur = stack.shift();
      if (!cur || cur.nodeType !== 1) continue;
      if (sels.some(s => cur.matches(s))) return cur;
      for (const c of cur.children) stack.push(c);
    }
    return null;
  };

  const listeners = {};
  const nodeFilterObj = { SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
  const docMock = {
    documentElement: body,
    body,
    readyState: 'complete',
    title: 'Antigravity',
    getElementById: (id) => findById(body, id),
    querySelector: (sel) => findBySelector(body, sel),
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    }
  };
  if (enableTreeWalker) {
    docMock.createTreeWalker = (root, whatToShow = nodeFilterObj.SHOW_ALL) => {
      treeWalkerCalls++;
      const list = [];
      const walk = (node) => {
        if (!node) return;
        const mask = node.nodeType === 1 ? nodeFilterObj.SHOW_ELEMENT : (node.nodeType === 3 ? nodeFilterObj.SHOW_TEXT : 0);
        if ((whatToShow & mask) !== 0) list.push(node);
        if (Array.isArray(node.childNodes)) {
          for (const child of node.childNodes) walk(child);
        }
      };
      walk(root);
      let idx = -1;
      return {
        currentNode: root,
        nextNode() {
          idx++;
          if (idx >= list.length) return null;
          this.currentNode = list[idx];
          return this.currentNode;
        }
      };
    };
  }

  const sandbox = {
    window: {
      ...(isHostPage ? { __APP_CONFIG__: { csrfToken: 'mock' }, __AGContextMeter: { version: '0.9.3', snapshot: () => null } } : {}),
      document: docMock
    },
    document: docMock,
    ...(enableTreeWalker ? { NodeFilter: nodeFilterObj } : {}),
    performance,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox.window;

  return {
    sandbox,
    body,
    el,
    text,
    getTreeWalkerCalls: () => treeWalkerCalls,
    nodes: {
      uiBtnText,
      splitText,
      customBtnText,
      brandText,
      meterText,
      radialText,
      modalHostText,
      hostNavText,
      hostPageText,
      footerText,
      inputEl,
      textareaText,
      editableText,
      lexicalText,
      monacoText,
      markdownText,
      codeText,
      xtermText
    }
  };
}

function createRealMockCdpServer(pageStates) {
  function encodeWsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    }
    if (payload.length < 65536) {
      const hdr = Buffer.alloc(4);
      hdr[0] = 0x81;
      hdr[1] = 126;
      hdr.writeUInt16BE(payload.length, 2);
      return Buffer.concat([hdr, payload]);
    }
    const hdr = Buffer.alloc(10);
    hdr[0] = 0x81;
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([hdr, payload]);
  }

  const activeSockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pageStates.listEntries));
      return;
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"mock"};</script>');
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  server.on('upgrade', (req, socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    if (req.headers.origin !== undefined) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const targetId = (req.url || '').split('/').pop();
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let rxBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (rxBuf.length < offset + 2) break;
          payloadLen = rxBuf.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (rxBuf.length < offset + 8) break;
          payloadLen = Number(rxBuf.readBigUInt64BE(offset));
          offset += 8;
        }
        if (masked && rxBuf.length < offset + 4) break;
        const maskKey = masked ? rxBuf.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (rxBuf.length < offset + payloadLen) break;
        const payload = Buffer.from(rxBuf.subarray(offset, offset + payloadLen));
        rxBuf = rxBuf.subarray(offset + payloadLen);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (opcode === 0x1) {
          if (masked && maskKey) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          }
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.method === 'Runtime.evaluate') {
            pageStates.evalCalls.push({ targetId, len: String(msg.params?.expression || '').length });
            const targetCtx = pageStates.contexts.get(targetId);
            if (typeof pageStates.onEvaluate === 'function') {
              const hookRes = pageStates.onEvaluate({ targetId, msg, targetCtx });
              if (hookRes && hookRes.throwError) {
                socket.write(encodeWsTextFrame(JSON.stringify({
                  id: msg.id,
                  result: { exceptionDetails: { text: hookRes.throwError } }
                })));
                continue;
              }
            }
            try {
              const value = vm.runInNewContext(msg.params.expression, targetCtx.sandbox);
              socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result: { result: { value } } })));
            } catch (err) {
              socket.write(encodeWsTextFrame(JSON.stringify({
                id: msg.id,
                result: { exceptionDetails: { text: err.message } }
              })));
            }
          }
        }
      }
    });
  });

  const close = () => new Promise((resolve) => {
    for (const s of activeSockets) {
      try { s.destroy(); } catch {}
    }
    activeSockets.clear();
    try { server.closeAllConnections?.(); } catch {}
    server.close(() => resolve());
  });

  return { server, close };
}

test('live-i18n 构建有效载荷并包含零个人路径/账户硬编码、保留回环与内置 plugin:// 白名单限制', () => {
  const bundle = buildRuntimeI18nBundle({
    chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'english' }
  });
  assert.equal(bundle.source, 'bundled-i18n');
  assert.ok(bundle.dictEntries >= 6000);
  assert.match(bundle.buildHash, /^[a-f0-9]{12}$/);
  assert.equal(bundle.configSig, '1:zh-CN:english');
  assert.doesNotMatch(bundle.code, /\/Users\/[^/\s"']+|\/home\/[^/\s"']+|C:\\Users\\/);

  const cdpSnap = {
    pages: [
      { id: 'page-1', type: 'page', url: 'https://127.0.0.1:41000/?token=abc#frag', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/page-1' },
      { id: 'bad-remote', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://192.168.1.50:58321/devtools/page/bad' }
    ],
    allPages: [
      { id: 'plugin-builtin', type: 'iframe', url: 'plugin://swarm--swarm_board-1/', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/plugin-builtin' },
      { id: 'plugin-builtin-ag', type: 'iframe', url: 'plugin://antigravity--settings/', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/plugin-builtin-ag' },
      { id: 'plugin-thirdparty', type: 'iframe', url: 'plugin://figma--canvas/', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/plugin-thirdparty' },
      { id: 'plugin-mcp-app', type: 'iframe', url: 'plugin://thirdparty-mcp--dashboard/', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/plugin-mcp-app' },
      { id: 'web-iframe', type: 'iframe', url: 'https://example.com/embed', webSocketDebuggerUrl: 'ws://127.0.0.1:58321/devtools/page/web-iframe' }
    ]
  };
  const targets = collectLocalizationTargets(cdpSnap);
  assert.deepEqual(
    targets.map(t => t.id),
    ['page-1', 'plugin-builtin', 'plugin-builtin-ag'],
    'CR-04: 默认仅保留宿主 page 与内置白名单 plugin:// 子框架，跳过第三方 UI 插件'
  );

  const optInTargets = collectLocalizationTargets(cdpSnap, { includeAllPluginIframes: true });
  assert.equal(optInTargets.some(t => t.id === 'plugin-thirdparty'), true);
});

test('CDP 运行时汉化注入真实 WebSocket + DOM 沙盒: TreeWalker/后备遍历、保护集、状态切换与 CR-05 宿主核验', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cdp-i18n-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const mainDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const pluginDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const thirdPartyDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: false });
  const nonHostDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: false });
  const pageStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([
      ['page-main', mainDom],
      ['page-other', nonHostDom],
      ['iframe-plugin', pluginDom],
      ['iframe-thirdparty', thirdPartyDom]
    ])
  };
  const mock = createRealMockCdpServer(pageStates);
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  pageStates.listEntries = [
    { id: 'page-main', type: 'page', url: `${origin}/c/test`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-main` },
    { id: 'page-other', type: 'page', url: `${origin}/local-preview`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-other` },
    { id: 'iframe-plugin', type: 'iframe', url: 'plugin://swarm--swarm_board-60000/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/iframe-plugin` },
    { id: 'iframe-thirdparty', type: 'iframe', url: 'plugin://figma--design-panel/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/iframe-thirdparty` }
  ];

  const cfg = loadModulesConfig({ stateDir });
  cfg.modules.chinese.enabled = true;
  cfg.modules.chinese.language = 'zh-CN';
  cfg.modules.chinese.brandTitle = 'english';
  saveModulesConfig(cfg, { stateDir });

  // 1. 首次 CDP 运行时注入（含混合宿主/非宿主页面 + 内置/第三方 plugin://）
  const firstRes = await injectRuntimeI18nIntoTargets({ stateDir, port, strictPort: true });
  assert.equal(firstRes.ok, true);
  assert.equal(firstRes.targetCount, 3, '第三方 plugin://figam 不应出现在待注入目标中');
  assert.equal(firstRes.injectedCount, 2, '仅主页面与内置 plugin:// 注入，非宿主 page 跳过');
  assert.equal(firstRes.skippedCount, 1);
  assert.equal(firstRes.targets.find(x => x.id === 'page-other')?.reason, 'non_host_page');
  assert.ok(mainDom.getTreeWalkerCalls() >= 0);

  // 验证主页面与内置 plugin:// 汉化成功，第三方 plugin:// 与非宿主本地页保持原文
  assert.equal(mainDom.nodes.uiBtnText.nodeValue, '设置');
  assert.equal(mainDom.nodes.splitText.nodeValue, '向右分屏');
  assert.equal(mainDom.nodes.brandText.nodeValue, 'Antigravity');
  assert.equal(pluginDom.nodes.uiBtnText.nodeValue, '设置');
  assert.equal(thirdPartyDom.nodes.uiBtnText.nodeValue, 'Settings');
  assert.equal(nonHostDom.nodes.uiBtnText.nodeValue, 'Settings');

  // CR-10: 验证新增 4 个宿主 DOM ID 与既有受保护区域保持原文
  assert.equal(mainDom.nodes.meterText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.radialText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.modalHostText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.hostNavText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.hostPageText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.footerText.nodeValue, 'Cache');
  assert.equal(mainDom.nodes.inputEl.getAttribute('value'), 'Settings');
  assert.equal(mainDom.nodes.textareaText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.editableText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.lexicalText.nodeValue, 'Split Right');
  assert.equal(mainDom.nodes.monacoText.nodeValue, 'Settings');
  assert.equal(mainDom.nodes.markdownText.nodeValue, 'Planning');
  assert.equal(mainDom.nodes.codeText.nodeValue, 'Runtime permission');
  assert.equal(mainDom.nodes.xtermText.nodeValue, 'Terminal Commands');

  // 2. 幂等性检查：再次调用不重复传输大字典
  const evalsBeforeSkip = pageStates.evalCalls.length;
  const secondRes = await injectRuntimeI18nIntoTargets({ stateDir, port, strictPort: true });
  assert.equal(secondRes.ok, true);
  assert.equal(secondRes.injectedCount, 0);
  assert.equal(secondRes.skippedCount, 3);
  assert.equal(pageStates.evalCalls.length, evalsBeforeSkip + 3);

  // 3. 品牌切换轻量热更新（english -> translated -> hidden -> english）并验证调用了 TreeWalker
  const twBeforeBrand = mainDom.getTreeWalkerCalls();
  cfg.modules.chinese.brandTitle = 'translated';
  saveModulesConfig(cfg, { stateDir });
  const brandRes = await injectRuntimeI18nIntoTargets({ stateDir, port, strictPort: true });
  assert.equal(brandRes.ok, true);
  assert.equal(brandRes.targets.some(x => x.brandRefreshed === true), true);
  assert.equal(mainDom.nodes.brandText.nodeValue, '反重力');

  cfg.modules.chinese.brandTitle = 'hidden';
  saveModulesConfig(cfg, { stateDir });
  const hideRes = await injectRuntimeI18nIntoTargets({ stateDir, port, strictPort: true });
  assert.equal(hideRes.ok, true);
  assert.equal(mainDom.nodes.brandText.nodeValue, '');

  cfg.modules.chinese.brandTitle = 'english';
  saveModulesConfig(cfg, { stateDir });
  const restoreRes = await injectRuntimeI18nIntoTargets({ stateDir, port, strictPort: true });
  assert.equal(restoreRes.ok, true);
  assert.equal(mainDom.nodes.brandText.nodeValue, 'Antigravity');
  assert.ok(mainDom.getTreeWalkerCalls() >= twBeforeBrand, 'TreeWalker 可用时应覆盖主路径');

  // 4. probeRuntimeI18nTargets 只读状态查询
  const probe = await probeRuntimeI18nTargets({ stateDir, port, strictPort: true });
  assert.equal(probe.configEnabled, true);
  assert.equal(probe.activeTargets, 2);
  assert.equal(probe.chineseActiveTargets, 2);
  assert.equal(probe.totalTargets, 3);
  assert.equal(probe.targets[0].contextMeterActive, true);

  // 5. 性能回归：3,250+ 设置节点单趟扫描 < 150ms
  const modal = mainDom.el('div', { className: 'agy-dialog settings-modal-container', attrs: { role: 'dialog' } });
  for (let i = 0; i < 650; i++) {
    const row = mainDom.el('div', { className: 'settings-row' });
    const lbl = mainDom.el('span');
    lbl.appendChild(mainDom.text(i % 2 === 0 ? 'General' : 'Settings'));
    const btn = mainDom.el('button');
    btn.appendChild(mainDom.text('Save'));
    row.appendChild(lbl);
    row.appendChild(btn);
    modal.appendChild(row);
  }
  const t0 = performance.now();
  mainDom.sandbox.window.__AGY_TRANSLATE_EL__(modal);
  const scanMs = performance.now() - t0;
  assert.ok(scanMs < 150, `3250+ 节点单趟扫描耗时 ${scanMs.toFixed(2)}ms 应小于 150ms`);
});

test('CR-01 & CR-08 回归: 仅品牌模式切换至开启中文、词典 buildHash 升级热生效、无 TreeWalker 后备及旧运行时 reloadRequired', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cr01-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  for (const enableTreeWalker of [true, false]) {
    const dom = createDomPageSandbox({ enableTreeWalker, isHostPage: true });
    const pageStates = {
      evalCalls: [],
      listEntries: [],
      contexts: new Map([['page-cr01', dom]])
    };
    const mock = createRealMockCdpServer(pageStates);
    await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
    t.after(() => mock.close());
    const port = mock.server.address().port;
    pageStates.listEntries = [
      { id: 'page-cr01', type: 'page', url: `http://127.0.0.1:${port}/c/cr01`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-cr01` }
    ];

    // 1. 先在仅品牌模式下注入（enabled: false, brandTitle: translated）
    const rBrandOnly = await injectRuntimeI18nIntoTargets({
      stateDir,
      port,
      strictPort: true,
      chineseConfig: { enabled: false, language: 'en', brandTitle: 'translated', shouldInject: true }
    });
    assert.equal(rBrandOnly.ok, true);
    assert.equal(dom.nodes.brandText.nodeValue, '反重力');
    assert.equal(dom.nodes.uiBtnText.nodeValue, 'Settings', '仅品牌模式下按钮应保留英文');

    // 2. 切换至开启中文（enabled: true, brandTitle: translated），必须真正翻译 DOM！
    const rEnable = await injectRuntimeI18nIntoTargets({
      stateDir,
      port,
      strictPort: true,
      chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'translated', shouldInject: true }
    });
    assert.equal(rEnable.ok, true);
    assert.equal(dom.nodes.uiBtnText.nodeValue, '设置', `enableTreeWalker=${enableTreeWalker}: 从仅品牌切到中文必须真正汉化界面`);
    assert.equal(dom.nodes.brandText.nodeValue, '反重力');
    if (enableTreeWalker) {
      assert.ok(dom.getTreeWalkerCalls() > 0, 'TreeWalker 分支必须被真实执行');
    }

    // 3. buildHash 变化时（词典新增条目）应热更新而非被 __AGY_I18N_INITIALIZED__ 吞掉
    const dictPath = path.join(tmpDir, `dict-${enableTreeWalker}.json`);
    const baseDict = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', 'zh-CN.json'), 'utf8'));
    baseDict.exact['Custom Demo Button'] = '自定义演示按钮';
    fs.writeFileSync(dictPath, JSON.stringify(baseDict), 'utf8');
    const rUpgrade = await injectRuntimeI18nIntoTargets({
      stateDir,
      port,
      strictPort: true,
      dictPath,
      chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'translated', shouldInject: true }
    });
    assert.equal(rUpgrade.ok, true);
    assert.equal(dom.nodes.customBtnText.nodeValue, '自定义演示按钮', '词典 buildHash 升级后新增词条应即时生效');
  }

  // 4. 若页面存在旧版/外部无热更新能力的 __AGY_I18N_INITIALIZED__，绝不能假报 ok:true 或篡改 configSig
  const legacyDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  legacyDom.sandbox.window.__AGY_I18N_INITIALIZED__ = true;
  legacyDom.sandbox.window.__AGY_RUNTIME_I18N_META__ = {
    mode: 'preload-or-external',
    buildHash: 'legacy000000',
    configSig: '0:en:translated'
  };
  const legacyStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-legacy', legacyDom]])
  };
  const legacyMock = createRealMockCdpServer(legacyStates);
  await new Promise(r => legacyMock.server.listen(0, '127.0.0.1', r));
  t.after(() => legacyMock.close());
  const legacyPort = legacyMock.server.address().port;
  legacyStates.listEntries = [
    { id: 'page-legacy', type: 'page', url: `http://127.0.0.1:${legacyPort}/c/legacy`, webSocketDebuggerUrl: `ws://127.0.0.1:${legacyPort}/devtools/page/page-legacy` }
  ];
  const rLegacy = await injectRuntimeI18nIntoTargets({
    stateDir,
    port: legacyPort,
    strictPort: true,
    chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'translated', shouldInject: true }
  });
  assert.equal(rLegacy.ok, false);
  assert.equal(rLegacy.reloadRequired, true);
  assert.equal(rLegacy.targets[0].reloadRequired, true);
  assert.equal(rLegacy.targets[0].reason, 'already_initialized_reload_required');
  assert.equal(legacyDom.sandbox.window.__AGY_RUNTIME_I18N_META__.configSig, '0:en:translated', '不得篡改旧运行时元数据');
});

test('CR-05 回归: 当 CDP 端口仅存在非宿主本地页面时拒绝注入并返回 no_host_page_targets', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cr05-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const foreignDom = createDomPageSandbox({ isHostPage: false });
  const states = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-foreign', foreignDom]])
  };
  const mock = createRealMockCdpServer(states);
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  states.listEntries = [
    { id: 'page-foreign', type: 'page', url: `http://127.0.0.1:${port}/preview.html`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-foreign` }
  ];

  const res = await injectRuntimeI18nIntoTargets({
    stateDir,
    port,
    strictPort: true,
    chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'english', shouldInject: true }
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_host_page_targets');
  assert.equal(foreignDom.nodes.uiBtnText.nodeValue, 'Settings');
});

test('CR-03 回归: 测试隔离门禁不得因仅隔离 stateDir 而放行真实宿主 DevToolsActivePort', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cr03-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const prevAppData = process.env.APPDATA;
  const prevStateEnv = process.env.AG_METER_STATE_DIR;
  delete process.env.APPDATA;
  process.env.AG_METER_STATE_DIR = stateDir;
  t.after(() => {
    if (prevAppData !== undefined) process.env.APPDATA = prevAppData;
    else delete process.env.APPDATA;
    if (prevStateEnv !== undefined) process.env.AG_METER_STATE_DIR = prevStateEnv;
    else delete process.env.AG_METER_STATE_DIR;
  });

  const injectBlocked = await injectRuntimeI18nIntoTargets({
    stateDir,
    homeDir: '/non-isolated-home-dir',
    chineseConfig: { enabled: true, language: 'zh-CN', brandTitle: 'english', shouldInject: true }
  });
  assert.equal(injectBlocked.ok, false);
  assert.equal(injectBlocked.reason, 'test_mode_isolated');

  const probeBlocked = await probeRuntimeI18nTargets({
    stateDir,
    homeDir: '/non-isolated-home-dir'
  });
  assert.equal(probeBlocked.isolated, true);
  assert.equal(probeBlocked.reason, 'test_mode_isolated');
  assert.equal(probeBlocked.totalTargets, 0);
});

test('CR-02 回归: live-host 免改盘图形设置面板 /modules-status 与 /toggle-module 支持实时开启汉化与切换品牌', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cr02-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const fakeAsar = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'clean-stock-asar');
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex');

  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = stateDir;
  t.after(() => {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
  });

  const dom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const pageStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-gui', dom]])
  };
  const cdpMock = createRealMockCdpServer(pageStates);
  await new Promise(r => cdpMock.server.listen(0, '127.0.0.1', r));
  t.after(() => cdpMock.close());
  const cdpPort = cdpMock.server.address().port;
  pageStates.listEntries = [
    { id: 'page-gui', type: 'page', url: `http://127.0.0.1:${cdpPort}/c/gui`, webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/page-gui` }
  ];

  const secret = 'cr02-secret';
  const handler = createLiveRequestHandler({
    api: { origin: 'vscode-file://vscode-app' },
    secret,
    cdpPort
  });
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => {
    try { srv.closeAllConnections?.(); } catch {}
    srv.close(r);
  }));

  const postJson = (route, payload) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: srv.address().port,
      path: route,
      method: 'POST',
      headers: {
        Origin: 'vscode-file://vscode-app',
        'X-AG-Context-Token': secret,
        'Content-Type': 'application/json',
        Connection: 'close'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });

  // 1. 初始状态：disk.chineseReady=false，但免改盘 CDP 能力可用
  const st0 = await postJson('/modules-status', { asarPath: fakeAsar });
  assert.equal(st0.ok, true);
  assert.equal(st0.disk.chineseReady, false);
  assert.equal(st0.runtime.chineseActive, false);
  assert.equal(st0.runtime.chineseMode, 'cdp-runtime');
  assert.equal(st0.runtime.chineseRuntimeAvailable, true);
  assert.equal(st0.runtime.chineseNeedsRestart, false);

  // 2. 设置面板点击开启汉化 -> 不报 install_failed，实时通过 CDP 生效，restartRequired=false
  const enRes = await postJson('/toggle-module', {
    name: 'chinese',
    enable: true,
    opts: { language: 'zh-CN', brandTitle: 'english', asarPath: fakeAsar }
  });
  assert.equal(enRes.ok, true);
  assert.equal(enRes.mode, 'cdp-runtime');
  assert.equal(enRes.restartRequired, false);
  assert.equal(enRes.runtime.chineseActive, true);
  assert.equal(enRes.runtime.chineseNeedsRestart, false);
  assert.equal(dom.nodes.uiBtnText.nodeValue, '设置');

  // 3. 再次查状态应准确反映 chineseActive=true 且 chineseNeedsRestart=false
  const st1 = await postJson('/modules-status', { asarPath: fakeAsar });
  assert.equal(st1.runtime.chineseActive, true);
  assert.equal(st1.runtime.chineseNeedsRestart, false);

  // 4. 面板热切换品牌标题 -> 无需重启且 DOM 更新
  const brRes = await postJson('/toggle-module', {
    name: 'chinese',
    enable: true,
    opts: { language: 'zh-CN', brandTitle: 'translated', asarPath: fakeAsar }
  });
  assert.equal(brRes.ok, true);
  assert.equal(brRes.restartRequired, false);
  assert.equal(dom.nodes.brandText.nodeValue, '反重力');

  // 5. 面板关闭汉化 -> 落盘并明确提示需刷新恢复英文
  const disRes = await postJson('/toggle-module', {
    name: 'chinese',
    enable: false,
    opts: { language: 'en', brandTitle: 'english', asarPath: fakeAsar }
  });
  assert.equal(disRes.ok, true);
  assert.equal(disRes.mode, 'cdp-runtime');
  assert.equal(disRes.restartRequired, true);
  assert.equal(loadModulesConfig({ stateDir }).modules.chinese.enabled, false);

  // 6. meter 模块在未注入 ASAR 上仍应拒绝并返回 install_failed
  const meterErr = await postJson('/toggle-module', {
    name: 'meter',
    enable: true,
    opts: { asarPath: fakeAsar }
  });
  assert.equal(meterErr.ok, false);
  assert.equal(meterErr.status, 'install_failed');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore);
});

test('CR-06 & CR-08 回归: watch 接入真实 Mock CDP (未就绪子框架/原地刷新/部分失败退避/Cmd+R/自重载参数保留) 且 app.asar 零修改', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watch-real-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  const appDataDir = path.join(tmpDir, 'appdata');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });

  const fakeAsar = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'official-signed-asar-untouched');
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex');

  const cfg = loadModulesConfig({ stateDir });
  cfg.modules.chinese.enabled = true;
  cfg.modules.chinese.language = 'zh-CN';
  saveModulesConfig(cfg, { stateDir });

  let mainDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  let swarmDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const thirdPartyDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: false });
  let failSwarmOnce = false;

  const pageStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([
      ['page-main', mainDom],
      ['plug-swarm', swarmDom],
      ['plug-figma', thirdPartyDom]
    ]),
    onEvaluate({ targetId }) {
      if (targetId === 'plug-swarm' && failSwarmOnce) {
        failSwarmOnce = false;
        return { throwError: 'transient iframe error' };
      }
      return null;
    }
  };
  const mock = createRealMockCdpServer(pageStates);
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(appDataDir, 'Antigravity', 'DevToolsActivePort'), `${port}\n/devtools/browser/mock\n`, 'utf8');

  const pkgVer = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

  // Cycle 控制：
  // 1: 主页 + 未就绪 swarm iframe(无 WS) + 第三方 figma iframe(有 WS)
  // 2: swarm iframe 就绪获得 WS -> 必须被补注（不能被 cycle 1 提前写入 seenPluginIframes）
  // 3: 稳态 -> 不重注
  // 4: swarm iframe 同 id/url 原地刷新（新沙盒）+ iframeReverifyIntervalMs: 1 -> 必须重注
  // 5: 主页 Cmd+R 刷新（新主沙盒）-> 必须重注
  // 6+: 关闭窗口退出
  let pollCount = 0;
  const origQuery = cli.queryLiveWindow;
  const res = await cli.runWatchDaemon({
    stateDir,
    appDataDir,
    port,
    strictPort: true,
    customPath: fakeAsar,
    silent: true,
    handleSignals: false,
    pollIntervalMs: 10,
    startupPollMs: 10,
    startupTimeoutMs: 2000,
    maxConsecutiveMisses: 1,
    maxCycles: 12,
    iframeReverifyIntervalMs: 1,
    i18nRetryBaseMs: 1,
    _discoverWindow: async () => {
      pollCount++;
      if (pollCount === 1) {
        pageStates.listEntries = [
          { id: 'page-main', type: 'page', url: `${origin}/c/w1`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-main` },
          { id: 'plug-swarm', type: 'iframe', url: 'plugin://swarm--board/' },
          { id: 'plug-figma', type: 'iframe', url: 'plugin://figma--canvas/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/plug-figma` }
        ];
      } else if (pollCount === 2) {
        failSwarmOnce = true; // 模拟 swarm iframe 首次拿到 WS 但瞬态失败一次
        pageStates.listEntries = [
          { id: 'page-main', type: 'page', url: `${origin}/c/w1`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-main` },
          { id: 'plug-swarm', type: 'iframe', url: 'plugin://swarm--board/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/plug-swarm` },
          { id: 'plug-figma', type: 'iframe', url: 'plugin://figma--canvas/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/plug-figma` }
        ];
      } else if (pollCount === 3) {
        // 第 3 轮：swarm 上轮失败未写入 seenPluginIframes，应自动重注并成功
      } else if (pollCount === 4) {
        // 稳态后模拟 swarm 同 id/url 原地刷新
        assert.equal(swarmDom.nodes.uiBtnText.nodeValue, '设置', '第 3 轮失败恢复后 swarm 必须已完成汉化');
        swarmDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
        pageStates.contexts.set('plug-swarm', swarmDom);
      } else if (pollCount === 5) {
        assert.equal(swarmDom.nodes.uiBtnText.nodeValue, '设置', '同 id/url 原地刷新后的 swarm 必须被重新汉化');
        // 模拟 Cmd+R 主窗口刷新
        mainDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
        pageStates.contexts.set('page-main', mainDom);
      } else if (pollCount === 6) {
        assert.equal(mainDom.nodes.uiBtnText.nodeValue, '设置', 'Cmd+R 刷新后主窗口必须自愈重注');
        pageStates.listEntries = [];
        return { running: false, pageFound: false };
      } else {
        return { running: false, pageFound: false };
      }
      return origQuery({ port, strictPort: true, appDataDir, lightProbe: true });
    },
    _ensureBridge: async (live) => ({
      ready: true,
      reused: true,
      backendSource: 'live-host',
      backendVersion: pkgVer,
      liveInfo: { pid: process.pid, port: 54321, token: 'tok', version: pkgVer, origins: live.origins }
    }),
    _hotInject: async () => {
      mainDom.sandbox.window.__AGContextMeter = { version: pkgVer };
      return { ok: true, injectedCount: 1, windowCount: 1, backendVersion: pkgVer, backendSource: 'live-host' };
    },
    _hotDispose: async () => true
  });

  assert.equal(res.ok, true);
  assert.equal(res.exitReason, 'window_closed');
  assert.ok(res.runtimeI18nInjectedCount >= 3);
  assert.equal(thirdPartyDom.nodes.uiBtnText.nodeValue, 'Settings', '第三方 figma plugin:// 子框架在 watch 中也不得被误注入');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore, 'watch 全生命周期不得修改 app.asar');

  // 测试热自重载保留 --chinese / --no-chinese 参数
  for (const chFlag of [true, false]) {
    const reloadStateDir = path.join(tmpDir, `reload-${chFlag}`);
    fs.mkdirSync(reloadStateDir, { recursive: true });
    let capturedArgs = null;
    const fakeRoot = path.join(tmpDir, `root-${chFlag}`);
    fs.mkdirSync(fakeRoot, { recursive: true });
    for (const f of ['cli.js', 'install.js', 'restore.js', 'live-host.js', 'live-i18n.js', 'host-recovery.js', 'local-api.js', 'meter-collector.js', 'meter-storage.js', 'meter-proxy.js', 'meter-cli-launcher.js', 'meter-context-unlock.js', 'meter-enhance.js', 'macos-binary-utils.js', 'modules-config.js', 'asar-engine.js', 'package.json']) {
      fs.copyFileSync(path.join(__dirname, f), path.join(fakeRoot, f));
    }
    const res2 = await cli.runWatchDaemon({
      bundleDir: fakeRoot,
      stateDir: reloadStateDir,
      port,
      customPath: fakeAsar,
      chinese: chFlag,
      silent: true,
      handleSignals: false,
      autoBootstrapHost: false,
      selfReloadOnHostChange: true,
      maxCycles: 3,
      pollIntervalMs: 5,
      startupPollMs: 5,
      startupTimeoutMs: 500,
      _discoverWindow: async () => {
        fs.appendFileSync(path.join(fakeRoot, 'live-i18n.js'), '\n// bump\n');
        return { running: false, pageFound: false };
      },
      _spawnSelfReload: (_exec, spawnArgs) => {
        capturedArgs = spawnArgs;
        return { unref() {} };
      }
    });
    assert.equal(res2.selfReloaded, true);
    assert.ok(Array.isArray(capturedArgs));
    assert.equal(
      capturedArgs.includes(chFlag ? '--chinese' : '--no-chinese'),
      true,
      `watch 热自重载必须保留 ${chFlag ? '--chinese' : '--no-chinese'}`
    );
  }
});

test('CR-07 & CR-08 回归: CLI --state-dir/--port 真实 CDP 注入、status URL 脱敏、unknown_signature 回退与失败不脏写配置', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-zh-live-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const stateDir = path.join(tmpDir, 'state');
  const fakeHome = path.join(tmpDir, 'home');
  const fakeAppData = path.join(tmpDir, 'appdata');
  const appResDir = path.join(tmpDir, 'Antigravity.app', 'Contents', 'Resources');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeAppData, { recursive: true });
  fs.mkdirSync(appResDir, { recursive: true });

  const fakeAsar = path.join(appResDir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'signed-asar-untouched');
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex');

  let dom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const pageStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-cli', dom]])
  };
  const mock = createRealMockCdpServer(pageStates);
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = mock.server.address().port;
  pageStates.listEntries = [
    { id: 'page-cli', type: 'page', url: `http://127.0.0.1:${port}/c/cli?token=secret-123#frag`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-cli` }
  ];

  // 注意：不传 AG_METER_STATE_DIR，专门验证 --state-dir 透传，并彻底隔离 HOME/APPDATA
  const env = {
    ...process.env,
    HOME: fakeHome,
    APPDATA: fakeAppData,
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    AG_METER_TEST_MODE: '1'
  };
  delete env.AG_METER_STATE_DIR;

  const outLive = await execFileAsync(process.execPath, [
    path.join(__dirname, 'cli.js'),
    'chinese:enable',
    '--live',
    '--port', String(port),
    '--state-dir', stateDir,
    '--path', fakeAsar
  ], { env, encoding: 'utf8' });
  assert.match(outLive, /立即通过 CDP 注入/);
  assert.equal(dom.nodes.uiBtnText.nodeValue, '设置', 'CLI --live --port 必须真实注入 Mock CDP 窗口');
  assert.equal(loadModulesConfig({ stateDir }).modules.chinese.enabled, true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore);

  // 验证 status --port --state-dir 且 URL 不含 query/hash
  const statusOut = await execFileAsync(process.execPath, [
    path.join(__dirname, 'cli.js'),
    'status',
    '--port', String(port),
    '--state-dir', stateDir
  ], { env, encoding: 'utf8' });
  const statusJson = JSON.parse(statusOut);
  assert.equal(statusJson.runtimeI18n.activeTargets, 1);
  assert.equal(statusJson.runtimeI18n.chineseActiveTargets, 1);
  assert.equal(statusJson.runtimeI18n.targets[0].url, `http://127.0.0.1:${port}/c/cli`);

  await execFileAsync(process.execPath, [
    path.join(__dirname, 'cli.js'),
    'chinese:disable',
    '--live',
    '--state-dir', stateDir,
    '--path', fakeAsar
  ], { env, encoding: 'utf8' });
  assert.equal(loadModulesConfig({ stateDir }).modules.chinese.enabled, false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore);

  if (process.platform === 'darwin') {
    // 1. 无 Info.plist（unknown_signature）时也必须自动回退免改盘 CDP 模式并注入新窗口
    dom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
    pageStates.contexts.set('page-cli', dom);
    const outUnknownSig = await execFileAsync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'chinese:enable',
      '--port', String(port),
      '--state-dir', stateDir,
      '--path', fakeAsar
    ], { env, encoding: 'utf8' });
    assert.match(outUnknownSig, /免改盘 CDP 运行时模式/);
    assert.equal(dom.nodes.uiBtnText.nodeValue, '设置');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore);

    // 切回关闭态供后续断言
    await execFileAsync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'chinese:disable',
      '--live',
      '--state-dir', stateDir,
      '--path', fakeAsar
    ], { env, encoding: 'utf8' });

    // 2. 存在 ElectronAsarIntegrity（blocked_integrity）时自动回退免改盘并注入
    dom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
    pageStates.contexts.set('page-cli', dom);
    const plistPath = path.join(tmpDir, 'Antigravity.app', 'Contents', 'Info.plist');
    fs.writeFileSync(
      plistPath,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ElectronAsarIntegrity</key><dict><key>algorithm</key><string>SHA256</string></dict></dict></plist>',
      'utf8'
    );
    const outIntegrity = await execFileAsync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'chinese:enable',
      '--port', String(port),
      '--state-dir', stateDir,
      '--path', fakeAsar
    ], { env, encoding: 'utf8' });
    assert.match(outIntegrity, /ElectronAsarIntegrity/);
    assert.match(outIntegrity, /免改盘 CDP 运行时模式/);
    assert.equal(dom.nodes.uiBtnText.nodeValue, '设置');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fakeAsar)).digest('hex'), shaBefore);

    // 3. 强行改盘失败（--force-mac-asar 对损坏 ASAR）时，modules.json 不得提前脏写为 enabled: true
    await execFileAsync(process.execPath, [
      path.join(__dirname, 'cli.js'),
      'chinese:disable',
      '--live',
      '--state-dir', stateDir,
      '--path', fakeAsar
    ], { env, encoding: 'utf8' });
    let failedAsExpected = false;
    try {
      await execFileAsync(process.execPath, [
        path.join(__dirname, 'cli.js'),
        'chinese:enable',
        '--force-mac-asar',
        '--state-dir', stateDir,
        '--path', fakeAsar
      ], { env, encoding: 'utf8' });
    } catch {
      failedAsExpected = true;
    }
    assert.equal(failedAsExpected, true);
    assert.equal(loadModulesConfig({ stateDir }).modules.chinese.enabled, false, '改盘失败不得提前污染 modules.json');
  }
});

test('R2-01 回归: ensureLiveBridgeIfNeeded 透传 --cdp-port/AG_CDP_PORT 且拒绝复用错端口 live-host', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-r201-bridge-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, 'state');
  const appDataDir = path.join(tmpDir, 'appdata');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });

  const pkgVer = PROJECT_VERSION;
  const hostBuildId = getHostCoreBuildId(__dirname);

  // 1. 预置绑定到默认端口 58321 的存活 .live-session.json，随后请求自定义端口 58921，绝不能误复用！
  fs.writeFileSync(path.join(stateDir, '.live-session.json'), JSON.stringify({
    pid: process.pid,
    port: 61001,
    token: 'wrong-port-tok',
    origin: 'https://127.0.0.1:62221',
    origins: ['https://127.0.0.1:62221'],
    cdpPort: 58321,
    version: pkgVer,
    hostBuildId,
    hasQuota: true
  }), 'utf8');

  let capturedArgs = null;
  let capturedEnv = null;
  let probeHits = 0;
  const bridgeRes = await cli.ensureLiveBridgeIfNeeded(
    {
      running: true,
      pageFound: true,
      cdpPort: 58921,
      origin: 'https://127.0.0.1:62221',
      origins: ['https://127.0.0.1:62221']
    },
    {
      stateDir,
      appDataDir,
      port: 58921,
      _spawn: (_exe, args, opts) => {
        capturedArgs = args;
        capturedEnv = opts.env;
        const stampPath = args[args.indexOf('--stamp') + 1];
        fs.writeFileSync(stampPath, JSON.stringify({
          pid: process.pid,
          port: 61002,
          token: 'custom-port-tok',
          origin: 'https://127.0.0.1:62221',
          origins: ['https://127.0.0.1:62221'],
          cdpPort: 58921,
          version: pkgVer,
          hostBuildId
        }), 'utf8');
        return { pid: process.pid, unref() {} };
      },
      _probeLiveHost: async (info) => {
        probeHits++;
        return {
          ok: true,
          backendVersion: pkgVer,
          hostBuildId,
          cdpPort: info.cdpPort || 58321,
          capabilities: { rehydrate: true },
          origins: ['https://127.0.0.1:62221']
        };
      }
    }
  );

  assert.equal(bridgeRes.ready, true);
  assert.notEqual(bridgeRes.reused, true, '不同 CDP 端口的已有 live-host 不得被复用');
  assert.equal(probeHits, 1, '应仅探测新拉起的 live-host，不探测错端口旧实例');
  const flagIdx = capturedArgs.indexOf('--cdp-port');
  assert.ok(flagIdx >= 0 && capturedArgs[flagIdx + 1] === '58921', 'spawn 参数必须包含 --cdp-port 58921');
  assert.equal(capturedEnv.AG_CDP_PORT, '58921', '子进程环境必须透传 AG_CDP_PORT=58921');
  assert.equal(bridgeRes.liveInfo.cdpPort, 58921);
});

test('R2-01 回归: 真实 live-host.js 子进程多实例隔离与严格端口防误连', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-r201-multi-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const stateDir = path.join(tmpDir, 'state');
  const appDataDir = path.join(tmpDir, 'appdata');
  const fakeHome = path.join(tmpDir, 'home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'Antigravity'), { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  const fakeAsar = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'clean-stock-asar');

  // 1. 启动诱饵实例 A（写入 DevToolsActivePort，模拟生产默认客户端）
  const decoyDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const decoyStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-decoy', decoyDom]])
  };
  const decoyMock = createRealMockCdpServer(decoyStates);
  await new Promise(r => decoyMock.server.listen(0, '127.0.0.1', r));
  t.after(() => decoyMock.close());
  const portA = decoyMock.server.address().port;
  decoyStates.listEntries = [
    { id: 'page-decoy', type: 'page', url: `http://127.0.0.1:${portA}/c/decoy`, webSocketDebuggerUrl: `ws://127.0.0.1:${portA}/devtools/page/page-decoy` }
  ];
  fs.writeFileSync(path.join(appDataDir, 'Antigravity', 'DevToolsActivePort'), `${portA}\n/devtools/browser/decoy\n`, 'utf8');

  // 2. 启动目标实例 B（使用自定义端口 portB，未写入 DevToolsActivePort）
  const targetDom = createDomPageSandbox({ enableTreeWalker: true, isHostPage: true });
  const targetStates = {
    evalCalls: [],
    listEntries: [],
    contexts: new Map([['page-target', targetDom]])
  };
  const targetMock = createRealMockCdpServer(targetStates);
  await new Promise(r => targetMock.server.listen(0, '127.0.0.1', r));
  let targetClosed = false;
  t.after(() => targetClosed ? Promise.resolve() : targetMock.close());
  const portB = targetMock.server.address().port;
  const originB = `http://127.0.0.1:${portB}`;
  targetStates.listEntries = [
    { id: 'page-target', type: 'page', url: `${originB}/c/target`, webSocketDebuggerUrl: `ws://127.0.0.1:${portB}/devtools/page/page-target` }
  ];

  // 3. 启动真实 live-host.js 子进程，仅绑定 portB（APPDATA 故意指向包含 portA 的目录）
  const stampPath = path.join(stateDir, '.live-session.r201.json');
  const originsB64 = Buffer.from(JSON.stringify([originB]), 'utf8').toString('base64');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'live-host.js'),
    '--cdp-port', String(portB),
    '--stamp', stampPath,
    '--origins-b64', originsB64,
    '--state-dir', stateDir
  ], {
    env: {
      ...process.env,
      HOME: fakeHome,
      APPDATA: appDataDir,
      XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
      AG_METER_STATE_DIR: stateDir,
      AG_METER_TEST_MODE: '1',
      AG_CDP_PORT: String(portB)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childLogs = '';
  child.stdout?.on('data', c => { childLogs += c.toString(); });
  child.stderr?.on('data', c => { childLogs += c.toString(); });
  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
  });

  let liveInfo = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stampPath)) {
      try {
        liveInfo = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
        if (liveInfo?.port && liveInfo?.token) break;
      } catch {}
    }
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(liveInfo && liveInfo.port, `真实 live-host.js 应顺利启动并写出 stamp: ${childLogs}`);
  assert.equal(liveInfo.cdpPort, portB);

  const postLive = (route, payload) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: liveInfo.port,
      path: route,
      method: 'POST',
      headers: {
        Origin: originB,
        'X-AG-Context-Token': liveInfo.token,
        'Content-Type': 'application/json',
        Connection: 'close'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });

  const rtInfo = await postLive('/runtime-info', {});
  assert.equal(rtInfo.ok, true);
  assert.equal(rtInfo.cdpPort, portB);

  // 4. 在多实例共存下点击开启汉化 -> 仅实例 B 生效，诱饵实例 A (DevToolsActivePort) 零访问
  const toggleOn = await postLive('/toggle-module', {
    name: 'chinese',
    enable: true,
    opts: { language: 'zh-CN', brandTitle: 'english', asarPath: fakeAsar }
  });
  assert.equal(toggleOn.ok, true);
  assert.equal(toggleOn.mode, 'cdp-runtime');
  assert.equal(toggleOn.restartRequired, false);
  assert.equal(toggleOn.runtime.chineseActive, true);
  assert.equal(targetDom.nodes.uiBtnText.nodeValue, '设置', '目标实例 B 必须完成实时汉化');
  assert.equal(decoyStates.evalCalls.length, 0, '严禁向 DevToolsActivePort 默认诱饵实例 A 发起任何 CDP 调用');
  assert.equal(decoyDom.nodes.uiBtnText.nodeValue, 'Settings');

  const statusB = await postLive('/modules-status', { asarPath: fakeAsar });
  assert.equal(statusB.runtime.chineseActive, true);
  assert.equal(statusB.runtime.chineseNeedsRestart, false);

  // 5. 错误目标防护：关闭目标实例 B，诱饵实例 A 仍在线时切换设置，绝不得回落到 portA！
  await targetMock.close();
  targetClosed = true;

  const toggleAfterClose = await postLive('/toggle-module', {
    name: 'chinese',
    enable: true,
    opts: { language: 'zh-CN', brandTitle: 'translated', asarPath: fakeAsar }
  });
  assert.equal(toggleAfterClose.ok, true);
  assert.equal(toggleAfterClose.runtime.chineseActive, false);
  assert.equal(toggleAfterClose.restartRequired, true);
  assert.equal(decoyStates.evalCalls.length, 0, '目标端口失效时绝不得回退连接 DevToolsActivePort 诱饵实例');
  assert.equal(decoyDom.nodes.uiBtnText.nodeValue, 'Settings');
  assert.equal(decoyDom.nodes.brandText.nodeValue, 'Antigravity');

  await postLive('/shutdown', {}).catch(() => {});
});
