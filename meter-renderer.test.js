const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
function harness(scanSession = session(), extraSandbox = null) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [], hidden: false, textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!current.includes(c)) current.push(c);
          attrs.set('class', current.join(' '));
        },
        remove(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', current.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) {
        if (k === 'id') {
          const id = attrs.get('id');
          if (id && docElements.get(id) === el) docElements.delete(id);
        }
        attrs.delete(k);
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx >= 0) this.parentElement.children.splice(idx, 1);
        }
        const myId = attrs.get('id');
        if (myId && docElements.get(myId) === this) {
          docElements.delete(myId);
        }
      },
      appendChild(x) {
        if (x) {
          x.parentElement = this;
          this.children.push(x);
          const xId = x.id || (typeof x.getAttribute === 'function' ? x.getAttribute('id') : null);
          if (xId) docElements.set(xId, x);
        }
      },
      querySelectorAll(sel) {
        const found = [];
        const check = node => {
          if (!node) return;
          if (sel === '#ag-wco-spacer' && (node.id === 'ag-wco-spacer' || node.getAttribute?.('id') === 'ag-wco-spacer')) {
            found.push(node);
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) check(child);
          }
        };
        for (const child of this.children) check(child);
        return found;
      },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element(); host.attachShadow = () => ({ set innerHTML(value) { }, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const pending = [], scans = [], timers = [];
  const docListeners = new Map();
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        docListeners.get(type)?.delete(fn);
      },
      dispatchEvent(ev) {
        const type = ev?.type || ev;
        for (const fn of (docListeners.get(type) || [])) fn(ev);
      },
      hidden: false
    },
    window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() { },
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
    ...(extraSandbox && typeof extraSandbox === 'object' ? extraSandbox : {})
  };
  // First createElement call is the host; later calls are safe text-only file rows.
  let first = true; sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  return { sandbox, host, pending, scans, elements, tick: () => timers[0](), flush: () => new Promise(resolve => setImmediate(resolve)), finishScan(i = 0) { scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } }); } };
}
function response(chatModel) { return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) }; }

test('帖子 #124：会话费用栏展示最近未知调用折算和混合会话总额', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const calls = [
    { callId: 'known', model: 'Gemini 4 Carbon', isPriced: true, costUSD: 2.5 },
    { callId: 'unknown', inputTokens: 40000, cacheTokens: 20000, outputTokens: 10000 }
  ];
  try {
    api.setComposerStateForTest({ sessionCalls: calls });
    api.setAvailableWidthForTest(900);
    const mixed = core.summarizeSessionHybridCost(calls);
    assert.ok(h.elements.get('round-cost-text').textContent.includes(mixed.latestEstimateUSD.toFixed(4)));
    assert.ok(h.elements.get('session-cost-text').textContent.includes(mixed.combinedTotalUSD.toFixed(4)));
    assert.match(h.elements.get('session-cost-text').title, /Gemini 3\.8 Flash/);
  } finally {
    api.dispose();
  }
});
test('late old request and old full-scan responses cannot contaminate a newly selected chat', async () => {
  const h = harness(); h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222'; h.tick();
  assert.equal(h.pending[0].options.signal.aborted, true);
  h.pending[1].resolve(response({ usage: { inputTokens: 10000 } })); h.finishScan(1); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 900000 } })); h.scans[0].resolve({ ok: true, data: { session: session(1), latest: null, scannedAt: Date.now() } }); await h.flush();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, 10000); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan.session.unknownFiles, 0); h.sandbox.__AGContextMeter.dispose();
});
test('server overflow dominates low client estimate, missing images and successful old usage', async () => {
  const h = harness(session(1)); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 9000 }, chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 127117, maxContextTokens: 256000 } }, retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.match(h.elements.get('status').textContent, /本地估算不可靠/); assert.match(h.elements.get('percent').textContent, /不提供/); assert.doesNotMatch(h.elements.get('status').textContent, /生成中|充足|正常/); h.sandbox.__AGContextMeter.dispose();
});
test('unknown attachments appear as unknown in totals and file names are literal text', async () => {
  const h = harness(session(1)); h.finishScan(); h.pending[0].resolve(response({ usage: { inputTokens: 1000 } })); await h.flush();
  assert.match(h.elements.get('session-total').textContent, /未知内容/); assert.match(h.elements.get('coverage').textContent, /1 个含未计内容/);
  assert.equal(h.elements.get('files').children[0].children[0].textContent, '<img onerror=bad> '); h.sandbox.__AGContextMeter.dispose();
});
test('a visible newer failure is not cleared by polling old successful metadata', async () => {
  const s = session(); s.currentError = { index: 907, text: 'The input token count exceeds the maximum number of tokens allowed 1048576.' };
  const h = harness(s); h.finishScan(); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 120000 } })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, null); h.sandbox.__AGContextMeter.dispose();
});
test('backend estimate never becomes a capacity percentage', async () => {
  const h = harness(); h.finishScan(); h.pending[0].resolve(response({ chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 1000, maxContextTokens: 256000 } } })); await h.flush();
  assert.match(h.elements.get('percent').textContent, /不提供/); assert.match(h.elements.get('amount').textContent, /真实量未知/); h.sandbox.__AGContextMeter.dispose();
});
test('failed history scan stays explicitly incomplete instead of claiming there were no attachments', async () => {
  const h = harness(); h.scans[0].resolve({ ok: false, error: 'missing file' }); h.pending[0].resolve({ ok: false, status: 503 }); await h.flush();
  assert.equal(h.elements.get('session-total').textContent, '扫描未完成'); assert.match(h.elements.get('coverage').textContent, /missing file/); h.sandbox.__AGContextMeter.dispose();
});
test('home screen clears previous conversation and cancels in-flight requests', () => {
  const h = harness(); h.sandbox.location.pathname = '/'; h.tick(); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan, null); assert.equal(h.pending[0].options.signal.aborted, true); h.sandbox.__AGContextMeter.dispose();
});
test('badge renders visual progress bar and concise context number when unhovered', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 214624, outputTokens: 1454 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '84.40546875%');
  assert.match(h.elements.get('amount').textContent, /^216(?:\.1)?K \(84%\)$/);
  assert.match(h.elements.get('hover-extra').textContent, /\/ 256K/);
  assert.equal(h.elements.get('key-used').textContent, '216.1K (84.4%)');
  assert.equal(h.elements.get('key-limit').textContent, '256K');
  assert.match(h.elements.get('key-remaining').textContent, /39\.9K \(15\.6%\)/);
  assert.match(h.elements.get('key-takeaway').textContent, /已使用 84\.4%/);
  assert.equal(h.elements.get('key-badge').textContent, '偏高');
  h.sandbox.__AGContextMeter.dispose();
});
test('key summary card shows overflow alert and zeroes remaining when exceeded', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '100%');
  assert.equal(h.elements.get('amount').textContent, '服务端超限');
  assert.equal(h.elements.get('key-badge').textContent, '已超限');
  assert.equal(h.elements.get('key-remaining').textContent, '0 (已溢出)');
  assert.match(h.elements.get('key-takeaway').textContent, /已超出服务端最大限制/);
  h.sandbox.__AGContextMeter.dispose();
});
test('theme mode switches freely between light and dark', () => {
  const h = harness();
  assert.equal(typeof h.sandbox.__AGContextMeter.theme(), 'string');
  h.sandbox.__AGContextMeter.setTheme('light');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'light');
  h.sandbox.__AGContextMeter.setTheme('dark');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'dark');
  h.sandbox.__AGContextMeter.dispose();
});
test('speed badge and speed summary card accurately render model output speed and duration', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    timeToFirstToken: '8.395092700s',
    streamingDuration: '12.902455200s',
    usage: {
      inputTokens: 4335,
      outputTokens: 2388,
      thinkingOutputTokens: 1260,
      responseOutputTokens: 1128
    },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('speed-amount').textContent, '185.1 tok/s');
  assert.match(h.elements.get('speed-hover-extra').textContent, /21\.3s/);
  assert.match(h.elements.get('badge-speed').title, /185\.1 tok\/s/);
  assert.equal(h.elements.get('speed-val').textContent, '185.1 tok/s');
  assert.equal(h.elements.get('speed-duration').textContent, '21.3s');
  assert.equal(h.elements.get('speed-ttft').textContent, '8.4s');
  assert.match(h.elements.get('speed-tokens').textContent, /2,388 tok/);
  assert.equal(h.elements.get('speed-badge').textContent, '⚡ 83.7 分 · A');
  assert.match(h.elements.get('speed-takeaway').textContent, /83\.8 分|整体均速 112\.1 tok\/s/);
  h.sandbox.__AGContextMeter.dispose();
});
test('drawer toggle controls secondary technical details visibility', () => {
  const h = harness();
  const btn = h.elements.get('btn-toggle-details');
  const body = h.elements.get('drawer-body');
  const arrow = h.elements.get('drawer-arrow');
  assert.ok(btn);
  assert.ok(body);
  btn.click();
  assert.equal(body.style.display, 'block');
  assert.equal(arrow.textContent, '▲ 点击收起明细');
  btn.click();
  assert.equal(body.style.display, 'none');
  assert.equal(arrow.textContent, '▼ 点击展开明细');
  h.sandbox.__AGContextMeter.dispose();
});
test('decoupled dual panels and hover switching between context and tokens', () => {
  const h = harness();
  const bContext = h.elements.get('badge');
  const bSpeed = h.elements.get('badge-speed');
  const bTokens = h.elements.get('badge-tokens');
  const pContext = h.elements.get('panel');
  const pTokens = h.elements.get('panel-tokens');

  assert.ok(pContext);
  assert.ok(pTokens);
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, true);

  // Click Context badge -> opens context panel only
  bContext.click();
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Hover over Tokens badge while open -> does NOT accidentally switch (anti-misclick)
  bTokens.trigger('mouseenter');
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Left click on Tokens badge -> switches to tokens panel
  bTokens.click();
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, false);

  // Hover over Speed / Context badge -> does NOT switch back
  bSpeed.trigger('mouseenter');
  bContext.trigger('mouseenter');
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, false);

  // Left click Context badge -> switches back to context panel
  bContext.click();
  assert.equal(pContext.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Close button closes context panel
  h.elements.get('close').click();
  assert.equal(pContext.hidden, true);
  assert.equal(pTokens.hidden, true);

  h.sandbox.__AGContextMeter.dispose();
});

test('circular ring indicator and 3-layer tooltip bubble match reference hierarchy on hover and focus', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 36500, outputTokens: 500 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 475000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tip = h.elements.get('context-tooltip');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');
  const badge = h.elements.get('badge');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'determinate');
  // 37k / 475k = 7.789% -> rounds to 8% used (92% remaining)
  assert.equal(tipTitle.textContent, '上下文窗口：');
  assert.equal(tipPct.textContent, '8% 已用（剩余 92%）');
  assert.equal(tipDetail.textContent, '已用 37k token，共 475k');

  // Hover opens tooltip, mouseleave closes
  assert.equal(tip.getAttribute('data-visible'), 'false');
  badge.trigger('mouseenter');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('mouseleave');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  // Keyboard focus opens tooltip, blur closes
  badge.trigger('focus');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('blur');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  h.sandbox.__AGContextMeter.dispose();
});

test('unknown capacity and estimated states never draw ring as 0% or 100% and preserve estimation labels', async () => {
  const h = harness(); h.finishScan();
  // Case 1: estimated only, no actual server usage
  h.pending[0].resolve(response({
    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 42000, maxContextTokens: 256000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'estimated');
  assert.equal(ringFill.getAttribute('stroke-dasharray'), '3.2 4.97');
  assert.match(tipTitle.textContent, /本地估算/);
  assert.match(tipPct.textContent, /仅估算/);
  assert.match(tipDetail.textContent, /≈ 42k token，共 256k/);

  h.sandbox.__AGContextMeter.dispose();
});

test('progressive width collapse transitions smoothly across 4 stages with hysteresis and preserves full access in ring-only mode', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  assert.equal(api.getLayoutMode(), 'wide');
  // Collapse wide -> compact (<195)
  assert.equal(api.setAvailableWidthForTest(180), 'compact');
  // Hysteresis deadband: 200 (<210) stays compact instead of oscillating back to wide
  assert.equal(api.setAvailableWidthForTest(200), 'compact');
  // Expand back to wide (>=210)
  assert.equal(api.setAvailableWidthForTest(215), 'wide');

  // Collapse to minimal (<135)
  assert.equal(api.setAvailableWidthForTest(120), 'minimal');
  assert.equal(api.setAvailableWidthForTest(142), 'minimal'); // hysteresis (<150)

  // Collapse to ring-only (<68)
  assert.equal(api.setAvailableWidthForTest(55), 'ring-only');
  assert.equal(api.setAvailableWidthForTest(75), 'ring-only'); // hysteresis (<82)
  assert.equal(api.setAvailableWidthForTest(90), 'minimal');

  // In ring-only mode, clicking the ring opens context panel, and overflow menu reaches token stats
  api.setAvailableWidthForTest(50);
  h.elements.get('badge').click();
  assert.equal(h.elements.get('panel').hidden, false);
  h.elements.get('overflow-tokens-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, true);
  assert.equal(h.elements.get('panel-tokens').hidden, false);
  h.elements.get('overflow-speed-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, false);

  api.dispose();
});

test('6 independent custom color slots support custom values, reset to theme default, and do not mask high-occupancy alerts', async () => {
  const h = harness(); h.finishScan();
  const api = h.sandbox.__AGContextMeter;

  api.setCustomColor('ringUsed', '#10b981');
  api.setCustomColor('speedText', '#f59e0b');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-ring-used'), '#10b981');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-speed'), '#f59e0b');

  // High occupancy (>=90%) sets data-occupancy="danger" and explicit text warning in bubble
  h.pending[0].resolve(response({
    usage: { inputTokens: 240000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.host.getAttribute('data-occupancy'), 'danger');
  assert.match(h.elements.get('ctx-tip-title').textContent, /高占用告警/);
  assert.match(h.elements.get('ctx-tip-pct').textContent, /接近上限/);

  api.resetCustomColors();
  assert.equal(h.host.style.getPropertyValue('--ag-custom-ring-used'), '');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-speed'), '');
  api.dispose();
});

test('window controls overlay spacer, convPane flex-grow self-healing, and clean dispose', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  assert.equal(api.version, pkgVersion);

  // 1. Antigravity 1.x: class contains 'top-0'
  const cluster1x = h.sandbox.document.createElement();
  cluster1x.className = 'absolute right-0 top-0 z-50 flex items-center';
  cluster1x.getBoundingClientRect = () => ({ top: 0, left: 1200, right: 1440, bottom: 40, width: 240, height: 40 });
  const auxToggle1x = h.sandbox.document.createElement();
  auxToggle1x.setAttribute('data-testid', 'toggle-aux-sidebar');
  auxToggle1x.closest = sel => sel.includes('top-0') ? cluster1x : null;

  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle1x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster1x, 'Must detect Antigravity 1.x cluster with top-0 class');

  // 2. Antigravity 2.x: top: 0px is inline style, class has no top-0
  const cluster2x = h.sandbox.document.createElement();
  cluster2x.className = 'absolute right-0 z-50 flex items-center shrink-0';
  cluster2x.style.top = '0px';
  cluster2x.getBoundingClientRect = () => ({ top: 0, left: 1200, right: 1440, bottom: 40, width: 240, height: 40 });
  const auxToggle2x = h.sandbox.document.createElement();
  auxToggle2x.setAttribute('data-testid', 'toggle-aux-sidebar');
  auxToggle2x.closest = sel => sel.includes('top-0') ? null : (sel.includes('right-0') ? cluster2x : null);

  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle2x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster2x, 'Must detect Antigravity 2.x cluster with style="top: 0px;"');

  // 3. Fallback when auxToggle is missing: matches cluster2x via fallback selector
  h.sandbox.document.querySelector = sel => {
    if (sel === 'div.absolute.right-0.z-50') return cluster2x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster2x, 'Fallback must find top-right cluster');

  // 4. Safety: strictly reject unrelated floating layers
  // 4a. Scrollbar track (w-3, right-0.5, top-0.5)
  const scrollbar = h.sandbox.document.createElement();
  scrollbar.className = 'group absolute top-0.5 bottom-0.5 right-0.5 w-3 z-30';
  scrollbar.getBoundingClientRect = () => ({ top: 0, left: 1435, right: 1440, bottom: 800, width: 5, height: 800 });

  // 4b. Full-height side drawer / panel
  const sideDrawer = h.sandbox.document.createElement();
  sideDrawer.className = 'absolute right-0 top-12 bottom-0 w-80 bg-white';
  sideDrawer.getBoundingClientRect = () => ({ top: 48, left: 1120, right: 1440, bottom: 800, width: 320, height: 752 });

  // 4c. Bottom toast notification
  const bottomToast = h.sandbox.document.createElement();
  bottomToast.className = 'absolute right-0 bottom-4 z-50';
  bottomToast.getBoundingClientRect = () => ({ top: 760, left: 1200, right: 1440, bottom: 800, width: 240, height: 40 });

  for (const unrelated of [scrollbar, sideDrawer, bottomToast]) {
    h.sandbox.document.querySelector = sel => {
      if (sel === 'div.absolute.right-0.z-50') return unrelated;
      return null;
    };
    assert.equal(api.findTopRightClusterForTest(), null, `Must safely reject unrelated floating element: ${unrelated.className}`);
  }

  // 5. WCO spacer width calculation & mounting on Windows (at top: 0px, no top-0 class)
  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle2x;
    return null;
  };
  const wcoWidth = api.computeWindowControlsWidthForTest(cluster2x);
  assert.equal(wcoWidth, 138, 'Windows with no menubar should allocate 138px for titleBarOverlay');

  api.syncWindowControlsOverlayForTest();
  assert.equal(cluster2x.children.length, 1);
  const spacer = cluster2x.children[0];
  assert.equal(spacer.id, 'ag-wco-spacer');
  assert.equal(spacer.style.cssText, 'width:138px;height:100%;flex-shrink:0;pointer-events:none;');
  assert.equal(h.sandbox.document.getElementById('ag-wco-spacer'), spacer, 'ag-wco-spacer must be accessible in document');

  // 6. When toolbar moves down (top >= 20), findTopRightCluster returns null, and syncWindowControlsOverlay removes the old spacer
  cluster2x.style.top = '25px';
  cluster2x.getBoundingClientRect = () => ({ top: 25, left: 1200, right: 1440, bottom: 65, width: 240, height: 40 });
  assert.equal(api.findTopRightClusterForTest(), null, 'findTopRightCluster must return null when toolbar moves down to top >= 20');
  api.syncWindowControlsOverlayForTest();
  assert.equal(cluster2x.children.length, 0, 'Spacer must be cleanly removed from toolbar when moved down');
  assert.equal(h.sandbox.document.getElementById('ag-wco-spacer'), null, 'ag-wco-spacer must be removed from document');

  // 7. Standalone compute check: when top menu bar is present (top >= 20), WCO width is 0
  const clusterWithMenu = h.sandbox.document.createElement();
  clusterWithMenu.className = 'absolute right-0 z-50 flex items-center shrink-0';
  clusterWithMenu.style.top = '35px';
  clusterWithMenu.getBoundingClientRect = () => ({ top: 35, left: 1200, right: 1440, bottom: 75, width: 240, height: 40 });
  assert.equal(api.computeWindowControlsWidthForTest(clusterWithMenu), 0);

  // 8. On macOS (Darwin/MacIntel), WCO width is 0
  h.sandbox.navigator = { platform: 'MacIntel' };
  assert.equal(api.computeWindowControlsWidthForTest(cluster2x), 0);
  api.dispose();
});

test('floating panels reposition clear of left project sidebar and overlay right auxiliary pane without clipping', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  // Simulate left project sidebar expanded (0..256px) and right auxiliary pane open (host right = 610px in 1280px window)
  h.sandbox.window.innerWidth = 1280;
  h.sandbox.window.innerHeight = 800;
  h.host.getBoundingClientRect = () => ({ left: 420, top: 6, right: 610, bottom: 34, width: 190, height: 28 });
  h.sandbox.document.querySelector = sel => {
    if (sel === 'div[role="navigation"]') {
      return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 256, bottom: 800, width: 256, height: 800 }) };
    }
    return null;
  };

  h.elements.get('badge-tokens').click();
  const pTokens = h.elements.get('panel-tokens');
  assert.equal(pTokens.hidden, false);
  const leftPx = parseInt(pTokens.style.left, 10);
  // Must be >= 256 + 12 = 268px (never occluded by left project sidebar) and extend rightward over Aux Pane
  assert.equal(leftPx, 268);
  assert.equal(pTokens.style.right, 'auto');
  assert.ok(leftPx + 730 <= 1280 - 12);

  api.dispose();
});

test('custom background color (panelBg), custom Color Picker HEX->RGB/HSL sync, and heatmap 5-stop presets & 2-endpoint interpolation', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Custom panel background color unifies Level 1 & Level 2 and sets data-panel-tone
  api.setCustomColor('panelBg', '#f8fafc');
  assert.equal(h.host.style.getPropertyValue('--ag-custom-panel-bg'), '#f8fafc');
  assert.equal(h.host.getAttribute('data-panel-tone'), 'light');

  // Open custom Color Picker for tokenAccent and test direct HEX input without '#' ('652ab7')
  api.openColorPicker('tokenAccent', null, 'Token 强调色');
  assert.equal(h.elements.get('color-picker-popover').hidden, false);
  const hexIn = h.elements.get('cp-input-hex');
  const rgbIn = h.elements.get('cp-input-rgb');
  const hslIn = h.elements.get('cp-input-hsl');
  hexIn.value = '652ab7';
  hexIn.trigger('input', { target: hexIn });
  assert.equal(h.host.style.getPropertyValue('--ag-custom-token-accent'), '#652ab7');
  assert.equal(rgbIn.value, 'rgb(101, 42, 183)');
  assert.equal(hslIn.value, 'hsl(265, 63%, 44%)');

  // Heatmap 5-stop preset switching
  api.setHeatPreset('green');
  assert.equal(api.getHeatPreset(), 'green');
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-4'), '#86efac');

  // Heatmap 2-endpoint custom interpolation (low = blue #1d4ed8, high = red #ef4444)
  api.setCustomColor('heatLow', '#1d4ed8');
  api.setCustomColor('heatHigh', '#ef4444');
  const palette = api.getHeatPalette();
  assert.equal(palette.length, 5);
  assert.equal(palette[0], '#1d4ed8');
  assert.equal(palette[4], '#ef4444');
  assert.notEqual(palette[2], palette[0]);
  assert.notEqual(palette[2], palette[4]);
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-2'), palette[2]);

  api.resetCustomColors();
  assert.equal(h.host.getAttribute('data-panel-tone'), null);
  api.dispose();
});

test('daily heatmap repaints low and high usage with the active purple theme', t => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  t.after(() => api.dispose());

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const lowDay = yesterday.toLocaleDateString('en-CA');
  const highDay = today.toLocaleDateString('en-CA');
  api.setTokenHistoryForTest({
    firstUseDate: lowDay,
    dailyMap: { [lowDay]: { total: 145700 }, [highDay]: { total: 131110000 } }
  });
  api.switchHeatView('daily');

  function cellColors() {
    const cells = h.elements.get('h-grid-cols').children.flatMap(col => col.children);
    return [lowDay, highDay].map(day =>
      cells.find(cell => cell.getAttribute('data-date') === day).style.backgroundColor);
  }

  api.setTheme('dark');
  assert.deepEqual(cellColors(), ['#5f27b2', '#d8b4fe']);

  api.setTheme('light');
  const legendStops = [1, 2, 3, 4].map(i => h.elements.get(`heat-leg-${i}`).style.background);
  const lowResponse = core.computeColorScaleResponse(145700, 'heat');
  const lightColors = [core.interpolateScaleColorHsl(lowResponse, legendStops), legendStops[3]];
  assert.deepEqual(cellColors(), lightColors);

  h.sandbox.document.documentElement.style = { colorScheme: 'dark' };
  api.setTheme('auto');
  assert.deepEqual(cellColors(), ['#5f27b2', '#d8b4fe']);
  h.sandbox.document.documentElement.style.colorScheme = 'light';
  api.setTheme('auto');
  assert.deepEqual(cellColors(), lightColors);
});

test('timeline starts at actual firstUseDate with zero leading blank cells and supports multi-year archive pagination', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Verify custom firstUseDate (2026-10-20)
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const win1 = api.getTimelineWindow();
  assert.equal(win1.firstUseDate, '2026-10-20');
  assert.equal(win1.winStart, '2026-10-20');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2026年10月20日');

  const colsBox = h.elements.get('h-grid-cols');
  assert.equal(colsBox.children.length, 52);
  const firstCell = colsBox.children[0].children[0];
  assert.equal(firstCell.getAttribute('data-date'), '2026-10-20');

  // Simulate multi-year archive (e.g., first use 2025-03-15) -> rolling 12-month window with pagination clamped >= firstUseDate
  api.setTokenHistoryForTest({
    firstUseDate: '2025-03-15',
    dailyMap: {
      '2025-03-15': { total: 12000000, input: 10000000, output: 1000000, cache: 1000000, steps: 80 }
    }
  });
  const win2 = api.getTimelineWindow();
  assert.equal(win2.firstUseDate, '2025-03-15');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2025年3月15日');
  assert.equal(win2.canPrev, true);

  // Page back to earliest history; winStart must never go earlier than 2025-03-15
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  const winEarliest = api.getTimelineWindow();
  assert.equal(winEarliest.winStart, '2025-03-15');
  assert.equal(winEarliest.canPrev, false);
  assert.equal(winEarliest.canNext, true);

  api.dispose();
});

test('5 heatmap levels (heatLvl0..4) support per-cell independent custom colors, free layering with presets/2-endpoint interpolation, and direct legend click color picker', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) All 5 levels (heatLvl0..4) set to 5 completely distinct custom colors
  const distinct5 = ['#1e293b', '#06b6d4', '#eab308', '#f97316', '#ec4899'];
  distinct5.forEach((hex, idx) => api.setCustomColor(`heatLvl${idx}`, hex));
  assert.deepEqual(Array.from(api.getHeatPalette()), distinct5);
  for (let i = 0; i < 5; i++) {
    assert.equal(h.host.style.getPropertyValue(`--ag-heat-lvl-${i}`), distinct5[i]);
    assert.equal(h.elements.get(`heat-leg-${i}`).style.background, distinct5[i]);
    assert.equal(h.elements.get(`heat-leg-${i}`).getAttribute('data-custom'), 'true');
  }

  // 2) Switching preset clears heatLvl0..4 and heatLow/heatHigh overrides, then single-cell override layers on top
  api.setHeatPreset('green');
  assert.equal(api.getHeatPreset(), 'green');
  const greenBase = Array.from(api.getHeatPalette());
  assert.equal(greenBase[4], '#86efac');
  assert.equal(h.elements.get('heat-leg-2').getAttribute('data-custom'), 'false');

  // Layer single-cell override on level 3 (heatLvl2 = bright orange #f97316) over green preset
  api.setCustomColor('heatLvl2', '#f97316');
  const greenWithOrangeMid = Array.from(api.getHeatPalette());
  assert.equal(greenWithOrangeMid[0], greenBase[0]);
  assert.equal(greenWithOrangeMid[1], greenBase[1]);
  assert.equal(greenWithOrangeMid[2], '#f97316');
  assert.equal(greenWithOrangeMid[3], greenBase[3]);
  assert.equal(greenWithOrangeMid[4], greenBase[4]);

  // Layer 2-endpoint interpolation (heatLow + heatHigh) with single-cell override on heatLvl2
  api.setCustomColor('heatLow', '#1d4ed8');
  api.setCustomColor('heatHigh', '#ef4444');
  const interpWithOrangeMid = Array.from(api.getHeatPalette());
  assert.equal(interpWithOrangeMid[0], '#1d4ed8');
  assert.equal(interpWithOrangeMid[2], '#f97316');
  assert.equal(interpWithOrangeMid[4], '#ef4444');

  // 3) Clicking legend cell #heat-leg-0..4 directly opens #color-picker-popover bound to that exact level
  api.closeColorPicker();
  assert.equal(h.elements.get('color-picker-popover').hidden, true);
  h.elements.get('heat-leg-3').click();
  assert.equal(h.elements.get('color-picker-popover').hidden, false);
  assert.equal(api.getActivePickerSlot(), 'heatLvl3');
  api.applyPickerHex('#a855f7');
  assert.equal(api.getHeatPalette()[3], '#a855f7');
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-3'), '#a855f7');

  // Resetting single slot via #reset-heatLvl3 restores level 3 to interpolated/preset color without losing heatLvl2
  h.elements.get('reset-heatLvl3').click();
  assert.notEqual(api.getHeatPalette()[3], '#a855f7');
  assert.equal(api.getHeatPalette()[2], '#f97316');

  // Reset all 5 heatmap levels via #reset-heat-lvls
  h.elements.get('reset-heat-lvls').click();
  assert.deepEqual(Array.from(api.getHeatPalette()), greenBase);

  api.dispose();
});

test('heatmap top-row anti-clipping padding and popover Chinese translations for Prompt, Output, Cache', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Ensure .heat-scroll-box has padding to prevent top cell hover outline clipping
  assert.match(source, /\.heat-scroll-box\s*\{[^}]*padding:\s*6px 6px 4px 6px/);
  assert.match(source, /\.pop-det-trans\s*\{[^}]*font-size:\s*9\.5px/);

  // 2) Trigger daily heatmap cell click
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const colsBox = h.elements.get('h-grid-cols');
  assert.ok(colsBox && colsBox.children.length > 0, 'grid columns should exist');
  const firstCol = colsBox.children[0];
  const firstCell = firstCol.children[0];
  assert.ok(firstCell, 'first cell should exist');

  // Trigger click on firstCell
  firstCell.click();

  const heatPopVal = h.elements.get('heat-pop-val');
  const heatPopDet = h.elements.get('heat-pop-det');
  assert.ok(heatPopVal, 'heatPopVal element exists');
  assert.ok(heatPopDet, 'heatPopDet element exists');

  // Value contains 'Tokens' and appended reference cost
  assert.match(heatPopVal.textContent, /Tokens/);
  assert.match(heatPopVal.textContent, /≈ \$/);

  // Detail section has 3 columns with Chinese translations directly beneath Prompt, Output, Cache
  assert.match(heatPopDet.innerHTML, /Prompt:[\s\S]*?<span class="pop-det-trans">提示词<\/span>/);
  assert.match(heatPopDet.innerHTML, /Output:[\s\S]*?<span class="pop-det-trans">输出<\/span>/);
  assert.match(heatPopDet.innerHTML, /Cache:[\s\S]*?<span class="pop-det-trans">缓存<\/span>/);

  api.dispose();
});

test('default current period API reference amount, independent subscription spend, and reference cost drawer', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 50000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const mockPayload = {
    updatedAt: '2026-11-08 19:00:00',
    currentPeriod: {
      key: '2026-11',
      label: '2026-11 (自然月)',
      isCurrentMonth: true
    },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'test@example.com',
      region: '未知',
      regionSource: 'unknown',
      actualPricePaid: null,
      officialPriceMonthly: 19.99,
      priceRangeNote: '$19.99/月（公开参考）',
      priceSource: 'official_reference',
      currency: 'USD',
      billingCycle: '月付（公开参考）'
    },
    costEstimate: {
      pricedCostUSD: 0.05,
      pricedRequestsCount: 2,
      unpricedRequestsCount: 100,
      coveragePercent: 2.0,
      unpricedTokens: 500000,
      unpricedReasons: { missingModel: 100, unsupportedModel: 0, missingUsage: 0 },
      byModel: { 'gemini-3.8-flash': { costUSD: 0.05, tokens: 20000 } }
    },
    costEstimateCurrentMonth: {
      pricedCostUSD: 0.03,
      pricedRequestsCount: 1,
      unpricedRequestsCount: 20,
      coveragePercent: 4.8,
      unpricedTokens: 100000,
      unpricedReasons: { missingModel: 20, unsupportedModel: 0, missingUsage: 0 },
      byModel: { 'gemini-3.8-flash': { costUSD: 0.03, tokens: 10000 } }
    },
    referenceCost: {
      currentMonth: {
        modelKey: 'gemini-3.8-flash',
        totalCostUSD: 69.50,
        inputCostUSD: 18.00,
        inputTokens: 24000000,
        cacheCostUSD: 41.50,
        cacheTokens: 553333333,
        outputCostUSD: 10.00,
        outputTokens: 2666667
      },
      all: {
        modelKey: 'gemini-3.8-flash',
        totalCostUSD: 211.64,
        inputCostUSD: 56.73,
        inputTokens: 75639212,
        cacheCostUSD: 123.58,
        cacheTokens: 1647757871,
        outputCostUSD: 31.33,
        outputTokens: 8354728
      },
      hybrid: {
        modelKey: 'gemini-3.8-flash',
        hybrid: {
          knownCostUSD: 0.05,
          unpricedResidualCostUSD: 211.59,
          combinedTotalUSD: 211.64,
          residualTokensBreakdown: {
            input: 75619212,
            cache: 1647757871,
            output: 8352728
          }
        }
      }
    }
  };

  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(mockPayload);
  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();

  // 1) 验证首屏默认并列展示：已记录用量按公开API折算金额（绝不显示为 $0）与用户实际支出
  const titleEl = h.elements.get('cost-card-title');
  const periodTag = h.elements.get('cost-period-tag');
  const grandVal = h.elements.get('cost-grand-val');
  assert.equal(titleEl.textContent, '💰 本期 API 参考金额');
  assert.equal(periodTag.textContent, '2026-11 (自然月)');
  assert.equal(grandVal.textContent, '约 $69.50');

  // 2) 验证并列展示的订阅支出（严禁回本或节省词汇）
  const subSpendVal = h.elements.get('cost-sub-spend-val');
  const subNote = h.elements.get('cost-sub-compare-note');
  assert.match(subSpendVal.textContent, /实付未知/);
  assert.match(subNote.textContent, /公开参考价 \$19.99\/月/);

  // 3) 切换为“仅已识别模型”模式：展示已识别记录 $0.03
  h.elements.get('cost-btn-mode-identified').click();
  assert.equal(grandVal.textContent, '$0.03');
  assert.equal(h.elements.get('cost-coverage-pill').textContent, '4.8% 计价覆盖');

  // 4) 切换回“参考模型折算”并切换至“全量历史”
  h.elements.get('cost-btn-mode-ref').click();
  h.elements.get('cost-btn-scope-all').click();
  assert.equal(titleEl.textContent, '💰 全量 API 参考金额');
  assert.equal(grandVal.textContent, '约 $211.64');
  assert.match(h.elements.get('cost-sub-compare-note').textContent, /全量累计不直接对比单月支出/);

  // 5) 测试套餐详情卡片内的就地自定义表单：选择学生认证优惠，勾选免额外实付
  h.elements.get('btn-plan-detail-toggle').click();
  const editBtn = h.elements.get('btn-edit-plan-custom');
  editBtn.click();
  const customForm = h.elements.get('plan-custom-form');
  assert.equal(customForm.style.display, 'block');

  h.elements.get('select-custom-acq').value = 'student_offer';
  // 模拟 change 事件
  h.elements.get('select-custom-acq').trigger('change', { target: { value: 'student_offer' } });
  assert.equal(h.elements.get('check-zero-extra').checked, true);
  assert.equal(h.elements.get('input-custom-paid').value, '0');

  h.elements.get('input-custom-region').value = '日本 (JP)';
  h.elements.get('input-custom-note').value = '学生组合优惠';
  h.elements.get('btn-custom-plan-save').click();

  assert.equal(customForm.style.display, 'none');
  assert.equal(h.elements.get('p-det-region').textContent, 'JP 日本');
  assert.match(h.elements.get('p-det-acq').textContent, /学生.*优惠/);
  assert.match(h.elements.get('p-det-price').textContent, /\$0/);
  assert.equal(h.elements.get('p-det-price-tag').textContent, '免费');

  // 验证在首屏估值卡片中，实际支出并列显示为 $0，且标注免费权益使用中
  h.elements.get('cost-btn-scope-period').click();
  assert.equal(h.elements.get('cost-sub-spend-val').textContent, '$0');
  assert.match(h.elements.get('cost-sub-compare-note').textContent, /免费权益使用中/);

  // 6) 清除自定义
  editBtn.click();
  h.elements.get('btn-custom-plan-clear').click();
  assert.equal(customForm.style.display, 'none');
  assert.equal(h.elements.get('p-det-region-tag').style.display, 'none');

  h.sandbox.__AGContextMeter.dispose();
});

test('integrated verification: legacy payload without referenceCost calculates dynamically, zero-flash prevention, and compact/detail expansion', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 50000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const todayStr = (new Date()).toISOString().slice(0, 10);
  const legacyPayload = {
    updatedAt: `${todayStr} 12:00:00`,
    dailyMap: {
      [todayStr]: { total: 31000, input: 10000, cache: 20000, output: 1000, steps: 5 }
    },
    // 故意不传 referenceCost，模拟旧版后台
    summary: {
      grandTotalTokens: 31000,
      totalInputTokens: 10000,
      totalCacheTokens: 20000,
      totalOutputTokens: 1000,
      monthTokens: 31000,
      currentMonthInput: 10000,
      currentMonthCache: 20000,
      currentMonthOutput: 1000
    }
  };

  // 1. 验证旧版 payload 能正确动态补齐参考金额，不显示 $0.00，且分类 tokens 完整
  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(legacyPayload);
  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();

  const grandVal = h.elements.get('cost-grand-val');
  assert.notEqual(grandVal.textContent, '$0.00');
  assert.equal(grandVal.textContent, '约 $0.01');

  // 分类 token 和金额验证
  const inVal = h.elements.get('ref-cost-input-val');
  const inTok = h.elements.get('ref-cost-input-tok');
  assert.equal(inVal.textContent, '$0.01');
  assert.match(inTok.textContent, /10K|1\.0万|10\.0K|10000/);

  // 2. 验证有效数据存在时，传入空 payload 或 loading 状态不会把顶栏和卡片清零（防归零闪烁）
  const badgeAmt = h.elements.get('token-amount');
  assert.equal(badgeAmt.textContent, '31.0K');

  const emptyLoadingPayload = { loading: true, dailyMap: {}, summary: { grandTotalTokens: 0 } };
  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(emptyLoadingPayload);
  assert.equal(badgeAmt.textContent, '31.0K'); // 保持原有效值，严禁变 0！
  assert.equal(grandVal.textContent, '约 $0.01');

  // 3. 验证默认紧凑摘要态、常驻“API折算 · 非实付”及热力图在统计页隔离
  const detailsPane = h.elements.get('cost-details-pane');
  const toggleBtn = h.elements.get('btn-cost-details-toggle');
  const tokensMain = h.elements.get('tokens-main-view');
  const nonPaidBadge = h.elements.get('cost-non-paid-badge');
  const scopeDesc = h.elements.get('cost-scope-desc');
  const pTokens = h.elements.get('panel-tokens');

  assert.equal(detailsPane.style.display, 'none'); // 默认收起详情
  assert.equal(toggleBtn.textContent, '展开详情 ▼');
  assert.equal(tokensMain.style.display, 'none'); // 费用模式下热力图与统计卡片完全不展示
  assert.equal(nonPaidBadge.textContent, 'API折算 · 非实付');
  assert.match(scopeDesc.textContent, /全部来源/);

  // 4. 验证展开与收起围绕右侧锚点自适应展开与收拢
  const compactLeft = parseInt(pTokens.style.left, 10);
  // 点击展开
  toggleBtn.click();
  assert.equal(detailsPane.style.display, 'block');
  assert.equal(toggleBtn.textContent, '收起详情 ▴');
  const expandedLeft = parseInt(pTokens.style.left, 10);
  assert.ok(expandedLeft <= compactLeft); // 宽度增加时向左下方展开，left 变小

  // 点击收起
  toggleBtn.click();
  assert.equal(detailsPane.style.display, 'none');
  assert.equal(toggleBtn.textContent, '展开详情 ▼');
  const collapsedLeft = parseInt(pTokens.style.left, 10);
  assert.equal(collapsedLeft, compactLeft); // 收拢时向右上方收回相同锚点

  // 5. 切换回 Token 统计视图，热力图与统计卡片恢复
  h.elements.get('tok-view-tokens').click();
  assert.equal(tokensMain.style.display, 'block');

  h.sandbox.__AGContextMeter.dispose();
});

test('instant region switch to Australia & Korea, price badge dynamic animation structure, and zero-latency state persistence', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const api = h.sandbox.__AGContextMeter;

  // 1. 初始化 payload：韩国 (KRW)
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'user@example.com',
      region: '韩国 (KRW)',
      currency: 'KRW',
      currencySymbol: '₩',
      actualPricePaid: 29000,
      actualPricePaidCNY: 147.9,
      cnyFormatted: '折合 ≈ ¥147.9 CNY',
      priceSource: 'preset_region',
      billingCycle: '月付'
    }
  });

  const priceVal = h.elements.get('plan-summary-price-val');
  const priceCny = h.elements.get('plan-summary-price-cny');
  const detPrice = h.elements.get('p-det-price');
  const detPriceTag = h.elements.get('p-det-price-tag');
  const directLabel = h.elements.get('direct-region-label');

  // 验证初始状态：韩元 29000（整数不带 .00）
  assert.match(priceVal.textContent, /₩29000/);
  assert.match(priceVal.textContent, /月/);
  assert.equal(priceCny.textContent, '· ≈ ¥147.9 CNY');
  assert.match(detPrice.textContent, /₩29000 · 月付/);
  assert.equal(detPriceTag.textContent, '官方定价');

  // 2. 模拟切换为澳大利亚 (AU$) 32.99
  const auPreset = h.sandbox.__AGContextMeterCore.SUBSCRIPTION_REGIONS_PRESET.find(p => p.id === 'AU');
  assert.ok(auPreset, 'Australia preset exists');

  // 通过菜单点击切换
  const directWrap = h.elements.get('direct-region-wrap');
  const directTrigger = h.elements.get('direct-region-trigger');
  directTrigger.click();

  const directMenu = h.elements.get('direct-region-menu');
  const items = directMenu.children.find(c => c.className === 'ag-dropdown-list-container')?.children || [];
  const auItem = items.find(it => (it.textContent && (it.textContent.includes('澳大利亚') || it.textContent.includes('AU'))) || it.children?.some?.(c => c.textContent && (c.textContent.includes('澳大利亚') || c.textContent.includes('AU'))));
  assert.ok(auItem, 'Australia item rendered in direct dropdown menu');

  // 点击澳大利亚
  auItem.click();

  // 3. 验证立即更新（0延迟保存与上面立即更改）
  assert.match(priceVal.textContent, /AU\$32\.99/);
  assert.match(priceVal.textContent, /月/);
  assert.equal(priceCny.textContent, '· ≈ ¥146.8 CNY');
  assert.match(detPrice.textContent, /AU\$32\.99 · 月付/);
  assert.equal(detPriceTag.textContent, '官方定价');
  assert.match(directLabel.textContent, /澳大利亚.*AU\$32\.99/);

  api.dispose();
});

test('tray/root startup visibility, settings save/restore (country, subscriptionRegion, currency), detail collapse lifecycle, and CLI launch', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1. 验证从托盘或后台恢复到根路径 / (无活跃会话) 时，顶栏插件始终可见且 ensureAlive 幂等可用
  h.sandbox.location.pathname = '/';
  h.tick();
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.getAttribute('data-has-session'), 'false');
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(api.ensureAlive(), true);
  assert.equal(h.host.hidden, false);

  // 2. 验证三项设置（国家、订阅地区、币种）独立持久化与失败反馈
  const savedPayloads = [];
  let shouldFailSave = false;
  h.sandbox.window.contextMeterAPI.saveSettings = async (payload) => {
    savedPayloads.push(payload);
    if (shouldFailSave) return { ok: false, error: '模拟磁盘只读无法写入' };
    return { ok: true, customPlan: payload.customPlan };
  };

  // 先设置订阅地区为韩国 (KR)
  const krPreset = h.sandbox.__AGContextMeterCore.SUBSCRIPTION_REGIONS_PRESET.find(p => p.id === 'KR');
  const directTrigger = h.elements.get('direct-region-trigger');
  directTrigger.click();
  const directMenu = h.elements.get('direct-region-menu');
  const items = directMenu.children.find(c => c.className === 'ag-dropdown-list-container')?.children || [];
  const krItem = items.find(it => it.children?.some?.(c => c.textContent && c.textContent.includes('韩国')));
  assert.ok(krItem, 'Korea item exists');
  krItem.click();
  await h.flush();

  // 再单独修改「国家」为 美国 (US)，验证订阅地区仍为韩国、币种仍为 KRW
  api.setCountry('美国 (US)');
  await h.flush();
  let snapSettings = api.getPlanSettings();
  assert.equal(snapSettings.country, '美国 (US)');
  assert.match(snapSettings.subscriptionRegion, /韩国/);
  assert.equal(snapSettings.currency, 'KRW');

  // 再单独修改「币种」为 AUD，验证国家仍为美国、订阅地区仍为韩国、币种更新为 AUD
  api.setCurrency('AUD');
  await h.flush();
  snapSettings = api.getPlanSettings();
  assert.equal(snapSettings.country, '美国 (US)');
  assert.match(snapSettings.subscriptionRegion, /韩国/);
  assert.equal(snapSettings.currency, 'AUD');
  assert.equal(snapSettings.lastSaveResult.ok, true);
  assert.ok(savedPayloads.length >= 3);

  // 模拟保存失败时的真实错误反馈
  shouldFailSave = true;
  api.setCurrency('JPY');
  await h.flush();
  assert.equal(api.getPlanSettings().lastSaveResult.ok, false);
  assert.match(h.elements.get('plan-save-feedback').textContent, /保存失败.*模拟磁盘只读/);
  shouldFailSave = false;

  // 3. 验证 AI Pro 详情单入口展开/收起、切换预估费用自动关闭详情及异步返回防重开
  h.elements.get('badge-tokens').click();
  const detailCard = h.elements.get('plan-detail-card');
  const toggleBtn = h.elements.get('btn-plan-detail-toggle');
  const collapseBottomBtn = h.elements.get('btn-plan-detail-collapse');
  const customForm = h.elements.get('plan-custom-form');

  // 初始为收起
  assert.equal(detailCard.style.display, 'none');
  // 点击展开详情并打开自定义表单
  toggleBtn.click();
  assert.equal(detailCard.style.display, 'block');
  assert.equal(api.getPlanDetailExpanded(), true);
  h.elements.get('btn-edit-plan-custom').click();
  assert.equal(customForm.style.display, 'block');

  // 再次点击单一展开/收起按钮手动关闭
  toggleBtn.click();
  assert.equal(detailCard.style.display, 'none');
  assert.equal(customForm.style.display, 'none');
  assert.equal(api.getPlanDetailExpanded(), false);
  assert.equal(toggleBtn.textContent, '详情 ▼');

  // 再次展开详情，然后切换到“API 参考金额（预估费用）”界面 -> 必须主动关闭详情，无任何残留
  toggleBtn.click();
  assert.equal(detailCard.style.display, 'block');
  h.elements.get('tok-view-cost').click();
  assert.equal(detailCard.style.display, 'none');
  assert.equal(customForm.style.display, 'none');
  assert.equal(api.getPlanDetailExpanded(), false);

  // 在预估费用界面期间，模拟后台旧请求完成返回 planStatus -> 绝不能重新撑开已关闭的详情面板
  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 50000, todayTokens: 5000 },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'user@example.com',
      country: '美国 (US)',
      region: '韩国 (KRW)',
      currency: 'KRW',
      actualPricePaid: 29000
    }
  });
  assert.equal(detailCard.style.display, 'none');

  // 切回 Token 统计视图 -> 保持干净的收起状态；再点展开并用底部“详情收回 ▲”按钮关闭
  h.elements.get('tok-view-tokens').click();
  assert.equal(detailCard.style.display, 'none');
  toggleBtn.click();
  assert.equal(detailCard.style.display, 'block');
  collapseBottomBtn.click();
  assert.equal(detailCard.style.display, 'none');

  // 4. 验证一键启动 CLI 按钮成功与失败反馈
  let cliMockResult = { ok: true, cwd: 'C:\\Projects\\测试 空格 目录', cliPath: 'C:\\Tools\\agy\\agy.exe' };
  h.sandbox.window.contextMeterAPI.launchCli = async (opts) => ({ ...cliMockResult, receivedOpts: opts });
  h.elements.get('badge-cli').click();
  await h.flush();
  assert.equal(api.getLastCliLaunchResult().ok, true);
  assert.match(h.elements.get('cli-launch-toast').textContent, /已启动 Antigravity CLI/);

  cliMockResult = { ok: false, error: '未找到 agy.exe' };
  h.elements.get('badge-cli').click();
  await h.flush();
  assert.equal(api.getLastCliLaunchResult().ok, false);
  assert.match(h.elements.get('cli-launch-toast').textContent, /启动 CLI 失败.*未找到 agy\.exe/);

  api.dispose();
});

// ============================================================================
// 下拉组件 UI 一致性与错误状态展示行为测试
// ============================================================================
test('custom dropdowns for country, region, and currency support code/symbol search, keyboard navigation, and inline alignment', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1. 打开 Token 详情卡片
  h.elements.get('badge-tokens').click();
  h.elements.get('btn-plan-detail-toggle').click();

  // 2. 验证「国家」统一定制下拉：展开、搜索代码 TW 过滤出台湾、键盘 Enter 确认选择
  const countryTrigger = h.elements.get('direct-country-trigger');
  const countryWrap = h.elements.get('direct-country-wrap');
  const countryMenu = h.elements.get('direct-country-menu');
  assert.ok(countryTrigger, 'Country trigger exists');
  assert.ok(countryWrap, 'Country wrap exists');

  // 点击展开
  countryTrigger.click();
  assert.ok(countryWrap.className.includes('is-open'));

  // 搜索 "TW" 过滤
  const countrySearch = countryMenu.children.find(c => c.className === 'ag-dropdown-search-wrap')?.children?.[0];
  assert.ok(countrySearch, 'Country search input exists');
  countrySearch.value = 'TW';
  countrySearch.trigger('input', { target: { value: 'TW' } });

  const countryItems = countryMenu.children.find(c => c.className === 'ag-dropdown-list-container')?.children || [];
  const twItem = countryItems.find(it => it.children?.some?.(c => c.textContent && c.textContent.includes('中国台湾')));
  assert.ok(twItem, 'Taiwan item filtered by code TW');
  assert.ok(!countryItems.some(it => it.children?.some?.(c => c.textContent && c.textContent.includes('美国'))), 'US filtered out');

  // 点击选中台湾
  twItem.click();
  await h.flush();
  assert.equal(api.getPlanSettings().country, 'TW 中国台湾');
  assert.equal(h.elements.get('direct-country-label').textContent, '🇹🇼 TW 中国台湾');

  // 3. 验证「币种」统一定制下拉：展开、搜索符号 "AU$" 过滤出澳元、选择后保存
  const curTrigger = h.elements.get('direct-currency-trigger');
  const curWrap = h.elements.get('direct-currency-wrap');
  const curMenu = h.elements.get('direct-currency-menu');
  assert.ok(curTrigger, 'Currency trigger exists');

  curTrigger.click();
  assert.ok(curWrap.className.includes('is-open'));
  assert.ok(!countryWrap.className.includes('is-open'), 'Previous country dropdown auto closed');

  const curSearch = curMenu.children.find(c => c.className === 'ag-dropdown-search-wrap')?.children?.[0];
  assert.ok(curSearch, 'Currency search input exists');
  curSearch.value = 'AU$';
  curSearch.trigger('input', { target: { value: 'AU$' } });

  const curItems = curMenu.children.find(c => c.className === 'ag-dropdown-list-container')?.children || [];
  const audItem = curItems.find(it => it.children?.some?.(c => c.textContent && c.textContent.includes('AUD')));
  assert.ok(audItem, 'AUD filtered by symbol AU$');
  audItem.click();
  await h.flush();
  assert.equal(api.getPlanSettings().currency, 'AUD');
  assert.equal(h.elements.get('direct-currency-label').textContent, 'AUD · AU$ 澳元');

  // 4. 验证 Esc 关闭
  curTrigger.click();
  assert.ok(curWrap.className.includes('is-open'));
  curTrigger.trigger('keydown', { key: 'Escape' });
  assert.ok(!curWrap.className.includes('is-open'), 'Closed via Escape');

  api.dispose();
});

test('network errors are consistently displayed across badge, tooltip, and key summary without clearing context metrics', async () => {
  const h = harness();
  h.finishScan();

  // 发生网络故障 (idle timeout + context deadline exceeded)
  h.pending[0].resolve(response({
    modelDisplayName: 'Gemini 4 Argon (High)',
    usage: { inputTokens: 538645, outputTokens: 268 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 983040, estimatedTokensUsed: 538913 } },
    retryInfos: [{ error: 'request failed: stream idle timeout (5m0s): context deadline exceeded', usage: { model: 'gemini' } }]
  }));
  await h.flush();

  // 验证三处对齐：
  // 1. 顶部徽章
  assert.equal(h.elements.get('badge-pct-val').textContent, '网络');
  assert.equal(h.elements.get('amount').textContent, '网络故障');

  // 2. 悬停提示气泡
  h.elements.get('badge').trigger('mouseenter');
  assert.equal(h.elements.get('ctx-tip-title').textContent, '网络连接（连接故障）：');
  assert.equal(h.elements.get('ctx-tip-pct').textContent, '网络连接失败或超时');
  assert.match(h.elements.get('ctx-tip-detail').textContent, /超时|网络/);
  assert.doesNotMatch(h.elements.get('ctx-tip-detail').textContent, /未送达服务端/);

  // 3. 核心用量速览卡片
  assert.equal(h.elements.get('key-badge').textContent, '网络故障');
  assert.match(h.elements.get('key-takeaway').textContent, /网络连接出现异常/);
  // 解耦验证：非超限错误保留预算与已有上下文，绝不归零
  assert.equal(h.elements.get('key-limit').textContent, '983K');
  assert.notEqual(h.elements.get('key-used').textContent, '—');
  assert.notEqual(h.elements.get('key-remaining').textContent, '0 (已溢出)');

  h.sandbox.__AGContextMeter.dispose();
});

test('cancellation status is muted, describes the recorded request, and clears after success', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 12000, outputTokens: 200 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
  }));
  await h.flush();
  try {
    const previous = api.snapshot().latest;
    const canceled = core.summarize({
      chatModel: {
        retryInfos: [{ error: 'request failed: Post "https://example.invalid/api": context canceled' }],
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    }, { previousValidContext: previous });
    api.setContextLatestForTest(canceled);
    h.elements.get('badge').trigger('mouseenter');
    assert.equal(h.elements.get('badge-pct-val').textContent, '已中断');
    assert.equal(h.elements.get('amount').textContent, '上次中断');
    assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
    assert.equal(h.elements.get('key-badge').className, 'key-pill pill-muted');
    assert.match(h.elements.get('ctx-tip-title').textContent, /最近一次/);
    assert.match(h.elements.get('ctx-tip-detail').textContent, /无法确定/);
    assert.doesNotMatch(h.elements.get('ctx-tip-detail').textContent, /用户取消|重新发送/);
    assert.match(h.elements.get('status').textContent, /最近一次.*中断/);
    assert.notEqual(h.elements.get('key-used').textContent, '—');
    assert.equal(h.elements.get('key-limit').textContent, '512K');
    assert.equal(api.snapshot().latest.actual, previous.actual);
    for (const [language, title] of [['en', /Last recorded request/], ['zh-TW', /最近一次/]]) {
      api.setPanelLanguage(language, { persist: false });
      h.elements.get('badge').trigger('mouseenter');
      assert.match(h.elements.get('ctx-tip-title').textContent, title);
      assert.equal(h.elements.get('key-badge').className, 'key-pill pill-muted');
    }
    api.setPanelLanguage('zh-CN', { persist: false });
    api.setContextLatestForTest(previous);
    assert.doesNotMatch(h.elements.get('badge-pct-val').textContent, /中断|待确认/);
    assert.doesNotMatch(h.elements.get('key-takeaway').textContent, /中断|原因未知/);
  } finally {
    api.dispose();
  }
});

test('quota exhaustion status across badge, tooltip, and summary displays affected pool and reset time', async () => {
  const h = harness();
  h.finishScan();

  // 明确模型额度耗尽 (周限额耗尽)
  h.pending[0].resolve(response({
    modelDisplayName: 'Gemini 4 Argon (High)',
    usage: { inputTokens: 538645, outputTokens: 268 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 983040, estimatedTokensUsed: 538913 } },
    retryInfos: [{ error: 'rpc error: code = ResourceExhausted desc = Quota exceeded for weekly pool', usage: { model: 'gemini' } }]
  }));
  await h.flush();

  // 验证三处对齐为额度耗尽：
  assert.equal(h.elements.get('badge-pct-val').textContent, '额度耗尽');
  assert.equal(h.elements.get('amount').textContent, '额度耗尽');
  assert.equal(h.elements.get('key-badge').textContent, '额度耗尽');
  assert.match(h.elements.get('key-takeaway').textContent, /额度已耗尽.*可手动切换/);

  h.sandbox.__AGContextMeter.dispose();
});

test('model and conversation switching isolates previous error state and recovers on successful response', async () => {
  const h = harness();

  // 1. 发起成功请求 -> 状态恢复为正常百分比
  h.tick();
  await h.flush();
  const req = h.pending.shift();
  assert.ok(req);
  req.resolve({
    ok: true,
    json: async () => ({
      generatorMetadata: [
        {
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 40000, outputTokens: 200 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
          }
        }
      ]
    })
  });
  await h.flush();

  // 验证正常状态
  assert.equal(h.elements.get('badge-pct-val').textContent, '16%');
  assert.match(h.elements.get('amount').textContent, /40\.2K/);
  assert.equal(h.elements.get('key-badge').textContent, '正常');

  // 2. 切换会话后清空旧状态
  h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
  h.tick();
  await h.flush();
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(h.elements.get('amount').textContent, '真实量未知');

  h.sandbox.__AGContextMeter.dispose();
});

test('5 heatmap views switching, segmented pill slider active state, and settings persistence', async () => {
  let savedSettings = null;
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    saveSettings: payload => { savedSettings = payload; return { ok: true }; }
  };
  const api = h.sandbox.__AGContextMeter;

  // 默认是 daily 视图
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-daily-box').style.display, 'block');

  // 1. 切换至 weekly 视图
  api.switchHeatView('weekly');
  assert.equal(api.getActiveHeatView(), 'weekly');
  assert.equal(h.elements.get('h-tab-weekly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'false');
  assert.equal(h.elements.get('h-weekly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-daily-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'weekly');

  // 2. 切换至 monthly 视图
  api.switchHeatView('monthly');
  assert.equal(api.getActiveHeatView(), 'monthly');
  assert.equal(h.elements.get('h-tab-monthly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-monthly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-weekly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'monthly');

  // 3. 切换至 yearly 视图
  api.switchHeatView('yearly');
  assert.equal(api.getActiveHeatView(), 'yearly');
  assert.equal(h.elements.get('h-tab-yearly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-yearly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-monthly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'yearly');

  // 4. 切换至 cum 视图
  api.switchHeatView('cum');
  assert.equal(api.getActiveHeatView(), 'cum');
  assert.equal(h.elements.get('h-tab-cum').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-cum-box').style.display, 'block');
  assert.equal(h.elements.get('h-yearly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'cum');

  // 5. 切换回 daily
  api.switchHeatView('daily');
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-daily-box').style.display, 'block');
  assert.equal(savedSettings?.savedHeatView, 'daily');

  api.dispose();
});

test('monthly view layout algorithm: 28/29/30/31 days across multiple viewport WxH, square cells and no overflow', () => {
  function calculateBestGrid(days, W, H, gap = 5) {
    let bestR = 1, bestC = days, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(days / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    const s = Math.floor(bestS);
    const totalW = bestC * s + (bestC - 1) * gap;
    const totalH = bestR * s + (bestR - 1) * gap;
    return { r: bestR, c: bestC, s, totalW, totalH, days };
  }

  const testDimensions = [
    { W: 670, H: 95 },
    { W: 500, H: 90 },
    { W: 800, H: 110 },
    { W: 400, H: 80 }
  ];
  const testMonthDays = [28, 29, 30, 31];

  for (const { W, H } of testDimensions) {
    for (const days of testMonthDays) {
      const res = calculateBestGrid(days, W, H);
      assert.ok(res.s > 0, `Cell size should be positive for days=${days}, W=${W}, H=${H}`);
      assert.ok(res.c * res.r >= days, `Grid capacity (${res.c}x${res.r}) must fit ${days} days`);
      assert.ok(res.totalW <= W, `Grid total width (${res.totalW}) exceeded container width (${W})`);
      assert.ok(res.totalH <= H, `Grid total height (${res.totalH}) exceeded container height (${H})`);
      if (W === 670 && H === 95) {
        assert.ok(res.s >= 18, `For 670x95, cell size ${res.s} should be >= 18px`);
      }
    }
  }
});

test('yearly view bubble chart: area proportional to tokens (sqrt mapping), future exclusion, and peak badge', () => {
  const Rmin = 6;
  const Rmax = 24;
  const maxTokens = 1000000;

  function computeRadius(tokens, isFuture) {
    if (isFuture || tokens <= 0) return Rmin;
    const ratio = Math.sqrt(tokens / maxTokens);
    return Rmin + ratio * (Rmax - Rmin);
  }

  assert.equal(computeRadius(0, false), Rmin);
  assert.equal(computeRadius(maxTokens, false), Rmax);
  const r25 = computeRadius(250000, false);
  assert.equal(r25, Rmin + 0.5 * (Rmax - Rmin));
  const rRatio = (computeRadius(40000, false) - Rmin) / (computeRadius(10000, false) - Rmin);
  assert.ok(Math.abs(rRatio - 2) < 1e-9, 'Radius expansion should be square-root mapped');
  assert.equal(computeRadius(500000, true), Rmin);
});

test('all-period reference cost and source switching reactivity on cards & popovers', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  const payload = {
    schemaVersion: '0.8.0',
    version: '0.8.0',
    summary: { grandTotalTokens: 500000, todayTokens: 100000, monthTokens: 300000, yearTokens: 500000, totalConversations: 5 },
    dailyMap: {
      '2026-11-09': { input: 80000, cache: 10000, output: 10000, total: 100000 },
      '2026-11-10': { input: 80000, cache: 10000, output: 10000, total: 100000 }
    },
    dailyMapBySource: {
      all: {
        '2026-11-09': { input: 80000, cache: 10000, output: 10000, total: 100000 },
        '2026-11-10': { input: 80000, cache: 10000, output: 10000, total: 100000 }
      },
      desktop: {
        '2026-11-09': { input: 40000, cache: 5000, output: 5000, total: 50000 },
        '2026-11-10': { input: 40000, cache: 5000, output: 5000, total: 50000 }
      },
      cli: {
        '2026-11-09': { input: 40000, cache: 5000, output: 5000, total: 50000 },
        '2026-11-10': { input: 40000, cache: 5000, output: 5000, total: 50000 }
      }
    }
  };

  api.applyTokenHistoryPayload(payload);

  const tTotalCost = h.elements.get('t-total-cost');
  assert.ok(tTotalCost, 'Total cost element exists');
  assert.match(tTotalCost.textContent, /≈ \$/);
  assert.match(tTotalCost.textContent, /日均/);

  h.elements.get('src-tab-desktop').click();
  assert.match(tTotalCost.textContent, /≈ \$/);

  api.dispose();
});

test('online update and GitHub entry points: openExternal whitelist enforcement and update popover', async () => {
  let openedUrl = null;
  let checkedUpdateOpts = null;
  let appliedUpdateOpts = null;

  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    openExternal: url => { openedUrl = url; return { ok: true }; },
    checkUpdate: opts => {
      checkedUpdateOpts = opts;
      return {
        ok: true,
        hasUpdate: true,
        currentVersion: '0.8.0',
        latestVersion: '0.8.1',
        tagName: 'v0.8.1',
        releaseNotes: '新特性说明',
        htmlUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.1'
      };
    },
    applyUpdate: opts => { appliedUpdateOpts = opts; return { ok: true, version: '0.8.1' }; }
  };
  const api = h.sandbox.__AGContextMeter;

  h.elements.get('btn-github-repo').click();
  assert.equal(openedUrl, 'https://github.com/elviscjn-cjn/antigravity-context-viewer');

  h.elements.get('btn-check-update').click();
  await h.flush();
  assert.ok(checkedUpdateOpts);
  assert.equal(checkedUpdateOpts.force, true);
  const updatePop = h.elements.get('update-popover');
  assert.equal(updatePop.style.display, 'block');
  assert.match(h.elements.get('up-pop-ver').textContent, /v0\.8\.1/);

  h.elements.get('btn-view-release-page').click();
  assert.equal(openedUrl, 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.1');

  h.elements.get('btn-apply-update').click();
  await h.flush();
  assert.ok(appliedUpdateOpts);

  api.dispose();
});

test('按稳定模型 ID 持久化上下文偏好、损坏隔离与模型切换独立加载', () => {
  const tmpDir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ctx-pref-test-'));
  try {
    const collector = require('./meter-collector');
    const stableA = core.resolveStableModelId({ model: 'MODEL_PLACEHOLDER_M37', modelDisplayName: 'Gemini 3.8 Flash' });
    const stableB = core.resolveStableModelId({ model: 'claude-opus-5-5-thinking', modelDisplayName: 'Claude Opus 5.5' });
    assert.equal(stableA, 'model_placeholder_m37');
    assert.equal(stableB, 'claude-opus-5-5-thinking');

    // 无效参数必须直接拦截拒写
    const badFixed = collector.savePluginSettings({
      contextPreference: { modelId: stableA, mode: 'fixed', limitTokens: 5000 }
    }, { agDir: tmpDir });
    assert.equal(badFixed.ok, false);

    // 分别保存模型 A (512,000) 与 模型 B (动态透传)
    const saveA = collector.savePluginSettings({
      contextPreference: { modelId: stableA, label: 'Gemini 3.8 Flash', mode: 'fixed', limitTokens: 512000 }
    }, { agDir: tmpDir });
    assert.equal(saveA.ok, true);

    const saveB = collector.savePluginSettings({
      contextPreference: { modelId: stableB, label: 'Claude Opus 5.5', mode: 'dynamic' }
    }, { agDir: tmpDir });
    assert.equal(saveB.ok, true);

    // 重新读取验证双方互相独立不覆盖
    const loaded1 = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(loaded1.contextPreferences[stableA].limitTokens, 512000);
    assert.equal(loaded1.contextPreferences[stableB].mode, 'dynamic');

    // 单模型恢复默认只移除 A，保留 B
    const resetA = collector.savePluginSettings({
      clearContextPreference: true,
      modelId: stableA
    }, { agDir: tmpDir });
    assert.equal(resetA.ok, true);
    const loaded2 = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(loaded2.contextPreferences[stableA], undefined);
    assert.equal(loaded2.contextPreferences[stableB].mode, 'dynamic');

    // 配置文件损坏保护：破坏文件后触发备份隔离不崩溃
    const cfgPath = collector.getCustomPlanPath(tmpDir);
    fs.writeFileSync(cfgPath, '{ BROKEN_JSON !!!', 'utf8');
    const recovered = collector.getPluginSettings({ agDir: tmpDir });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recoveredFromCorruption, true);
    assert.ok(fs.existsSync(cfgPath.replace(/\.json$/i, '.corrupt.bak.json')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3 分页布局、设置视图迁移、7.1 禁用词与查看模型选择器契约', async () => {
  const savedPayloads = [];
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, contextPreferences: {} }),
    saveSettings: async (payload) => {
      savedPayloads.push(payload);
      return { ok: true, contextPreferences: {} };
    },
    getContextUnlockStatus: async () => ({
      ok: true,
      data: { status: 'not_patched', arch: 'x86-64', configuredMode: 'default', configuredLimitTokens: 256000 }
    }),
    getModulesStatus: async () => ({
      ok: true,
      data: { modules: { chinese: { enabled: true }, proxy: { enabled: false, proxyUrl: 'http://127.0.0.1:7890' } } },
      disk: { chineseReady: true, proxyReady: true }
    }),
    toggleModule: async () => ({ ok: true })
  };

  // 打开面板，验证 3 分页与当前会话核心字段保留
  h.elements.get('badge').click();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest({
    model: 'Gemini 4 Argon (Low)',
    modelId: 'gemini-4-argon-low',
    status: 'reported',
    used: 42000,
    budget: 256000,
    remaining: 214000,
    speed: { tps: 88.5, durationSec: 2.0, ttftSec: 0.4, outputTokens: 177 }
  }, [
    { modelId: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
  ]);
  await h.flush();

  assert.equal(h.elements.get('ctx-model-selector-role').textContent, '查看模型');
  assert.equal(h.elements.get('pane-ctx-session').hidden, false);
  assert.equal(h.elements.get('pane-ctx-models').hidden, true);
  assert.equal(h.elements.get('pane-ctx-speed').hidden, true);
  assert.equal(h.elements.get('speed-val').textContent, '88.5 tok/s');

  // 切换到“模型设置”分页并验证选择器切换不写配置、且出现“回到当前模型”
  h.elements.get('tab-ctx-models').click();
  await h.flush();
  assert.equal(h.elements.get('pane-ctx-models').hidden, false);
  assert.equal(h.elements.get('pane-ctx-session').hidden, true);
  const saveCountBeforeSwitch = savedPayloads.length;
  const selectEl = h.elements.get('ctx-model-select');
  selectEl.value = 'product:anthropic:claude-sonnet-4.6';
  selectEl.trigger('change', { target: { value: 'product:anthropic:claude-sonnet-4.6' } });
  await h.flush();
  assert.equal(h.elements.get('btn-ctx-back-current').hidden, false);
  assert.equal(savedPayloads.length, saveCountBeforeSwitch, '查看其他模型不得自动改写配置');
  h.elements.get('btn-ctx-back-current').click();
  assert.equal(api.getContextPreferencesState().selectedProductKey, 'product:google:gemini-4-argon');
  assert.equal(h.elements.get('btn-ctx-back-current').hidden, true);

  // 打开 ⚙ 设置视图，验证汉化、代理、外观 DOM ID 与事件仍在且 ‹ 返回有效
  h.elements.get('btn-ctx-settings').click();
  await h.flush();
  assert.equal(h.elements.get('pane-ctx-settings').hidden, false);
  assert.equal(h.elements.get('ctx-tabs-bar').hidden, false);
  assert.ok(h.elements.get('btn-toggle-chinese'));
  assert.ok(h.elements.get('btn-toggle-chinese-module'));
  assert.ok(h.elements.get('btn-toggle-proxy'));
  assert.ok(h.elements.get('input-proxy-url'));
  assert.ok(h.elements.get('input-proxy-bypass'));
  assert.ok(h.elements.get('btn-toggle-proxy-module'));
  assert.ok(h.elements.get('btn-toggle-colors'));
  assert.ok(h.elements.get('color-panelBg'));
  assert.ok(h.elements.get('btn-panel-palette'));

  // 验证汉化切换按钮事件仍然有效
  let toggleCalled = false;
  h.sandbox.window.contextMeterAPI.toggleModule = async (mod) => {
    if (mod === 'chinese') toggleCalled = true;
    return { ok: true, data: { modules: { chinese: { enabled: false }, proxy: { enabled: false } } } };
  };
  h.elements.get('btn-toggle-chinese-module').click();
  await h.flush();
  assert.equal(toggleCalled, true);

  h.elements.get('btn-ctx-settings-back').click();
  assert.equal(h.elements.get('pane-ctx-settings').hidden, true);
  assert.equal(h.elements.get('pane-ctx-models').hidden, false);

  // 7.1 禁用词检查：模板中 #panel 区域及普通视图动态 DOM 文本均不可出现技术黑话
  const tplHtml = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const panelSection = tplHtml.slice(tplHtml.indexOf('id="panel"'), tplHtml.indexOf('id="token-panel"'));
  const forbiddenTerms = ['共享后端', '动态透传', 'Gate', 'sidecar', 'PE 指纹', '补丁', '二进制', 'language_server', 'manifest'];
  const collectedRuntimeText = [
    h.elements.get('ctx-compact-saved')?.textContent || '',
    h.elements.get('ctx-compact-client')?.textContent || '',
    h.elements.get('ctx-client-status-text')?.textContent || '',
    h.elements.get('unlock-badge')?.textContent || '',
    h.elements.get('ctx-card-saved')?.textContent || '',
    h.elements.get('ctx-card-client')?.textContent || '',
    h.elements.get('ctx-card-client-tag')?.textContent || '',
    h.elements.get('ctx-card-observed-budget')?.textContent || '',
    h.elements.get('ctx-card-observed-speed')?.textContent || '',
    h.elements.get('unlock-status-desc')?.textContent || ''
  ].join('\n');
  for (const term of forbiddenTerms) {
    assert.equal(panelSection.includes(term), false, `template.html 面板区不可包含禁用词: ${term}`);
    assert.equal(collectedRuntimeText.includes(term), false, `运行时普通视图不可包含禁用词: ${term}`);
  }
  api.dispose();
});

test('产品级偏好、旧档位同值直显与异值冲突迁移、预设 512K/524288/983040 边界与 K 统一', async () => {
  const savedStore = {
    // 1. Hydrogen 同值旧键 -> 应直接合并显示 512K，且用户点击保存后清旧键写产品键
    'gemini-4-hydrogen-low': { modelId: 'gemini-4-hydrogen-low', mode: 'fixed', limitTokens: 512000 },
    'gemini-4-hydrogen-high': { modelId: 'gemini-4-hydrogen-high', mode: 'fixed', limitTokens: 512000 },
    // 2. Argon 异值旧键 -> 应显示冲突横幅，用户未确认前绝不写回
    'gemini-4-argon-low': { modelId: 'gemini-4-argon-low', mode: 'fixed', limitTokens: 524288 },
    'gemini-4-argon-high': { modelId: 'gemini-4-argon-high', mode: 'fixed', limitTokens: 983040 }
  };
  let saveCalls = 0;
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, contextPreferences: { ...savedStore } }),
    saveSettings: async (payload) => {
      saveCalls++;
      if (payload?.contextPreference) {
        if (Array.isArray(payload.contextPreference.clearLegacyKeys)) {
          for (const k of payload.contextPreference.clearLegacyKeys) delete savedStore[k];
        }
        const k = payload.contextPreference.productKey || payload.contextPreference.modelId;
        savedStore[k] = { ...payload.contextPreference };
      }
      return { ok: true, contextPreferences: { ...savedStore } };
    },
    getContextUnlockStatus: async () => ({
      ok: true,
      data: { status: 'not_patched', arch: 'x86-64', configuredMode: 'default', configuredLimitTokens: 256000 }
    })
  };
  const api = h.sandbox.__AGContextMeter;
  h.elements.get('ctx-conflict-rows').replaceChildren = function (...nodes) { this.children = nodes; };
  h.elements.get('ctx-card-observed-speed').replaceChildren = function (...nodes) { this.children = nodes; };
  const cascadeConfigs = [
    { modelId: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
    { modelId: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
    { modelId: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { modelId: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { modelId: 'orchestrator-carbon', label: 'Orchestrator (Carbon)' },
    { modelId: 'orchestrator-argon', label: 'Orchestrator (Argon)' }
  ];

  // 先从宿主 mock 恢复测试配置，再切换至 Argon (触发异值冲突) -> 确认未写入、冲突横幅可见
  await api.restoreSettingsFromHost();
  api.setContextLatestForTest({
    model: 'Gemini 4 Argon (Low)',
    modelId: 'gemini-4-argon-low',
    status: 'reported',
    used: 12000,
    budget: 256000,
    serviceLimit: 1000000
  }, cascadeConfigs);
  api.switchContextTabForTest('models');
  await h.flush();
  assert.equal(h.elements.get('ctx-conflict-banner').hidden, false);
  assert.equal(saveCalls, 0, '展示冲突时绝不能自动写入');
  // 验证 budget 与 serviceLimit 分开显示（默认短 K 格式 + 悬浮完整数字）
  assert.match(h.elements.get('ctx-card-observed-budget').textContent, /256K/);
  assert.match(h.elements.get('ctx-card-observed-budget').title || '', /256,000/);
  assert.match(h.elements.get('ctx-card-service-limit').textContent, /服务端报错上限：1M/);
  assert.match(h.elements.get('ctx-card-service-limit').title || '', /1,000,000/);
  assert.equal(h.elements.get('ctx-card-service-limit').hidden, false);

  // 点击第一个冲突行的“用这个”(524288) -> 验证清掉旧档位键，写入产品键，并显示“自定义 524.3K（524,288）”
  const conflictRows = h.elements.get('ctx-conflict-rows').children;
  assert.ok(conflictRows.length >= 2);
  const useBtn = conflictRows[0].children.find(c => c.textContent === '用这个');
  useBtn.click();
  await h.flush();
  assert.equal(h.elements.get('ctx-conflict-banner').hidden, true);
  assert.equal(savedStore['gemini-4-argon-low'], undefined);
  assert.equal(savedStore['gemini-4-argon-high'], undefined);
  assert.equal(savedStore['product:google:gemini-4-argon'].limitTokens, 524288);
  assert.match(h.elements.get('ctx-card-saved').textContent, /自定义 524\.3K（524,288）/);

  // B. 校验固定 983040 与动态跟随 (mode: 'dynamic') 是不同的存储结构
  const customInput = h.elements.get('ctx-custom-limit-input');
  customInput.value = '983040';
  customInput.trigger('input');
  h.elements.get('btn-save-model-ctx').click();
  await h.flush();
  assert.equal(savedStore['product:google:gemini-4-argon'].mode, 'fixed');
  assert.equal(savedStore['product:google:gemini-4-argon'].limitTokens, 983040);
  assert.match(h.elements.get('ctx-card-saved').textContent, /自定义 983K（983,040）/);

  const dynBtn = { getAttribute: (k) => (k === 'data-ctx-mode' ? 'dynamic' : ''), dataset: { ctxMode: 'dynamic', ctxLimit: '' } };
  h.elements.get('ctx-preset-grid').trigger('click', { target: { closest: () => dynBtn } });
  h.elements.get('btn-save-model-ctx').click();
  await h.flush();
  assert.equal(savedStore['product:google:gemini-4-argon'].mode, 'dynamic');
  assert.equal(savedStore['product:google:gemini-4-argon'].limitTokens, null);

  // C. 切换 Hydrogen (同值 512,000 旧档位自动直显，不报冲突)，切换其 High 档位也共享同产品偏好，且预算/速度不跨档位借用
  api.setContextLatestForTest({
    model: 'Gemini 4 Hydrogen (Low)',
    modelId: 'gemini-4-hydrogen-low',
    status: 'reported',
    used: 5000,
    budget: 512000
  }, cascadeConfigs);
  await h.flush();
  assert.equal(h.elements.get('ctx-conflict-banner').hidden, true);
  assert.match(h.elements.get('ctx-card-saved').textContent, /^512K$/);
  assert.match(h.elements.get('ctx-card-saved').title || '', /512,000/);

  // 点击 512K 预设确认写入值是 512000 而非 524288
  const p512Btn = { getAttribute: (k) => (k === 'data-ctx-mode' ? 'fixed' : (k === 'data-ctx-limit' ? '512000' : '')), dataset: { ctxMode: 'fixed', ctxLimit: '512000' } };
  h.elements.get('ctx-preset-grid').trigger('click', { target: { closest: () => p512Btn } });
  h.elements.get('btn-save-model-ctx').click();
  await h.flush();
  assert.equal(savedStore['product:google:gemini-4-hydrogen'].limitTokens, 512000);
  assert.equal(savedStore['gemini-4-hydrogen-low'], undefined);

  // 切换到未观测过的 Orchestrator (Carbon)，确保缺失预算与速度不跨档位借用且显示规定文案
  api.setContextLatestForTest({
    model: 'Orchestrator (Carbon)',
    modelId: 'orchestrator-carbon',
    status: 'reported',
    used: 1000
  }, cascadeConfigs);
  await h.flush();
  assert.equal(h.elements.get('ctx-card-observed-budget').textContent, '尚未观测');
  assert.equal(h.elements.get('ctx-card-observed-speed').children[0]?.textContent, '暂无实测数据');

  api.dispose();
});

test('安全应用、重启确认、手动重启说明与三条件已加载核验', async () => {
  let restartCalls = 0;
  let nextRestartSupported = true;
  let mockStatusData = {
    status: 'not_patched',
    arch: 'x86-64',
    configuredMode: 'default',
    configuredLimitTokens: 256000,
    runtimeEvidence: { restartDetected: false }
  };
  let nextApplyResponse = { ok: false, error: 'EBUSY: 占用中' };
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, contextPreferences: {} }),
    saveSettings: async () => ({ ok: true }),
    getContextUnlockStatus: async () => ({ ok: true, data: { ...mockStatusData } }),
    applyContextUnlock: async () => nextApplyResponse,
    restartHost: async () => {
      restartCalls++;
      return { ok: true, supported: nextRestartSupported };
    }
  };
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest({ model: 'Gemini 4 Flash', modelId: 'gemini-4-flash', status: 'reported', used: 1000, budget: 256000 });
  api.switchContextTabForTest('models');
  await h.flush();

  // 1. 保存 / 应用失败 -> 不出现重启按钮，不调用重启 IPC
  const p512Btn = { getAttribute: (k) => (k === 'data-ctx-mode' ? 'fixed' : (k === 'data-ctx-limit' ? '512000' : '')), dataset: { ctxMode: 'fixed', ctxLimit: '512000' } };
  h.elements.get('ctx-preset-grid').trigger('click', { target: { closest: () => p512Btn } });
  h.elements.get('btn-apply-unlock').click();
  await h.flush();
  assert.equal(h.elements.get('btn-restart-host').hidden, true, '应用失败绝不出现重启按钮');
  assert.equal(restartCalls, 0);

  // 2. 应用成功且 needsRestart: true -> 自动出现重启按钮，但绝不自动重启
  nextApplyResponse = { ok: true, needsRestart: true };
  mockStatusData = {
    status: 'patched_pending_restart',
    arch: 'x86-64',
    configuredMode: 'fixed',
    configuredLimitTokens: 512000,
    runtimeEvidence: { restartDetected: false }
  };
  h.elements.get('btn-apply-unlock').click();
  await h.flush();
  assert.equal(restartCalls, 0, '保存并应用后不能自动重启');
  assert.equal(h.elements.get('btn-restart-host').hidden, false);

  // 3. 当宿主不支持重启 (supported: false) -> 点击确认后显示手动重启说明
  nextRestartSupported = false;
  h.elements.get('btn-restart-host').click();
  assert.equal(h.elements.get('ctx-restart-confirm').hidden, false);
  h.elements.get('btn-restart-confirm-go').click();
  await h.flush();
  assert.equal(restartCalls, 1);
  assert.equal(h.elements.get('ctx-manual-restart-note').hidden, false);

  // 4. 三条件核验：仅 patched_loaded + 未重启 => 状态未确认；
  // 重启过但配置不一致 (实际 256000 vs 目标 512000) => 状态未确认；
  // 三条件全满足 => 已加载
  api.setRestartVerificationForTest({ mode: 'fixed', limitTokens: 512000, requestedAt: new Date().toISOString() });
  mockStatusData = { status: 'patched_loaded', arch: 'x86-64', configuredMode: 'fixed', configuredLimitTokens: 512000, runtimeEvidence: { restartDetected: false } };
  await api.refreshUnlockStatusForTest();
  assert.equal(h.elements.get('unlock-badge').textContent, '状态未确认');

  mockStatusData = { status: 'patched_loaded', arch: 'x86-64', configuredMode: 'fixed', configuredLimitTokens: 256000, runtimeEvidence: { restartDetected: true } };
  await api.refreshUnlockStatusForTest();
  assert.equal(h.elements.get('unlock-badge').textContent, '状态未确认');
  assert.equal(h.elements.get('ctx-restart-mismatch-note').hidden, false);

  // 重新应用匹配目标并满足全部三条件
  api.setRestartVerificationForTest({ mode: 'fixed', limitTokens: 512000, requestedAt: new Date().toISOString() });
  mockStatusData = { status: 'patched_loaded', arch: 'x86-64', configuredMode: 'fixed', configuredLimitTokens: 512000, runtimeEvidence: { restartDetected: true } };
  await api.refreshUnlockStatusForTest();
  assert.equal(h.elements.get('unlock-badge').textContent, '已加载');

  api.dispose();
});

test('速度对比分页：零网络请求与零 IPC 发送，正确绘制柱状图/折线图并标注样本少', async () => {
  const h = harness();
  h.finishScan();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;

  h.elements.get('badge').click();
  h.elements.get('tab-ctx-speed').click();
  await h.flush();
  // harness 默认 replaceChildren 不保留子节点，此处启用以检查 SVG 绘制元素
  h.elements.get('speed-bar-svg').replaceChildren = function (...nodes) { this.children = nodes; };
  h.elements.get('speed-line-svg').replaceChildren = function (...nodes) { this.children = nodes; };

  const fetchBefore = h.pending.length;
  const scansBefore = h.scans.length;

  const now = Date.now();
  api.setSpeedRecordsForTest([
    { callId: 'c1', modelExactId: 'gemini-4-argon-low', modelLabel: 'Gemini 4 Argon (Low)', status: 'final', outputTokens: 120, durationSec: 2, tps: 60, ttftSec: 0.5, timestamp: now - 5000 },
    { callId: 'c2', modelExactId: 'gemini-4-argon-low', modelLabel: 'Gemini 4 Argon (Low)', status: 'final', outputTokens: 200, durationSec: 2, tps: 100, ttftSec: 0.7, timestamp: now - 3000 },
    { callId: 'c3', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 160, durationSec: 2, tps: 80, ttftSec: 0.9, timestamp: now - 4000 },
    { callId: 'c4', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 180, durationSec: 2, tps: 90, ttftSec: 1.0, timestamp: now - 2000 },
    { callId: 'c5', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 200, durationSec: 2, tps: 100, ttftSec: 1.1, timestamp: now - 1000 }
  ]);
  // 再切换到其他分页切回“速度对比”，确认打开页面不触发网络请求与 IPC
  h.elements.get('tab-ctx-session').click();
  h.elements.get('tab-ctx-speed').click();
  await h.flush();

  assert.equal(h.pending.length, fetchBefore, '打开速度对比页不得发起任何 fetch 请求');
  assert.equal(h.scans.length, scansBefore, '打开速度对比页不得发起任何 scan/IPC');
  assert.equal(h.elements.get('speed-bar-empty').hidden, true);
  assert.equal(h.elements.get('speed-line-empty').hidden, true);

  const collectNodeTexts = (node) => {
    if (!node) return [];
    const arr = [];
    if (node.textContent) arr.push(node.textContent);
    if (Array.isArray(node.children)) {
      for (const ch of node.children) arr.push(...collectNodeTexts(ch));
    }
    return arr;
  };
  const barTexts = collectNodeTexts(h.elements.get('speed-bar-svg')).join(' | ');
  assert.match(barTexts, /样本少/);
  assert.ok(h.elements.get('speed-line-svg').children.length > 0, '折线图 SVG 应生成绘制节点');

  // 切换指标到首字延迟
  h.elements.get('speed-metric-ttft').click();
  assert.equal(h.elements.get('speed-bar-title').textContent, '首字延迟对比');

  api.dispose();
});

test('插件面板三语言切换、持久化、动态文案、模型名保留与客户端语言分离', async () => {
  let savedSettingsPayload = null;
  let storedSettings = {
    contextPreferences: { 'gemini-3-1-pro': { mode: 'fixed', limitTokens: 512000 } }
  };
  let restartCalls = 0;

  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, ...storedSettings }),
    saveSettings: async (payload) => {
      savedSettingsPayload = payload;
      storedSettings = {
        ...storedSettings,
        panelLanguage: payload.panelLanguage,
        uiPreferences: { ...(storedSettings.uiPreferences || {}), ...(payload.uiPreferences || {}) }
      };
      return { ok: true, ...storedSettings };
    },
    restartHost: async () => {
      restartCalls += 1;
      return { ok: true, supported: true };
    },
    getModulesStatus: async () => ({
      ok: true,
      chinese: { enabled: true, applied: true, active: true, asarPatched: true, targetLanguage: 'zh-CN' },
      proxy: { enabled: false, active: false }
    })
  };
  h.finishScan();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;
  await api.restoreSettingsForTest();

  // 1. 老用户未设置 panelLanguage 时默认保持简体中文 (zh-CN)
  assert.equal(api.getPanelLanguage(), 'zh-CN');
  assert.equal(api.translateForTest('tab.session'), '当前会话');
  assert.equal(api.translateForTest('tab.models'), '模型设置');
  assert.equal(api.translateForTest('tab.speed'), '速度对比');
  assert.equal(h.elements.get('status').textContent, '请求用量与会话累计分别统计；会话 token 数始终为本地估算。');

  // 打开上下文面板与设置页，验证客户端语言选项仅提供简体中文和 English（无虚假繁體中文客户端按钮）
  h.elements.get('badge').click();
  h.elements.get('btn-ctx-settings').click();
  await h.flush();
  assert.ok(h.elements.get('btn-panel-lang-zh-CN'), '面板应提供简体中文按钮');
  assert.ok(h.elements.get('btn-panel-lang-zh-TW'), '面板应提供繁體中文按钮');
  assert.ok(h.elements.get('btn-panel-lang-en'), '面板应提供 English 按钮');
  assert.ok(h.elements.get('btn-client-lang-zh-CN'), '客户端语言应提供简体中文按钮');
  assert.ok(h.elements.get('btn-client-lang-en'), '客户端语言应提供 English 按钮');
  assert.equal(h.elements.get('btn-client-lang-zh-TW'), undefined, '客户端暂不交付繁體中文词典，不得出现无效选择项');
  assert.match(api.translateForTest('settings.clientLang.licenseNote'), /qqxpee\/antigravity2-cn/, '应展示客户端词典授权说明');

  // 准备模型数据与最新请求数据（含官方模型名与准确 ID）
  api.setContextLatestForTest({
    model: 'Gemini 3.1 Pro (High)',
    modelId: 'MODEL_PLACEHOLDER_M26',
    status: 'reported',
    used: 120000,
    budget: 512000,
    speed: { tps: 45, duration: 2.0, ttft: 0.4, streamingSec: 1.6, outputTokens: 90 }
  });
  await h.flush();

  // 2. 切换为繁體中文 -> 立即更新静态+动态文案，不改写上下文长度，不触发重启
  h.elements.get('btn-panel-lang-zh-TW').click();
  await h.flush();
  assert.equal(api.getPanelLanguage(), 'zh-TW');
  assert.equal(api.translateForTest('tab.session'), '目前工作階段');
  assert.equal(api.translateForTest('tab.models'), '模型設定');
  assert.equal(api.translateForTest('tab.speed'), '速度對比');
  assert.equal(h.elements.get('panel-lang-save-badge').textContent, '已切換並儲存');
  assert.equal(savedSettingsPayload.panelLanguage, 'zh-TW');
  assert.equal(savedSettingsPayload.contextPreferences, undefined, '切换面板语言不得改写上下文偏好');
  assert.equal(restartCalls, 0, '切换面板语言不得触发重启');
  assert.equal(h.elements.get('model').textContent, 'Gemini 3.1 Pro (High)', '模型正式名称应保持原样不被翻译');
  assert.equal(h.elements.get('speed-badge').textContent, '⚡ 82.7 分 · A');
  assert.match(h.elements.get('speed-sub-label').textContent, /流式 56\.3 tok\/s/);

  // 验证静态属性遍历器在标准 DOM 下会同步更新 data-i18n 节点
  const mockStaticNode = {
    getAttribute: (k) => (k === 'data-i18n' ? 'tab.session' : null),
    textContent: ''
  };
  api.applyStaticTranslationsForTest({
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? [mockStaticNode] : [])
  });
  assert.equal(mockStaticNode.textContent, '目前工作階段');

  // 3. 切换为 English -> 验证静态标签、动态状态、模型名称原样保留
  h.elements.get('btn-panel-lang-en').click();
  await h.flush();
  assert.equal(api.getPanelLanguage(), 'en');
  assert.equal(api.translateForTest('tab.session'), 'Session');
  assert.equal(api.translateForTest('tab.models'), 'Models');
  assert.equal(api.translateForTest('tab.speed'), 'Speed');
  assert.equal(api.translateForTest('models.btn.saveApply'), 'Save & Apply');
  assert.equal(h.elements.get('speed-bar-title').textContent, 'Output Speed Comparison');
  assert.equal(h.elements.get('panel-lang-save-badge').textContent, api.translateForTest('settings.panelLang.saved'));
  assert.equal(h.elements.get('model').textContent, 'Gemini 3.1 Pro (High)', '切换为 English 后模型正式名称应保持原样');
  assert.equal(h.elements.get('speed-badge').textContent, '⚡ 82.7 pts · A');
  assert.match(h.elements.get('speed-sub-label').textContent, /Stream 56\.3 tok\/s/);
  assert.doesNotMatch(h.elements.get('speed-takeaway').textContent, /[\u4e00-\u9fa5]/, '英文模式速度评语不得夹带中文');
  assert.equal(storedSettings.contextPreferences['gemini-3-1-pro'].limitTokens, 512000, '已有模型上下文偏好必须保持原值');

  // 4. 模拟重启恢复：重新挂载并从 getSettings 恢复为 en
  api.dispose();
  const h2 = harness();
  h2.sandbox.window.contextMeterAPI = {
    ...h2.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, ...storedSettings })
  };
  await h2.sandbox.__AGContextMeter.restoreSettingsForTest();
  await h2.flush();
  assert.equal(h2.sandbox.__AGContextMeter.getPanelLanguage(), 'en');
  assert.equal(h2.elements.get('status').textContent, 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.');
  h2.sandbox.__AGContextMeter.dispose();
});

test('0.8.3 UI & restart & i18n regression: model selector moved into tab, details collapsed, restart button persists on patched_runtime_unconfirmed', async () => {
  const pathMod = require('path');
  const html = fs.readFileSync(pathMod.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const headerStart = html.indexOf('<div class="panel-header-bar">');
  const tabsStart = html.indexOf('<div id="ctx-tabs-bar"');
  assert.ok(headerStart >= 0 && tabsStart > headerStart);
  const headerSlice = html.slice(headerStart, tabsStart);
  assert.equal(headerSlice.includes('ctx-model-dropdown-wrap'), false, '标题栏第一行不应再包含模型下拉选择器');
  const modelsPaneStart = html.indexOf('<div id="pane-ctx-models"');
  const speedPaneStart = html.indexOf('<div id="pane-ctx-speed"');
  const modelsPaneSlice = html.slice(modelsPaneStart, speedPaneStart);
  assert.equal(modelsPaneSlice.includes('ctx-model-dropdown-wrap'), true, '模型选择器应位于模型设置页内');
  assert.equal(modelsPaneSlice.includes('ctx-card-details-drawer'), true, '实测预算与速度详情应位于下层折叠抽屉');

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  assert.notEqual(h.elements.get('ctx-card-drawer-body').style.display, 'block');
  h.elements.get('btn-toggle-card-details').click();
  assert.equal(h.elements.get('ctx-card-drawer-body').style.display, 'block');
  h.elements.get('btn-toggle-card-details').click();
  assert.equal(h.elements.get('ctx-card-drawer-body').style.display, 'none');

  // 模拟应用 1000000 后刷新状态返回 patched_runtime_unconfirmed，重启按钮必须保持可见
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getContextUnlockStatus: async () => ({
      ok: true,
      data: {
        status: 'patched_runtime_unconfirmed',
        arch: 'x86-64',
        clientMode: 'fixed',
        clientLimitTokens: 1000000,
        hasBackup: true
      }
    }),
    applyContextUnlock: async () => ({
      ok: true,
      status: 'patched_pending_restart',
      arch: 'x86-64',
      configuredMode: 'fixed',
      configuredLimitTokens: 1000000,
      needsRestart: true,
      hasBackup: true
    }),
    saveSettings: async (p) => ({ ok: true, contextPreferences: {} })
  };

  api.setContextLatestForTest({
    model: 'Gemini 3.8 Flash (Medium)',
    modelId: 'gemini-3-8-flash-medium',
    cascadeModelConfigs: [
      { label: 'Gemini 3.8 Flash (Medium)', modelOrAlias: { model: 'gemini-3-8-flash-medium' } }
    ]
  });
  await h.flush();

  const limitInput = h.elements.get('ctx-custom-limit-input');
  limitInput.value = '1000000';
  limitInput.trigger('input');
  h.elements.get('btn-apply-unlock').click();
  await h.flush();
  assert.equal(h.elements.get('btn-restart-host').hidden, false, '应用成功后即使状态为 patched_runtime_unconfirmed，重启按钮也必须可见');

  // 切换至英文后确认新增 i18n 键非空且不等于中文
  h.elements.get('btn-panel-lang-en').click();
  await h.flush();
  assert.equal(api.translateForTest('models.card.detailsToggle'), 'Observed budget, speed & details');
  assert.equal(api.translateForTest('cost.subSpendLabel'), 'Your Actual Spend');
  assert.equal(api.translateForTest('diag.ctx.badge'), 'Limit');
  api.dispose();
});

test('0.8.3 增强设置中心全流程：品牌三态、0~4档矩阵、推荐配置勾选确认与恢复官方默认', async () => {
  const calls = { enhanceApply: [], enhanceRestore: 0, toggleMod: [], unlockApply: [], unlockRestore: 0, restartLs: 0 };
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getEnhanceStatus: async () => ({
      ok: true,
      data: {
        supported: true,
        summary: {
          promptTier: 0,
          chineseTitleEnabled: false,
          chineseTitleMode: 'en',
          slotCount: 10,
          activeSlotBytes: 3100,
          totalCapacityBytes: 8192,
          allBackedUp: false
        }
      }
    }),
    applyEnhancePatch: async (p) => {
      calls.enhanceApply.push(p);
      return { ok: true, needsRestart: true };
    },
    restoreAllEnhance: async () => {
      calls.enhanceRestore++;
      return { ok: true, needsRestart: true };
    },
    restartLanguageServers: async () => {
      calls.restartLs++;
      return { ok: true, killed: ['language_server.exe'] };
    },
    getModulesStatus: async () => ({
      ok: true,
      data: { modules: { chinese: { enabled: false, brandTitle: 'english' }, proxy: { enabled: false } } },
      disk: { chinese: false, proxy: false }
    }),
    toggleModule: async (name, enable, opts) => {
      calls.toggleMod.push({ name, enable, opts });
      return { ok: true };
    },
    applyContextUnlock: async (p) => {
      calls.unlockApply.push(p);
      return { ok: true, needsRestart: true };
    },
    restoreContextUnlock: async () => {
      calls.unlockRestore++;
      return { ok: true };
    }
  };

  h.elements.get('btn-ctx-settings').click();
  await h.flush();
  assert.equal(h.elements.get('enhance-stat-backup').textContent, '无（未改写）');

  // 1. 切换品牌展示为「隐藏」
  h.elements.get('btn-brand-hidden').click();
  await h.flush();
  assert.equal(calls.toggleMod.length, 1);
  assert.equal(calls.toggleMod[0].opts.brandTitle, 'hidden');

  // 2. 选择 4 档，核对保留/清空/替换矩阵文案更新
  h.elements.get('enhance-tier-4').click();
  assert.match(h.elements.get('enhance-tier-replaces').textContent, /证据准则|真实工具/);

  // 3. 勾选推荐配置四项 -> 弹窗预览确认 -> 一键写入
  h.elements.get('chk-rec-prompt').checked = true;
  h.elements.get('chk-rec-title').checked = true;
  h.elements.get('chk-rec-lang').checked = true;
  h.elements.get('chk-rec-ctx').checked = true;
  h.elements.get('btn-enhance-preset-apply').click();
  assert.equal(h.elements.get('enhance-preset-confirm').hidden, false);

  h.elements.get('btn-enhance-confirm-go').click();
  await h.flush();
  assert.equal(calls.enhanceApply[0].promptTier, 4);
  assert.equal(calls.enhanceApply[0].chineseTitle, true);
  assert.equal(calls.toggleMod.some(c => c.name === 'chinese' && c.enable === true), true);
  assert.equal(calls.unlockApply[0].mode, 'dynamic');
  assert.equal(h.elements.get('btn-enhance-restart-ls').hidden, false);
  assert.equal(h.elements.get('btn-enhance-restart-host').hidden, false);

  // 4. 恢复全部官方默认
  h.elements.get('btn-enhance-restore-all').click();
  h.elements.get('btn-enhance-confirm-go').click();
  await h.flush();
  assert.equal(calls.enhanceRestore, 1);
  assert.equal(calls.unlockRestore, 1);
  assert.equal(calls.toggleMod.at(-1).enable, false);
  api.dispose();
});

test('0.8.3 结果框重启/手动引导、partial_match 重试与全量三语言无遗漏', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1. 模拟不支持自动重启的预览态 + 状态 partial_match -> 重试按钮必须可见，不误显示重启按钮
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getContextUnlockStatus: async () => ({
      ok: true,
      data: {
        status: 'partial_match',
        arch: 'x86-64',
        hostSupportsRestart: false,
        partialMatchReason: '未找到可用的上下文写入模式或目标特征不完整'
      }
    }),
    saveSettings: async () => ({ ok: true, contextPreferences: {} })
  };

  await api.refreshUnlockStatusForTest();
  await h.flush();
  const uiState1 = api.getUnlockUiStateForTest();
  assert.equal(uiState1.resultBoxDisplay, 'block');
  assert.equal(uiState1.resultRetryHidden, false, 'partial_match 时应显示重新检测按钮');
  assert.equal(uiState1.resultRestartHidden, true, '不支持自动重启时不应显示假重启按钮');

  // 2. 切换为 zh-TW 和 en 验证所有核心增强与错误键都有准确非空翻译
  for (const lang of ['zh-TW', 'en']) {
    await api.setPanelLanguage(lang, { persist: false });
    const titleVal = api.translateForTest('enhance.preset.title');
    const partialVal = api.translateForTest('status.badge.partialMatch');
    const halluVal = api.translateForTest('enhance.hallucinationNote');
    assert.ok(titleVal && titleVal !== 'enhance.preset.title');
    assert.ok(partialVal && partialVal !== 'status.badge.partialMatch');
    assert.ok(halluVal && halluVal !== 'enhance.hallucinationNote');
    if (lang === 'en') {
      assert.equal(/[\u4e00-\u9fa5]/.test(titleVal), false, `en 文案不应含汉字: ${titleVal}`);
      assert.equal(/[\u4e00-\u9fa5]/.test(partialVal), false, `en 文案不应含汉字: ${partialVal}`);
    }
  }
  api.dispose();
});

test('0.8.3 推荐配置按勾选隔离且部分失败准确分列成功/失败，全部恢复不吞异常', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const calls = { enhanceApply: 0, toggleMod: 0, unlockApply: 0, unlockRestore: 0 };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getEnhanceStatus: async () => ({ ok: true, data: { supported: true, summary: { promptTier: 0, chineseTitleMode: 'en' } } }),
    applyEnhancePatch: async () => { calls.enhanceApply++; return { ok: true, needsRestart: true }; },
    restoreAllEnhance: async () => ({ ok: true, needsRestart: true }),
    getModulesStatus: async () => ({ ok: true, data: { modules: { chinese: { enabled: false, brandTitle: 'english' } } }, disk: {} }),
    toggleModule: async () => { calls.toggleMod++; return { ok: false, error: 'app.asar 被占用' }; },
    applyContextUnlock: async () => { calls.unlockApply++; return { ok: true, needsRestart: true }; },
    restoreContextUnlock: async () => { calls.unlockRestore++; return { ok: false, error: 'language_server.exe 被锁定' }; }
  };

  h.elements.get('btn-ctx-settings').click();
  await h.flush();

  // 1. 只勾选上下文一项：其余三项调用数必须为 0
  h.elements.get('chk-rec-prompt').checked = false;
  h.elements.get('chk-rec-title').checked = false;
  h.elements.get('chk-rec-lang').checked = false;
  h.elements.get('chk-rec-ctx').checked = true;
  h.elements.get('btn-enhance-preset-apply').click();
  h.elements.get('btn-enhance-confirm-go').click();
  await h.flush();
  assert.equal(calls.enhanceApply, 0);
  assert.equal(calls.toggleMod, 0);
  assert.equal(calls.unlockApply, 1);

  // 2. 恢复全部默认：提示词成功，但语言开关和上下文还原均返回失败 -> 绝不能整组报成功
  h.elements.get('btn-enhance-restore-all').click();
  assert.match(h.elements.get('enhance-preset-confirm-text').textContent, /不会清除网络代理/);
  h.elements.get('btn-enhance-confirm-go').click();
  await h.flush();
  const resText = h.elements.get('enhance-global-result-text').textContent;
  assert.match(resText, /部分完成/);
  assert.match(resText, /app\.asar 被占用/);
  assert.match(resText, /language_server\.exe 被锁定/);
  assert.match(h.elements.get('enhance-global-result').className, /result-error/);
  api.dispose();
});

test('0.8.3 UI 模式切换：所有模型统一设置与按模型分别设置切换、极简看板与详细信息折叠抽屉', async () => {
  const h = harness();
  let savedSettings = null;
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({
      ok: true,
      contextScopeMode: 'unified',
      contextUnifiedPreference: { mode: 'fixed', limitTokens: 500000 },
      contextPreferences: {
        'product:google:gemini-3.8-flash': { mode: 'fixed', limitTokens: 512000 }
      }
    }),
    saveSettings: async (payload) => {
      savedSettings = payload;
      return { ok: true, contextPreferences: {} };
    },
    getContextUnlockStatus: async () => ({
      ok: true,
      data: { status: 'not_patched', arch: 'x86-64', hostSupportsRestart: false }
    })
  };

  h.elements.get('badge').click();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest({
    model: 'Gemini 3.8 Flash',
    modelId: 'gemini-3.8-flash',
    status: 'reported',
    used: 12000,
    budget: 256000,
    remaining: 244000
  }, [
    { modelId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }
  ]);
  h.elements.get('tab-ctx-models').click();
  await h.flush();

  // 1. 验证极简主看板元素存在且内容直观
  const summaryModeEl = h.elements.get('ctx-summary-mode');
  const summaryModelEl = h.elements.get('ctx-summary-model');
  const summaryLengthEl = h.elements.get('ctx-summary-length');
  const summaryPillEl = h.elements.get('ctx-summary-status-pill');
  assert.ok(summaryModeEl, '当前模式元素存在');
  assert.ok(summaryModelEl, '当前模型元素存在');
  assert.ok(summaryLengthEl, '当前使用长度元素存在');
  assert.ok(summaryPillEl, '当前状态角标存在');

  // 2. 初始统一模式下：模型选择器工具条与模型列表处于隐藏状态
  const btnUnified = h.elements.get('btn-ctx-mode-unified');
  const btnPerModel = h.elements.get('btn-ctx-mode-per-model');
  const toolbar = h.elements.get('ctx-models-toolbar');
  const modelList = h.elements.get('ctx-model-list');
  assert.equal(toolbar.hidden, true);
  assert.equal(modelList.hidden, true);

  // 3. 点击切换为按模型分别设置
  btnPerModel.click();
  await h.flush();
  assert.equal(api.getContextScopeModeForTest(), 'per_model');
  assert.equal(toolbar.hidden, false);
  assert.equal(modelList.hidden, false);
  assert.match(summaryModeEl.textContent, /按模型分别设置/);

  // 4. 折叠抽屉：详细信息默认折叠，点击展开与收起
  const cardDrawerBody = h.elements.get('ctx-card-drawer-body');
  const toggleBtn = h.elements.get('btn-toggle-card-details');
  assert.ok(toggleBtn);
  assert.ok(cardDrawerBody);
  toggleBtn.click();
  assert.equal(cardDrawerBody.style.display, 'block');
  toggleBtn.click();
  assert.equal(cardDrawerBody.style.display, 'none');

  // 5. 切回统一设置：原统一设置完好保留，不冲刷也不丢失
  btnUnified.click();
  await h.flush();
  assert.equal(api.getContextScopeModeForTest(), 'unified');
  assert.equal(toolbar.hidden, true);
  assert.equal(modelList.hidden, true);

  api.dispose();
});

test('0.8.3 设置页品牌选项与动态反馈单语言三态一致性', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const nodePath = require('node:path');
  const templateHtml = fs.readFileSync(nodePath.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const brandNodeSpecs = [
    ['btn-brand-english', 'enhance.brand.english'],
    ['btn-brand-hidden', 'enhance.brand.hidden'],
    ['btn-brand-translated', 'enhance.brand.translated']
  ];
  // 校验 template.html 中的 data-i18n 与实际键绑定一致
  for (const [id, key] of brandNodeSpecs) {
    assert.match(templateHtml, new RegExp(`id="${id}"[\\s\\S]{0,160}data-i18n="${key}"`));
  }
  const brandNodes = brandNodeSpecs.map(([id, key]) => {
    const node = h.elements.get(id);
    node.getAttribute = (k) => (k === 'data-i18n' ? key : null);
    return node;
  });
  const mockRoot = {
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? brandNodes : [])
  };

  try {
    h.elements.get('btn-ctx-settings').click();
    await h.flush();

    h.elements.get('btn-top-lang-en').click();
    await h.flush();
    api.applyStaticTranslationsForTest(mockRoot);
    assert.equal(h.elements.get('btn-brand-english').textContent, 'Antigravity');
    assert.equal(h.elements.get('btn-brand-hidden').textContent, 'Hide');
    assert.equal(h.elements.get('btn-brand-translated').textContent, 'Translated Name');
    assert.equal(api.translateForTest('enhance.brand.appliedName', { mode: 'Antigravity' }), 'Header name updated to "Antigravity" (applied).');
    assert.equal(api.translateForTest('enhance.brand.appliedHidden'), 'Header name hidden (applied).');

    h.elements.get('btn-top-lang-zh-TW').click();
    await h.flush();
    api.applyStaticTranslationsForTest(mockRoot);
    assert.equal(h.elements.get('btn-brand-english').textContent, 'Antigravity');
    assert.equal(h.elements.get('btn-brand-hidden').textContent, '隱藏');
    assert.equal(h.elements.get('btn-brand-translated').textContent, '反重力');
    assert.equal(api.translateForTest('enhance.brand.appliedHidden'), '已儲存並套用：左上角品牌已隱藏。');

    h.elements.get('btn-top-lang-zh-CN').click();
    await h.flush();
    api.applyStaticTranslationsForTest(mockRoot);
    assert.equal(h.elements.get('btn-brand-english').textContent, 'Antigravity');
    assert.equal(h.elements.get('btn-brand-hidden').textContent, '隐藏');
    assert.equal(h.elements.get('btn-brand-translated').textContent, '反重力');
    assert.equal(api.translateForTest('enhance.brand.appliedHidden'), '已保存并应用：左上角品牌已隐藏。');
  } finally {
    api.dispose();
  }
});

// --- PR #9 实时同步与队列测试 ---
const path = require('node:path');

test('real-time token history refresh: idle dedup, recordCalls ordering, a 5s automatic scan interval, and busy coalescing', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  // Drain initial boot scan & initial requestPoll microtasks first
  h.finishScan(0);
  await flushAsync();

  const events = [];
  let recordCallsDeferred = null;
  const historyDeferredQueue = [];
  let autoResolveHistory = true;

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const ids = calls.map(c => c.callId).join(',');
      events.push(`recordCalls:${ids}`);
      if (recordCallsDeferred) {
        const p = recordCallsDeferred.promise;
        recordCallsDeferred = null;
        return p;
      }
      return Promise.resolve({ ok: true, changed: false });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      if (!autoResolveHistory) {
        return new Promise(resolve => {
          historyDeferredQueue.push({ force: Boolean(force), resolve });
        });
      }
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 12:30:00',
          summary: { grandTotalTokens: 40000, todayTokens: 4000 },
          dailyMap: { '2026-11-12': { total: 4000, input: 3000, cache: 500, output: 500, steps: 1 } }
        }
      });
    }
  };

  try {
    // (a) Initial hydration poll resolves a final row (changed: false) -> recorded once, then repeated idle 3s polls do NOT re-invoke recordCalls or getTokenHistory
    const idleRow = {
      stepIndices: [2],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        responseModel: 'gemini-3.8-flash',
        usage: { inputTokens: 10000, cacheReadTokens: 2000, outputTokens: 500, responseId: 'resp-idle-1' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-idle-1']);

    events.length = 0;
    // Idle 3s poll #2 with identical final row
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll #2 with unchanged final row must not call recordCalls or getTokenHistory');

    // Idle 3s poll #3 with identical final row
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll #3 with unchanged final row must not call recordCalls or getTokenHistory');

    // (b) Streaming row does not trigger recordCalls/getTokenHistory; newly-final transition awaits recordCalls strictly BEFORE getTokenHistory(true)
    const streamingRow = {
      isStreaming: true,
      status: 'streaming',
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 12000, outputTokens: 120, responseId: 'resp-live-2' }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[3].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, streamingRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'In-flight streaming row must not trigger final ledger write or token history rescan');

    let resolveRecord;
    recordCallsDeferred = {
      promise: new Promise(r => { resolveRecord = r; })
    };
    const finalRow2 = {
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        responseModel: 'gemini-3.8-flash',
        timeToFirstToken: '1.2s',
        streamingDuration: '2.0s',
        usage: { inputTokens: 12000, cacheReadTokens: 4000, outputTokens: 600, responseId: 'resp-live-2' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[4].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, finalRow2] }) });
    await flushAsync();

    // Context badge updates immediately without blocking on recordCalls, while getTokenHistory(true) waits for recordCalls!
    assert.equal(api.snapshot().latest.actual, 16600);
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'getTokenHistory must NOT fire before recordCalls resolves');

    events.push('resolvingRecordCalls');
    resolveRecord({ ok: true, changed: true });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-live-2',
      'resolvingRecordCalls',
      'getTokenHistory:true'
    ], 'getTokenHistory(true) must fire strictly after recordCalls resolves');

    // Usage progression on an already-final row triggers once, then stabilizes
    events.length = 0;
    const calibratedRow2 = {
      ...finalRow2,
      chatModel: {
        ...finalRow2.chatModel,
        usage: { inputTokens: 12000, cacheReadTokens: 4000, outputTokens: 950, responseId: 'resp-live-2' }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[5].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, calibratedRow2] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'Ledger writes should proceed during the scan cooldown');

    fakeNow += 1499;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'No automatic scan before five seconds');

    fakeNow += 1;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2', 'getTokenHistory:true']);

    events.length = 0;
    fakeNow += 2000;
    h.tick();
    h.pending[6].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, calibratedRow2] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Calibrated final row must not re-trigger on subsequent idle poll');

    // (c) Concurrent syncTokenHistoryFromHost requests while historySyncBusy coalesce into at most ONE trailing getTokenHistory(true)
    events.length = 0;
    autoResolveHistory = false;

    void api.syncTokenHistoryFromHost(false);
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 1);
    assert.equal(historyDeferredQueue[0].force, false);
    assert.deepEqual(events, ['getTokenHistory:false']);

    // Fire 5 overlapping refresh requests (including opening #panel-tokens and explicit force=true calls) while busy
    void api.syncTokenHistoryFromHost(false);
    h.elements.get('badge-tokens').click(); // showPanel('tokens') -> syncTokenHistoryFromHost(true)
    void api.syncTokenHistoryFromHost(true);
    void api.syncTokenHistoryFromHost(true);
    void api.syncTokenHistoryFromHost(false);
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 1, 'No parallel getTokenHistory calls while historySyncBusy is true');
    assert.deepEqual(events, ['getTokenHistory:false']);

    // Resolve the in-flight sync -> must launch AT MOST ONE trailing sync, upgraded to force=true
    historyDeferredQueue[0].resolve({
      ok: true,
      data: {
        updatedAt: '2026-11-12 12:31:00',
        summary: { grandTotalTokens: 50000, todayTokens: 5000 },
        dailyMap: { '2026-11-12': { total: 5000, input: 4000, cache: 500, output: 500, steps: 2 } }
      }
    });
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 2, 'Exactly one trailing getTokenHistory call must start');
    assert.equal(historyDeferredQueue[1].force, true, 'Trailing coalesced call must preserve force=true');
    assert.deepEqual(events, ['getTokenHistory:false', 'getTokenHistory:true']);

    // Resolve the trailing sync -> must settle cleanly with zero extra calls and render latest payload
    historyDeferredQueue[1].resolve({
      ok: true,
      data: {
        updatedAt: '2026-11-12 12:31:05',
        summary: { grandTotalTokens: 88000, todayTokens: 8000 },
        dailyMap: { '2026-11-12': { total: 8000, input: 6000, cache: 1000, output: 1000, steps: 3 } }
      }
    });
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 2, 'No extra trailing syncs after coalesced sync finishes');
    assert.equal(h.elements.get('token-amount').textContent, '88.0K');

    // Also verify non-forced requests arriving while busy coalesce into ONE trailing getTokenHistory(false)
    events.length = 0;
    historyDeferredQueue.length = 0;
    void api.syncTokenHistoryFromHost(true);
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 1);
    assert.equal(historyDeferredQueue[0].force, true);
    void api.syncTokenHistoryFromHost(false);
    void api.syncTokenHistoryFromHost(false);
    await flushAsync();
    historyDeferredQueue[0].resolve({
      ok: true,
      data: { updatedAt: '2026-11-12 12:31:10', summary: { grandTotalTokens: 88000, todayTokens: 8000 }, dailyMap: {} }
    });
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 2);
    assert.equal(historyDeferredQueue[1].force, false, 'Non-forced pending syncs keep nextForce=false');
    historyDeferredQueue[1].resolve({
      ok: true,
      data: { updatedAt: '2026-11-12 12:31:12', summary: { grandTotalTokens: 88000, todayTokens: 8000 }, dailyMap: {} }
    });
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:true', 'getTokenHistory:false']);

    // Verify 15s polling fallback still works when >15000ms elapses
    events.length = 0;
    autoResolveHistory = true;
    fakeNow += 16000;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:false']);
  } finally {
    api.dispose();
  }
});

test('requestPoll retries recordCalls on next 3s poll after failure or rejection and commits only on ok:true', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  let attempt = 0;
  const origWarn = console.warn;
  console.warn = () => { };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      attempt++;
      const ids = calls.map(c => c.callId).join(',');
      events.push(`recordCalls#${attempt}:${ids}`);
      if (attempt === 1) {
        return Promise.resolve({ ok: false, error: 'write failed' });
      }
      if (attempt === 2) {
        return Promise.reject(new Error('IPC channel busy'));
      }
      return Promise.resolve({ ok: true, changed: true });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 14:25:00',
          summary: { grandTotalTokens: 64000, todayTokens: 14000 },
          dailyMap: { '2026-11-12': { total: 14000, input: 10000, cache: 3000, output: 1000, steps: 1 } }
        }
      });
    }
  };

  const finalRow = {
    stepIndices: [3],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 10000, cacheReadTokens: 3000, outputTokens: 1000, responseId: 'resp-retry-1' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  try {
    // Poll 1: recordCalls returns { ok: false, error: 'write failed' } -> must NOT commit or call getTokenHistory(true)
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#1:resp-retry-1'], 'Failed recordCalls (ok:false) must not trigger getTokenHistory(true)');

    // Poll 2 (next 3s tick): identical finalRow -> retried (#2), rejects -> must NOT commit or call getTokenHistory(true)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#2:resp-retry-1'], 'Rejected recordCalls must not trigger getTokenHistory(true) and must stay retryable');

    // Poll 3 (next 3s tick): identical finalRow -> retried (#3), succeeds ({ ok: true, changed: true }) -> commits & triggers getTokenHistory(true)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#3:resp-retry-1', 'getTokenHistory:true'], 'Successful retry must trigger getTokenHistory(true)');
    assert.equal(h.elements.get('token-amount').textContent, '64.0K');

    // Poll 4 (next 3s tick): identical finalRow -> already committed in syncedFinalMap, zero further recordCalls attempts!
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 4);
    h.pending[3].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Once recordCalls succeeds, subsequent idle polls must not re-send');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('pendingFinalCalls retains 5-row batch across offset=2 sliding window, retries via tick() without RPC rows, and re-flushes in-flight progressions', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const makeRow = (id, stepIdx, outTokens = 400) => ({
    stepIndices: [stepIdx],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 8000 + stepIdx * 100, cacheReadTokens: 2000, outputTokens: outTokens, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = () => Promise.resolve({ ok: true, changed: true });
  const origWarn = console.warn;
  console.warn = () => { };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const summary = calls.map(c => `${c.callId}:${c.outputTokens}`).join(',');
      events.push(`recordCalls:${summary}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:00:00',
          summary: { grandTotalTokens: 95000, todayTokens: 25000 },
          dailyMap: { '2026-11-12': { total: 25000, input: 18000, cache: 5000, output: 2000, steps: 5 } }
        }
      });
    }
  };

  try {
    // Part 1: Direct 5-row sliding-window failure (Poll 1 offset=0 -> Poll 2 +3.5s offset=2 with call_3..call_5 -> Poll 3 makes 0 recordCalls)
    const rowsA = [1, 2, 3, 4, 5].map(n => makeRow(`call_${n}`, n, 300));
    assert.equal(JSON.parse(h.pending[0].options.body).generatorMetadataOffset, 0);

    recordBehavior = () => Promise.resolve({ ok: false, error: 'disk write failed' });
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA }) });
    await flushAsync();

    assert.equal(api.snapshot().count, 5);
    assert.deepEqual(events, [
      'recordCalls:call_1:300,call_2:300,call_3:300,call_4:300,call_5:300'
    ], 'Poll 1 attempts all 5 calls and does not call getTokenHistory on failure');

    // Poll 2 (+3.5s): offset slides to Math.max(0, 5 - 3) = 2, returning ONLY call_3..call_5
    events.length = 0;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    assert.equal(JSON.parse(h.pending[1].options.body).generatorMetadataOffset, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA.slice(2) }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:call_1:300,call_2:300,call_3:300,call_4:300,call_5:300',
      'getTokenHistory:true'
    ], 'Retry must retain call_1 and call_2 despite offset=2 returning only call_3..call_5');
    assert.deepEqual(Array.from(savedLedger.keys()), ['call_1', 'call_2', 'call_3', 'call_4', 'call_5']);

    // Poll 3 (+3.5s): offset=2 returning call_3..call_5 -> 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA.slice(2) }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Poll 3 must make 0 recordCalls after all 5 calls were saved');

    // Part 2: Sliding window + tick() retry when RPC is NOT polled yet AND after RPC returns []
    savedLedger.clear();
    h.sandbox.location.pathname = '/c/33333333-3333-3333-3333-333333333333';
    h.tick();
    h.finishScan(1);
    await flushAsync();
    events.length = 0;

    const rowsB = [1, 2, 3, 4, 5].map(n => makeRow(`b_${n}`, n, 250));
    const pollB1Idx = h.pending.length - 1;
    assert.equal(JSON.parse(h.pending[pollB1Idx].options.body).generatorMetadataOffset, 0);

    let resolveSlowFail;
    recordBehavior = () => new Promise(r => { resolveSlowFail = r; });
    h.pending[pollB1Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsB }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250']);

    // Slow failure finishes at +1000ms -> requestNext is +3000ms while nextFlushRetryAt is +4000ms
    events.length = 0;
    fakeNow += 1000;
    resolveSlowFail({ ok: false, error: 'ipc timeout' });
    await flushAsync();

    // At +3200ms: Poll 2 (offset=2) runs and returns ONLY b_3..b_5 BEFORE nextFlushRetryAt (+4000ms)
    fakeNow += 2200;
    h.tick();
    const pollB2Idx = h.pending.length - 1;
    assert.equal(JSON.parse(h.pending[pollB2Idx].options.body).generatorMetadataOffset, 2);
    h.pending[pollB2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsB.slice(2) }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Retry waits until nextFlushRetryAt backoff expires');

    // At +4100ms: tick() runs WITHOUT any new RPC poll (requestNext is +6200ms) -> retries all 5!
    const pendingBeforeTickRetry = h.pending.length;
    recordBehavior = () => Promise.reject(new Error('still busy'));
    fakeNow += 900;
    h.tick();
    await flushAsync();
    assert.equal(h.pending.length, pendingBeforeTickRetry, 'No RPC poll needed for tick() retry');
    assert.deepEqual(events, ['recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250']);

    // At +6500ms: Poll 3 runs and RPC returns empty [] -> pendingFinalCalls must still keep b_1..b_5!
    events.length = 0;
    fakeNow += 2400;
    h.tick();
    const pollB3Idx = h.pending.length - 1;
    h.pending[pollB3Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [] }) });
    await flushAsync();
    assert.equal(api.snapshot().count, 0);
    assert.deepEqual(events, []);

    // At +7200ms: tick() retries again WITHOUT RPC returning any rows -> succeeds & saves all 5!
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    const pendingBeforeEmptyRecovery = h.pending.length;
    fakeNow += 700;
    h.tick();
    await flushAsync();
    assert.equal(h.pending.length, pendingBeforeEmptyRecovery);
    assert.deepEqual(events, [
      'recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250',
      'getTokenHistory:true'
    ], 'All 5 pending calls survive RPC [] and commit via tick() retry');
    assert.deepEqual(Array.from(savedLedger.keys()), ['b_1', 'b_2', 'b_3', 'b_4', 'b_5']);

    // Part 3: If a call progresses to larger { tot, out } while flushPendingFinalCalls is in flight, it is NOT deleted and triggers a follow-up flush
    events.length = 0;
    let resolveInFlight;
    recordBehavior = calls => new Promise(r => {
      resolveInFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    fakeNow += 3500;
    h.tick();
    const pollB4Idx = h.pending.length - 1;
    h.pending[pollB4Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 120)] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_6:120']);

    // While b_6:120 flush is still in flight, next poll calibrates b_6 to outputTokens=480
    fakeNow += 3500;
    h.tick();
    const pollB5Idx = h.pending.length - 1;
    h.pending[pollB5Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 480)] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_6:120'], 'Single-flight guard prevents overlapping flush');

    // Prepare immediate resolution for the follow-up flush when in-flight flush completes
    const finishFirstFlush = resolveInFlight;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    finishFirstFlush({ ok: true, changed: true });
    await flushAsync();

    assert.equal(savedLedger.get('b_6')?.outputTokens, 480, 'Follow-up flush must persist progressed outputTokens=480');
    assert.equal(events.includes('recordCalls:b_6:480'), true, 'Progressed pending call must trigger follow-up flush in finally');

    // Subsequent idle poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    const pollB6Idx = h.pending.length - 1;
    h.pending[pollB6Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 480)] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll after follow-up flush makes 0 recordCalls');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('pendingFinalCalls survives route switches across conversations and / home screen and retries via tick()', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = () => Promise.resolve({ ok: true, changed: true });
  const origWarn = console.warn;
  console.warn = () => { };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}@${c.cascadeId.slice(0, 8)}`).join(',');
      events.push(`recordCalls:${desc}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:30:00',
          summary: { grandTotalTokens: 112000, todayTokens: 32000 },
          dailyMap: { '2026-11-12': { total: 32000, input: 24000, cache: 5000, output: 3000, steps: 2 } }
        }
      });
    }
  };

  const rowUuid1 = {
    stepIndices: [1],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 12000, cacheReadTokens: 3000, outputTokens: 1500, responseId: 'resp-route-u1' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  const rowUuid2 = {
    stepIndices: [2],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 12000, cacheReadTokens: 2000, outputTokens: 1500, responseId: 'resp-route-u2' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  try {
    // 1. In /c/11111111-..., Poll 1 fails ({ ok: false }) -> resp-route-u1 remains queued
    recordBehavior = () => Promise.resolve({ ok: false, error: 'temporary lock' });
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid1] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-route-u1@11111111']);

    // 2. Switch route to /c/22222222-... AND then to / (id === null) before backoff expires
    events.length = 0;
    fakeNow += 500;
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(1);
    await flushAsync();

    fakeNow += 500;
    h.sandbox.location.pathname = '/';
    h.tick();
    await flushAsync();
    assert.equal(api.snapshot().route, null);
    assert.equal(api.snapshot().sessionCalls.length, 0);
    // Only route-switch getTokenHistory(true) ran; backoff (+3000ms) hasn't expired yet
    assert.equal(events.some(e => e.startsWith('recordCalls:')), false);

    // 3. Once backoff expires while STILL on / (id === null), tick() retries recordCalls, saves uuid-1's call, empties queue, and refreshes history
    events.length = 0;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    fakeNow += 2500; // total +3500ms since failure
    h.tick();
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp-route-u1@11111111',
      'getTokenHistory:true'
    ], 'tick() on / home route must retry and commit queued call from previous conversation');
    assert.equal(savedLedger.get('resp-route-u1')?.cascadeId, '11111111-1111-1111-1111-111111111111');
    assert.equal(h.elements.get('token-amount').textContent, '112.0K');

    // Subsequent tick() on / makes 0 recordCalls (queue is now empty)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, []);

    // 4. Also verify an in-flight flush completes and commits even if route switches to / mid-flight
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(2);
    await flushAsync();
    events.length = 0;

    let resolveMidFlight;
    recordBehavior = calls => new Promise(r => {
      resolveMidFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    const poll2Idx = h.pending.length - 1;
    h.pending[poll2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid2] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-route-u2@22222222']);

    // Switch to / while recordCalls is still in flight
    h.sandbox.location.pathname = '/';
    h.tick();
    await flushAsync();
    events.length = 0;

    resolveMidFlight({ ok: true, changed: true });
    await flushAsync();
    assert.equal(savedLedger.has('resp-route-u2'), true);
    assert.deepEqual(events, []);
    fakeNow += 5000;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:true']);

    // Re-entering /c/22222222-... and polling rowUuid2 again must NOT re-send resp-route-u2 (syncedFinalMap preserved across routes)
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(3);
    await flushAsync();
    events.length = 0;
    const pollReenterIdx = h.pending.length - 1;
    h.pending[pollReenterIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid2] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'syncedFinalMap retained across route switches prevents duplicate recordCalls on re-entry');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('flushPendingFinalCalls chunks >500 items and >900KB UTF-8 payloads for live-host limits and recovers from partial chunk failure', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const origWarn = console.warn;
  console.warn = () => { };

  // Use live-host HTTP mode (enforcing live-host.js MAX_RECORD_CALLS=500 & MAX_BODY_BYTES=1MB)
  delete h.sandbox.window.contextMeterAPI.recordCalls;
  delete h.sandbox.window.contextMeterAPI.getTokenHistory;
  h.sandbox.window.__AGContextMeterLive = { port: 43199, token: 'test-live-token' };

  const chunkLog = [];
  const savedIds = new Set();
  let failNextChunk2Once = true;
  const baseFetch = h.sandbox.fetch;
  h.sandbox.fetch = (url, options = {}) => {
    if (String(url).endsWith('/record-calls')) {
      const rawBody = String(options.body || '');
      const utf8Bytes = Buffer.byteLength(rawBody, 'utf8');
      if (utf8Bytes > 1024 * 1024) {
        chunkLog.push(`413:${utf8Bytes}`);
        return Promise.resolve({ ok: false, status: 413, json: async () => ({ ok: false, error: 'Payload too large' }) });
      }
      assert.equal(utf8Bytes <= 900 * 1024, true, `Chunk UTF-8 bytes (${utf8Bytes}) must respect 900KB ceiling`);
      const parsed = JSON.parse(rawBody);
      const calls = parsed.calls || [];
      if (calls.length > 500) {
        chunkLog.push(`400:${calls.length}`);
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: 'Too many calls' }) });
      }
      chunkLog.push(`chunk:${calls.length}:${calls[0]?.callId}..${calls[calls.length - 1]?.callId}`);
      if (calls.length === 1 && calls[0]?.callId === 'c_501' && failNextChunk2Once) {
        failNextChunk2Once = false;
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false, error: 'transient 503' }) });
      }
      for (const c of calls) savedIds.add(c.callId);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) });
    }
    if (String(url).endsWith('/token-history')) {
      const parsed = JSON.parse(String(options.body || '{}'));
      chunkLog.push(`history:${Boolean(parsed.force)}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            updatedAt: '2026-11-12 15:35:00',
            summary: { grandTotalTokens: 501000, todayTokens: 501000 },
            dailyMap: { '2026-11-12': { total: 501000, input: 400000, cache: 50000, output: 51000, steps: 501 } }
          }
        })
      });
    }
    if (String(url).endsWith('/get-settings')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) });
    }
    return baseFetch(url, options);
  };

  const makeFinalRow = (id, stepIdx, modelLabel = 'Gemini 4 Carbon (High)') => ({
    stepIndices: [stepIdx],
    chatModel: {
      modelDisplayName: modelLabel,
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 800, cacheReadTokens: 100, outputTokens: 100, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  try {
    // (a) 501 items: Chunk 1 (500 items) succeeds and commits immediately; Chunk 2 (1 item) fails once, then retries ONLY that 1 item
    const rows501 = Array.from({ length: 501 }, (_, idx) => makeFinalRow(`c_${idx + 1}`, idx + 1));
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501 }) });
    await flushAsync();

    assert.equal(savedIds.size, 500, 'Chunk 1 (500 items) must commit even when Chunk 2 fails');
    assert.deepEqual(chunkLog, [
      'chunk:500:c_1..c_500',
      'chunk:1:c_501..c_501',
      'history:true'
    ]);

    // After +3.5s backoff, tick() retries ONLY the remaining 1 item (c_501), NOT the already-confirmed 500 items!
    chunkLog.length = 0;
    fakeNow += 3500;
    h.tick();
    const poll2Idx = h.pending.length - 1;
    h.pending[poll2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501.slice(498) }) });
    await flushAsync();

    assert.equal(savedIds.size, 501, 'Remaining Chunk 2 item must succeed on retry and drain queue to 0');
    assert.deepEqual(chunkLog, ['chunk:1:c_501..c_501']);
    fakeNow += 1500;
    h.tick();
    await flushAsync();
    assert.deepEqual(chunkLog, [
      'chunk:1:c_501..c_501',
      'history:true'
    ]);

    // Idle poll makes 0 /record-calls requests
    chunkLog.length = 0;
    fakeNow += 2000;
    h.tick();
    const poll3Idx = h.pending.length - 1;
    h.pending[poll3Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501.slice(498) }) });
    await flushAsync();
    assert.deepEqual(chunkLog, []);

    // (b) Multi-byte UTF-8 byte-limit chunking: 12 items with 35,000 CJK chars each (~105KB UTF-8 per item -> ~1.26MB total > 1MB, though UTF-16 length is only ~420K)
    const bigCjkLabel = 'Gemini 4 ' + '测'.repeat(35000);
    const bigRows = Array.from({ length: 12 }, (_, idx) => makeFinalRow(`big_${idx + 1}`, 600 + idx, bigCjkLabel));
    fakeNow += 3500;
    h.tick();
    const pollBigIdx = h.pending.length - 1;
    h.pending[pollBigIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: bigRows }) });
    await flushAsync();

    const bigChunks = chunkLog.filter(entry => entry.startsWith('chunk:'));
    assert.equal(bigChunks.length >= 2, true, `Expected >=2 UTF-8 byte-capped chunks, got: ${JSON.stringify(chunkLog)}`);
    for (let i = 1; i <= 12; i++) {
      assert.equal(savedIds.has(`big_${i}`), true, `Missing big_${i}`);
    }

    // Idle poll after byte-chunked drain makes 0 /record-calls requests
    chunkLog.length = 0;
    fakeNow += 3500;
    h.tick();
    const pollAfterBigIdx = h.pending.length - 1;
    h.pending[pollAfterBigIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: bigRows.slice(9) }) });
    await flushAsync();
    assert.deepEqual(chunkLog, []);
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('final call model enrichment with unchanged 100 tokens re-sends to host once (empty -> model, placeholder -> model, and in-flight enrichment)', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = calls => {
    for (const c of calls) savedLedger.set(c.callId, c);
    return Promise.resolve({ ok: true, changed: true });
  };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.model || '(empty)'}:${c.modelKey || '(nokey)'}:${c.totalTokens}`).join(',');
      events.push(`recordCalls:${desc}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:55:00',
          summary: { grandTotalTokens: 120000, todayTokens: 12000 },
          dailyMap: { '2026-11-12': { total: 12000, input: 8000, cache: 2000, output: 2000, steps: 3 } }
        }
      });
    }
  };

  const makeRow100 = (id, stepIdx, modelDisplayName = '') => ({
    stepIndices: [stepIdx],
    status: 'final',
    chatModel: {
      ...(modelDisplayName ? { modelDisplayName } : {}),
      usage: { inputTokens: 60, cacheReadTokens: 0, outputTokens: 40, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  try {
    // (a1) model: "" -> model: "Gemini 4 Carbon" with identical 100 tokens
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, '')] }) });
    await flushAsync();
    assert.equal(savedLedger.get('resp-mdl-1')?.model, '');
    assert.equal(savedLedger.get('resp-mdl-1')?.isPriced, false);
    assert.deepEqual(events, [
      'recordCalls:resp-mdl-1:(empty):(nokey):100',
      'getTokenHistory:true'
    ]);

    // Unchanged empty-model poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, '')] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // Model populates to "Gemini 4 Carbon" while tokens stay at 100 (60 in + 40 out) -> MUST re-send & refresh history!
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, 'Gemini 4 Carbon')] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-mdl-1:Gemini 4 Carbon:gemini-4-carbon:100',
      'getTokenHistory:true'
    ]);
    assert.equal(savedLedger.get('resp-mdl-1')?.model, 'Gemini 4 Carbon');
    assert.equal(savedLedger.get('resp-mdl-1')?.modelKey, 'gemini-4-carbon');
    assert.equal(savedLedger.get('resp-mdl-1')?.isPriced, true);

    // Subsequent identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, 'Gemini 4 Carbon')] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // (a2) Placeholder ("MODEL_PLACEHOLDER_M18" -> "Gemini 4 Argon (High)") and unmapped slug ("unknown-preview-v0" -> "Gemini 4 Carbon") with unchanged 100 tokens
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'unknown-preview-v0'),
          makeRow100('resp-ph-mapped', 3, 'MODEL_PLACEHOLDER_M18')
        ]
      })
    });
    await flushAsync();
    assert.equal(savedLedger.get('resp-ph-unmapped')?.modelKey, null);
    assert.equal(savedLedger.get('resp-ph-mapped')?.modelKey, null);
    assert.equal(savedLedger.get('resp-ph-mapped')?.isPriced, false);

    events.length = 0;
    fakeNow += 5000;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'Gemini 4 Carbon'),
          makeRow100('resp-ph-mapped', 3, 'Gemini 4 Argon (High)')
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-ph-unmapped:Gemini 4 Carbon:gemini-4-carbon:100,resp-ph-mapped:Gemini 4 Argon (High):gemini-4-argon:100',
      'getTokenHistory:true'
    ]);
    assert.equal(savedLedger.get('resp-ph-unmapped')?.isPriced, true);
    assert.equal(savedLedger.get('resp-ph-mapped')?.model, 'Gemini 4 Argon (High)');
    assert.equal(savedLedger.get('resp-ph-mapped')?.modelKey, 'gemini-4-argon');
    assert.equal(savedLedger.get('resp-ph-mapped')?.isPriced, true);

    // Subsequent identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'Gemini 4 Carbon'),
          makeRow100('resp-ph-mapped', 3, 'Gemini 4 Argon (High)')
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(events, []);

    // (a3) In-flight model enrichment while model:"" flush is still awaiting
    events.length = 0;
    let resolveFirstInFlight;
    recordBehavior = calls => new Promise(r => {
      resolveFirstInFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, '')] })
    });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-mdl-inflight:(empty):(nokey):100']);

    // Enriched model arrives while first flush is still in flight
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, 'Gemini 4 Carbon')] })
    });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-mdl-inflight:(empty):(nokey):100']);

    const finishFirst = resolveFirstInFlight;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    finishFirst({ ok: true, changed: true });
    await flushAsync();

    assert.equal(savedLedger.get('resp-mdl-inflight')?.model, 'Gemini 4 Carbon');
    assert.equal(savedLedger.get('resp-mdl-inflight')?.isPriced, true);
    assert.equal(events.includes('recordCalls:resp-mdl-inflight:Gemini 4 Carbon:gemini-4-carbon:100'), true);

    // Next identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, 'Gemini 4 Carbon')] })
    });
    await flushAsync();
    assert.deepEqual(events, []);
  } finally {
    api.dispose();
  }
});

test('oversized >1 MiB first item never head-of-line blocks normal queued items and is quarantined in Live HTTP and recordCalls modes', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const origWarn = console.warn;
  console.warn = () => { };

  const makeRow = (id, stepIdx, modelLabel = 'Gemini 4 Carbon') => ({
    stepIndices: [stepIdx],
    status: 'final',
    chatModel: {
      modelDisplayName: modelLabel,
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 100, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  // ~1.2 MiB UTF-8 string ('超' is 3 UTF-8 bytes -> 410,000 * 3 = 1,230,000 bytes > 1 MiB)
  const over1MiBLabel = 'Gemini 4 Carbon ' + '超'.repeat(410000);
  // ~950 KiB UTF-8 string (320,000 * 3 = 960,000 bytes -> >900 KiB and <=1 MiB)
  const mid950KiBLabel = 'Gemini 4 Carbon ' + '中'.repeat(320000);

  try {
    // Part 1: Live HTTP mode (>1 MiB first item + 950 KiB 413 item + normal items behind them)
    delete h.sandbox.window.contextMeterAPI.recordCalls;
    delete h.sandbox.window.contextMeterAPI.getTokenHistory;
    h.sandbox.window.__AGContextMeterLive = { port: 43299, token: 'live-tok' };

    const liveEvents = [];
    const liveSaved = new Set();
    const baseFetch = h.sandbox.fetch;
    h.sandbox.fetch = (url, options = {}) => {
      if (String(url).endsWith('/record-calls')) {
        const rawBody = String(options.body || '');
        const utf8Bytes = Buffer.byteLength(rawBody, 'utf8');
        const parsed = JSON.parse(rawBody);
        const ids = (parsed.calls || []).map(c => c.callId).join(',');
        if (utf8Bytes > 1024 * 1024 || ids === 'mid_413_live') {
          liveEvents.push(`http413:${ids}`);
          return Promise.resolve({ ok: false, status: 413, json: async () => ({ ok: false, error: 'Payload too large' }) });
        }
        liveEvents.push(`liveSaved:${ids}`);
        for (const c of parsed.calls || []) liveSaved.add(c.callId);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) });
      }
      if (String(url).endsWith('/token-history')) {
        const parsed = JSON.parse(String(options.body || '{}'));
        liveEvents.push(`liveHistory:${Boolean(parsed.force)}`);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              updatedAt: '2026-11-12 16:00:00',
              summary: { grandTotalTokens: 1400, todayTokens: 1400 },
              dailyMap: { '2026-11-12': { total: 1400, input: 1000, cache: 200, output: 200, steps: 2 } }
            }
          })
        });
      }
      if (String(url).endsWith('/get-settings')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) });
      }
      return baseFetch(url, options);
    };

    // Enqueue >1 MiB item FIRST, 950 KiB 413 item SECOND, and normal items AFTER them!
    const liveBatch = [
      makeRow('huge_live_1', 1, over1MiBLabel),
      makeRow('mid_413_live', 2, mid950KiBLabel),
      makeRow('norm_live_1', 3),
      makeRow('norm_live_2', 4)
    ];
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: liveBatch }) });
    await flushAsync();

    // Normal items MUST drain FIRST without head-of-line blocking, >1 MiB item quarantined immediately, 413 item quarantined on 413!
    assert.deepEqual(Array.from(liveSaved), ['norm_live_1', 'norm_live_2']);
    assert.deepEqual(liveEvents, [
      'liveSaved:norm_live_1,norm_live_2',
      'http413:mid_413_live',
      'liveHistory:true'
    ]);

    // Subsequent poll + tick() with identical rows must NOT re-enqueue quarantined items or spin!
    liveEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: liveBatch }) });
    await flushAsync();
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(liveEvents, [], 'Quarantined oversized items must not retry infinitely on subsequent polls/ticks');

    // Part 2: IPC recordCalls mode rejecting >1 MiB payloads while normal items behind it drain first
    const ipcEvents = [];
    const ipcSaved = new Set();
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      recordCalls: calls => {
        const bytes = Buffer.byteLength(JSON.stringify({ calls }), 'utf8');
        const ids = calls.map(c => c.callId).join(',');
        if (bytes > 1024 * 1024) {
          ipcEvents.push(`ipcRejectOversize:${ids}`);
          return Promise.resolve({ ok: false, error: 'Payload exceeds 1MiB' });
        }
        ipcEvents.push(`ipcSaved:${ids}`);
        for (const c of calls) ipcSaved.add(c.callId);
        return Promise.resolve({ ok: true, changed: true });
      },
      getTokenHistory: force => {
        ipcEvents.push(`ipcHistory:${Boolean(force)}`);
        return Promise.resolve({
          ok: true,
          data: {
            updatedAt: '2026-11-12 16:01:00',
            summary: { grandTotalTokens: 2800, todayTokens: 2800 },
            dailyMap: { '2026-11-12': { total: 2800, input: 2000, cache: 400, output: 400, steps: 4 } }
          }
        });
      }
    };

    const ipcBatch = [
      makeRow('huge_ipc_1', 10, over1MiBLabel),
      makeRow('norm_ipc_1', 11),
      makeRow('norm_ipc_2', 12)
    ];
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcBatch }) });
    await flushAsync();

    assert.deepEqual(Array.from(ipcSaved), ['norm_ipc_1', 'norm_ipc_2']);
    assert.deepEqual(ipcEvents, [
      'ipcSaved:norm_ipc_1,norm_ipc_2',
      'ipcRejectOversize:huge_ipc_1',
      'ipcHistory:true'
    ], 'Normal items drain first; rejected >1 MiB IPC item is quarantined after single attempt');

    // Subsequent poll + tick() makes 0 further recordCalls attempts!
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcBatch }) });
    await flushAsync();
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(ipcEvents, []);

    // Part 3: Transient IPC write failures on >1 MiB records (EBUSY / Promise reject) must NOT be misclassified as oversize — must retry & succeed!
    let transientHugeAttempt = 0;
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      recordCalls: calls => {
        const ids = calls.map(c => c.callId).join(',');
        if (ids === 'huge_ipc_code_limit') {
          ipcEvents.push(`ipcCodeQuarantine:${ids}`);
          return Promise.resolve({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'limit hit' });
        }
        if (ids === 'huge_ipc_transient') {
          transientHugeAttempt++;
          ipcEvents.push(`ipcHugeAttempt#${transientHugeAttempt}:${ids}`);
          if (transientHugeAttempt === 1) {
            return Promise.resolve({ ok: false, error: '保存账本落盘失败: EBUSY' });
          }
          if (transientHugeAttempt === 2) {
            return Promise.reject(new Error('EBUSY: resource busy'));
          }
          for (const c of calls) ipcSaved.add(c.callId);
          return Promise.resolve({ ok: true, changed: true });
        }
        ipcEvents.push(`ipcSaved:${ids}`);
        for (const c of calls) ipcSaved.add(c.callId);
        return Promise.resolve({ ok: true, changed: true });
      }
    };

    // Attempt 1: >1 MiB item fails transiently with EBUSY while normal items behind it still save immediately
    const ipcTransientBatch1 = [
      makeRow('huge_ipc_transient', 20, over1MiBLabel),
      makeRow('norm_ipc_3', 21)
    ];
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcTransientBatch1 }) });
    await flushAsync();

    assert.equal(ipcSaved.has('norm_ipc_3'), true, 'Normal record behind transient >1 MiB item must save immediately');
    assert.equal(ipcSaved.has('huge_ipc_transient'), false);
    assert.deepEqual(ipcEvents, [
      'ipcSaved:norm_ipc_3',
      'ipcHugeAttempt#1:huge_ipc_transient',
      'ipcHistory:true'
    ]);

    // Attempt 2 (+3.5s, with a new normal record norm_ipc_4 arriving): norm_ipc_4 drains first, then >1 MiB retries (#2) and rejects transiently
    ipcEvents.length = 0;
    const ipcTransientBatch2 = [
      makeRow('huge_ipc_transient', 20, over1MiBLabel),
      makeRow('norm_ipc_3', 21),
      makeRow('norm_ipc_4', 22)
    ];
    fakeNow += 3500;
    h.tick();
    // Wait: tick() starts retry #2 immediately if no new normal item arrived yet; verify retry #2 ran, then Poll 2 delivers norm_ipc_4 which drains immediately!
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcTransientBatch2 }) });
    await flushAsync();

    assert.equal(ipcSaved.has('norm_ipc_4'), true, 'New normal record must drain immediately even while >1 MiB item is in retry backoff');
    assert.equal(ipcEvents.includes('ipcHugeAttempt#2:huge_ipc_transient'), true);
    assert.equal(ipcEvents.includes('ipcSaved:norm_ipc_4'), true);

    // Attempt 3 (+3.5s via tick() without needing RPC rows): >1 MiB record retries (#3), succeeds, saves, and refreshes token history!
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [] }) });
    await flushAsync();

    assert.equal(ipcSaved.has('huge_ipc_transient'), true, 'Transiently failing >1 MiB IPC record must NOT be quarantined and must commit on retry');
    assert.deepEqual(ipcEvents, [
      'ipcHugeAttempt#3:huge_ipc_transient',
      'ipcHistory:true'
    ]);

    // Subsequent poll with huge_ipc_transient makes 0 recordCalls (committed in syncedFinalMap), while explicit code:PAYLOAD_TOO_LARGE quarantines in 1 attempt
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow('huge_ipc_transient', 20, over1MiBLabel),
          makeRow('huge_ipc_code_limit', 23, over1MiBLabel)
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(ipcEvents, ['ipcCodeQuarantine:huge_ipc_code_limit']);

    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(ipcEvents, ['ipcHistory:true'], 'The deferred history refresh runs without re-sending either oversized record');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('[P2] renderer watermark re-sends when RPC upgrades provisional date to authoritative date (same-cost cross-month & cross-rate-tier) without transcript log', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-date-upgrade-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 10, 12, 23, 59, 58).getTime(); // 本地 2026-11-12 23:59:58
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.dateSource || 'none'}:${c.costUSD}`).join(',');
      events.push(`recordCalls:${desc}`);
      const res = recordModelCalls(calls, { agDir: tempDir });
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 23:59:59',
          summary: { grandTotalTokens: 405000, todayTokens: 0 },
          dailyMap: { '2026-10-28': { total: 405000, input: 300000, cache: 100000, output: 5000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 首次轮询：RPC 未返回时间，临时打上 2026-11-12（Claude Opus 5.5 费率 $1.32）并写入磁盘账本
    const rowProvisionalNov = {
      stepIndices: [1],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Claude Opus 5.5 (High)',
        usage: { inputTokens: 300000, cacheReadTokens: 100000, outputTokens: 5000, responseId: 'resp_rpc_late_date' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowProvisionalNov] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_rpc_late_date:2026-11-12:provisional:1.32',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_late_date.date, '2026-11-12');
    assert.equal(disk.calls.resp_rpc_late_date.dateIsProvisional, true);

    // 2) 跨零点进入 2026-11-13 00:00:03，但 RPC 仍无真实时间（依然是 provisional）：不得产生跨零点无效重传
    events.length = 0;
    fakeNow = new Date(2026, 10, 13, 0, 0, 3).getTime();
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowProvisionalNov] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仍为临时日期时跨零点轮询不得误触发重复入账');

    // 3) RPC 后补真实日期 2026-10-28（Token 与 $1.32 费用完全相同，且无本地 transcript.jsonl）：渲染层必须识别日期来源提升并重传落盘！
    events.length = 0;
    fakeNow += 3500;
    const rowAuthoritativeOct = {
      ...rowProvisionalNov,
      created_at: '2026-10-28T09:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_rpc_late_date:2026-10-28:created_at:1.32',
      'getTokenHistory:true'
    ], 'RPC 补齐真实日期后必须触发单次重传并刷新历史');
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_late_date.date, '2026-10-28');
    assert.equal(disk.calls.resp_rpc_late_date.dateIsProvisional, false);
    assert.equal(disk.calls.resp_rpc_late_date.costUSD, 1.32);

    // 4) 后续相同轮询稳定零重发
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // 5) 跨调价日回拨（临时 2026-12-02 $1.22 -> RPC 后补真实 2026-11-25 $0.61，费用下降）：同样重传 1 次并将 $0.61 落盘，后续稳定零重发
    events.length = 0;
    fakeNow = new Date(2026, 11, 2, 10, 0, 0).getTime(); // 2026-12-02
    const rowCarbonProvDec = {
      stepIndices: [2],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_rpc_rate_drop' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.tick();
    if (h.scans.length > 1) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonProvDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_rpc_rate_drop:2026-12-02:provisional:1.22',
      'getTokenHistory:true'
    ]);

    events.length = 0;
    fakeNow += 5000;
    const rowCarbonAuthNov = {
      ...rowCarbonProvDec,
      created_at: '2026-11-25T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonAuthNov] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_rpc_rate_drop:2026-11-25:created_at:0.61',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_rate_drop.date, '2026-11-25');
    assert.equal(disk.calls.resp_rpc_rate_drop.costUSD, 0.61);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonAuthNov] }) });
    await flushAsync();
    assert.deepEqual(events, [], '费用随真实日期下调落盘后，后续轮询不得因旧高价水位误判或重发');
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { }
  }
});

test('[P3] provisional Carbon call crossing 11-30 -> 12-01 rate-hike midnight does not trigger spurious cost-growth re-send', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-prov-rate-midnight-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 10, 30, 23, 59, 58).getTime(); // 本地 2026-11-30 23:59:58
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.dateSource || 'none'}:${c.costUSD}`).join(',');
      events.push(`recordCalls:${desc}`);
      const res = recordModelCalls(calls, { agDir: tempDir });
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-30 23:59:59',
          summary: { grandTotalTokens: 360000, todayTokens: 360000 },
          dailyMap: { '2026-11-30': { total: 360000, input: 250000, cache: 100000, output: 10000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 2026-11-30 23:59:58 首次观测无时间戳 Carbon 调用：按 11-30 费率 ($0.61) 记临时日期并落盘
    const rowCarbonProv = {
      stepIndices: [1],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_carbon_prov_midnight' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-11-30:provisional:0.61',
      'getTokenHistory:true'
    ]);
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 2) 跨过 11-30 -> 12-01 调价零点（未锚定时按 12-01 会变成 $1.22）：仍为临时日期且用量未变，不得触发任何重传，面板费用保持 $0.61
    events.length = 0;
    fakeNow = new Date(2026, 11, 1, 0, 0, 3).getTime(); // 本地 2026-12-01 00:00:03
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仍为临时日期跨过 Carbon 调价零点时不得因费率上涨触发无效重传');
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 3) 切换会话清空 sessionCallsMap 后再切回原会话（仍在 12-01）：凭 syncedFinalMap 锚定 11-30 临时日期，依然零重传且会话费用保持 $0.61
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();

    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后仍不得因 12-01 调价触发无效重传');
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 4) 同在 12-01 仍为临时日期时，若真实用量增长（如配比变化 + 输出增至 15k）：必须按锚定的 11-30 费率 ($0.755) 重传更新，而非 12-01 费率
    events.length = 0;
    fakeNow += 3500;
    const rowCarbonProgressedUsage = {
      ...rowCarbonProv,
      chatModel: {
        ...rowCarbonProv.chatModel,
        usage: { inputTokens: 300000, cacheReadTokens: 50000, outputTokens: 15000, responseId: 'resp_carbon_prov_midnight' }
      }
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProgressedUsage] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-11-30:provisional:0.755',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_carbon_prov_midnight.date, '2026-11-30');
    assert.equal(disk.calls.resp_carbon_prov_midnight.costUSD, 0.755);

    // 5) 随后 RPC 补齐真实本地 2026-12-01 时间戳：日期来源升阶 (1 -> 3)，按 12-01 费率 ($1.51) 校准落盘，后续轮询零重发
    events.length = 0;
    fakeNow += 5000;
    const rowCarbonAuthDec = {
      ...rowCarbonProgressedUsage,
      created_at: new realDate(2026, 11, 1, 0, 0, 1).toISOString()
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonAuthDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-12-01:created_at:1.51',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_carbon_prov_midnight.date, '2026-12-01');
    assert.equal(disk.calls.resp_carbon_prov_midnight.dateIsProvisional, false);
    assert.equal(disk.calls.resp_carbon_prov_midnight.costUSD, 1.51);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonAuthDec] }) });
    await flushAsync();
    assert.deepEqual(events, []);
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { }
  }
});

test('[P2] same-rank authoritative created_at revision updates persisted ledger date & costUSD and settles cleanly', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-same-rank-date-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 11, 1, 12, 0, 0).getTime();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const res = recordModelCalls(calls, { agDir: tempDir });
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.costUSD}:changed=${res.changed}`).join(',');
      events.push(`recordCalls:${desc}`);
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase, code: res.code });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-12-01 12:00:00',
          summary: { grandTotalTokens: 360000, todayTokens: 360000 },
          dailyMap: { '2026-12-01': { total: 360000, input: 250000, cache: 100000, output: 10000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 初始权威时间 2026-11-12 入账 ($0.61, sourceRevision: 1)
    const rowNov = {
      stepIndices: [1],
      status: 'final',
      sourceRevision: 1,
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_same_rank_e2e' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNov] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-12:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-11-12');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 0.61);

    // 2) 同等级 created_at 正向修正至 2026-12-01 (sourceRevision: 2, 同用量 360k)：后端返回 changed=true 并更新磁盘为 12-01 / $1.22
    events.length = 0;
    fakeNow += 6000;
    const rowDec = {
      ...rowNov,
      sourceRevision: 2,
      created_at: '2026-12-01T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-12-01:1.22:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 1.22);
    assert.equal(api.snapshot().sessionCostTotal, 1.22);

    // 2b) 新修正 -> 同用量旧包 (rev=1 及无版本旧包) -> 重复旧包（含切路由再切回）：严禁重发或回滚日期/费用
    const rowNovUnversioned = { ...rowNov };
    delete rowNovUnversioned.sourceRevision;
    for (const staleVariant of [rowNov, rowNov, rowNovUnversioned]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [staleVariant] }) });
      await flushAsync();
      assert.deepEqual(events, [], '同用量旧包及重复旧包不得触发重传');
      assert.equal(api.snapshot().sessionCostTotal, 1.22);
    }
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovUnversioned] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后收到同用量旧包依然零重发、零回滚');
    assert.equal(api.snapshot().sessionCostTotal, 1.22);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 1.22);

    // 3) 同等级 created_at 逆向修正回 2026-11-15 (sourceRevision: 3)：双向校准更新磁盘回 2026-11-15 / $0.61，随后迟到 rev=2 零重发
    events.length = 0;
    fakeNow += 6000;
    const rowNovRevised = {
      ...rowNov,
      sourceRevision: 3,
      created_at: '2026-11-15T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-15:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-11-15');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 0.61);
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    for (const staleAfterRev3 of [rowDec, rowDec]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [staleAfterRev3] }) });
      await flushAsync();
      assert.deepEqual(events, [], '逆向校准后迟到的高费率旧修订包不得触发重发');
      assert.equal(api.snapshot().sessionCostTotal, 0.61);
    }

    // 4) 无版本冲突交替场景 ([11-12, 12-01, 11-12, 12-01])：保持首个已确认权威日期，零反复重发
    events.length = 0;
    fakeNow += 6000;
    const rowUnvA = {
      stepIndices: [2],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_unv_alt' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    const rowUnvB = { ...rowUnvA, created_at: '2026-12-01T10:00:00Z' };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_unv_alt:2026-11-12:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    for (const alt of [rowUnvB, rowUnvA, rowUnvB]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, alt] }) });
      await flushAsync();
      assert.deepEqual(events, [], '两版无版本同用量快照交替到达时不得重发震荡');
      assert.equal(api.snapshot().sessionCostTotal, 1.22); // 0.61 + 0.61
    }

    // 5) “总量增加、输出量下降”交叉变化前后端联动：input=100k,out=20k,tot=120k,11-12 ($0.40) -> input=130k,out=10k,tot=140k,12-01 ($0.72)
    fakeNow += 6000;
    const rowCross1 = {
      stepIndices: [3],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 20000, responseId: 'resp_cross_e2e' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    const rowCross2 = {
      ...rowCross1,
      created_at: '2026-12-01T10:00:00Z',
      chatModel: {
        ...rowCross1.chatModel,
        usage: { inputTokens: 130000, cacheReadTokens: 0, outputTokens: 10000, responseId: 'resp_cross_e2e' }
      }
    };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross1] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_cross_e2e:2026-11-12:0.4:changed=true',
      'getTokenHistory:true'
    ]);

    fakeNow += 6000;
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_cross_e2e:2026-12-01:0.72:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_cross_e2e.inputTokens, 130000);
    assert.equal(disk.calls.resp_cross_e2e.outputTokens, 10000);
    assert.equal(disk.calls.resp_cross_e2e.totalTokens, 140000);
    assert.equal(disk.calls.resp_cross_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_cross_e2e.costUSD, 0.72);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 1.94); // 0.61 + 0.61 + 0.72

    // 迟到的旧交叉快照 (120k/20k, 11-12) 到达时零重发，磁盘与面板完全一致
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross1] }) });
    await flushAsync();
    assert.deepEqual(events, []);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_cross_e2e.totalTokens, 140000);
    assert.equal(disk.calls.resp_cross_e2e.outputTokens, 10000);
    assert.equal(disk.calls.resp_cross_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_cross_e2e.costUSD, 0.72);

    // 6a) 仅显式修订号提升 (sourceRevision: 3 -> 4，日期/总量/输出均未变)：提交 1 次更新账本版本，随后零重发
    fakeNow += 6000;
    const rowNovRev4 = { ...rowNovRevised, sourceRevision: 4 };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-15:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.sourceRevision, 4);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仅修订号提升提交确认后，后续相同修订号轮询必须零重发');

    // 6b) 同总量/输出量下输入与缓存重新分配导致费用下降 (rev=1: inp=1M,cap=0,$2.10 -> rev=2: inp=100k,cap=900k,$0.39) 及迟到旧版防护
    fakeNow += 6000;
    const rowSplitRev1 = {
      stepIndices: [4],
      status: 'final',
      sourceRevision: 1,
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 1000000, cacheReadTokens: 0, outputTokens: 10000, responseId: 'resp_split_rebalance' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1048576 } }
      }
    };
    const rowSplitRev2 = {
      ...rowSplitRev1,
      sourceRevision: 2,
      chatModel: {
        ...rowSplitRev1.chatModel,
        usage: { inputTokens: 100000, cacheReadTokens: 900000, outputTokens: 10000, responseId: 'resp_split_rebalance' }
      }
    };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_split_rebalance:2026-11-12:2.1:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 1000000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 0);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 2.1);

    fakeNow += 6000;
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_split_rebalance:2026-11-12:0.39:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 100000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 900000);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 0.39);
    assert.equal(disk.calls.resp_split_rebalance.sourceRevision, 2);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33); // 0.61 + 0.61 + 0.72 + 0.39

    // 迟到的高费用旧版本 rev=1 ($2.10) 在同路由与跨路由切回后均不得覆盖或重发
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, []);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33);

    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后收到同总量高费用旧版本 rev=1 仍不得覆盖或重发');
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 100000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 900000);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 0.39);
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { }
  }
});

test('PR #13 & PR #21: 弹窗动态锚点定位、首帧显示前预设坐标、无缩放/left防抖与繁中术语回归', async () => {
  const pathMod = require('node:path');
  const cssSrc = fs.readFileSync(pathMod.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  // 1. 验证 styles.css 无 .ag-unit:active transform 缩放且 #panel-tokens 无 left transition
  const activeBlock = cssSrc.match(/\.ag-unit:active\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(activeBlock, /transform\s*:\s*scale/i, '.ag-unit:active 不应有按压缩放');
  const tokensRule = cssSrc.match(/#panel-tokens\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(tokensRule, /\bleft\s+\./i, '#panel-tokens 不应对 left 做过渡动画');
  assert.match(cssSrc, /#overflow-menu\s*\{[^}]*box-sizing\s*:\s*border-box/i);

  // 2. 验证每个触发按钮锚点（badge / badge-speed / badge-tokens / badge-quota / overflow）与先定位再显示
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.sandbox.window.innerWidth = 1280;
    h.sandbox.window.innerHeight = 800;
    h.host.getBoundingClientRect = () => ({ left: 820, top: 6, width: 320, height: 28, right: 1140, bottom: 34 });
    h.elements.get('badge').getBoundingClientRect = () => ({ left: 820, top: 6, width: 88, height: 28, right: 908, bottom: 34 });
    h.elements.get('badge-speed').getBoundingClientRect = () => ({ left: 912, top: 6, width: 64, height: 28, right: 976, bottom: 34 });
    h.elements.get('badge-tokens').getBoundingClientRect = () => ({ left: 980, top: 6, width: 68, height: 28, right: 1048, bottom: 34 });
    h.elements.get('badge-quota').getBoundingClientRect = () => ({ left: 1052, top: 6, width: 52, height: 28, right: 1104, bottom: 34 });
    h.elements.get('badge-overflow').getBoundingClientRect = () => ({ left: 1108, top: 6, width: 28, height: 28, right: 1136, bottom: 34 });

    // 验证 showPanel 在 hidden=false 前已将 style.left 写入
    let leftWhenUnhidden = null;
    const panel = h.elements.get('panel');
    let hiddenVal = true;
    Object.defineProperty(panel, 'hidden', {
      get: () => hiddenVal,
      set: (v) => {
        if (v === false) leftWhenUnhidden = panel.style.left;
        hiddenVal = Boolean(v);
      }
    });

    h.elements.get('badge').click();
    assert.ok(leftWhenUnhidden && leftWhenUnhidden !== '', '取消 hidden 前必须已预设 style.left');
    assert.equal(panel.style.left, `${908 - 472}px`);
    assert.equal(h.elements.get('badge').getAttribute('aria-expanded'), 'true');
    assert.equal(h.elements.get('badge-speed').getAttribute('aria-expanded'), 'false');

    h.elements.get('badge-speed').click();
    assert.equal(panel.style.left, `${976 - 472}px`);
    assert.equal(h.elements.get('badge-speed').getAttribute('aria-expanded'), 'true');

    h.elements.get('badge-tokens').click();
    assert.equal(h.elements.get('panel-tokens').style.left, `${1048 - 730}px`);

    h.elements.get('badge-quota').trigger('click', { detail: 0 });
    assert.equal(h.elements.get('panel-quota').style.left, `${1104 - 460}px`);

    // 溢出入口打开 tokens / quota 时必须对齐 badge-overflow 而非隐藏按钮
    h.elements.get('badge-overflow').click();
    assert.equal(h.elements.get('overflow-menu').hidden, false);
    assert.equal(h.elements.get('overflow-menu').style.left, `${1136 - 220}px`);
    h.elements.get('overflow-tokens-btn').click();
    assert.equal(h.elements.get('panel-tokens').style.left, `${1136 - 730}px`);
    h.elements.get('overflow-quota-btn').click();
    assert.equal(h.elements.get('panel-quota').style.left, `${1136 - 460}px`);

    // 窄屏越界钳位
    h.sandbox.window.innerWidth = 600;
    h.host.getBoundingClientRect = () => ({ left: 400, top: 6, width: 180, height: 28, right: 580, bottom: 34 });
    h.elements.get('badge').getBoundingClientRect = () => ({ left: 400, top: 6, width: 60, height: 28, right: 460, bottom: 34 });
    h.elements.get('badge').click();
    assert.equal(panel.style.left, '12px');

    // 3. 验证 PR #21 繁中译文与参数占位符完好
    h.elements.get('btn-top-lang-zh-TW').click();
    await h.flush();
    assert.equal(api.translateForTest('badge.tokens.aria'), 'Token 用量總覽');
    assert.equal(api.translateForTest('colors.btn.restore'), '還原');
    assert.equal(api.translateForTest('diag.auth.tipTitle'), '帳號權限（身分異常）：');
    assert.equal(api.translateForTest('badge.corpus.scanning'), '對話掃描中…');
    assert.equal(api.translateForTest('cost.scopeAll'), '完整歷史紀錄');
  } finally {
    api.dispose();
  }
});

test('Issue #22: applyAppUpdate 在严格模式下不因未声明 currentVer 报错，且按 liveInjected 状态安全刷新版本 UI', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const curVer = pkg.version;
  const escapedVer = curVer.replace(/\./g, '\\.');
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    let mockLiveInjected = false;
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      checkUpdate: async () => ({
        ok: true,
        hasUpdate: true,
        currentVersion: '0.8.3',
        latestVersion: curVer,
        tagName: `v${curVer}`,
        releaseNotes: 'Fix update flow',
        htmlUrl: `https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v${curVer}`
      }),
      applyUpdate: async () => ({
        ok: true,
        version: curVer,
        installedVersion: curVer,
        liveInjected: mockLiveInjected,
        backendHotReloaded: mockLiveInjected
      })
    };

    h.elements.get('btn-check-update').click();
    await h.flush();
    assert.equal(h.elements.get('up-pop-ver').textContent, `v0.8.3 → ${curVer}`);

    h.elements.get('btn-apply-update').click();
    await h.flush();

    assert.equal(h.elements.get('v').textContent, '');
    assert.match(h.elements.get('up-pop-ver').textContent, new RegExp(escapedVer));
    assert.doesNotMatch(h.elements.get('up-pop-status').textContent, /currentVer|异常|失败/i);
    assert.match(h.elements.get('up-pop-status').textContent, new RegExp(escapedVer));

    mockLiveInjected = true;
    h.elements.get('btn-apply-update').click();
    await h.flush();
    assert.equal(h.elements.get('v').textContent, curVer);
  } finally {
    api.dispose();
  }
});

test('ELV-84: 静止浮层避免常驻合成层与冗余模糊，混合 DPI 坐标对齐像素网格并在跨屏变更时重排与清理', async () => {
  // 1. CSS 静态防虚契约断言（构建产物 meter-renderer.js，兼容合法 CSS 多行排版与空白）
  assert.match(source, /font:\s*12px\/1\.4 [^;]*"Microsoft YaHei UI"/, '应优先使用 Microsoft YaHei UI 改善 100% 缩放 ClearType');
  assert.match(source, /\.ag-panel\s*\{[^}]*transform:\s*none;[^}]*\}/, '.ag-panel 静止打开态必须回退到 transform:none');
  assert.doesNotMatch(source, /\.ag-panel\s*\{[^}]*will-change:\s*opacity,\s*transform;/, '.ag-panel 不应常驻 will-change:opacity,transform');
  assert.doesNotMatch(source, /\.ag-panel\s*\{[^}]*contain:\s*layout paint;/, '.ag-panel 不应常驻 contain:layout paint');
  assert.match(source, /#context-tooltip\[data-visible="true"\]\s*\{[^}]*transform:\s*none;/, '悬停气泡可见态应使用 transform:none');
  assert.doesNotMatch(source, /#overflow-menu\s*\{[^}]*will-change:\s*opacity,\s*transform;/, '溢出菜单不应常驻 will-change');
  assert.match(source, /\.ag-dropdown-wrapper\.is-open \.ag-dropdown-menu\s*\{[^}]*transform:\s*none;/, '打开的下拉列表应使用 transform:none');
  assert.doesNotMatch(source, /\.ag-dropdown-menu\s*\{[^}]*backdrop-filter:\s*blur\(24px\)/, '不透明背景的下拉列表不得叠加 backdrop-filter:blur(24px)');
  assert.match(source, /@keyframes agSmoothExpand\s*\{\s*0%\s*\{[^}]*\}\s*100%\s*\{[^}]*transform:\s*none;/, '展开关键帧结束态应使用 transform:none');
  assert.doesNotMatch(source, /animation:\s*agSmoothExpand[^;]*forwards/, '折叠展开动画不得使用 forwards 永久锁定合成层');
  assert.match(source, /\.view-pane-fade\s*\{[^}]*transform:\s*none/, '视图切换容器静止态应使用 transform:none');

  // 2. 运行态设备像素网格对齐与跨屏 DPI change 事件测试
  const ctx = {};
  const winListeners = new Map();
  const mqlListeners = new Map();
  let mqlRemoved = 0;
  const mockHost = {
    style: { setProperty() { }, removeProperty() { }, top: '', right: '', left: '', zIndex: '' },
    setAttribute() { },
    getAttribute() { return null; },
    removeAttribute() { },
    remove() { },
    getBoundingClientRect: () => ({ left: 1210.4, top: 6.3, right: 1410.3, bottom: 34.1, width: 199.9, height: 27.8 }),
    attachShadow() {
      return {
        _innerHTML: '',
        set innerHTML(v) { this._innerHTML = v; },
        get innerHTML() { return this._innerHTML; },
        getElementById: id => {
          if (!mockElements.has(id)) mockElements.set(id, makeEl(id));
          return mockElements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => []
      };
    }
  };
  const makeEl = id => {
    const attrs = new Map([['id', id]]);
    return {
      id,
      hidden: id.startsWith('panel') || id === 'overflow-menu' || id === 'color-picker-popover',
      textContent: '',
      value: '',
      children: [],
      style: { display: '', top: '', left: '', right: '', maxWidth: '', maxHeight: '', transformOrigin: '', setProperty() { }, removeProperty() { } },
      classList: { add() { }, remove() { }, contains() { return false; } },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() { },
      removeEventListener() { },
      replaceChildren() { },
      appendChild() { },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 1300.3, top: 6.2, right: 1410.3, bottom: 34.1, width: 110, height: 27.9 })
    };
  };
  const mockElements = new Map();
  for (const id of ['badge', 'badge-quota', 'badge-tokens', 'badge-overflow', 'panel', 'panel-quota', 'panel-tokens', 'overflow-menu', 'update-popover', 'btn-check-update', 'context-tooltip', 'color-picker-popover', 'v']) {
    mockElements.set(id, makeEl(id));
  }
  const winObj = {
    devicePixelRatio: 1.75,
    innerWidth: 1646,
    innerHeight: 1029,
    addEventListener(type, fn) { winListeners.set(type, fn); },
    removeEventListener(type, fn) { if (winListeners.get(type) === fn) winListeners.delete(type); },
    matchMedia(query) {
      return {
        media: query,
        matches: true,
        addEventListener(type, fn) { if (type === 'change') mqlListeners.set(query, fn); },
        removeEventListener(type, fn) { if (type === 'change' && mqlListeners.get(query) === fn) { mqlListeners.delete(query); mqlRemoved++; } }
      };
    }
  };
  let isFirstCreate = true;
  const docObj = {
    body: { appendChild() { }, children: [] },
    documentElement: { appendChild() { } },
    createElement: () => {
      if (isFirstCreate) {
        isFirstCreate = false;
        return mockHost;
      }
      return makeEl('dyn');
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { },
    removeEventListener() { },
    getElementById: () => null
  };
  Object.assign(ctx, {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    __AGContextMeterCore: core,
    window: Object.assign(winObj, { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } }) } }),
    document: docObj,
    globalThis: null,
    navigator: {},
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval: () => 1,
    clearInterval() { },
    fetch: () => new Promise(() => { }),
    AbortController,
    URL,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Error,
    getComputedStyle: () => ({ color: '', backgroundColor: '' })
  });
  ctx.globalThis = ctx;
  ctx.window.window = winObj;
  vm.runInNewContext(source, ctx);
  try {
    const panel = mockElements.get('panel');
    panel.hidden = false;
    // 1.75x 下验证物理像素对齐：val * 1.75 应为整数
    const top175 = parseFloat(panel.style.top);
    const left175 = parseFloat(panel.style.left);
    assert.ok(Number.isFinite(top175) && Number.isFinite(left175), '175% DPI 下应计算出面板坐标');
    assert.equal(Math.round(top175 * 1.75), top175 * 1.75, '175% DPI 下 top 必须落在物理像素边界上');
    assert.equal(Math.round(left175 * 1.75), left175 * 1.75, '175% DPI 下 left 必须落在物理像素边界上');
    const prevGeomKey = panel._lastPlacedGeomKey;
    assert.match(prevGeomKey, /\|1\.75$/, 'geomKey 应记录当前 dpr');

    // 模拟拖到 1920x1080 @ 100% 屏幕：触发 resolution: 1.75dppx 的 change
    const changeFn = mqlListeners.get('(resolution: 1.75dppx)');
    assert.equal(typeof changeFn, 'function', '应注册当前 DPI 的 matchMedia 监听');
    winObj.devicePixelRatio = 1;
    winObj.innerWidth = 1920;
    winObj.innerHeight = 1080;
    mockElements.get('badge').getBoundingClientRect = () => ({ left: 1700.4, top: 6.2, right: 1810.4, bottom: 34.4, width: 110, height: 28.2 });
    const upPop = mockElements.get('update-popover');
    upPop.style.display = 'block';
    mockElements.get('btn-check-update').getBoundingClientRect = () => ({ left: 1750.3, right: 1790.7, top: 45.2, bottom: 68.6, width: 40.4, height: 23.4 });

    changeFn();
    const top100 = parseFloat(panel.style.top);
    const left100 = parseFloat(panel.style.left);
    assert.equal(Math.floor(top100), top100, '100% DPI 下 top 必须严格取整');
    assert.equal(Math.floor(left100), left100, '100% DPI 下 left 必须严格取整');
    assert.match(panel._lastPlacedGeomKey, /\|1$/, '切换 DPI 后应重算并更新 geomKey');
    assert.equal(Math.floor(parseFloat(upPop.style.top)), parseFloat(upPop.style.top), '100% DPI 下 update-popover top 必须取整');
    assert.equal(Math.floor(parseFloat(upPop.style.right)), parseFloat(upPop.style.right), '100% DPI 下 update-popover right 必须取整');
    assert.equal(typeof mqlListeners.get('(resolution: 1dppx)'), 'function', '变更后应重新订阅新 DPI (1dppx) 的监听');
  } finally {
    ctx.__AGContextMeter.dispose();
    assert.ok(mqlRemoved >= 1, 'dispose() 时必须取消 DPI matchMedia 监听');
  }
});

test('By Model usage view: renders stacked bars, percentages, 7d/30d, variant/cache toggles, and hover tooltip', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayDt = new Date(Date.now() - 86400000);
    const yKey = `${yesterdayDt.getFullYear()}-${String(yesterdayDt.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDt.getDate()).padStart(2, '0')}`;
    const tKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    const modelMetaByKey = {
      'gemini-4-hydrogen:xhigh': { modelKey: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', variantKey: 'gemini-4-hydrogen:xhigh', variantLabel: 'Gemini 4 Hydrogen (XHigh)' },
      'gemini-4-hydrogen:medium': { modelKey: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', variantKey: 'gemini-4-hydrogen:medium', variantLabel: 'Gemini 4 Hydrogen (Medium)' },
      'gemini-4-argon:high': { modelKey: 'gemini-4-argon', modelLabel: 'Gemini 4 Argon', variantKey: 'gemini-4-argon:high', variantLabel: 'Gemini 4 Argon (High)' }
    };

    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      summary: { grandTotalTokens: 1000000, todayTokens: 600000, totalConversations: 4 },
      dailyMap: {
        [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
        [tKey]: { total: 600000, input: 150000, cache: 350000, output: 100000, steps: 6 }
      },
      dailyMapBySource: {
        all: {
          [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
          [tKey]: { total: 600000, input: 150000, cache: 350000, output: 100000, steps: 6 }
        },
        desktop: {
          [tKey]: { total: 200000, input: 50000, cache: 100000, output: 50000, steps: 2 }
        },
        cli: {
          [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
          [tKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 }
        }
      },
      dailyModelMapBySource: {
        all: {
          [yKey]: {
            'gemini-4-hydrogen:medium': { total: 300000, input: 75000, cache: 185000, output: 40000, steps: 3 },
            'gemini-4-argon:high': { total: 100000, input: 25000, cache: 65000, output: 10000, steps: 1 }
          },
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 500000, input: 120000, cache: 300000, output: 80000, steps: 5 },
            __unattributed__: { total: 100000, input: 30000, cache: 50000, output: 20000, steps: 1 }
          }
        },
        desktop: {
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 200000, input: 50000, cache: 100000, output: 50000, steps: 2 }
          }
        },
        cli: {
          [yKey]: {
            'gemini-4-hydrogen:medium': { total: 300000, input: 75000, cache: 185000, output: 40000, steps: 3 },
            'gemini-4-argon:high': { total: 100000, input: 25000, cache: 65000, output: 10000, steps: 1 }
          },
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 300000, input: 70000, cache: 200000, output: 30000, steps: 3 },
            __unattributed__: { total: 100000, input: 30000, cache: 50000, output: 20000, steps: 1 }
          }
        }
      },
      modelMetaByKey
    });

    // Switch to By Model view
    h.sandbox.__AGContextMeter.toggle(true, 'tokens');
    h.elements.get('tok-view-models').click();
    assert.equal(h.elements.get('model-usage-view').style.display, 'block');
    assert.equal(h.elements.get('tokens-main-view').style.display, 'none');
    assert.equal(h.elements.get('cost-estimate-card').style.display, 'none');

    const barsEl = h.elements.get('model-usage-bars');
    const legendEl = h.elements.get('model-usage-legend');
    assert.equal(barsEl.children.length, 7);
    assert.equal(legendEl.children.length, 3); // Hydrogen, Argon, Unattributed
    assert.equal(h.elements.get('model-usage-window-total').textContent, '1.0M Tokens');
    assert.equal(h.elements.get('model-toggle-unattr').style.display, 'inline-flex');

    // Hover today's bar (last column) -> shows heat-pop details
    barsEl.children[6].trigger('mouseenter');
    assert.equal(h.elements.get('heat-pop').style.opacity, '1');
    assert.match(h.elements.get('heat-pop-val').textContent, /600\.0K Tokens/);

    // Switch to variant breakdown
    h.elements.get('model-group-variant').click();
    assert.equal(legendEl.children.length, 4); // XHigh, Medium, Argon High, Unattributed

    // Hide unattributed -> 3 variants and 900.0K total
    h.elements.get('model-toggle-unattr').click();
    assert.equal(legendEl.children.length, 3);
    assert.equal(h.elements.get('model-usage-window-total').textContent, '900.0K Tokens');

    // Switch to 30d and noCache
    h.elements.get('model-period-30d').click();
    assert.equal(barsEl.children.length, 30);
    h.elements.get('model-metric-nocache').click();
    assert.equal(h.elements.get('model-usage-window-total').textContent, '350.0K Tokens');

    // Source switch to desktop
    h.elements.get('src-tab-desktop').click();
    assert.equal(h.elements.get('model-usage-window-total').textContent, '100.0K Tokens');
    assert.equal(legendEl.children.length, 1);

    // Switch back to all sources and verify variant effort shade + dark/light theme color adaptation
    h.elements.get('src-tab-all').click();
    h.sandbox.__AGContextMeter.setTheme('dark');
    assert.equal(legendEl.children[0].children[0].style.background, '#826cc3'); // gemini-4-hydrogen:xhigh shade

    h.elements.get('model-group-model').click();
    h.elements.get('model-metric-total').click();
    h.elements.get('model-toggle-unattr').click(); // show unattributed again
    assert.equal(legendEl.children.length, 3);
    assert.equal(legendEl.children[0].children[0].style.background, '#a78bfa');
    assert.equal(legendEl.children[1].children[0].style.background, '#6366f1');
    assert.equal(legendEl.children[2].children[0].style.background, 'rgba(161, 161, 170, 0.28)');

    h.sandbox.__AGContextMeter.setTheme('light');
    assert.equal(legendEl.children[0].children[0].style.background, '#7c3aed');
    assert.equal(legendEl.children[1].children[0].style.background, '#4f46e5');
    assert.equal(legendEl.children[2].children[0].style.background, 'rgba(113, 113, 122, 0.24)');

    h.sandbox.__AGContextMeter.setTheme('dark');
    assert.equal(legendEl.children[0].children[0].style.background, '#a78bfa');
  } finally {
    api.dispose();
  }
});

test('v0.8.8 顶栏收尾回归: ring-only 保留溢出菜单入口，无菜单栏贴顶时主标题栏右侧自动避让 WCO', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const stylesCssText = fs.readFileSync(path.join(__dirname, 'src/renderer/styles.css'), 'utf8');
  try {
    // 1. ring-only 模式下 CSS 与布局保持溢出按钮与已打开溢出菜单可用
    assert.match(stylesCssText, /:host\(\[data-layout="ring-only"\]\)\s*#badge-overflow\s*\{\s*display:\s*inline-flex\s*!important;/);
    assert.doesNotMatch(stylesCssText, /:host\(\[data-layout="ring-only"\]\)[^}]*#badge-overflow[^}]*display:\s*none/);

    api.setAvailableWidthForTest(90); // minimal
    h.elements.get('badge-overflow').click();
    assert.equal(h.elements.get('overflow-menu').hidden, false);
    assert.equal(api.setAvailableWidthForTest(40), 'ring-only');
    assert.equal(h.elements.get('overflow-menu').hidden, false, '切换到 ring-only 时不得强行关闭溢出菜单');

    // 2. 无独立菜单栏行（titlebar top < 20 且贴窗口最右边）时，自动注入 padding-right 避让原生 138px 窗口控制区
    if (!h.sandbox.document.head) {
      h.sandbox.document.head = h.sandbox.document.createElement();
    }
    h.sandbox.navigator = { platform: 'Win32' };
    h.sandbox.window.innerWidth = 1440;
    h.sandbox.window.outerWidth = 1440;
    const tb = h.sandbox.document.createElement();
    tb.className = 'flex w-full min-w-0 select-none items-center justify-between overflow-hidden @container/titlebar';
    tb.getBoundingClientRect = () => ({ top: 0, left: 256, right: 1440, bottom: 40, width: 1184, height: 40 });
    h.sandbox.document.querySelector = sel => (sel.includes('@container/titlebar') ? tb : null);

    api.syncWindowControlsOverlayForTest();
    const fixEl = h.sandbox.document.getElementById('ag-topbar-host-fix');
    assert.ok(fixEl, '应创建 #ag-topbar-host-fix 样式节点');
    assert.match(fixEl.textContent, /\[class\*="@container\/titlebar"\][\s\S]*padding-right:\s*138px\s*!important/);

    // 3. 当顶部有独立菜单栏行（titlebar top >= 20）时，立即撤销 titlebar padding-right 避让规则
    tb.getBoundingClientRect = () => ({ top: 35, left: 256, right: 1440, bottom: 75, width: 1184, height: 40 });
    api.syncWindowControlsOverlayForTest();
    assert.doesNotMatch(fixEl.textContent, /\[class\*="@container\/titlebar"\]\s*\{\s*padding-right:/);
  } finally {
    api.dispose();
  }
});

test('v0.8.8 chart visual redesign E2E: single 1.82M vs heavy 100..3.64B, cross-tier monotonic invariance, cumulative A+C strip/ruler/lock, stacked bars and theme/narrow', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 为 yearly/cum SVG 提供 createElementNS 与测量追踪能力
  api.switchHeatView('cum');
  api.switchHeatView('yearly');
  api.switchHeatView('daily');
  const origCreateEl = h.sandbox.document.createElement;
  h.sandbox.document.createElementNS = (_ns, tag) => {
    const node = origCreateEl();
    node.tagName = tag;
    return node;
  };

  const scrollBox = h.elements.get('h-scroll-box');
  let mockChartWidth = 670;
  scrollBox.getBoundingClientRect = () => ({ left: 0, top: 0, width: mockChartWidth, height: 120, right: mockChartWidth, bottom: 120 });

  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = `${y}-${pad(m + 1)}-${pad(today.getDate())}`;
  const ymCur = `${y}-${pad(m + 1)}`;

  const findAll = (root, pred) => {
    const out = [];
    const walk = n => {
      if (!n) return;
      if (pred(n)) out.push(n);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(root);
    return out;
  };

  try {
    // 场景 1: 全年单月 1.82M（今天所在月，早先为未启用，未来为虚线）
    const activeDay = `${ymCur}-${pad(Math.min(28, Math.max(1, today.getDate())))}`;
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: activeDay,
      dailyMap: { [activeDay]: { total: 1.82e6, input: 100e3, cache: 1.7e6, output: 20e3 } },
      dailyMapBySource: { all: { [activeDay]: { total: 1.82e6, input: 100e3, cache: 1.7e6, output: 20e3 } } },
      summary: {
        firstUseDate: activeDay,
        grandTotalTokens: 1.82e6,
        totalInputTokens: 100e3,
        totalCacheTokens: 1.7e6,
        totalOutputTokens: 20e3,
        cacheReadStats: {
          cacheStatus: 'hit',
          totalUncachedInput: 100e3,
          totalCacheRead: 1.7e6,
          totalInput: 1.8e6,
          totalOutput: 20e3,
          cacheReadPct: 94.4,
          missingCount: 0
        }
      },
      dailyModelMap: { [activeDay]: { 'gemini-4-hydrogen': { total: 1.82e6, input: 100e3, cache: 1.7e6, output: 20e3, steps: 2 } } },
      dailyModelMapBySource: { all: { [activeDay]: { 'gemini-4-hydrogen': { total: 1.82e6, input: 100e3, cache: 1.7e6, output: 20e3, steps: 2 } } } }
    });

    // 缓存占比条与 API 明细卡微进度条
    const tcbState = api.getTokenCacheBreakdownForTest();
    assert.equal(tcbState.ratio, '94.4%');
    assert.equal(tcbState.ratioBarWidth, '94.4%');
    h.elements.get('tok-view-cost').click();
    assert.match(h.elements.get('ref-cost-output-share').textContent, /%$/);
    h.elements.get('tok-view-tokens').click();

    // 「今年」视图：单月 1.82M 直径 33.64px、无峰值圈、同心参考环、三态区分
    api.switchHeatView('yearly');
    const yearlyBox = h.elements.get('h-yearly-box');
    assert.equal(yearlyBox.getAttribute('data-scale-tier'), '10M');
    const svg = yearlyBox.children[0];
    assert.equal(findAll(svg, n => String(n.className || '').includes('bubble-peak-badge')).length, 0);
    assert.equal(findAll(svg, n => String(n.className || '').includes('yearly-ref-rings')).length, 1);
    const monthGroups = findAll(svg, n => String(n.className || '').includes('heat-yearly-bubble-group'));
    const curCircle182 = findAll(monthGroups[m], n => String(n.className || '').includes('bubble-main'))[0];
    const diam182Single = Number(curCircle182.getAttribute('data-diameter'));
    const color182Single = curCircle182.getAttribute('fill');
    assert.ok(Math.abs(diam182Single - 33.64) < 0.08, `连续分锚点映射下 1.82M 气泡应约 33.64px，实测 ${diam182Single}`);

    // 窄窗 (W=360) 验证：同心参考环不挡月份标签
    mockChartWidth = 360;
    api.switchHeatView('yearly');
    const monthLbls = findAll(h.elements.get('h-yearly-box').children[0], n => String(n.className || '').includes('bubble-month-lbl'));
    assert.ok(Number(monthLbls[11].getAttribute('x')) < 360 - 52);
    mockChartWidth = 670;

    // 场景 2: 同一张图跨 100M -> 1B+ 边界：其他同值月 1.82M 与 100M 的尺寸与颜色绝不缩小！
    const otherMonth = m > 0 ? 0 : 1;
    const mPad = pad(otherMonth + 1);
    const crossDm = {
      [`${y}-${mPad}-05`]: { total: 100e6, input: 10e6, cache: 85e6, output: 5e6 }
    };
    crossDm[activeDay] = { total: 1.82e6, input: 100e3, cache: 1.7e6, output: 20e3 };
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: `${y}-01-01`,
      dailyMap: crossDm,
      dailyMapBySource: { all: crossDm },
      summary: { firstUseDate: `${y}-01-01`, grandTotalTokens: 101.82e6 }
    });
    api.switchHeatView('yearly');
    assert.equal(h.elements.get('h-yearly-box').getAttribute('data-scale-tier'), '100M');
    let mGroupsCross = findAll(h.elements.get('h-yearly-box').children[0], n => String(n.className || '').includes('heat-yearly-bubble-group'));
    const d100M_at100M = Number(findAll(mGroupsCross[otherMonth], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('data-diameter'));
    const c100M_at100M = findAll(mGroupsCross[otherMonth], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('fill');
    assert.equal(d100M_at100M, 49.0);
    // 同值 1.82M 在 100M 包络下与 10M 包络下像素/颜色完全相等
    assert.equal(Number(findAll(mGroupsCross[m], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('data-diameter')), diam182Single);
    assert.equal(findAll(mGroupsCross[m], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('fill'), color182Single);

    // 将 otherMonth 增加到 100M + 1 -> 跨入 1B 包络，此时自身不得缩小且 1.82M 也不得缩小！
    crossDm[`${y}-${mPad}-06`] = { total: 1, input: 1, cache: 0, output: 0 };
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: `${y}-01-01`,
      dailyMap: crossDm,
      dailyMapBySource: { all: crossDm },
      summary: { firstUseDate: `${y}-01-01`, grandTotalTokens: 101.82e6 + 1 }
    });
    api.switchHeatView('yearly');
    assert.equal(h.elements.get('h-yearly-box').getAttribute('data-scale-tier'), '1B');
    mGroupsCross = findAll(h.elements.get('h-yearly-box').children[0], n => String(n.className || '').includes('heat-yearly-bubble-group'));
    const d100M_at1B = Number(findAll(mGroupsCross[otherMonth], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('data-diameter'));
    const c100M_at1B = findAll(mGroupsCross[otherMonth], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('fill');
    assert.ok(d100M_at1B >= d100M_at100M, `100M+1 (${d100M_at1B}) 不得小于 100M (${d100M_at100M})`);
    assert.equal(c100M_at1B, c100M_at100M);
    assert.equal(Number(findAll(mGroupsCross[m], n => String(n.className || '').includes('bubble-main'))[0].getAttribute('data-diameter')), diam182Single);

    // 场景 3: 重做「累计总量」A+C — 30 天 ~4.86B（含 4 个零用量日 + 3 个连续高峰日）
    const d30End = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const d30Start = new Date(d30End.getTime() - 29 * 86400000);
    const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dm30 = {};
    const zeroIdxSet = new Set([4, 13, 19, 20]);
    const peakIdxMap = { 9: 620e6, 10: 710e6, 11: 580e6 };
    let sum30 = 0;
    for (let i = 0; i < 30; i++) {
      const ds = fmtD(new Date(d30Start.getTime() + i * 86400000));
      if (zeroIdxSet.has(i)) continue;
      const val = peakIdxMap[i] || (i >= 7 && i <= 12 ? 220e6 : 100e6);
      sum30 += val;
      dm30[ds] = { total: val, input: Math.round(val * 0.1), cache: Math.round(val * 0.85), output: Math.round(val * 0.05) };
    }
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: fmtD(d30Start),
      dailyMap: dm30,
      dailyMapBySource: { all: dm30 },
      summary: { firstUseDate: fmtD(d30Start), grandTotalTokens: sum30 }
    });
    api.switchHeatView('cum');
    const cumBox = h.elements.get('h-cum-box');
    const byId = id => findAll(cumBox, n => n.id === id)[0];
    const cumState30 = api.getCumulativeViewStateForTest();
    assert.equal(cumState30.summary.totalDays, 30);
    assert.equal(cumState30.summary.activeDays, 26);
    assert.equal(cumState30.summary.zeroDays, 4);
    assert.equal(cumState30.summary.grouping, 'daily');
    assert.equal(h.elements.get('h-sum-tokens-wrap').style.display, 'none', '累计页顶部已显示总量，底部区间合计必须隐藏防重复');
    assert.equal(h.elements.get('h-sum-cost-wrap').style.display, 'none', '累计页顶部已显示参考金额，底部预估费用必须隐藏防重复');
    assert.equal(byId('cum-ruler-marker').getAttribute('data-ruler-status'), 'in_range');
    const stripSegs = byId('cum-strip').children;
    assert.equal(stripSegs.length, 26, '横带仅包含 26 个活跃日，4 个 0 用量日不占宽度');
    const pctTotal = stripSegs.reduce((acc, el) => acc + parseFloat(el.getAttribute('data-width-pct')), 0);
    assert.ok(Math.abs(pctTotal - 100) < 0.02);
    const axisZeroSlots = byId('cum-axis-row').children.filter(el => el.getAttribute('data-zero') === 'true');
    assert.equal(axisZeroSlots.length, 4, '等距日期轴应标出 4 个 0 用量日的 ✕ 标记');
    assert.ok(byId('cum-peak-chips').children.length >= 1);
    assert.match(byId('cum-conclusion-row').textContent, /50%/);

    // 点击锁定某段 -> 出现详情与定位按钮 -> 按 Esc 取消锁定但不关闭面板 -> 再锁定并点击定位「每天」热力图高亮
    const peakKey = cumState30.summary.peakDay.date;
    const peakSegEl = stripSegs.find(el => el.getAttribute('data-cum-key') === peakKey);
    peakSegEl.click();
    assert.equal(api.getCumulativeViewStateForTest().lockedKey, peakKey);
    assert.ok(byId('cum-inspector'));
    api.getCumulativeViewStateForTest().pressEscape();
    assert.equal(api.getCumulativeViewStateForTest().lockedKey, null, 'Esc 应取消累计段锁定');
    // 再次点击锁定并定位到「每天」
    byId('cum-strip').children.find(el => el.getAttribute('data-cum-key') === peakKey).click();
    byId('cum-btn-locate-daily').click();
    assert.equal(api.getActiveHeatView(), 'daily');
    const linkedCell = findAll(h.elements.get('h-grid-cols'), n => n.getAttribute?.('data-date') === peakKey)[0];
    assert.ok(linkedCell && String(linkedCell.className || '').includes('is-cum-linked'), '跳转「每天」后应高亮联动同一天格子');

    // 场景 4: 3 天轻量账号 -> 省略集中度结论，保留峰值与 <10M 量级尺提示，切换清理旧锁定
    const d3Start = new Date(d30End.getTime() - 2 * 86400000);
    const dm3 = {};
    for (let i = 0; i < 3; i++) {
      dm3[fmtD(new Date(d3Start.getTime() + i * 86400000))] = { total: (i + 1) * 5000, input: 1000, cache: 3000, output: 1000 };
    }
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: fmtD(d3Start),
      dailyMap: dm3,
      dailyMapBySource: { all: dm3 },
      summary: { firstUseDate: fmtD(d3Start), grandTotalTokens: 30000 }
    });
    api.switchHeatView('cum');
    const cum3State = api.getCumulativeViewStateForTest();
    assert.equal(cum3State.lockedKey, null, '切换账号数据后应清理失效锁定');
    assert.equal(cum3State.summary.totalDays, 3);
    assert.equal(cum3State.summary.concentration, null);
    assert.equal(byId('cum-ruler-marker').getAttribute('data-ruler-status'), 'below_min');

    // 场景 5: 0 用量空态（避免除零）
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      isAccountSwitched: true,
      firstUseDate: fmtD(d3Start),
      dailyMap: {},
      dailyMapBySource: { all: {} },
      summary: { firstUseDate: fmtD(d3Start), grandTotalTokens: 0 }
    });
    api.switchHeatView('cum');
    assert.ok(byId('cum-empty-state'));
    assert.equal(byId('cum-ruler-marker').getAttribute('data-ruler-status'), 'zero');

    // 场景 6: 超过 90 天 + 历史翻页 + 按周分组展开到日 + 窄窗 + 深浅主题切换
    const d400Start = new Date(d30End.getTime() - 420 * 86400000);
    const dmLong = {};
    for (let i = 0; i <= 420; i += 3) {
      dmLong[fmtD(new Date(d400Start.getTime() + i * 86400000))] = { total: 50e6, input: 5e6, cache: 40e6, output: 5e6 };
    }
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: fmtD(d400Start),
      dailyMap: dmLong,
      dailyMapBySource: { all: dmLong },
      summary: { firstUseDate: fmtD(d400Start), grandTotalTokens: 7e9 }
    });
    api.switchHeatView('cum');
    assert.equal(api.getCumulativeViewStateForTest().summary.grouping, 'weekly');
    // 点击第 1 段周分组并展开日明细
    byId('cum-strip').children[0].click();
    assert.ok(byId('cum-week-days'), '按周分组选中后可展开日明细');
    // 历史翻页：保留历史窗口末日，不强制改成今天
    h.elements.get('h-page-prev').click();
    const pagedCum = api.getCumulativeViewStateForTest().summary;
    assert.ok(pagedCum.endDate < todayStr, `历史翻页区间末日 (${pagedCum.endDate}) 应早于今天 (${todayStr})`);
    // 窄窗模式 & 浅色主题切换
    mockChartWidth = 360;
    api.switchHeatView('cum');
    assert.ok(String(cumBox.children[0].className || '').includes('is-narrow'));
    h.sandbox.__AGContextMeter.setTheme('light');
    assert.equal(h.elements.get('h-cum-box').style.display, 'block');
    h.sandbox.__AGContextMeter.setTheme('dark');
    mockChartWidth = 670;

    // 场景 7: 按模型 100 vs 418.3M -> 跨 500M+ 与 800M 边界柱高单调 + 1.5px 微段保底 & 求和恒等 + 图例折叠与锁定
    const modelDayMap = {};
    for (let k = 0; k < 7; k++) {
      modelDayMap[`series-${k}`] = { total: k === 0 ? 418.3e6 : (k === 1 ? 100 : (7 - k) * 1e6), input: 10, cache: 10, output: 10, steps: 1 };
    }
    const dayMinorKey = fmtD(new Date(today.getTime() - 86400000));
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: fmtD(d3Start),
      dailyMap: dm30,
      dailyMapBySource: { all: dm30 },
      summary: { firstUseDate: fmtD(d3Start), grandTotalTokens: sum30 },
      dailyModelMap: {
        [todayStr]: modelDayMap,
        [dayMinorKey]: { 'series-0': { total: 100, input: 40, cache: 40, output: 20, steps: 1 } }
      },
      dailyModelMapBySource: {
        all: {
          [todayStr]: modelDayMap,
          [dayMinorKey]: { 'series-0': { total: 100, input: 40, cache: 40, output: 20, steps: 1 } }
        }
      }
    });
    h.elements.get('tok-view-models').click();
    const mLegend = h.elements.get('model-usage-legend');
    assert.equal(mLegend.children.length, 6);
    assert.equal(mLegend.children[5].getAttribute('data-series-key'), '__other_series__');

    const mBars = h.elements.get('model-usage-bars');
    const todayStack = mBars.children[mBars.children.length - 1].children[0];
    const todayTotalH = parseFloat(todayStack.getAttribute('data-total-height'));
    const segHeights = todayStack.children.map(seg => parseFloat(seg.style.height));
    assert.ok(Math.abs(segHeights.reduce((a, b) => a + b, 0) - todayTotalH) < 0.01);
    assert.ok(segHeights.every(sh => sh >= 1.49));

    const minorBarH_mixed = parseFloat(mBars.children[mBars.children.length - 2].children[0].getAttribute('data-total-height'));
    h.elements.get('model-scale-linear').click();
    const minorBarH_linear = parseFloat(mBars.children[mBars.children.length - 2].children[0].getAttribute('data-total-height'));
    assert.ok(minorBarH_mixed > minorBarH_linear + 5);
    h.elements.get('model-scale-mixed').click();

    const targetLegendKey = mLegend.children[1].getAttribute('data-series-key');
    mLegend.children[1].click();
    assert.equal(api.getModelUsageScaleForTest().lockedKey, targetLegendKey);
    assert.equal(mBars.children[mBars.children.length - 1].children[0].children[0].getAttribute('data-series-key'), targetLegendKey);

    // 场景 8: 累计页容器不被 height:105px 或 overflow-y:hidden 裁切，切回其他页正确还原
    const stylesSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
    assert.ok(!/#h-cum-box\s*\{[^}]*height\s*:\s*105px/i.test(stylesSrc), '#h-cum-box 不得存在 height:105px 覆盖规则');
    assert.ok(/\.heat-scroll-box\.is-cum-active\s*\{\s*overflow\s*:\s*visible\s*\}/i.test(stylesSrc), '缺少 .heat-scroll-box.is-cum-active{overflow:visible}');
    api.switchHeatView('cum');
    assert.ok(String(h.elements.get('h-scroll-box').className || '').includes('is-cum-active'));
    api.switchHeatView('daily');
    assert.ok(!String(h.elements.get('h-scroll-box').className || '').includes('is-cum-active'));
  } finally {
    api.dispose();
  }
});

test('当前权威版本展示与预发布更新比较隔离', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const curVer = pkg.version;
  const escapedVer = curVer.replace(/\./g, '\\.');
  assert.equal(pkg.displayVersion, curVer);

  // 1. 默认构建模板中 #v 与 #up-pop-ver 均为权威版本，且 beta 通道开关默认未勾选
  const builtCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(builtCode, new RegExp(`<span id="v"[^>]*>${escapedVer}<\\/span>`));
  assert.match(builtCode, new RegExp(`<span id="up-pop-ver"[^>]*>${escapedVer}<\\/span>`));
  assert.equal(builtCode.includes('id="check-allow-beta-updates"'), true);

  // 2. 当前版本 vs 当前版本 判为已是最新
  {
    const h = harness();
    const api = h.sandbox.__AGContextMeter;
    assert.equal(h.elements.get('check-allow-beta-updates').checked, false);
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      checkUpdate: async (req) => {
        assert.equal(req.currentVersion, curVer);
        assert.equal(req.allowBetaUpdates, false);
        return { ok: true, hasUpdate: false, currentVersion: curVer, installedVersion: curVer };
      }
    };
    try {
      await api.checkUpdate(true);
      await h.flush();
      assert.equal(h.elements.get('up-pop-ver').textContent, `${curVer} (已是最新)`);
      assert.match(h.elements.get('up-pop-body').textContent, new RegExp(escapedVer));
    } finally {
      api.dispose();
    }
  }

  // 3. 预发布展示格式，以及开启 beta 通道开关持久化
  {
    const savedPayloads = [];
    const h = harness();
    const api = h.sandbox.__AGContextMeter;
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      saveSettings: async (payload) => {
        savedPayloads.push(payload);
        return { ok: true };
      },
      checkUpdate: async (req) => {
        assert.equal(req.currentVersion, curVer);
        assert.equal(req.allowBetaUpdates, true);
        return { ok: true, hasUpdate: true, currentVersion: curVer, latestVersion: `${curVer}-beta.2`, releaseNotes: `v${curVer}-beta.2` };
      }
    };
    const chkBeta = h.elements.get('check-allow-beta-updates');
    chkBeta.checked = true;
    chkBeta.trigger('change', { target: chkBeta });
    await h.flush();
    assert.equal(savedPayloads.some(p => p.allowBetaUpdates === true), true);

    try {
      await api.checkUpdate(true);
      await h.flush();
      assert.equal(h.elements.get('up-pop-ver').textContent, `${curVer} → ${curVer} beta2`);
      assert.match(h.elements.get('up-pop-body').textContent, new RegExp(`v${escapedVer}`));
      assert.equal(h.elements.get('btn-apply-update').style.display, 'inline-block');
    } finally {
      api.dispose();
    }
  }
});

test('i18n completeness: all static t()/data-i18n keys and known dynamic keys exist in zh-CN/zh-TW/en', () => {
  const vm = require('node:vm');
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(`${i18nSrc}\nthis.__I18N = PANEL_I18N;`, ctx);
  const dict = ctx.__I18N;
  const langs = ['zh-CN', 'zh-TW', 'en'];

  const files = ['main.js', 'heatmap.js', 'colors.js', 'dropdown.js', 'context-budget-engine.js', 'template.html'];
  const staticKeys = new Set();
  const reT = /\bt\(\s*'([^']+)'/g;
  const reAttr = /data-i18n(?:-title|-aria|-placeholder|-html)?="([^"]+)"/g;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, 'src', 'renderer', rel), 'utf8');
    let m;
    while ((m = reT.exec(src))) staticKeys.add(m[1]);
    while ((m = reAttr.exec(src))) staticKeys.add(m[1]);
  }

  // 补充扫描到的动态模板键值
  for (let i = 0; i <= 4; i++) {
    ['desc', 'keeps', 'clears', 'replaces', 'meaning'].forEach(p => staticKeys.add(`enhance.tier.${i}.${p}`));
    if (i >= 1) staticKeys.add(`enhance.tier.${i}.short`);
  }
  ['exhausted', 'no_permission', 'error', 'stale', 'unknown'].forEach(s => staticKeys.add(`quota.short.${s}`));
  ['disabled', 'watching', 'pending_debounce', 'waiting_idle', 'cooldown', 'switching', 'all_candidates_exhausted', 'blocked_untrusted_quota', 'error'].forEach(s => staticKeys.add(`accounts.status.${s}`));
  ['account_switched', 'quota_reset', 'rolling_recovery', 'sampling_gap'].forEach(s => staticKeys.add(`quota.split.${s}`));
  for (let i = 0; i <= 4; i++) staticKeys.add(`colors.lvl${i}`);

  const missing = [];
  for (const key of staticKeys) {
    const entry = dict[key];
    for (const lang of langs) {
      if (!entry || typeof entry[lang] !== 'string' || !entry[lang].trim()) {
        missing.push(`${key}:${lang}`);
      }
    }
  }
  assert.deepEqual(missing, [], `发现缺失的 i18n 词条: ${missing.join(', ')}`);
  assert.equal(dict['tokens.cum.zeroDayBadge']['zh-CN'], '0 用量');
  assert.equal(dict['tokens.cum.zeroDayBadge']['en'], '0 Tokens');
  assert.equal(dict['models.btnRestartHost']['en'], 'Restart Client');
});

test('cumulative ResizeObserver auto-toggles is-narrow across 460px threshold without redundant rerenders and disconnects on dispose', () => {
  const observerInstances = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe(target) { this.observed.push(target); }
    disconnect() { this.disconnected = true; }
    trigger() { if (!this.disconnected) this.cb([]); }
  }

  const h = harness(session(), { ResizeObserver: MockResizeObserver });
  const api = h.sandbox.__AGContextMeter;
  const origCreateEl = h.sandbox.document.createElement;
  h.sandbox.document.createElementNS = (_ns, tag) => {
    const node = origCreateEl();
    node.tagName = tag;
    return node;
  };

  let mockWidth = 670;
  const scrollBox = h.elements.get('h-scroll-box');
  const panelTokens = h.elements.get('panel-tokens');
  scrollBox.getBoundingClientRect = () => ({ left: 0, top: 0, width: mockWidth, height: 120, right: mockWidth, bottom: 120 });
  panelTokens.getBoundingClientRect = () => ({ left: 0, top: 0, width: mockWidth + 56, height: 420, right: mockWidth + 56, bottom: 420 });

  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const d0 = fmt(today);
  const d1 = fmt(new Date(today.getTime() - 86400000));
  const dm = {
    [d1]: { total: 10e6, input: 1e6, cache: 8e6, output: 1e6 },
    [d0]: { total: 20e6, input: 2e6, cache: 16e6, output: 2e6 }
  };

  try {
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      firstUseDate: d1,
      dailyMap: dm,
      dailyMapBySource: { all: dm },
      summary: { firstUseDate: d1, grandTotalTokens: 30e6 }
    });
    api.switchHeatView('cum');

    const cumBox = h.elements.get('h-cum-box');
    const panelObserver = observerInstances.find(inst => inst.observed.includes(panelTokens));
    assert.ok(panelObserver, '#panel-tokens 必须被 ResizeObserver 监听');

    const rootWide1 = cumBox.children[0];
    assert.equal(String(rootWide1.className || '').includes('is-narrow'), false);

    // 仍在 >=460px 同一侧收缩，不应触发冗余重绘（DOM 根节点引用不变）
    mockWidth = 520;
    panelObserver.trigger();
    assert.equal(cumBox.children[0], rootWide1);

    // 跨过 460px 阈值降至 360px：自动重绘并加上 .is-narrow
    mockWidth = 360;
    panelObserver.trigger();
    const rootNarrow = cumBox.children[0];
    assert.notEqual(rootNarrow, rootWide1);
    assert.ok(String(rootNarrow.className || '').includes('is-narrow'));

    // 再从 360px 恢复至 670px：自动重绘并移除 .is-narrow
    mockWidth = 670;
    panelObserver.trigger();
    const rootWide2 = cumBox.children[0];
    assert.notEqual(rootWide2, rootNarrow);
    assert.equal(String(rootWide2.className || '').includes('is-narrow'), false);

    api.dispose();
    assert.equal(panelObserver.disconnected, true, 'dispose 时必须断开 panelTokensResizeObserver');
  } finally {
    try { api.dispose(); } catch { }
  }
});

function htmlAwareRendererHarness(extraSandbox = null) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  let shadowRootNode = null;

  const makeEl = (tagName = 'div') => {
    const attrs = new Map();
    const props = new Map();
    let _innerHTML = '';
    const el = {
      tagName: String(tagName).toUpperCase(),
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      get options() {
        return this.children.filter(c => String(c.tagName).toUpperCase() === 'OPTION');
      },
      get selectedOptions() {
        return this.options.filter(o => o.value === this.value);
      },
      get innerHTML() { return _innerHTML; },
      set innerHTML(v) {
        _innerHTML = String(v || '');
        if (!shadowRootNode || this !== shadowRootNode) return;
        const bodyHtml = _innerHTML
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '');
        const VOID_TAGS = new Set(['INPUT', 'BR', 'HR', 'IMG', 'META', 'LINK', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON']);
        const stack = [shadowRootNode];
        const tokRe = /<(\/?)([a-zA-Z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>|([^<]+)/g;
        let m;
        while ((m = tokRe.exec(bodyHtml))) {
          if (m[5] !== undefined) {
            const txt = m[5].replace(/\s+/g, ' ');
            const curParent = stack[stack.length - 1];
            if (txt.trim() && curParent && !curParent.children.length) {
              curParent.textContent = (curParent.textContent ? curParent.textContent + ' ' : '') + txt.trim();
            } else if (txt.trim() && curParent) {
              curParent.textContent = (curParent.textContent ? curParent.textContent + ' ' : '') + txt.trim();
            }
            continue;
          }
          const isClose = m[1] === '/';
          const tName = m[2].toUpperCase();
          const attrStr = m[3] || '';
          const selfClose = m[4] === '/' || VOID_TAGS.has(tName);
          if (isClose) {
            while (stack.length > 1) {
              const popped = stack.pop();
              if (popped.tagName === tName) break;
            }
            continue;
          }
          const node = makeEl(tName);
          const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
          let am;
          while ((am = attrRe.exec(attrStr))) {
            const ak = am[1];
            const av = am[2] ?? am[3] ?? am[4] ?? '';
            node.setAttribute(ak, av);
            if (ak === 'value') node.value = av;
            if (ak === 'hidden') node.hidden = true;
            if (ak === 'disabled') node.disabled = true;
            if (ak === 'style') {
              const dispMatch = /display\s*:\s*([^;]+)/i.exec(av);
              if (dispMatch) node.style.display = dispMatch[1].trim();
            }
          }
          const parent = stack[stack.length - 1];
          parent.appendChild(node);
          if (node.id) elements.set(node.id, node);
          if (!selfClose) stack.push(node);
        }
      },
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) { docElements.set(String(v), el); elements.set(String(v), el); } },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', cur.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, []);
        listeners.get(el).push({ type, fn });
      },
      dispatchEvent(ev) {
        const type = ev?.type || ev;
        const handlers = listeners.get(el) || [];
        for (const h of handlers) {
          if (h.type === type) h.fn({ target: el, ...ev });
        }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) { docElements.set(String(v), el); elements.set(String(v), el); }
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      closest(sel) {
        const cl = String(sel || '').replace(/^\./, '');
        let cur = this;
        while (cur) {
          if (cur.classList?.contains?.(cl)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      appendChild(x) {
        if (x) {
          x.parentElement = this;
          this.children.push(x);
          const xId = x.id || x.getAttribute?.('id');
          if (xId) { docElements.set(xId, x); elements.set(xId, x); }
        }
      },
      insertBefore(x, ref) {
        if (!x) return;
        x.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, x);
        else this.children.push(x);
        const xId = x.id || x.getAttribute?.('id');
        if (xId) { docElements.set(xId, x); elements.set(xId, x); }
      },
      replaceChildren(...nodes) {
        this.children = [];
        for (const n of nodes) this.appendChild(n);
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          if (!n || n === this) {
            for (const c of (n?.children || [])) walk(c);
            return;
          }
          let ok = false;
          if (sel.startsWith('[') && sel.endsWith(']')) {
            const inner = sel.slice(1, -1);
            const eq = inner.indexOf('=');
            if (eq > 0) {
              const ak = inner.slice(0, eq).trim();
              const av = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
              ok = n.getAttribute?.(ak) === av;
            } else {
              ok = n.getAttribute?.(inner) !== null;
            }
          } else if (sel.startsWith('.')) {
            const parts = sel.split('.').filter(Boolean);
            ok = parts.every(p => n.classList?.contains?.(p));
          } else if (sel.startsWith('#')) {
            ok = n.id === sel.slice(1);
          } else if (/^input\[type="date"\]$/i.test(sel)) {
            ok = n.tagName === 'INPUT' && n.getAttribute?.('type') === 'date';
          } else {
            ok = n.tagName === sel.toUpperCase();
          }
          if (ok) res.push(n);
          for (const c of (n.children || [])) walk(c);
        };
        walk(this);
        return res;
      },
      click() {
        const handlers = listeners.get(el) || [];
        for (const h of handlers) {
          if (h.type === 'click') h.fn({ target: el, stopPropagation() { } });
        }
      },
      trigger(type, ev = {}) {
        const handlers = listeners.get(el) || [];
        for (const h of handlers) {
          if (h.type === type) h.fn({ target: el, preventDefault() { }, stopPropagation() { }, ...ev });
        }
      },
      getBoundingClientRect() { return { left: 100, top: 100, width: 120, height: 26, right: 220, bottom: 126 }; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i >= 0 ? (this.parentElement.children[i + 1] || null) : null;
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const i = this.parentElement.children.indexOf(this);
          if (i >= 0) this.parentElement.children.splice(i, 1);
        }
      }
    };
    return el;
  };

  const host = makeEl('div');
  host.attachShadow = () => {
    shadowRootNode = makeEl('shadow-root');
    shadowRootNode.getElementById = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl('div'));
      return elements.get(id);
    };
    return shadowRootNode;
  };

  const savedSettings = [];
  const docListeners = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      head: makeEl('head'),
      body: makeEl('body'),
      createElement: (tag) => makeEl(tag || 'div'),
      createElementNS: (_ns, tag) => makeEl(tag || 'svg'),
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener(type, fn) { docListeners.push({ type, fn }); },
      removeEventListener() { },
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      innerWidth: 1000,
      innerHeight: 800,
      contextMeterAPI: {
        scan: () => Promise.resolve(null),
        saveSettings: async (payload) => { savedSettings.push(payload); return { ok: true, settings: payload }; },
        getSettings: async () => ({}),
        checkUpdate: async () => ({ ok: true, currentVersion: '0.8.8', latestVersion: '0.8.8', hasUpdate: false, tagName: 'v0.8.8' })
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval: () => 1,
    clearInterval() { },
    fetch: () => new Promise(() => { }),
    ...(extraSandbox && typeof extraSandbox === 'object' ? extraSandbox : {})
  };
  let first = true;
  sandbox.document.createElement = (tag) => { if (first) { first = false; return host; } return makeEl(tag || 'div'); };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, host, get shadow() { return shadowRootNode; }, elements, savedSettings };
}

test('v0.8.8 英文界面完整去汉字回归、地区预设自动转换与零 native input[type="date"] 门禁', async () => {
  const h = htmlAwareRendererHarness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const today = new Date();
    const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const d0 = `${ym}-10`;
    const d1 = `${ym}-09`;
    const oldDates = [];
    for (let i = 100; i >= 1; i--) {
      const dt = new Date(today.getTime() - i * 86400000);
      oldDates.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
    }
    const dm = {
      [d1]: { total: 40e6, input: 10e6, cache: 25e6, output: 5e6, costUSD: 20.5 },
      [d0]: { total: 80e6, input: 20e6, cache: 50e6, output: 10e6, costUSD: 40.0 }
    };
    dm[oldDates[0]] = { total: 5e6, input: 1e6, cache: 3e6, output: 1e6, costUSD: 2.0 };

    // 1. 先在简体中文环境下注入完整真实场景数据并打开各主要子面板/自定义表单/日期选择器
    await api.setPanelLanguage('zh-CN', { persist: false });
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      currentPeriod: { key: ym, periodType: 'calendar_month', label: ym, isCurrentMonth: true },
      firstUseDate: oldDates[0],
      dailyMap: dm,
      dailyMapBySource: { all: dm },
      summary: {
        firstUseDate: oldDates[0],
        grandTotalTokens: 125e6,
        totalInputTokens: 31e6,
        totalCacheTokens: 78e6,
        totalOutputTokens: 16e6,
        monthTokens: 120e6,
        currentMonthInput: 30e6,
        currentMonthCache: 75e6,
        currentMonthOutput: 15e6,
        todayTokens: 80e6
      },
      planStatus: {
        tierKey: 'pro',
        tierName: 'Google AI Pro',
        email: 'elvis@example.com',
        country: '美国 (US)',
        countrySource: 'custom',
        region: '美国 (USD)',
        subscriptionRegion: '美国 (USD)',
        regionSource: 'custom',
        currency: 'USD',
        currencySymbol: '$',
        actualPricePaid: 19.99,
        billingCycle: '月付',
        validEndDate: `${ym}-28`,
        acquisitionSource: 'normal_paid',
        acquisitionSourceName: '正常付费订阅',
        priceMode: 'preset',
        priceSource: 'preset_region'
      },
      byModel: {
        'gemini-3.8-flash': { modelLabel: 'Gemini 3.8 Flash', totalTokens: 80e6, inputTokens: 20e6, cacheTokens: 50e6, outputTokens: 10e6, requestCount: 12 },
        'claude-opus-4-7': { modelLabel: 'Claude Opus 4.7', totalTokens: 45e6, inputTokens: 11e6, cacheTokens: 28e6, outputTokens: 6e6, requestCount: 8 }
      }
    });

    h.elements.get('badge-tokens').click();
    h.elements.get('tok-view-models').click();
    h.elements.get('tok-view-tokens').click();
    h.elements.get('tok-view-cost').click();
    h.elements.get('btn-plan-detail-toggle').click();
    h.elements.get('btn-edit-plan-custom').click();
    h.elements.get('valid-end-trigger').click();
    api.switchHeatView('cum');

    // 2. 切换为英文（en），验证所有可见节点与控件值、提示属性零汉字残留
    await api.setPanelLanguage('en', { persist: false });

    assert.equal(h.shadow.querySelectorAll('input[type="date"]').length, 0, '不允许存在原生 input[type="date"]');
    assert.equal(h.elements.get('input-custom-country').value, 'US United States');
    assert.equal(h.elements.get('input-custom-region').value, 'USD United States');
    assert.equal(h.elements.get('cost-period-tag').textContent, `${ym} (Calendar Month)`);
    assert.doesNotMatch(h.elements.get('cost-scope-desc').textContent, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(h.elements.get('plan-summary-price-val').textContent, /[\u4e00-\u9fff]/);
    assert.equal(h.elements.get('plan-summary-price-cny').textContent, '', 'en 下默认 USD 订阅不显示人民币换算');
    assert.doesNotMatch(h.elements.get('p-det-price').textContent, /CNY|¥/);

    const leaks = [];
    const ALLOWED_SWITCHER_IDS = new Set(['btn-top-lang-zh-CN', 'btn-top-lang-zh-TW', 'btn-lang-zh-CN', 'btn-lang-zh-TW', 'btn-ctx-lang-zh-CN', 'btn-ctx-lang-zh-TW']);
    const isInsideHiddenOrOption = (node) => {
      if (node.tagName === 'OPTION') return true;
      let cur = node;
      while (cur) {
        if (cur.style?.display === 'none' || cur.hidden) return true;
        if (ALLOWED_SWITCHER_IDS.has(cur.id)) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const walkShadow = (node) => {
      if (!node) return;
      if (isInsideHiddenOrOption(node)) return;
      const fields = [
        ['textContent', node.textContent],
        ['value', node.value],
        ['title', node.getAttribute?.('title')],
        ['placeholder', node.getAttribute?.('placeholder')],
        ['aria-label', node.getAttribute?.('aria-label')]
      ];
      for (const [fName, val] of fields) {
        if (typeof val === 'string' && /[\u4e00-\u9fff]/.test(val)) {
          leaks.push({ id: node.id || node.className || node.tagName, field: fName, val });
        }
      }
      for (const child of (node.children || [])) walkShadow(child);
    };
    // 将主看板全部设为可见以便全量遍历
    h.elements.get('panel-tokens').style.display = 'flex';
    h.elements.get('plan-detail-card').style.display = 'block';
    h.elements.get('plan-custom-form').style.display = 'block';
    h.elements.get('valid-end-popover').style.display = 'block';
    h.elements.get('cost-details-pane').style.display = 'block';
    walkShadow(h.shadow);
    assert.deepEqual(leaks, [], `en 模式下发现汉字泄露: ${JSON.stringify(leaks, null, 2)}`);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('v0.8.8 三语货币参考规则（en 纯 USD / zh-CN USD+CNY / zh-TW 四币种且零简体）与自定义日期选择器全流程', async () => {
  const h = htmlAwareRendererHarness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const today = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const todayYmd = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    const ym = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
    const d0 = `${ym}-${pad2(Math.max(1, today.getDate()))}`;
    const dm = { [d0]: { total: 50e6, input: 10e6, cache: 35e6, output: 5e6, costUSD: 100.0 } };

    const basePayload = {
      schemaVersion: '0.8.5',
      currentPeriod: { key: ym, periodType: 'calendar_month', label: ym, isCurrentMonth: true },
      firstUseDate: d0,
      dailyMap: dm,
      dailyMapBySource: { all: dm },
      summary: {
        firstUseDate: d0,
        grandTotalTokens: 50e6,
        totalInputTokens: 10e6,
        totalCacheTokens: 35e6,
        totalOutputTokens: 5e6,
        monthTokens: 50e6,
        currentMonthInput: 10e6,
        currentMonthCache: 35e6,
        currentMonthOutput: 5e6,
        todayTokens: 50e6
      },
      planStatus: {
        tierKey: 'pro',
        tierName: 'Google AI Pro',
        country: '美国 (US)',
        region: '美国 (USD)',
        currency: 'USD',
        currencySymbol: '$',
        actualPricePaid: 19.99,
        billingCycle: '月付',
        priceMode: 'custom',
        priceSource: 'custom'
      }
    };

    // A. en: 纯 USD，绝无 ¥ / CNY；非 USD 订阅展示 approx. $... USD
    await api.setPanelLanguage('en', { persist: false });
    api.applyTokenHistoryPayload(basePayload);
    h.elements.get('tok-view-cost').click();
    assert.doesNotMatch(h.elements.get('t-total-cost').textContent, /¥|CNY/);
    assert.doesNotMatch(h.elements.get('t-today-cost').textContent, /¥|CNY/);
    assert.doesNotMatch(h.elements.get('t-month-cost').textContent, /¥|CNY/);
    assert.doesNotMatch(h.elements.get('t-year-cost').textContent, /¥|CNY/);
    assert.doesNotMatch(h.elements.get('cost-grand-val').textContent, /¥|CNY/);
    assert.equal(h.elements.get('plan-summary-price-cny').textContent, '');

    api.applyTokenHistoryPayload({
      ...basePayload,
      planStatus: { ...basePayload.planStatus, region: '日本 (JPY)', currency: 'JPY', currencySymbol: '¥', actualPricePaid: 2900 }
    });
    assert.match(h.elements.get('plan-summary-price-cny').textContent, /approx\. \$\d+\.\d{2} USD/);

    // B. zh-CN: USD + CNY (¥)
    await api.setPanelLanguage('zh-CN', { persist: false });
    api.applyTokenHistoryPayload(basePayload);
    assert.match(h.elements.get('t-total-cost').textContent, /≈ \$.*\(¥/);
    assert.match(h.elements.get('p-det-price').textContent, /¥[\d.]+ CNY/);

    // C. zh-TW: 紧凑卡片 USD + HK$/NT$；详情四币种 USD/HKD/TWD/CNY；地区转繁体且零简体字
    await api.setPanelLanguage('zh-TW', { persist: false });
    api.applyTokenHistoryPayload(basePayload);
    assert.match(h.elements.get('t-total-cost').textContent, /HK\$[\d.]+.*NT\$[\d.]+/);
    assert.match(h.elements.get('cost-grand-val').textContent, /HK\$.*NT\$.*¥[\d.]+ CNY/);
    assert.match(h.elements.get('cost-sub-line').textContent, /HK\$.*NT\$.*¥[\d.]+ CNY/);

    h.elements.get('btn-plan-detail-toggle').click();
    h.elements.get('btn-edit-plan-custom').click();
    assert.equal(h.elements.get('input-custom-country').value, 'US 美國');
    assert.equal(h.elements.get('input-custom-region').value, 'USD 美國');

    // 扫描 PANEL_I18N zh-TW 全字典不含明确简体专属字
    const simpOnlyRe = /[国韩亚欧乌罗马联东陆区宾兰达尔义书买云亿仅从仓优会体佣储兑划创删剂剑劝办务动励劳势协单卖卫却压厌双变叠叶号叹启员响哑唤严丰临举么乐习乡乱亏亚产亲们价众伙伞伟传伤伦伪侣侦侧侨俩仓个倾偿催傲傻]/;
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
    const iCtx = {};
    vm.runInNewContext(`${i18nSrc}\nthis.__I18N = PANEL_I18N;`, iCtx);
    const twSimpHits = [];
    for (const [k, v] of Object.entries(iCtx.__I18N)) {
      if (typeof v['zh-TW'] === 'string' && simpOnlyRe.test(v['zh-TW'])) {
        twSimpHits.push(`${k}: ${v['zh-TW']}`);
      }
    }
    assert.deepEqual(twSimpHits, [], `zh-TW 字典存在简体字: ${twSimpHits.join('; ')}`);

    // D. 自定义日期选择器全流程：英文表头、选日、清空、今天、保存持久化
    await api.setPanelLanguage('en', { persist: false });
    const dpTrigger = h.elements.get('valid-end-trigger');
    const dpPopover = h.elements.get('valid-end-popover');
    const dpHidden = h.elements.get('input-valid-end');
    const dpLabel = h.elements.get('valid-end-label');

    dpTrigger.click();
    assert.equal(dpPopover.style.display, 'block');
    const wkTexts = dpPopover.querySelectorAll('.ag-dp-weekday').map(n => n.textContent);
    assert.deepEqual(wkTexts, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);

    const targetCell = dpPopover.querySelectorAll('.ag-dp-day').find(b => b.getAttribute('data-date') === d0);
    assert.ok(targetCell, `应存在日期格 ${d0}`);
    targetCell.click();
    assert.equal(dpHidden.value, d0);
    assert.equal(dpLabel.textContent, d0);
    assert.equal(dpPopover.style.display, 'none');

    // 重新打开点 Clear
    dpTrigger.click();
    dpPopover.querySelector('[data-dp-action="clear"]').click();
    assert.equal(dpHidden.value, '');
    assert.equal(dpLabel.textContent, 'YYYY-MM-DD');

    // 重新打开点 Today 并保存
    dpTrigger.click();
    dpPopover.querySelector('[data-dp-action="today"]').click();
    assert.equal(dpHidden.value, todayYmd);
    assert.equal(dpLabel.textContent, todayYmd);

    h.elements.get('btn-custom-plan-save').click();
    const lastSave = h.savedSettings[h.savedSettings.length - 1];
    assert.equal(lastSave?.customPlan?.validEndDate, todayYmd);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('v0.8.9 UI 精简 4 项实装: 标题栏/卡片瘦身、ELV-94 五态停靠、Issue #41 额度窗口四态、ELV-93 纯 SVG 等待沙漏', async () => {
  const tpl = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  // 1. 面板瘦身结构断言
  assert.equal(tpl.includes('id="ctx-compact-card"'), false, '应移除独立 #ctx-compact-card 并合并入 #key-summary 头部胶囊');
  assert.equal(tpl.includes('id="speed-active-test-note"'), false, '应移除 #speed-active-test-note');
  assert.equal(tpl.includes('id="quota-usage-tip"'), false, '应移除 #quota-usage-tip');
  assert.equal(tpl.includes('id="quota-basis-note"'), false, '应移除静态大段 #quota-basis-note');
  assert.equal(tpl.includes('id="btn-plan-detail-collapse-top"'), false, '应移除重复的 #btn-plan-detail-collapse-top');
  assert.ok(tpl.includes('id="btn-check-update"'), '主面板标题栏应回迁检查更新按钮');
  assert.ok(tpl.includes('id="btn-github-repo"'), '主面板标题栏应回迁 GitHub 按钮');
  assert.ok(tpl.includes('id="panel-lang-top-segmented"'), '主面板标题栏应回迁三语言切换按钮');
  assert.ok(tpl.includes('id="settings-about-update-card"'), '配置 Tab 应包含统一的更新与项目链接卡');
  assert.ok(tpl.includes('id="ui-slim-prefs-card"'), '配置 Tab 应包含外观、停靠与顶栏偏好卡');
  assert.ok(tpl.includes('id="badge-speed-wait-svg"'), '顶栏速度单元应包含等待态纯 SVG 沙漏容器');

  // 2. #key-takeaway 仅告警/异常时显示（<75% 隐藏，>=75% 显示），点击 #v 直达设置更新
  const savedPayloads = [];
  const auxContainer = {
    children: [],
    appendChild(n) { this.children.push(n); n.parentElement = this; },
    insertBefore(n) { this.children.unshift(n); n.parentElement = this; },
    removeChild(n) { this.children = this.children.filter(x => x !== n); }
  };
  const pageContainer = {
    children: [],
    appendChild(n) { this.children.push(n); n.parentElement = this; },
    insertBefore(n) { this.children.unshift(n); n.parentElement = this; },
    removeChild(n) { this.children = this.children.filter(x => x !== n); }
  };
  let mockQueryMode = 'none';
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.document.querySelector = (sel) => {
    if (mockQueryMode === 'aux' && sel.includes('aux-sidebar')) return auxContainer;
    if (mockQueryMode === 'page' && sel.includes('workbench.parts.editor')) return pageContainer;
    return null;
  };
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    saveSettings: async (payload) => { savedPayloads.push(payload); return { ok: true }; }
  };
  try {
    h.finishScan();
    // 50% 安全状态 -> #key-takeaway 隐藏
    h.pending[0].resolve(response({ usage: { inputTokens: 128000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } }));
    await h.flush();
    assert.equal(h.elements.get('key-takeaway').hidden, true, '正常 <75% 占用时 #key-takeaway 应隐藏');

    // 点击版本号胶囊 #v 自动展开主面板并切至设置 Tab
    assert.equal(h.elements.get('panel').hidden, true);
    h.elements.get('v').click();
    assert.equal(h.elements.get('panel').hidden, false);
    assert.equal(h.elements.get('pane-ctx-settings').hidden, false);

    // 3. 停靠位置支持四种形态: 常态 flow、缩略 compact、右侧辅助面板 aux、独立页面 page，hide 安全兼容为 flow
    mockQueryMode = 'none';
    api.setDockPosition('aux');
    assert.equal(api.getDockPosition().dockPosition, 'aux');
    assert.equal(api.getDockPosition().fallbackReason, 'aux', '无辅助栏容器时平滑回退并记录 fallbackReason');

    mockQueryMode = 'compact';
    api.setDockPosition('compact');
    assert.equal(api.getDockPosition().dockPosition, 'compact', '支持缩略三图标 compact 形态');
    assert.equal(api.getDockPosition().actualDock, 'compact');

    api.setDockPosition('hide');
    assert.equal(api.getDockPosition().dockPosition, 'flow', '历史或外部传入 hide 自动安全规范为 flow 且激活隐藏开关');

    api.setDockPosition('flow');
    assert.equal(api.getDockPosition().dockPosition, 'flow');

    // 4. Issue #41 顶栏额度窗口模式 4 选 1 (auto / 5h / weekly / both) 逐一点按 DOM 按钮与右键/Alt+点击切换
    const nowQuotaTs = Date.now();
    api.setContextLatestForTest({ model: 'Gemini 4 Hydrogen (High)', modelId: 'gemini-4-hydrogen-high', actual: 12000, budget: 256000 });
    api.setQuotaSnapshotForTest({
      snapshot: {
        fetchedAtMs: nowQuotaTs,
        currentModel: { productKey: 'product:google:gemini-4-hydrogen', productLabel: 'Gemini 4 Hydrogen (High)', poolKey: 'shared_gemini_main' },
        activeStatus: 'available',
        pools: [{
          poolKey: 'shared_gemini_main',
          title: 'Gemini 模型',
          models: [{ productKey: 'product:google:gemini-4-hydrogen', productLabel: 'Gemini 4 Hydrogen', modelIds: ['gemini-4-hydrogen-high'] }],
          buckets: [
            { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.92, percentText: '92%' },
            { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.64, percentText: '64%' }
          ]
        }]
      }
    }, nowQuotaTs);
    assert.equal(h.elements.get('quota-badge-val').textContent, '64%', 'auto 模式默认显示更紧缩的 7d 64%');

    // 逐一点按 4 个 DOM 按钮断言顶栏文本即时变化
    const segQuota = h.elements.get('quota-mode-segmented');
    const clickQuotaMode = (mode) => {
      segQuota.trigger('click', {
        target: {
          closest: (sel) => ({ getAttribute: (k) => (k === 'data-quota-window-mode' ? mode : null) })
        }
      });
    };

    clickQuotaMode('5h');
    assert.equal(h.elements.get('quota-badge-val').textContent, '92%', '点按 5h 按钮立即刷新为 92%');
    assert.equal(h.elements.get('quota-badge-tag').textContent, '5h');

    clickQuotaMode('weekly');
    assert.equal(h.elements.get('quota-badge-val').textContent, '64%', '点按周额度按钮立即刷新为 64%');
    assert.equal(h.elements.get('quota-badge-tag').textContent, '7d');

    clickQuotaMode('both');
    assert.equal(h.elements.get('quota-badge-dual').hidden, false, '点按双显按钮立即展示双行额度');
    assert.equal(h.elements.get('quota-badge-dual').children[0].textContent, '5h 92%');
    assert.equal(h.elements.get('quota-badge-dual').children[1].textContent, '7d 64%');

    clickQuotaMode('auto');
    assert.equal(h.elements.get('quota-badge-dual').hidden, true, '点按自动按钮双显隐藏并恢复单显');
    assert.equal(h.elements.get('quota-badge-val').textContent, '64%');

    const quotaBadge = h.elements.get('badge-quota');
    const quotaPanel = h.elements.get('panel-quota');
    // 左键轮转，提示和数值即时更新，面板保持关闭。
    quotaBadge.trigger('click', { detail: 1 });
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    assert.equal(h.elements.get('quota-badge-val').textContent, '92%');
    assert.equal(quotaPanel.hidden, true);

    let prevented = false;
    let stopped = false;
    quotaBadge.trigger('contextmenu', {
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; }
    });
    assert.ok(prevented && stopped);
    assert.equal(quotaPanel.hidden, false);
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    quotaBadge.trigger('click', { altKey: true, detail: 1 });
    assert.equal(quotaPanel.hidden, true);
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    quotaBadge.trigger('click', { detail: 0 });
    assert.equal(quotaPanel.hidden, false);
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    h.elements.get('close-quota').click();
    assert.equal(savedPayloads.at(-1).quotaBadgeWindowMode, '5h');

    // 5. ELV-93 顶栏等待状态改为纯 SVG 沙漏动效（去除 Wait Xs / 等待 Xs 文本抖动）
    api.setSpeedEvaluationForTest({ phase: 'waiting', elapsedSec: 4 });
    const spWait = api.getSpeedPanelStateForTest();
    assert.equal(spWait.topSpeedPhase, 'waiting');
    assert.equal(spWait.topWaitSvgVisible, true);
    assert.equal(spWait.topSpeedText, '', '等待期顶栏不得显示每秒跳动文字');
    assert.match(h.elements.get('badge-speed').title, /4s/);

    api.setSpeedEvaluationForTest({
      phase: 'final',
      ttftSec: 0.7,
      streamingSec: 2.0,
      totalDurationSec: 2.7,
      streamSpeed: 145.2,
      overallTps: 108.0,
      outputTokens: 290
    });
    const spDone = api.getSpeedPanelStateForTest();
    assert.equal(spDone.topSpeedPhase, null);
    assert.equal(spDone.topWaitSvgVisible, false);
    assert.match(spDone.topSpeedText, /145\.2/);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('多账号卡片配额展示回归: Pro/Free 账号不出现假 Carbon、Ultra 账号正常显示 Carbon 5h/7d、双窗口与单窗口格式对齐、过滤历史残留杂项池', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const mockOverview = {
      accounts: [
        // 1. Pro 账号：Hydrogen 双窗口 (5h 0%, 7d 70%), Claude/3P 双窗口 (5h 100%, 7d 87%), Argon 单窗口 (7d 70%), Carbon 无权限 (noPermission: true),
        // 且包含历史残留 shared_chat_23310 与 shared_gemini-25-pro 杂项池
        {
          email: 'pro-user@example.com',
          isActive: true,
          hasRefreshToken: true,
          tierId: 'g1-pro-tier',
          lastQuotaUpdatedAtMs: 1760000000000,
          quotaSnapshot: {
            pools: [
              {
                poolKey: 'shared_gemini_main',
                title: 'Gemini 4 Hydrogen',
                percentText: '0%',
                buckets: [
                  { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0, percentText: '0%' },
                  { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.70, percentText: '70%' }
                ]
              },
              {
                poolKey: 'shared_3p_pool',
                title: 'Claude/3P',
                percentText: '87%',
                buckets: [
                  { bucketId: 'b5h_3p', windowKey: '5h', windowShort: '5h', remainingFraction: 1.0, percentText: '100%' },
                  { bucketId: 'b7d_3p', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.87, percentText: '87%' }
                ]
              },
              {
                poolKey: 'shared_gemini_argon',
                title: 'Gemini 4 Argon',
                percentText: '70%',
                buckets: [
                  { bucketId: 'barg', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.70, percentText: '70%' }
                ]
              },
              {
                poolKey: 'shared_gemini_carbon',
                title: 'Gemini 4 Carbon',
                noPermission: true,
                remainingFraction: null,
                percentText: '无权限',
                buckets: []
              },
              {
                poolKey: 'shared_chat_23310',
                title: 'Internal Chat 23310',
                remainingFraction: 1.0,
                percentText: '100%',
                buckets: []
              },
              {
                poolKey: 'shared_gemini-25-pro',
                title: 'Gemini 2.5 Pro',
                remainingFraction: 1.0,
                percentText: '100%',
                buckets: []
              }
            ]
          }
        },
        // 2. Free 账号：仅有 Hydrogen 单窗口 7d 100%，Carbon 无权限
        {
          email: 'free-user@example.com',
          isActive: false,
          hasRefreshToken: true,
          tierId: 'free-tier',
          lastQuotaUpdatedAtMs: 1760000000000,
          quotaSnapshot: {
            pools: [
              {
                poolKey: 'shared_gemini_main',
                title: 'Gemini 4 Hydrogen',
                percentText: '100%',
                buckets: [
                  { bucketId: 'bfree_7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 1.0, percentText: '100%' }
                ]
              },
              {
                poolKey: 'shared_gemini_carbon',
                title: 'Gemini 4 Carbon',
                noPermission: true,
                remainingFraction: null,
                percentText: '无权限',
                buckets: []
              }
            ]
          }
        },
        // 3. Ultra 账号：Carbon 具有真实可用权限且存在双窗口配额 (5h 100%, 7d 100%)
        {
          email: 'ultra-user@example.com',
          isActive: false,
          hasRefreshToken: true,
          tierId: 'g1-ultra-tier',
          lastQuotaUpdatedAtMs: 1760000000000,
          quotaSnapshot: {
            pools: [
              {
                poolKey: 'shared_gemini_main',
                title: 'Gemini 4 Hydrogen',
                percentText: '90%',
                buckets: [
                  { bucketId: 'u_5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.90, percentText: '90%' },
                  { bucketId: 'u_7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.95, percentText: '95%' }
                ]
              },
              {
                poolKey: 'shared_gemini_carbon',
                title: 'Gemini 4 Carbon',
                noPermission: false,
                remainingFraction: 1.0,
                percentText: '100%',
                buckets: [
                  { bucketId: 'c_5h', windowKey: '5h', windowShort: '5h', remainingFraction: 1.0, percentText: '100%' },
                  { bucketId: 'c_7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 1.0, percentText: '100%' }
                ]
              }
            ]
          }
        }
      ]
    };

    api.setAccountsOverviewForTest(mockOverview);
    const listEl = h.elements.get('quota-accounts-list');
    assert.equal(listEl.children.length, 3);

    // 1) 验证 Pro 账号卡片
    const proCard = listEl.children[0];
    const proMeta = proCard.children.find(c => c.className === 'quota-acct-meta');
    assert.ok(proMeta, 'Pro 卡片应有 meta 摘要行');
    const proText = proMeta.textContent;
    // 验证双窗口与单窗口格式
    assert.match(proText, /Gemini \(Neon\/Hydrogen\): 5h 0% \/ 7d 70%/);
    assert.match(proText, /Claude\/3P: 5h 100% \/ 7d 87%/);
    assert.match(proText, /Argon: 7d 70%/);
    // 严禁出现假 Carbon（shared_chat_23310 或 gemini-2.5-pro 绝不能变成 Carbon）
    assert.doesNotMatch(proText, /Carbon: 100%/);
    // Pro 用户无 Carbon 权限，Carbon 应直接隐藏，不显示 "Carbon: 无模型权限"
    assert.doesNotMatch(proText, /Carbon/);
    assert.doesNotMatch(proText, /chat_23310/);
    assert.doesNotMatch(proText, /gemini-25-pro/);

    // 2) 验证 Free 账号卡片
    const freeCard = listEl.children[1];
    const freeMeta = freeCard.children.find(c => c.className === 'quota-acct-meta');
    assert.ok(freeMeta);
    const freeText = freeMeta.textContent;
    assert.match(freeText, /Gemini \(Neon\/Hydrogen\): 7d 100%/);
    assert.doesNotMatch(freeText, /Carbon/);

    // 3) 验证 Ultra 账号卡片
    const ultraCard = listEl.children[2];
    const ultraMeta = ultraCard.children.find(c => c.className === 'quota-acct-meta');
    assert.ok(ultraMeta);
    const ultraText = ultraMeta.textContent;
    assert.match(ultraText, /Gemini \(Neon\/Hydrogen\): 5h 90% \/ 7d 95%/);
    assert.match(ultraText, /Carbon: 5h 100% \/ 7d 100%/);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('Issue #49: 套餐规格与 5x/20x 子档覆盖下拉选择、立即保存及三端 UI 同步展示', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  let savedSettingsPayload = null;
  h.sandbox.window.contextMeterAPI.saveSettings = async (payload) => {
    savedSettingsPayload = payload;
    return { ok: true, customPlan: payload.customPlan };
  };

  try {
    const mockPlan = {
      status: 'identified',
      tierKey: 'ultra',
      tierName: 'Google AI Ultra',
      email: 'ultra-user@example.com'
    };
    api.applyTokenHistoryPayload({
      planStatus: mockPlan,
      rawPlanStatus: mockPlan,
      dailyMap: {}
    });

    // 1. 验证存在紫光风格下拉选择器包裹容器与 trigger
    const wrap = h.elements.get('direct-tier-wrap');
    assert.ok(wrap, '必须渲染 direct-tier-wrap 下拉包裹器');
    const labelEl = h.elements.get('direct-tier-label');
    assert.ok(labelEl, '必须渲染 direct-tier-label');

    // 2. 选择 Google AI Ultra (5x) 并触发 change
    const sel = h.elements.get('direct-tier-select');
    assert.ok(sel, '必须存在原生 direct-tier-select');
    sel.value = 'ultra_5x';
    sel.trigger('change', { target: { value: 'ultra_5x' } });

    // 3. 验证触发了 saveSettings 保存，且 customPlan 包含 planTierOverride
    assert.ok(savedSettingsPayload, '必须调用 saveSettings');
    assert.equal(savedSettingsPayload.customPlan.planTierOverride, 'ultra_5x');

    // 4. 验证 Token 面板订阅摘要条展示带子档套餐名
    const sumTxt = h.elements.get('plan-summary-text');
    assert.match(sumTxt.textContent, /Google AI Ultra 5x/);

    // 5. 验证额度面板顶部套餐胶囊展示带子档套餐名
    const quotaPill = h.elements.get('quota-plan-tier-pill');
    assert.equal(quotaPill.hidden, false);
    assert.equal(quotaPill.textContent, 'Google AI Ultra 5x');

    // 6. 验证多账号列表展示带子档套餐名
    const mockOverview = {
      accounts: [
        {
          email: 'ultra-user@example.com',
          isActive: true,
          hasRefreshToken: true,
          tierId: 'g1-ultra-tier',
          quotaSnapshot: { pools: [] }
        }
      ]
    };
    api.setAccountsOverviewForTest(mockOverview);
    const listEl = h.elements.get('quota-accounts-list');
    assert.ok(listEl.children.length > 0);
    const acctEmail = listEl.children[0].children.find(c => c.className === 'quota-subcard-row')?.children?.find(c => c.className === 'quota-acct-email');
    assert.ok(acctEmail);
    assert.match(acctEmail.textContent, /ultra-user@example\.com · Google AI Ultra 5x/);

    // 7. 验证切换英文 en 模式下，全 DOM 零汉字门禁通过
    await api.setPanelLanguage('en', { persist: false });
    assert.doesNotMatch(labelEl.textContent, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(sumTxt.textContent, /[\u4e00-\u9fff]/);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('Issue #54 & Issue #59: 顶栏内联锚定打开 IDE 左侧、右侧辅助栏开关零飞移、Customizations 避让与 4 额度窗口即时重算刷新', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1. 模拟会话标题栏 DOM 结构：左侧标题，右侧按钮组（包含打开 IDE 与三个点按钮）
  const openIdeBtn = { textContent: 'Open IDE', getBoundingClientRect: () => ({ top: 10, left: 800, right: 880, width: 80 }) };
  const moreBtn = { textContent: '...', getBoundingClientRect: () => ({ top: 10, left: 884, right: 914, width: 30 }) };
  const rightGroup = {
    className: 'shrink-0 flex items-center',
    children: [openIdeBtn, moreBtn],
    get firstChild() { return this.children[0]; },
    get firstElementChild() { return this.children[0]; },
    appendChild(n) { this.children.push(n); n.parentElement = this; },
    insertBefore(n, ref) {
      const existingIdx = this.children.indexOf(n);
      if (existingIdx >= 0) this.children.splice(existingIdx, 1);
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, n);
      else this.children.unshift(n);
      n.parentElement = this;
    },
    getBoundingClientRect: () => ({ top: 10, left: 800, right: 920, width: 120 })
  };
  const titlebarEl = {
    className: 'flex items-center justify-between @container/titlebar',
    firstElementChild: { scrollWidth: 140, firstElementChild: { getBoundingClientRect: () => ({ left: 20 }) } },
    lastElementChild: rightGroup,
    querySelector(sel) { return sel.includes('shrink-0') ? rightGroup : null; },
    contains(n) { return rightGroup.children.includes(n) || n.parentElement === rightGroup; },
    getBoundingClientRect: () => ({ top: 10, left: 0, right: 1200, width: 1200 })
  };

  h.sandbox.document.querySelector = (sel) => {
    if (sel.includes('@container/titlebar')) return titlebarEl;
    if (sel.includes('toggle-aux-sidebar')) return { click() { } };
    return null;
  };

  api.setDockPosition('flow');
  const pos = api.getDockPosition();
  assert.equal(pos.dockPosition, 'flow');
  assert.equal(pos.actualDock, 'flow');

  // 断言宿主挂在右侧组最前面，即处于“打开 IDE”与“三个点”按钮左侧，同一水平线上
  const activeHost = h.sandbox.__AGContextMeterActiveHost;
  assert.ok(activeHost);
  assert.equal(activeHost.parentElement, rightGroup);
  assert.equal(rightGroup.children[0], activeHost, '顶栏组件必须作为 targetContainer.firstChild 锚定在打开 IDE 左侧');
  assert.equal(rightGroup.children[1], openIdeBtn);

  // 2. 开关右侧辅助面板（模拟 DOM 发生变动且尺寸改变），宿主依然稳固锚定在打开 IDE 左侧，严禁飞到 fixed 或 top: 6px
  for (let i = 0; i < 3; i++) {
    api.setDockPosition('flow');
    assert.equal(api.getDockPosition().actualDock, 'flow', '开关辅助栏期间 actualDock 始终为 flow 零飞移');
    assert.equal(activeHost.style.top, '', '严禁设置 top: 6px');
    assert.equal(activeHost.style.right, '', '严禁设置 fixed right 偏移动态乱飞');
  }

  // 3. 适配 Antigravity 2.33 的 Customizations 自定义扩展等非会话全屏子视图顶栏避让 (Issue #59)
  if (!h.sandbox.document.head) {
    h.sandbox.document.head = h.sandbox.document.createElement();
  }
  h.sandbox.navigator = { platform: 'Win32' };
  h.sandbox.window.innerWidth = 1200;
  h.sandbox.window.outerWidth = 1200;
  titlebarEl.getBoundingClientRect = () => ({ top: 10, left: 0, right: 1200, width: 1200, height: 40 });
  let inCustomizationView = true;
  const backBtn = { getBoundingClientRect: () => ({ top: 10, left: 8, right: 36, width: 28, height: 28 }) };
  h.sandbox.document.querySelector = (sel) => {
    if (inCustomizationView && (sel.includes('customization') || sel.includes('Back'))) {
      return backBtn;
    }
    if (sel.includes('@container/titlebar')) return titlebarEl;
    return null;
  };

  // 触发布局测量，在 Customizations 视图下自动预留原生返回与搜索空间，绝不遮挡原生按钮
  h.sandbox.__AGContextMeter.syncWindowControlsOverlayForTest?.();
  const styleFix = h.sandbox.document.getElementById('ag-topbar-host-fix');
  assert.ok(styleFix, '必须注入避让样式表');
  assert.match(styleFix.textContent, /#ag-context-meter[\s\S]*-webkit-app-region:\s*no-drag/);

  // 4. 自动化 DOM 测试逐一点按 4 个额度窗口按钮立即从 buckets 重算 5h 与 7d 数值并当场刷新 #badge-quota
  const nowTs = Date.now();
  api.setQuotaSnapshotForTest({
    snapshot: {
      fetchedAtMs: nowTs,
      activeStatus: 'available',
      pools: [{
        poolKey: 'shared_gemini_main',
        title: 'Gemini 模型',
        buckets: [
          { bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.85, percentText: '85%' },
          { bucketId: 'b7d', windowKey: 'weekly', windowShort: '7d', remainingFraction: 0.42, percentText: '42%' }
        ]
      }]
    }
  }, nowTs);

  const segQuota = h.elements.get('quota-mode-segmented');
  const clickQuotaMode = (mode) => {
    segQuota.trigger('click', {
      target: {
        closest: (sel) => ({ getAttribute: (k) => (k === 'data-quota-window-mode' ? mode : null) })
      }
    });
  };

  // a) 点按 5h 窗口
  clickQuotaMode('5h');
  assert.equal(h.elements.get('quota-badge-val').textContent, '85%', '点按 5h 按钮后 #badge-quota 文本即时变化为 85%');
  assert.equal(h.elements.get('quota-badge-tag').textContent, '5h');

  // b) 点按周额度
  clickQuotaMode('weekly');
  assert.equal(h.elements.get('quota-badge-val').textContent, '42%', '点按周额度按钮后 #badge-quota 文本即时变化为 42%');
  assert.equal(h.elements.get('quota-badge-tag').textContent, '7d');

  // c) 点按 5h+周双显
  clickQuotaMode('both');
  assert.equal(h.elements.get('quota-badge-dual').hidden, false, '点按双显按钮后双显行立即展示');
  assert.equal(h.elements.get('quota-badge-dual').children[0].textContent, '5h 85%');
  assert.equal(h.elements.get('quota-badge-dual').children[1].textContent, '7d 42%');

  // d) 点按自动（最紧缩）
  clickQuotaMode('auto');
  assert.equal(h.elements.get('quota-badge-dual').hidden, true);
  assert.equal(h.elements.get('quota-badge-val').textContent, '42%', '点按自动按钮立即根据 buckets 选出最紧缩 42%');
});

test('桌面端四种停靠形态与隐藏顶栏开关: 常态、缩略、右侧辅助面板、独立页面，旧偏好安全兼容', async () => {
  const extraSandbox = {
    localStorage: {
      _store: new Map([['ag_dock_position', 'hide']]),
      getItem(k) { return this._store.get(k) || null; },
      setItem(k, v) { this._store.set(k, String(v)); },
      removeItem(k) { this._store.delete(k); }
    }
  };
  const h = harness(undefined, extraSandbox);
  const api = h.sandbox.__AGContextMeter;

  try {
    // 1. 初始化时历史配置 hide 自动兼容规范为 flow
    assert.equal(api.getDockPosition().dockPosition, 'flow', '本地历史写入 hide 时初始化自动兼容为 flow');
    assert.equal(api.getDockPosition().actualDock, 'flow', '实际挂载保持为顶栏默认显示');

    // 2. 四种合法形态切换
    api.setDockPosition('compact');
    assert.equal(api.getDockPosition().dockPosition, 'compact', '支持切换为缩略形态');

    api.setDockPosition('aux');
    assert.equal(api.getDockPosition().dockPosition, 'aux', '支持切换为右侧辅助面板');

    api.setDockPosition('page');
    assert.equal(api.getDockPosition().dockPosition, 'page', '支持切换为独立页面');

    api.setDockPosition('flow');
    assert.equal(api.getDockPosition().dockPosition, 'flow', '支持切换为常态');

    // 3. 静态模板门禁: 验证 template.html 存在四形态按钮与隐藏开关
    const templatePath = path.resolve(__dirname, 'src/renderer/template.html');
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    assert.ok(templateHtml.includes('id="btn-dock-flow"'), '必须包含常态按钮 btn-dock-flow');
    assert.ok(templateHtml.includes('id="btn-dock-compact"'), '必须包含缩略按钮 btn-dock-compact');
    assert.ok(templateHtml.includes('id="btn-dock-aux"'), '必须包含右侧辅助面板按钮 btn-dock-aux');
    assert.ok(templateHtml.includes('id="btn-dock-page"'), '必须包含独立页面按钮 btn-dock-page');
    assert.ok(templateHtml.includes('id="chk-hide-topbar"'), '必须包含隐藏顶栏开关 chk-hide-topbar');
    assert.ok(templateHtml.includes('id="badge-dock-wake"'), '必须保留边缘轻量唤醒按钮 badge-dock-wake');
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('弹窗顶栏布局回迁: 简繁EN语言切换、GitHub入口与检查更新按钮紧凑并排且点击可用, 配置页无重复区块', async () => {
  let openedUrl = null;
  let checkedUpdateOpts = null;
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    openExternal: url => { openedUrl = url; },
    checkUpdate: opts => {
      checkedUpdateOpts = opts;
      return {
        hasUpdate: true,
        version: '0.8.9-beta.1',
        tagName: 'v0.8.9-beta.1',
        releaseNotes: '新特性说明',
        htmlUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.8.9-beta.1'
      };
    }
  };
  const api = h.sandbox.__AGContextMeter;

  try {
    // 1. 结构与位置断言：读取 template.html 验证 #panel 标题栏容器包含回迁的组件
    const templatePath = path.resolve(__dirname, 'src/renderer/template.html');
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    const panelHeaderMatch = templateHtml.match(/<section id="panel"[\s\S]*?<div id="view-context">/);
    assert.ok(panelHeaderMatch, '必须存在 #panel 顶部区域');
    const headerHtml = panelHeaderMatch[0];

    assert.ok(headerHtml.includes('id="panel-lang-top-segmented"'), '顶栏必须包含三语言分段按钮');
    assert.ok(headerHtml.includes('id="btn-top-lang-zh-CN"'), '顶栏必须包含简中按钮');
    assert.ok(headerHtml.includes('id="btn-top-lang-zh-TW"'), '顶栏必须包含繁中按钮');
    assert.ok(headerHtml.includes('id="btn-top-lang-en"'), '顶栏必须包含EN按钮');
    assert.ok(headerHtml.includes('id="btn-github-repo"'), '顶栏必须包含 GitHub 按钮');
    assert.ok(headerHtml.includes('id="btn-check-update"'), '顶栏必须包含检查更新按钮');
    assert.ok(headerHtml.includes('id="theme-toggle"'), '顶栏必须包含主题切换按钮');
    assert.ok(headerHtml.includes('id="close"'), '顶栏必须包含关闭按钮');

    // 2. 配置页清理断言：配置页内不得存在重复的语言分段按钮和重复的 GitHub/更新按钮
    const settingsPaneMatch = templateHtml.match(/<div id="pane-ctx-settings"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
    assert.ok(settingsPaneMatch, '必须存在配置页容器');
    const settingsHtml = settingsPaneMatch[0];
    assert.equal(settingsHtml.includes('id="panel-lang-top-segmented"'), false, '配置页内不得残留重复的语言分段按钮');
    assert.equal(settingsHtml.includes('id="btn-top-lang-zh-CN"'), false, '配置页内不得残留重复简中按钮');
    assert.equal(settingsHtml.includes('id="btn-check-update"'), false, '配置页卡片内不得残留重复检查更新按钮');
    assert.equal(settingsHtml.includes('id="btn-github-repo"'), false, '配置页卡片内不得残留重复 GitHub 按钮');

    // 3. 点击可用性验证：点击 GitHub 入口
    const btnGithub = h.elements.get('btn-github-repo');
    assert.ok(btnGithub, 'DOM 中必须解析出 btn-github-repo');
    btnGithub.click();
    assert.equal(openedUrl, 'https://github.com/elviscjn-cjn/antigravity-context-viewer');

    // 4. 点击可用性验证：点击检查更新入口
    const btnUpdate = h.elements.get('btn-check-update');
    assert.ok(btnUpdate, 'DOM 中必须解析出 btn-check-update');
    btnUpdate.click();
    await h.flush();
    assert.ok(checkedUpdateOpts, '点击检查更新必须触发更新检查逻辑');
    assert.equal(checkedUpdateOpts.force, true);

    // 5. 点击可用性验证：语言切换简 繁 EN
    const btnEn = h.elements.get('btn-top-lang-en');
    const btnTw = h.elements.get('btn-top-lang-zh-TW');
    const btnCn = h.elements.get('btn-top-lang-zh-CN');
    assert.ok(btnEn && btnTw && btnCn, 'DOM 中必须解析出三语言切换按钮');

    btnEn.click();
    await h.flush();
    assert.equal(api.getPanelLanguage(), 'en');

    btnTw.click();
    await h.flush();
    assert.equal(api.getPanelLanguage(), 'zh-TW');

    btnCn.click();
    await h.flush();
    assert.equal(api.getPanelLanguage(), 'zh-CN');
  } finally {
    try { api.dispose(); } catch { }
  }
});
test('Split Windows route: picks the focused conversation from /c/<id1>%2B<id2>?focused=<id>', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const C = '33333333-3333-3333-3333-333333333333';
  const h = harness();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, A);
  h.sandbox.location.pathname = `/c/${A}%2B${B}`;
  h.sandbox.location.search = `?project=outside-of-project&focused=${B}`;
  h.tick();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, B);
  h.sandbox.location.pathname = `/c/${A}%2B${B}%2B${C}`;
  h.sandbox.location.search = `?focused=${C}`;
  h.tick();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, C);
  h.sandbox.location.search = '';
  h.tick();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, A, 'falls back to the first pane without focused');
  h.sandbox.location.search = '?focused=44444444-4444-4444-4444-444444444444';
  h.tick();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, A, 'ignores a focused id that is not in the path');
  h.sandbox.location.pathname = '/c/not-a-uuid';
  h.tick();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().route, null);
  h.sandbox.__AGContextMeter.dispose();
});


test('multi-pane Split Right / Split Down: route focus follow, 0ms cache hot-switch without closing panel, and blank _new fallback', async () => {
  const [A, B, C, D] = [1, 2, 3, 4].map(n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`);
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const settleLatest = async (tokens, stepCount = 1) => {
    const row = { chatModel: { usage: { inputTokens: tokens }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } } } };
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: Array.from({ length: stepCount }, () => row) })
    });
    h.finishScan(h.scans.length - 1);
    await h.flush();
  };
  const nav = (pathname, search = '') => { h.sandbox.location.pathname = pathname; h.sandbox.location.search = search; h.tick(); };
  try {
    let sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, A);
    assert.equal(sc.scopeBarHidden, true);
    assert.equal(sc.badgeScopeTagHidden, true);
    assert.equal(sc.keyScopeChipHidden, true);

    h.elements.get('panel').hidden = false;
    await settleLatest(46100, 5);
    assert.equal(api.snapshot().latest.actual, 46100);

    nav(`/c/${A}%2B${B}`, `?project=outside-of-project&focused=${A}`);
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, A);
    assert.equal(sc.scopeBarHidden, false);
    assert.equal(sc.badgeScopeTagHidden, false);
    assert.equal(sc.badgeScopeTag, '1/2');
    assert.equal(sc.keyScopeChip, '窗格 1');
    assert.equal(sc.followLabel, '跟随焦点');
    assert.deepEqual(Array.from(sc.pills, p => p.selected), [true, false]);

    const pendingBeforeSwitch = h.pending.length;
    nav(`/c/${A}%2B${B}`, `?project=outside-of-project&focused=${B}`);
    assert.equal(h.elements.get('panel').hidden, false, '同屏分屏切窗格时不应强行关闭已展开的面板');
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, B);
    assert.equal(sc.badgeScopeTag, '2/2');
    assert.equal(sc.keyScopeChip, '窗格 2');
    assert.equal(sc.pills[1].selected, true);
    assert.ok(sc.cachedRoutes.includes(A));
    assert.ok(h.pending.length > pendingBeforeSwitch);

    await settleLatest(128400);
    assert.equal(api.snapshot().latest.actual, 128400);

    const pendingBeforeBack = h.pending.length;
    nav(`/c/${A}%2B${B}`, `?project=outside-of-project&focused=${A}`);
    assert.equal(api.snapshot().latest.actual, 46100, '同屏回切应立即命中会话快照缓存（零闪烁）');
    assert.notEqual(h.elements.get('files').children[0]?.textContent, '暂无附件', '回切首帧应直接还原缓存附件列表而非暂无附件');
    assert.equal(h.elements.get('panel').hidden, false);
    assert.ok(h.pending.length > pendingBeforeBack);

    // 模拟切走期间窗格 1 消息被撤回/回滚（步数从 5 缩至 1）：首轮增量 offset=2 返回空时自动作废旧缓存并从 offset=0 重拉
    const catchupReq = h.pending[h.pending.length - 1];
    assert.equal(JSON.parse(catchupReq.options.body).generatorMetadataOffset, 2);
    catchupReq.resolve({ ok: true, json: async () => ({ generatorMetadata: [] }) });
    await h.flush();
    const retryFromZeroReq = h.pending[h.pending.length - 1];
    assert.equal(JSON.parse(retryFromZeroReq.options.body).generatorMetadataOffset, 0);
    retryFromZeroReq.resolve({ ok: true, json: async () => ({ generatorMetadata: [{ chatModel: { usage: { inputTokens: 12300 }, modelDisplayName: 'Gemini 4 Neon', chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } } } }] }) });
    await h.flush();
    assert.equal(api.snapshot().latest.actual, 12300);
    assert.equal(api.snapshot().count, 1);

    nav(`/c/${A}%2B${B}%2B${C}`, `?focused=${C}`);
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, C);
    assert.equal(sc.badgeScopeTag, '3/3');
    assert.equal(sc.pills.length, 3);

    nav(`/c/${A}%2B${B}%2B${C}`, '?focused=99999999-9999-9999-9999-999999999999');
    assert.equal(api.getConversationScopeStateForTest().activeRoute, A);

    nav(`/c/${A}%2B_new`, '?focused=_new');
    assert.equal(api.getConversationScopeStateForTest().activeRoute, A);

    h.elements.get('panel').hidden = false;
    nav(`/c/${D}`);
    assert.equal(h.elements.get('panel').hidden, true);
    assert.equal(api.getConversationScopeStateForTest().scopeBarHidden, true);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('Side Chat / Side Question read-only view switcher, auto-resume follow, 3-locale i18n, and top-rightmost titlebar docking', async () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const S = '9a41c80b-77e2-4f10-81ad-3b20e91c4f02';
  const S2 = '7c63e02d-55c0-4d31-83cf-5d42013e6f24';
  const Q = '8b52d91c-66d1-4e20-92be-4c31f02d5e13';

  const makeMockTitlebar = (id, rect) => ({
    id, isConnected: true, children: [], getBoundingClientRect: () => rect,
    appendChild(c) { if (c) { c.parentElement = this; this.children.push(c); } },
    insertBefore(c) { if (c) { c.parentElement = this; this.children.unshift(c); } },
    contains(c) { return this.children.includes(c); }
  });
  const tbLeft = makeMockTitlebar('tb-left', { top: 0, left: 0, right: 600, width: 600, height: 40 });
  const tbTopRight = makeMockTitlebar('tb-top-right', { top: 0, left: 600, right: 1200, width: 600, height: 40 });
  const tbBottomRight = makeMockTitlebar('tb-bottom-right', { top: 420, left: 600, right: 1200, width: 600, height: 40 });
  let mockDomTabNodes = [];

  const h = harness(session(), {
    document: {
      createElement: () => null, getElementById: () => null, documentElement: { appendChild() { } },
      addEventListener() { }, removeEventListener() { }, hidden: false,
      querySelectorAll: (sel) => sel === '[class*="@container/titlebar"]'
        ? [tbLeft, tbBottomRight, tbTopRight]
        : (sel === '[data-tab-id]' ? mockDomTabNodes : []),
      querySelector: (sel) => (sel === '[class*="@container/titlebar"]' ? tbLeft : null)
    }
  });
  const api = h.sandbox.__AGContextMeter;
  const settleLatest = async (tokens) => {
    h.pending[h.pending.length - 1].resolve(response({ usage: { inputTokens: tokens }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } } }));
    h.finishScan(h.scans.length - 1);
    await h.flush();
  };
  try {
    assert.equal(api.findHostTitlebarForTest(), tbTopRight);

    h.elements.get('panel').hidden = false;
    await settleLatest(52000);

    const origPathname = `/c/${A}`;
    const origSearch = `?project=demo&tab=subagent_convo__${S}`;
    h.sandbox.location.pathname = origPathname;
    h.sandbox.location.search = origSearch;
    h.tick();

    let sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, A);
    assert.equal(sc.isFollowingFocus, true);
    assert.equal(sc.scopeBarHidden, false);
    assert.equal(sc.badgeScopeTag, '+支线');
    assert.deepEqual(Array.from(sc.pills, p => p.label), ['主对话', 'Side Chat']);

    const pendingBeforeSide = h.pending.length;
    h.elements.get('ctx-scope-pills').children[1].click();
    assert.equal(h.sandbox.location.pathname, origPathname, '点击胶囊绝不能篡改宿主主对话路径');
    assert.equal(h.sandbox.location.search, origSearch, '点击胶囊绝不能篡改宿主查询参数');
    assert.equal(h.elements.get('panel').hidden, false);

    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, S);
    assert.equal(sc.pinnedViewRoute, S);
    assert.equal(sc.isFollowingFocus, false);
    assert.equal(sc.badgeScopeTag, '支线');
    assert.equal(sc.badgeScopeLocked, 'true');
    assert.equal(sc.followAttr, 'false');
    assert.equal(sc.followLabel, '恢复跟随');
    assert.equal(sc.keyScopeChip, 'Side Chat');
    assert.ok(h.pending.length > pendingBeforeSide);
    assert.equal(JSON.parse(h.pending[h.pending.length - 1].options.body).cascadeId, S);

    await api.setPanelLanguage('en', { persist: false });
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.badgeScopeTag, 'Side');
    assert.equal(sc.followLabel, 'Follow Focus');
    assert.deepEqual(Array.from(sc.pills, p => p.label), ['Main', 'Side Chat']);
    assert.doesNotMatch(`${sc.badgeScopeTag}${sc.followLabel}${sc.pills.map(p => p.label).join('')}`, /[\u4e00-\u9fff]/);

    await api.setPanelLanguage('zh-TW', { persist: false });
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.badgeScopeTag, '支線');
    assert.equal(sc.followLabel, '恢復跟隨');
    assert.equal(sc.pills[0].label, '主對話');

    await api.setPanelLanguage('zh-CN', { persist: false });
    h.elements.get('btn-ctx-scope-follow').click();
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, A);
    assert.equal(sc.isFollowingFocus, true);
    assert.equal(sc.badgeScopeTag, '+支线');
    assert.equal(api.snapshot().latest.actual, 52000);

    h.sandbox.location.search = `?tab=side_question__${Q}`;
    h.tick();
    assert.equal(api.getConversationScopeStateForTest().pills[1].label, '支线问答');
    api.selectConversationScopeForTest(Q);
    assert.equal(api.getConversationScopeStateForTest().activeRoute, Q);

    h.sandbox.location.search = '';
    h.tick();
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.activeRoute, A);
    assert.equal(sc.pinnedViewRoute, null);
    assert.equal(sc.scopeBarHidden, true);

    let activeDomSideId = S;
    const makeMockSideTab = (sid, title) => ({
      get className() { return activeDomSideId === sid ? 'bg-secondary text-foreground' : 'bg-transparent text-secondary-foreground'; },
      getAttribute: k => (k === 'data-tab-id' ? `subagent_convo__${sid}` : (k === 'title' ? title : null)),
      textContent: title
    });
    mockDomTabNodes = [makeMockSideTab(S, 'Side Chat · Debug API'), makeMockSideTab(S2, 'Side Chat · Review Diff')];
    h.tick();
    sc = api.getConversationScopeStateForTest();
    assert.equal(sc.scopeBarHidden, false);
    assert.deepEqual(Array.from(sc.pills, p => p.label), ['主对话', 'Side Chat 1', 'Side Chat 2']);

    api.selectConversationScopeForTest(S);
    assert.equal(api.getConversationScopeStateForTest().activeRoute, S);
    await settleLatest(18200);
    assert.equal(api.snapshot().latest.actual, 18200);

    activeDomSideId = S2;
    h.sandbox.location.search = `?tab=subagent_convo__${S2}`;
    h.tick();
    sc = api.getConversationScopeStateForTest();
    assert.deepEqual(Array.from(sc.pills).slice(1).map(p => `${p.label}:${p.id}`), [`Side Chat 1:${S}`, `Side Chat 2:${S2}`]);
    assert.equal(sc.activeRoute, S2);
    await settleLatest(33400);
    assert.equal(api.snapshot().latest.actual, 33400);

    activeDomSideId = S;
    h.sandbox.location.search = '';
    h.tick();
    assert.equal(api.getConversationScopeStateForTest().activeRoute, S);
    assert.equal(api.snapshot().latest.actual, 18200);

    mockDomTabNodes = [];
    h.tick();
    assert.equal(api.getConversationScopeStateForTest().activeRoute, A);
    assert.equal(api.getConversationScopeStateForTest().scopeBarHidden, true);

    h.sandbox.location.pathname = `/c/${A}%2B${B}`;
    h.sandbox.location.search = `?focused=${A}`;
    h.tick();
    api.selectConversationScopeForTest(B);
    assert.equal(api.getConversationScopeStateForTest().isFollowingFocus, false);
    assert.equal(api.getConversationScopeStateForTest().activeRoute, B);
    h.sandbox.location.search = `?focused=${B}`;
    h.tick();
    assert.equal(api.getConversationScopeStateForTest().isFollowingFocus, true);
    h.sandbox.location.search = `?focused=${A}`;
    h.tick();
    assert.equal(api.getConversationScopeStateForTest().activeRoute, A);
    assert.equal(api.getConversationScopeStateForTest().isFollowingFocus, true);
  } finally {
    try { api.dispose(); } catch { }
  }
});

test('/compact 端到端闭环：压缩中稳态提示、完成后强制重扫回落圆环、轮询防倒灌、三语切换与新消息无缝恢复实测', async () => {
  let nowMs = 1763500000000;
  class MockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  const cascadeId = '11111111-1111-1111-1111-111111111111';
  const h = harness(session(), { Date: MockDate });
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.contextMeterAPI.scan = (id, force = false) =>
    new Promise(resolve => h.scans.push({ id, force, resolve }));

  try {
    // 1. 初始压缩前 80% 偏高状态（204,800 / 256,000）
    const preSession = {
      ...session(),
      total: { chars: 480000, low: 150000, high: 210000 },
      steps: 3,
      userMessages: 1,
      assistantMessages: 1,
      lastModelStepAt: 1,
      checkpointCount: 0,
      lastCheckpointIndex: -1
    };
    const preTurnRow = {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_GOOGLE_GEMINI_4_HYDROGEN_HIGH',
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        usage: { inputTokens: 202800, outputTokens: 2000 },
        timeToFirstToken: '1.0s',
        streamingDuration: '4.0s',
        chatStartMetadata: {
          startStepIndex: 1,
          contextWindowMetadata: { estimatedTokensUsed: 202000, maxContextTokens: 256000 }
        }
      }
    };
    h.scans[0].resolve({ ok: true, data: { session: preSession, scannedAt: nowMs, generatorCount: 1, latest: null } });
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [preTurnRow] }) });
    await h.flush();

    assert.equal(h.host.getAttribute('data-occupancy'), 'warn');
    assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'determinate');
    const preArcDash = h.elements.get('ring-fill').getAttribute('stroke-dasharray');
    assert.equal(h.elements.get('amount').textContent, '204.8K (80%)');
    assert.equal(h.elements.get('key-badge').textContent, '偏高');
    const preSpeedTxt = h.elements.get('speed-amount').textContent;
    assert.ok(preSpeedTxt && !preSpeedTxt.includes('--'), `应显示有效速度，实际: ${preSpeedTxt}`);

    // 2. 用户输入 /compact：进入压缩过渡态，圆环弧长保持稳定不乱跳，速度徽章不误入“等待首字”
    nowMs += 500;
    const dispatchTok = h.sandbox.__AG_METER_ON_SEND_MESSAGE__({
      cascadeId,
      items: [{ text: '/compact' }]
    });
    assert.ok(dispatchTok?.dispatchId?.startsWith('compact_'), '应识别 /compact 指令并返回专属 dispatchId');
    assert.equal(api.snapshot().compacting?.cascadeId, cascadeId);
    assert.equal(h.elements.get('ring-fill').getAttribute('stroke-dasharray'), preArcDash, '压缩进行中圆环弧长应保持稳定');
    assert.equal(h.elements.get('speed-amount').textContent, preSpeedTxt, '/compact 不应污染速度徽章为等待首字');
    assert.equal(h.elements.get('status').textContent, '正在压缩会话上下文，完成后圆环与剩余空间将自动同步更新…');
    assert.equal(h.host.getAttribute('data-compacting'), 'true', '压缩进行中宿主节点必须标记 data-compacting="true" 驱动呼吸动效');
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…', '顶栏圆环旁胶囊在压缩进行中必须即时显示“压缩中…”反馈');
    assert.equal(h.elements.get('key-badge').textContent, '压缩中…');
    assert.equal(h.elements.get('request-status').textContent, '正在压缩上下文…');
    assert.equal(h.elements.get('ctx-tip-title').textContent, '上下文窗口（正在压缩…）：');
    assert.equal(h.elements.get('ctx-tip-pct').textContent, '正在生成压缩摘要，完成后自动更新');

    // 3. /compact RPC 完成：立即触发 scan(id, force=true) 绕过 20s 周期与 12s 缓存
    nowMs += 600;
    h.sandbox.__AG_METER_ON_SEND_RESULT__(dispatchTok.dispatchId, true, null);
    assert.equal(h.scans.length, 2, '压缩完成应立即发起新扫描');
    assert.equal(h.scans[1].id, cascadeId);
    assert.equal(h.scans[1].force, true, '压缩后扫描必须传入 force=true 绕过缓存');

    const postSession = {
      ...preSession,
      steps: 4,
      userMessages: 2,
      checkpointCount: 1,
      lastCheckpointIndex: 3,
      lastCheckpointFailed: false,
      groups: {
        ...preSession.groups,
        summaries: { chars: 1200, low: 400, high: 800 }
      },
      postCheckpoint: {
        textTotal: { chars: 42000, low: 14000, high: 18000 },
        mediaRefs: {}
      },
      postCompactActiveTotal: { chars: 50000, low: 16000, high: 20000 }
    };
    const postLatest = core.buildPostCompactSummary({
      session: postSession,
      previousLatest: {
        budget: 256000,
        model: 'Gemini 4 Hydrogen (High)',
        speed: { tps: 500, streamingTps: 500, duration: 4, ttft: 1, outputTokens: 2000 }
      }
    });
    h.scans[1].resolve({
      ok: true,
      data: {
        session: postSession,
        scannedAt: nowMs,
        generatorCount: 2,
        preCompactLatest: { budget: 256000, model: 'Gemini 4 Hydrogen (High)' },
        latest: postLatest
      }
    });
    await h.flush();

    assert.equal(api.snapshot().compacting, null, '读取到新检查点后应清除压缩过渡态');
    assert.equal(h.host.getAttribute('data-occupancy'), 'normal', '压缩回落后应清除 80% 橙色告警');
    assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'determinate');
    const postArcLen = parseFloat(h.elements.get('ring-fill').getAttribute('stroke-dasharray'));
    assert.ok(postArcLen > 1.8 && postArcLen < 5, `压缩后圆环弧长应回落至 ~7%（实测 ${postArcLen}）`);
    assert.equal(h.elements.get('amount').textContent, '~18K (7%)');
    assert.equal(h.elements.get('badge-pct-val').textContent, '~7%');
    assert.equal(h.elements.get('ctx-tip-title').textContent, '上下文窗口（已压缩 · 预估）：');
    assert.equal(h.elements.get('ctx-tip-pct').textContent, '约 7% 已用（剩余约 93% · 已压缩）');
    assert.equal(h.elements.get('ctx-tip-detail').textContent, '压缩后预估 ≈ 18k / 256k token（发新消息后切换精确值）');
    assert.equal(h.elements.get('key-badge').textContent, '已压缩 · 预估');
    assert.equal(h.elements.get('key-used').textContent, '~18K (7.0%)');
    assert.equal(h.elements.get('key-remaining').textContent, '~238K (93.0%)');
    assert.equal(h.elements.get('request-status').textContent, '已压缩（待下一轮实测校准）');
    assert.equal(h.elements.get('actual').textContent, '待压缩后首条消息返回');
    assert.equal(h.elements.get('percent').textContent, '~7.0%（按压缩后估算）');
    assert.match(h.elements.get('summaries').textContent, /共 1 次压缩（最近 #3）/);
    assert.match(h.elements.get('session-total').textContent, /150K–210K/, '技术明细抽屉应继续保留会话累计历史');

    // 4. 轮询防倒灌：后续 3s 轮询返回压缩前轮次 (#1) 与内部摘要器调用 (#3, 195K 输入) 时，绝不回跳至 80%
    nowMs += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    const summarizerRow = {
      stepIndices: [3],
      chatModel: {
        model: 'MODEL_FLASH_SUMMARIZER_INTERNAL',
        modelDisplayName: 'Internal Summarizer',
        usage: { inputTokens: 195000, outputTokens: 1500 }
      }
    };
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: [preTurnRow, summarizerRow] }) });
    await h.flush();

    assert.equal(api.snapshot().latest.compacted, true, '轮询到 <= lastCheckpointIndex 的记录不得覆盖压缩后状态');
    assert.equal(h.elements.get('amount').textContent, '~18K (7%)');
    assert.equal(h.host.getAttribute('data-occupancy'), 'normal');

    // 5. 三语实时切换验证（zh-TW 繁体无简体残留 / en 纯英文无汉字泄漏）
    h.elements.get('btn-top-lang-zh-TW').click();
    await h.flush();
    assert.equal(h.elements.get('key-badge').textContent, '已壓縮 · 預估');
    assert.equal(h.elements.get('ctx-tip-title').textContent, '上下文視窗（已壓縮 · 預估）：');
    assert.equal(h.elements.get('request-status').textContent, '已壓縮（待下一輪實測校準）');
    assert.equal(h.elements.get('actual').textContent, '待壓縮後首則訊息回傳');

    h.elements.get('btn-top-lang-en').click();
    await h.flush();
    assert.equal(h.elements.get('key-badge').textContent, 'Compacted · Est.');
    assert.equal(h.elements.get('ctx-tip-title').textContent, 'Context window (compacted · est.):');
    assert.equal(h.elements.get('request-status').textContent, 'Compacted (awaiting next turn calibration)');
    assert.equal(h.elements.get('actual').textContent, 'Pending first post-compact message');
    assert.match(h.elements.get('summaries').textContent, /1 compaction\(s\) \(latest #3\)/);
    assert.doesNotMatch(h.elements.get('key-takeaway').textContent, /[\u4e00-\u9fff]/);

    h.elements.get('btn-top-lang-zh-CN').click();
    await h.flush();

    // 6. 发送压缩后首条新消息（stepIndices=[5] > 3）：自动褪去 ~ 预估前缀，无缝切回服务端精确上报
    nowMs += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    const postCompactReplyRow = {
      stepIndices: [5],
      chatModel: {
        model: 'MODEL_GOOGLE_GEMINI_4_HYDROGEN_HIGH',
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        usage: { inputTokens: 20000, outputTokens: 480 },
        timeToFirstToken: '0.8s',
        streamingDuration: '2.0s',
        chatStartMetadata: {
          startStepIndex: 5,
          contextWindowMetadata: { estimatedTokensUsed: 19800, maxContextTokens: 256000 }
        }
      }
    };
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: [preTurnRow, summarizerRow, postCompactReplyRow] }) });
    await h.flush();

    assert.equal(Boolean(api.snapshot().latest.compacted), false, '收到压缩后新回复应退出 compacted 态');
    assert.equal(api.snapshot().latest.status, 'reported');
    assert.equal(h.elements.get('amount').textContent, '20.5K (8%)');
    assert.equal(h.elements.get('badge-pct-val').textContent, '8%');
    assert.equal(h.elements.get('key-badge').textContent, '正常');
    assert.equal(h.elements.get('request-status').textContent, '已返回实际统计');
    assert.equal(h.elements.get('actual').textContent, '20,480 tokens');
  } finally {
    api.dispose();
  }
});

test('/compact 100% 溢出自救与双通道感知：被动 WebSocket ContextWindowUsage 0ms 回落及宿主 DOM 横幅兜底触发', async () => {
  let nowMs = 1763510000000;
  class MockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  const cascadeId = '11111111-1111-1111-1111-111111111111';
  const overflowSession = {
    ...session(),
    steps: 11,
    checkpointCount: 1,
    lastCheckpointIndex: 4,
    currentError: {
      index: 10,
      text: 'The input token count exceeds the maximum number of tokens allowed 1048576.'
    }
  };
  const h = harness(overflowSession, { Date: MockDate });
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.contextMeterAPI.scan = (id, force = false) =>
    new Promise(resolve => h.scans.push({ id, force, resolve }));

  try {
    h.scans[0].resolve({ ok: true, data: { session: overflowSession, scannedAt: nowMs, generatorCount: 3, latest: null } });
    h.pending[0].resolve(response({
      retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }]
    }));
    await h.flush();

    assert.equal(h.elements.get('amount').textContent, '服务端超限');
    assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'exceeded');
    assert.equal(h.host.getAttribute('data-occupancy'), 'danger');

    // 1. 宿主在 #12 步完成第二次压缩并通过 WebSocket 推送 ContextWindowUsage（此时后台 scan 尚未返回）
    nowMs += 800;
    api.simulateHostWsMessageForTest({
      payload: {
        update: {
          conversationId: cascadeId,
          contextWindowUsage: {
            estimatedTokensUsed: 15360,
            maxContextTokens: 256000,
            lastStepIndex: 12,
            generatorMetadataIndex: 4,
            estimatedAfterCompaction: true
          }
        }
      }
    });

    // 0ms 即刻清除 100% 超限红环并回落至 15.4K (6%)，同时触发后台强制扫描
    assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'determinate');
    assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
    assert.equal(h.elements.get('amount').textContent, '~15.4K (6%)');
    assert.equal(h.elements.get('badge-pct-val').textContent, '~6%');
    assert.equal(h.elements.get('key-badge').textContent, '已压缩 · 预估');
    assert.equal(h.scans.length, 2);
    assert.equal(h.scans[1].force, true);

    const recoveredSession = {
      ...overflowSession,
      steps: 13,
      checkpointCount: 2,
      lastCheckpointIndex: 12,
      currentError: null,
      postCompactActiveTotal: { chars: 40000, low: 12000, high: 16000 }
    };
    h.scans[1].resolve({
      ok: true,
      data: {
        session: recoveredSession,
        scannedAt: nowMs,
        generatorCount: 4,
        latest: core.buildPostCompactSummary({ session: recoveredSession, previousLatest: { budget: 256000 } })
      }
    });
    await h.flush();
    assert.equal(h.elements.get('amount').textContent, '~15.4K (6%)');

    // 2. 宿主 DOM 自动压缩横幅兜底探测：覆盖长会话 (>900 个前置节点) + 逐字闪烁 span (children.length === 10)
    const leadingHistoryNodes = Array.from({ length: 900 }, (_, idx) => ({ textContent: `history row ${idx}`, children: [] }));
    const shimmerChars = Array.from('Compacting').map(ch => ({ textContent: ch, children: [] }));
    let mockDomNodes = [
      ...leadingHistoryNodes,
      { textContent: 'Compacting', children: shimmerChars }
    ];
    h.sandbox.document.querySelectorAll = () => mockDomNodes;
    nowMs += 1000;
    api.checkHostDomCompactionForTest();
    assert.equal(api.snapshot().compacting?.cascadeId, cascadeId, '长会话底部逐字闪烁的 Compacting 提示必须被逆序探测命中');
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');
    assert.equal(h.elements.get('key-badge').textContent, '压缩中…');

    mockDomNodes = [
      ...leadingHistoryNodes,
      { textContent: 'The conversation was compacted to fit within the context window.', children: [] }
    ];
    nowMs += 1000;
    api.checkHostDomCompactionForTest();
    assert.equal(h.scans.length, 3, '宿主压缩横幅出现且 Compacting 消失时应触发强制扫描');
    assert.equal(h.scans[2].force, true);
    h.scans[2].resolve({
      ok: true,
      data: {
        session: { ...recoveredSession, checkpointCount: 3, lastCheckpointIndex: 14 },
        scannedAt: nowMs,
        generatorCount: 4,
        latest: core.buildPostCompactSummary({ session: { ...recoveredSession, checkpointCount: 3, lastCheckpointIndex: 14 }, previousLatest: { budget: 256000 } })
      }
    });
    await h.flush();
    assert.equal(api.snapshot().compacting, null);

    // 3. SlashCommandScopeItem（Antigravity [>< compact] 胶囊：info.name = "compact"，无前导斜杠）直击检测
    const slashPillTok = h.sandbox.__AG_METER_ON_SEND_MESSAGE__({
      cascadeId,
      items: [{ item: { slashCommand: { info: { name: 'compact', displayName: 'compact' } } } }]
    });
    assert.ok(slashPillTok?.dispatchId?.startsWith('compact_'), 'SlashCommandScopeItem(name="compact") 必须立即触发压缩过渡态');
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');
    assert.equal(h.elements.get('key-badge').textContent, '压缩中…');
  } finally {
    api.dispose();
  }
});

test('/compact 二次长时压缩防闪回回归：保持压缩前 94% 用量不误算 7.35M、超 45s 宿主仍在压缩时不闪回 94%、完成直达 ~6%', async () => {
  let nowMs = 1763520000000;
  class MockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  const intervalCallbacks = [];
  const cascadeId = '11111111-1111-1111-1111-111111111111';

  const preSecondCompactSession = {
    ...session(),
    steps: 437,
    checkpointCount: 1,
    lastCheckpointIndex: 229,
    lastCheckpointFailed: false,
    inProgressCheckpointIndex: -1,
    lastAssistantAt: 436,
    lastModelStepAt: 436,
    postCheckpoint: {
      checkpointIndex: 229,
      textTotal: { chars: 20000000, bytes: 24000000, low: 6000000, high: 8700000 },
      mediaRefs: {}
    },
    postCompactActiveTotal: { chars: 20000000, bytes: 24000000, low: 6000000, high: 8700000 }
  };

  const preCompactRealLatest = {
    used: 483235,
    actual: 483235,
    estimate: 461654,
    budget: 512000,
    percent: (483235 / 512000) * 100,
    compacted: false,
    estimated: false,
    status: 'reported',
    model: 'Gemini 4 Carbon (High)',
    modelId: 'MODEL_GOOGLE_GEMINI_4_CARBON_HIGH',
    speed: { tps: 82.5, streamingTps: 82.5, duration: 32.6, ttft: 8.95, outputTokens: 1954 }
  };

  const h = harness(preSecondCompactSession, {
    Date: MockDate,
    setInterval(cb) {
      intervalCallbacks.push(cb);
      return intervalCallbacks.length;
    }
  });
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.contextMeterAPI.scan = (id, force = false) =>
    new Promise(resolve => h.scans.push({ id, force, resolve }));

  try {
    h.scans[0].resolve({
      ok: true,
      data: {
        session: preSecondCompactSession,
        scannedAt: nowMs,
        generatorCount: 48,
        preCompactLatest: preCompactRealLatest,
        latest: preCompactRealLatest
      }
    });
    h.pending[0].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [{
          chatModel: {
            model: 'MODEL_GOOGLE_GEMINI_4_CARBON_HIGH',
            modelDisplayName: 'Gemini 4 Carbon (High)',
            usage: { inputTokens: 481281, outputTokens: 1954 },
            chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 461654, maxContextTokens: 512000 } }
          }
        }]
      })
    });
    await h.flush();
    assert.equal(h.elements.get('badge-pct-val').textContent, '94%');
    assert.equal(h.elements.get('key-used').textContent, '483.2K (94.4%)');

    let mockDomNodes = [{ textContent: 'Compacting', children: [] }];
    h.sandbox.document.querySelectorAll = () => mockDomNodes;
    h.sandbox.__AG_METER_ON_SEND_MESSAGE__({
      cascadeId,
      items: [{ item: { slashCommand: { info: { name: 'compact' } } } }]
    });
    api.checkHostDomCompactionForTest();

    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');
    assert.equal(h.elements.get('key-badge').textContent, '压缩中…');
    assert.equal(h.elements.get('key-used').textContent, '483.2K (94.4%)', '二次压缩开始时应保留 483.2K');

    nowMs += 4000;
    const compactProbeCb = intervalCallbacks[intervalCallbacks.length - 1];
    compactProbeCb();
    assert.equal(h.scans.length, 2);
    h.scans[1].resolve({
      ok: true,
      data: {
        session: preSecondCompactSession,
        scannedAt: nowMs,
        generatorCount: 48,
        preCompactLatest: preCompactRealLatest,
        latest: preCompactRealLatest
      }
    });
    await h.flush();

    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');
    assert.equal(h.elements.get('key-used').textContent, '483.2K (94.4%)', '二次压缩期间严禁回退旧检查点 229 误算出 ~7.35M (100.0%)');

    mockDomNodes = [{ textContent: 'Compacting · 46s', children: [] }];
    nowMs += 42000;
    compactProbeCb();
    if (h.scans.length > 2) {
      h.scans[h.scans.length - 1].resolve({
        ok: true,
        data: {
          session: preSecondCompactSession,
          scannedAt: nowMs,
          generatorCount: 48,
          preCompactLatest: preCompactRealLatest,
          latest: preCompactRealLatest
        }
      });
      await h.flush();
    }
    assert.equal(api.snapshot().compacting?.domEndedAtMs, 0);
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');

    mockDomNodes = [{ textContent: 'Compacting · 1m 5s', children: [] }];
    nowMs += 19000;
    compactProbeCb();
    if (h.scans.length > 3) {
      h.scans[h.scans.length - 1].resolve({
        ok: true,
        data: {
          session: preSecondCompactSession,
          scannedAt: nowMs,
          generatorCount: 48,
          preCompactLatest: preCompactRealLatest,
          latest: preCompactRealLatest
        }
      });
      await h.flush();
    }
    assert.ok(api.snapshot().compacting);
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');

    mockDomNodes = [{ textContent: '1m ago', children: [] }];
    nowMs += 1000;
    const scansBeforeDone = h.scans.length;
    api.checkHostDomCompactionForTest();
    assert.equal(h.scans.length, scansBeforeDone + 1);
    assert.equal(h.elements.get('badge-pct-val').textContent, '压缩中…');

    const postSecondCompactSession = {
      ...preSecondCompactSession,
      steps: 439,
      checkpointCount: 2,
      lastCheckpointIndex: 438,
      postCheckpoint: {
        checkpointIndex: 438,
        textTotal: { chars: 12000, bytes: 15000, low: 3500, high: 5500 },
        mediaRefs: {}
      },
      postCompactActiveTotal: { chars: 96000, bytes: 110000, low: 26000, high: 35000 }
    };
    const postSecondCompactLatest = core.buildPostCompactSummary({
      session: postSecondCompactSession,
      previousLatest: preCompactRealLatest
    });
    h.scans[h.scans.length - 1].resolve({
      ok: true,
      data: {
        session: postSecondCompactSession,
        scannedAt: nowMs,
        generatorCount: 49,
        preCompactLatest: preCompactRealLatest,
        latest: postSecondCompactLatest
      }
    });
    await h.flush();

    assert.equal(api.snapshot().compacting, null);
    assert.equal(h.elements.get('badge-pct-val').textContent, '~6%');
    assert.equal(h.elements.get('key-badge').textContent, '已压缩 · 预估');
    assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
  } finally {
    api.dispose();
  }
});

test('ELV-95: renderSessionTimeline 渲染五类上下文变化事件及前后 Token 差值', async () => {
  const cascadeId = '11111111-1111-1111-1111-111111111111';
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.sandbox.window.contextMeterAPI.getSessionTimeline = async () => ({
    ok: true,
    data: {
      cascadeId,
      turns: [{ turnIndex: 1, stepIndex: 0, preview: 'hi', callCount: 1, inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200, calls: [] }],
      unlinkedSubagentCalls: [],
      totalCalls: 1,
      mainCallsCount: 1,
      subagentCallsCount: 0,
      cacheSummary: { cacheStatus: 'zero_cache', cacheReadPct: 0 },
      contextChangeEvents: [
        { type: 'compaction', stepIndex: 3, detail: '#3', beforeTokens: 120000, afterTokens: 14500, deltaTokens: -105500 },
        { type: 'inject', stepIndex: 4, detail: 'post-compact-rehydrate', beforeTokens: 14500, afterTokens: 15800, deltaTokens: 1300 },
        { type: 'model', stepIndex: 5, detail: 'Carbon → Hydrogen', beforeTokens: 15800, afterTokens: 16000, deltaTokens: 200 }
      ]
    }
  });
  const collectText = (node) => {
    if (!node) return '';
    const own = node.textContent ? String(node.textContent) : '';
    const kids = Array.isArray(node.children) ? node.children.map(collectText).join(' ') : '';
    return `${own} ${kids}`.trim();
  };
  try {
    h.elements.get('btn-session-history-toggle').click();
    await h.flush();
    const eventsEl = h.elements.get('session-timeline-events');
    assert.equal(eventsEl.hidden, false, '应显示 session-timeline-events 容器');
    const txt = collectText(eventsEl);
    assert.match(txt, /上下文变化事件 \(3\)/);
    assert.match(txt, /120K → 14.5K/);
    assert.match(txt, /post-compact-rehydrate/);
    assert.match(txt, /Carbon → Hydrogen/);
  } finally {
    api.dispose();
  }
});

test('Step 6: 2.34.0 Rich Text 对话可点与顶栏强制 no-drag，进 Customizations/Installed 自动收起并禁开', async () => {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const docListeners = new Map();
  const createdEls = [];
  let isMarketplace = false;
  let capturedObserverCb = null;
  const scheduledTimers = [];

  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        pointerEvents: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [],
      hidden: false,
      textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', cur.join(' '));
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); },
        toggle(c, force) {
          const has = this.contains(c);
          const want = force !== undefined ? Boolean(force) : !has;
          if (want) this.add(c); else this.remove(c);
          return want;
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) {
        if (k === 'id') {
          const id = attrs.get('id');
          if (id && docElements.get(id) === el) docElements.delete(id);
        }
        attrs.delete(k);
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx >= 0) this.parentElement.children.splice(idx, 1);
        }
      },
      appendChild(x) {
        if (x) {
          x.parentElement = this;
          this.children.push(x);
          const xId = x.id || x.getAttribute?.('id');
          if (xId) docElements.set(xId, x);
        }
      },
      contains(target) {
        if (!target) return false;
        if (target === el) return true;
        return Array.isArray(el.children) && el.children.some(c => c && (c === target || c.contains?.(target)));
      },
      closest() { return null; },
      querySelectorAll(sel) {
        const found = [];
        const check = node => {
          if (!node) return;
          if (sel === '#ag-wco-spacer' && (node.id === 'ag-wco-spacer' || node.getAttribute?.('id') === 'ag-wco-spacer')) found.push(node);
          if (Array.isArray(node.children)) node.children.forEach(check);
        };
        this.children.forEach(check);
        return found;
      },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };

  const host = element();
  host.isConnected = true;
  let rehydrateTriggerClicks = 0;
  let proxyTriggerClicks = 0;
  const preRehydrateCard = element();
  preRehydrateCard.classList.add('ctx-settings-card');
  preRehydrateCard.closest = () => null;
  preRehydrateCard.querySelector = s => s === '.drawer-trigger'
    ? { getAttribute: () => 'false', click: () => { rehydrateTriggerClicks++; } }
    : null;
  elements.set('rehydrate-hook-card', preRehydrateCard);
  const preProxyDrawer = element();
  preProxyDrawer.classList.add('tech-drawer');
  preProxyDrawer.closest = () => null;
  preProxyDrawer.querySelector = s => s === '.drawer-trigger'
    ? { getAttribute: () => 'false', click: () => { proxyTriggerClicks++; } }
    : null;
  elements.set('proxy-notun-drawer', preProxyDrawer);
  host.attachShadow = () => ({
    set innerHTML(_) { },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  });
  const pending = [];
  const scans = [];
  const composerNode = { tagName: 'DIV', isContentEditable: true, getAttribute: () => null };
  const marketplaceHeading = { textContent: 'Installed', closest: () => null };
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      body: element(),
      head: element(),
      documentElement: element(),
      createElement() {
        if (first) { first = false; return host; }
        const n = element();
        createdEls.push(n);
        return n;
      },
      getElementById: id => docElements.get(id) || null,
      querySelector(sel) {
        if (!isMarketplace && sel && sel.includes('[contenteditable="true"]')) return composerNode;
        if (isMarketplace && sel && sel.includes('marketplace')) return null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel && sel.includes('[role="heading"]')) {
          return isMarketplace ? [marketplaceHeading] : [{ textContent: 'Installed', closest: () => null }];
        }
        return [];
      },
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
      dispatchEvent(ev) {
        const type = ev?.type || ev;
        for (const fn of (docListeners.get(type) || [])) fn(ev);
      },
      hidden: false
    },
    window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    MutationObserver: function (cb) {
      capturedObserverCb = cb;
      return { observe() { }, disconnect() { } };
    },
    setTimeout(fn, ms) {
      scheduledTimers.push({ fn, ms });
      return scheduledTimers.length;
    },
    clearTimeout() { },
    setInterval: () => 1,
    clearInterval() { },
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve }))
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  try {
    scans[0]?.resolve({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } });
    pending[0]?.resolve(response({ usage: { inputTokens: 1000 } }));
    await new Promise(r => setImmediate(r));

    const badge = elements.get('badge');
    const panel = elements.get('panel');
    // 1. 注入 WCO 样式必须强制顶栏可点击且 no-drag
    const wcoStyle = docElements.get('ag-topbar-host-fix') || createdEls.find(n => String(n.textContent || '').includes('#ag-context-meter') && String(n.textContent || '').includes('-webkit-app-region: no-drag !important'));
    assert.ok(wcoStyle && String(wcoStyle.textContent).includes('-webkit-app-region: no-drag !important; pointer-events: auto;'));

    // 2. 2.34.0 Rich Text 对话页不应误判 Marketplace，点击顶栏打开面板
    isMarketplace = false;
    badge.click();
    assert.equal(panel.hidden, false, '有 [contenteditable="true"] 的对话页点击顶栏应打开面板');

    // 3. 切入 Customizations / Installed（无输入框 + Installed 标题）触发 DOM 变更应自动收起并禁止重新打开
    isMarketplace = true;
    const beforeLen = scheduledTimers.length;
    if (typeof capturedObserverCb === 'function') {
      capturedObserverCb([{ type: 'childList', addedNodes: [{}] }]);
    }
    for (const item of scheduledTimers.slice(beforeLen)) {
      try { item.fn(); } catch { }
    }
    assert.equal(panel.hidden, true, '进入 Installed 页面后已打开面板应自动收起');
    badge.click();
    assert.equal(panel.hidden, true, '在 Installed 页面顶栏点击不应重新打开面板');

    // 4. 返回对话后可手动打开
    isMarketplace = false;
    badge.click();
    assert.equal(panel.hidden, false, '返回聊天页后点击顶栏应恢复打开');

    // 5. 配置页快捷导航：点卡片不误展开内部抽屉，点 .tech-drawer 自动展开
    const quickNav = elements.get('settings-quick-nav-group');
    quickNav.children = [];
    quickNav.trigger('click', {
      currentTarget: quickNav,
      target: { closest: () => ({ getAttribute: k => k === 'data-nav-target' ? 'rehydrate-hook-card' : null, classList: { toggle() { } } }) }
    });
    assert.equal(rehydrateTriggerClicks, 0, '点击卡片快捷导航不得误展开内部附属技术抽屉');
    quickNav.trigger('click', {
      currentTarget: quickNav,
      target: { closest: () => ({ getAttribute: k => k === 'data-nav-target' ? 'proxy-notun-drawer' : null, classList: { toggle() { } } }) }
    });
    assert.equal(proxyTriggerClicks, 1, '点击 .tech-drawer 快捷导航应自动展开对应抽屉');
  } finally {
    sandbox.__AGContextMeter.dispose();
  }
});

test('Step 6: aux/page 停靠 data-panel-docked、返回聊天仅 page 显示、配置页无残留、导航不误展开抽屉、无 600K 硬编码及 rgb 标题栏适配', async () => {
  const overlayCalls = [];
  const extScans = [];
  const h = harness(session(), {
    getComputedStyle: () => ({
      getPropertyValue: k => k === '--vscode-titleBar-activeBackground' ? 'rgb(30, 31, 34)' : ''
    }),
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: id => new Promise(resolve => extScans.push({ id, resolve })),
        getSettings: async () => ({ ok: true, settings: {} })
      },
      electronNative: {
        setTitleBarOverlay: opts => overlayCalls.push(opts)
      }
    }
  });
  try {
    extScans[0]?.resolve({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } });
    h.pending[0]?.resolve(response({ usage: { inputTokens: 1000 } }));
    await h.flush();

    // 1. colors.js 应能解析 rgb(30, 31, 34) 为 #1e1f22 同步给原生标题栏覆盖按钮
    h.elements.get('theme-toggle').click();
    assert.ok(overlayCalls.some(o => o && o.color === '#1e1f22'), `应把 rgb(30, 31, 34) 转为 #1e1f22，实际: ${JSON.stringify(overlayCalls)}`);

    // 2. 停靠位置与“返回聊天”可见性（挂接右栏与编辑器宿主容器）
    const makeDockContainer = () => ({
      firstChild: null,
      children: [],
      appendChild(n) { n.parentElement = this; this.children.push(n); this.firstChild = this.children[0] || n; },
      insertBefore(n) { this.appendChild(n); }
    });
    const auxContainer = makeDockContainer();
    const pageContainer = makeDockContainer();
    h.sandbox.document.querySelector = sel => {
      if (sel && sel.includes('auxiliarybar')) return auxContainer;
      if (sel && sel.includes('workbench.parts.editor')) return pageContainer;
      return null;
    };
    const panel = h.elements.get('panel');
    const backBtn = h.elements.get('btn-dock-page-back');
    h.sandbox.__AGContextMeter.setDockPosition('aux');
    assert.equal(panel.getAttribute('data-panel-docked'), 'true');
    assert.equal(backBtn.hidden, true, 'aux 模式不显示返回聊天按钮');

    h.sandbox.__AGContextMeter.setDockPosition('page');
    assert.equal(panel.getAttribute('data-panel-docked'), 'true');
    assert.equal(backBtn.hidden, false, '仅 page 独立页面显示返回聊天按钮');

    h.sandbox.__AGContextMeter.setDockPosition('flow');
    assert.equal(panel.getAttribute('data-panel-docked'), null);
    assert.equal(backBtn.hidden, true, 'flow 模式隐藏返回聊天按钮');

    // 3. 配置页切换其它三页时 pane-ctx-settings 无残留高度；快捷导航仅自动展开 .tech-drawer
    h.sandbox.__AGContextMeter.openContextSettingsForTest({ forceFallbackPane: true });
    const paneSettings = h.elements.get('pane-ctx-settings');
    assert.equal(paneSettings.hidden, false);
    assert.equal(paneSettings.style.display, '');

    h.elements.get('tab-ctx-models').click();
    assert.equal(paneSettings.hidden, true);
    assert.equal(paneSettings.style.display, 'none');

    // 4. 输入框状态条：缺失上限与 Token 时全显示 — 且绝无硬编码 600K；速度直达 context/speed；离开 5 行卡同步零残留
    h.sandbox.__AGContextMeter.setComposerStateForTest({ sessionStats: { usedTokens: 50000 } });
    assert.equal(h.elements.get('csb-context-text').textContent, '--%');
    assert.equal(String(h.elements.get('csb-group-context').title || ''), '', '原生 title 必须清空以消除系统黑框双气泡');
    assert.doesNotMatch(String(h.elements.get('csb-group-context').getAttribute('data-tooltip') || ''), /600K/);
    assert.match(String(h.elements.get('csb-group-context').getAttribute('data-tooltip') || ''), /—/);

    // 验证全空时显示 —
    const hEmpty = harness();
    try {
      const csbEmpty = hEmpty.sandbox.__AGContextMeter.getComposerStatusBarStateForTest();
      assert.match(csbEmpty.tokensText, /—/);
      assert.equal(csbEmpty.cardTotal, '—');
      assert.equal(csbEmpty.cardUncached, '—');

      hEmpty.elements.get('csb-group-speed').click();
      assert.equal(hEmpty.elements.get('panel').hidden, false, '点击底栏速度项直达速度对比视图');
      assert.equal(hEmpty.elements.get('tab-ctx-speed').classList.contains('active'), true);
      // 二次点击同视图关闭
      hEmpty.elements.get('csb-group-speed').click();
      assert.equal(hEmpty.elements.get('panel').hidden, true, '再次点击底栏速度项关闭面板');

      const tokBtn = hEmpty.elements.get('csb-group-tokens');
      const card = hEmpty.elements.get('csb-card-tokens');
      tokBtn.trigger('mouseenter');
      assert.equal(card.hidden, false);
      assert.equal(card.style.display, '');
      tokBtn.trigger('mouseleave');
      assert.equal(card.hidden, true);
      assert.equal(card.style.display, 'none');
      assert.equal(card.style.pointerEvents, 'none');
    } finally {
      hEmpty.sandbox.__AGContextMeter.dispose();
    }
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('会话深度剖析桌面 UI: 注入/技能组成对照与时间线 5 视图 (Delta/耗时/文件/命令/Agent家族) 渲染', async () => {
  const extScans = [];
  const collectText = (node) => {
    if (!node) return '';
    const kids = Array.isArray(node.children) && node.children.length > 0
      ? node.children.map(collectText).join(' ')
      : '';
    return kids || String(node.textContent || '');
  };
  const timelineMock = {
    cascadeId: 'c1',
    totalCalls: 2,
    mainCallsCount: 1,
    subagentCallsCount: 1,
    cacheSummary: { evaluatedRequestCount: 2, totalInput: 10000, totalUncachedInput: 4000, totalCacheRead: 6000, cacheReadPct: 60, cacheStatus: 'hit' },
    contextDeltaSummary: { initialContextTokens: 4000, latestContextTokens: 12000, netDeltaTokens: 8000, maxJumpCallId: 'c2', maxJumpDeltaTokens: 8000 },
    timingSummary: { totalTtftSec: 1.5, ttftCount: 2, totalStreamingSec: 6.0, streamingCount: 2, totalToolExecSec: 2.5, toolExecCount: 2, activeWallSec: 10.0, ttftPct: 15, streamingPct: 60, toolExecPct: 25 },
    fileActivities: [
      { path: 'D:/repo/meter-core.js', basename: 'meter-core.js', readCount: 2, writeCount: 1, searchCount: 0, totalCount: 3, addedLines: 14, removedLines: 2, turnNumbers: [1] }
    ],
    commandExecutions: [
      { id: 'cmd-1', stepIndex: 2, turnNumber: 1, program: 'node', command: 'node test.js --token ***', status: 'failed', isSlow: true, isBackground: false, durationSec: 6.1 }
    ],
    agentFleetSummary: {
      mainAgent: { callCount: 1, models: ['Gemini 4'], totalTokens: 12000 },
      subagents: [{ childCid: 'sub-1', type: 'research', callCount: 1, models: ['Gemini Flash'], totalTokens: 2000 }],
      unlinkedCount: 0,
      mainOnlyTotalTokens: 12000,
      fleetCombinedTotalTokens: 14000,
      dedupVerified: true
    },
    turns: [
      {
        turnIndex: 1, stepIndex: 0, preview: 'inspect repo',
        inputTokens: 4000, cacheReadTokens: 6000, outputTokens: 300,
        lastContextTokens: 12000, deltaFromPrevTurn: 8000,
        calls: [
          { callId: 'c2', stepIndex: 3, modelLabel: 'Gemini 4', agentRole: 'main', hasInputCacheFields: true, inputTokens: 4000, cacheReadTokens: 8000, totalInputTokens: 12000, outputTokens: 300, contextWindowTokens: 12000, deltaFromPrevStep: 8000, isMaxContextJump: true, outcomeStatus: 'success', created_at: '2026-11-22T01:00:05Z' }
        ]
      }
    ],
    unlinkedSubagentCalls: [],
    contextChangeEvents: []
  };
  const h = harness(session(), {
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: id => new Promise(resolve => extScans.push({ id, resolve })),
        getSettings: async () => ({ ok: true, settings: {} }),
        getSessionTimeline: async () => ({ ok: true, data: timelineMock })
      }
    }
  });
  try {
    const baseSess = session();
    const sessWithSub = {
      ...baseSess,
      groups: {
        ...baseSess.groups,
        user: { chars: 4000, bytes: 4000, low: 800, high: 1200 }
      },
      compositionSubgroups: {
        injections: { chars: 1200, bytes: 1200, low: 300, high: 500 },
        skills: { chars: 400, bytes: 400, low: 100, high: 200 },
        injectionCount: 2,
        skillCount: 1
      }
    };
    extScans[0]?.resolve({ ok: true, data: { session: sessWithSub, scannedAt: Date.now(), latest: { actual: 9000 } } });
    h.pending[0]?.resolve(response({ usage: { inputTokens: 9000, outputTokens: 200 } }));
    await h.flush();

    assert.match(h.elements.get('injections').textContent, /2/);
    assert.match(h.elements.get('skills').textContent, /1/);
    assert.match(h.elements.get('composition-gap').textContent, /9\.2K|9K|9000/);

    // 展开历史时间线抽屉并逐项验证 5 个洞察标签页及 Δ 切换
    h.elements.get('btn-session-history-toggle').click();
    await h.flush();
    assert.equal(h.elements.get('session-timeline-drawer').style.display, 'flex');
    assert.match(collectText(h.elements.get('session-timeline-summary')), /\+8K|8K/);

    const bar = h.elements.get('timeline-insight-bar');
    const clickTab = tabName => bar.trigger('click', {
      currentTarget: bar,
      target: { getAttribute: k => k === 'data-tl-tab' ? tabName : null }
    });

    const insightBody = h.elements.get('session-timeline-insight-body');
    clickTab('timing');
    assert.equal(insightBody.hidden, false);
    assert.match(collectText(insightBody), /10s|10\.0|60%/);

    clickTab('files');
    assert.match(collectText(insightBody), /meter-core\.js/);

    clickTab('commands');
    const cmdTxt = collectText(insightBody);
    assert.match(cmdTxt, /\*\*\*/);
    assert.match(cmdTxt, /node/);

    clickTab('fleet');
    assert.match(collectText(insightBody), /12K.*14K/);

    clickTab('turns');
    assert.equal(insightBody.hidden, true);
    bar.trigger('click', {
      currentTarget: bar,
      target: { id: 'btn-timeline-delta-mode', getAttribute: () => null }
    });
    assert.equal(h.elements.get('btn-timeline-delta-mode').getAttribute('aria-pressed'), 'true');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('2.34.0 Hub DOM 停靠、分屏/Side Chat 右侧打开精确传参、点击固定 5 行卡、分段条 75/90 阈值与每轮尾部微徽标', async () => {
  const openCalls = [];
  const savedPayloads = [];
  const makeContainer = () => ({
    children: [],
    appendChild(n) { n.parentElement = this; this.children.push(n); this.firstChild = this.children[0] || n; },
    insertBefore(n) { this.appendChild(n); }
  });
  const hubConvParent = makeContainer();
  const hubConvView = { parentElement: hubConvParent };
  const auxBox = makeContainer();
  const sideFooterList = [];
  const makeToolbar = (sideQuestion = false) => {
    const row = {
      children: [],
      prepend(n) { n.parentElement = this; this.children.unshift(n); },
      appendChild(n) { n.parentElement = this; this.children.push(n); },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      }
    };
    return {
      firstElementChild: row,
      row,
      getAttribute: k => (sideQuestion && k === 'data-side-question' ? 'true' : null)
    };
  };
  const tbMain = makeToolbar(false);
  const tbSide = makeToolbar(true);

  let currentTabs = [];
  let currentTabNodes = [];
  const h = harness(session(), {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', search: '' }
  });
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    openDashboardBrowser: async (opts) => {
      openCalls.push(opts);
      const q = opts?.sessionId ? `/?sessionId=${encodeURIComponent(opts.sessionId)}&source=${opts.source || 'desktop'}` : '';
      return { ok: true, baseUrl: 'http://127.0.0.1:56780', url: `http://127.0.0.1:56780${q}`, openedExternal: Boolean(opts?.openExternal) };
    },
    saveSettings: async (payload) => { savedPayloads.push(payload); return { ok: true }; }
  };
  h.sandbox.document.querySelector = sel => {
    if (sel && sel.includes('data-aux-pane-focus-scope')) return auxBox;
    if (sel && sel.includes('conversation-view')) return hubConvView;
    return null;
  };
  h.sandbox.document.querySelectorAll = sel => {
    if (sel && sel.includes('data-tab-id')) return currentTabNodes;
    if (sel && sel.includes('cascade-system-message-toolbar')) return [tbMain, tbSide];
    if (sel && sel.includes('.ag-cm-turn-footer')) {
      return [tbMain.row.children[0], tbSide.row.children[0]].filter(Boolean);
    }
    return [];
  };

  try {
    const api = h.sandbox.__AGContextMeter;
    api.setTurnFooterStatsEnabledForTest(true);

    // 1. 2.34.0 Hub DOM (无 workbench.parts.editor) 下 page 模式直接挂载到 Hub 主视图且不回退
    api.setDockPosition('page');
    assert.equal(api.getDockPosition().actualDock, 'page');
    assert.equal(api.getDockPosition().fallbackReason, '');
    assert.equal(h.elements.get('btn-dock-page-back').hidden, false);
    h.elements.get('btn-dock-page-back').click();
    assert.equal(api.getDockPosition().dockPosition, 'flow');
    assert.equal(h.elements.get('btn-dock-page-back').hidden, true);

    // 2. 右侧打开与外部浏览器打开分别传 openExternal: false / true 且精准跟随会话 A -> B -> Side Chat
    await api.openDashboardInRightPanelForTest();
    assert.equal(openCalls[0].sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(openCalls[0].source, 'desktop');
    assert.equal(openCalls[0].openExternal, false);

    // 切到会话 B 并触发宿主路由轮询提交聚焦态
    h.sandbox.location.pathname = '/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    h.tick();
    await api.openStandaloneBrowserPageForTest();
    assert.equal(openCalls[1].sessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(openCalls[1].openExternal, true);

    // 激活 Side Chat tab 并选中 Side Question 视角
    currentTabNodes = [{
      getAttribute: k => (k === 'data-tab-id' ? 'side_question__cccccccc-cccc-4ccc-8ccc-cccccccccccc' : (k === 'aria-selected' ? 'true' : null)),
      className: 'bg-secondary',
      textContent: 'Side Question'
    }];
    h.tick();
    assert.equal(api.selectConversationScopeForTest('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), true);
    await api.openDashboardInRightPanelForTest();
    assert.equal(openCalls[2].sessionId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(openCalls[2].openExternal, false);

    // 无法解析会话 ID 时传 null，绝不瞎猜
    h.sandbox.location.pathname = '/home';
    currentTabNodes = [];
    h.tick();
    await api.openDashboardInRightPanelForTest();
    assert.equal(openCalls[3].sessionId, null);

    // 恢复正常会话路线供后续检查
    h.sandbox.location.pathname = '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    h.tick();

    // 3. 输入框 4 态运行态、分段条 (>=75% warning)、点击固定 5 行卡与 Esc 关闭
    api.setContextLatestForTest({ model: 'Gemini 3.8 Flash', actual: 160000, budget: 200000 });
    api.setComposerStateForTest({
      sessionCalls: [{
        callId: 'c-turn-1',
        modelLabel: 'Gemini 3.8 Flash',
        inputTokens: 30000,
        cacheCreationInputTokens: 10000,
        cacheReadTokens: 118000,
        outputTokens: 2000,
        streamingTps: 145
      }],
      sessionStats: { usedTokens: 160000, limitTokens: 200000, turnCount: 1, stepCount: 2 }
    });
    const csbSnap = api.getComposerStatusBarStateForTest();
    assert.equal(csbSnap.runtimeState, 'idle');
    assert.equal(csbSnap.segThreshold, 'warning');
    assert.match(csbSnap.segLegend, /32\.0K|118\.0K/);

    const statusBtn = h.elements.get('csb-group-status');
    const tokBtn = h.elements.get('csb-group-tokens');
    const card = h.elements.get('csb-card-tokens');
    // 悬停 Token 胶囊预览、移开关闭；状态胶囊取消点击收敛为纯遥测展示
    tokBtn.trigger('mouseenter');
    assert.equal(card.hidden, false);
    tokBtn.trigger('mouseleave');
    assert.equal(card.hidden, true);

    statusBtn.click();
    assert.equal(card.hidden, true, '状态胶囊收敛不误弹浮卡');
    assert.equal(api.getComposerStatusBarStateForTest().cardPinned, false);

    // 4. 每轮回复尾部统计微徽标（主区 + Side Chat toolbar）及配置开关持久化
    assert.ok(tbMain.row.children[0].textContent.includes('Gemini 3.8 Flash'));
    assert.match(tbSide.row.children[0].textContent, /缓存|Cache/);
    const footerSwitch = h.elements.get('chk-show-turn-footer-stats');
    footerSwitch.checked = false;
    footerSwitch.trigger('change', { target: footerSwitch });
    assert.equal(api.getTurnFooterStatsForTest().enabled, false);
    assert.equal(tbMain.row.children.length, 0);
    assert.ok(savedPayloads.some(p => p.showTurnFooterStats === false));
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1 实机停靠修复: hidden 停靠面板零高度折叠、page 偏好不跨重启锁死、异步标题栏延迟重挂', async () => {
  // 1. 验证 styles.css 与最新构建产物包含 aux/page 隐藏面板 display:none 与限高规则
  const cssRaw = fs.readFileSync(require('node:path').join(__dirname, 'src/renderer/styles.css'), 'utf8');
  assert.match(cssRaw, /:host\(\[data-dock="aux"\]\) \.ag-panel\[data-panel-docked="true"\]\[hidden\],\s*:host\(\[data-dock="page"\]\) \.ag-panel\[data-panel-docked="true"\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.doesNotMatch(cssRaw, /:host\(\[data-dock="page"\]\) \.ag-panel\[data-panel-docked="true"\][^}]*max-height:\s*none/);

  // 2. 冷启动时若 localStorage 与宿主 getSettings() 均残存历史 page 模式，自动归位为 flow 并清理设置
  const savedBatch = [];
  const lStore = new Map([['ag_dock_position', 'page']]);
  const titlebarEl = {
    className: 'flex items-center justify-between @container/titlebar',
    children: [],
    firstElementChild: { scrollWidth: 80 },
    lastElementChild: null,
    querySelector() { return null; },
    contains(node) { return this.children.includes(node) || node?.parentElement === this; },
    appendChild(n) { n.parentElement = this; this.children.push(n); },
    insertBefore(n, ref) {
      const existingIdx = this.children.indexOf(n);
      if (existingIdx >= 0) this.children.splice(existingIdx, 1);
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, n);
      else this.children.unshift(n);
      n.parentElement = this;
    },
    getBoundingClientRect: () => ({ top: 35, left: 257, right: 1329, width: 1072, height: 40 })
  };
  let titlebarReady = false;
  let observerCb = null;
  const scheduledTimeouts = [];
  const docBody = {
    children: [],
    appendChild(n) { n.parentElement = this; if (!this.children.includes(n)) this.children.push(n); },
    contains(n) { return this.children.includes(n); }
  };

  // 构建带 body、MutationObserver 与可控 setTimeout 的延迟标题栏沙盒
  const lateDocElements = new Map();
  const lateDocListeners = new Map();
  const mkSimpleEl = () => ({
    style: { setProperty() { }, removeProperty() { }, getPropertyValue() { return ''; } },
    children: [], childNodes: [], hidden: false, textContent: '',
    classList: { add() { }, remove() { }, contains() { return false; } },
    addEventListener() { }, setAttribute() { }, getAttribute() { return null; }, removeAttribute() { },
    appendChild() { }, replaceChildren() { }, querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 })
  });
  const editorPageContainer = {
    firstChild: null,
    children: [],
    appendChild(n) { n.parentElement = this; this.children.push(n); if (!this.firstChild) this.firstChild = n; },
    insertBefore(n, ref) { n.parentElement = this; this.children.unshift(n); this.firstChild = n; },
    contains(n) { return this.children.includes(n); }
  };
  const convViewNode = { parentElement: editorPageContainer };
  const h = harness(undefined, {
    localStorage: {
      getItem: k => lStore.get(k) || null,
      setItem: (k, v) => lStore.set(k, String(v)),
      removeItem: k => lStore.delete(k)
    },
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe() { }
      disconnect() { }
    },
    setTimeout(fn, delay) {
      if (typeof fn === 'function' && delay === 60) {
        scheduledTimeouts.push(fn);
      }
      return scheduledTimeouts.length;
    },
    document: {
      body: docBody,
      head: { appendChild() { } },
      hidden: false,
      createElement: () => mkSimpleEl(),
      getElementById: id => lateDocElements.get(id) || null,
      documentElement: { appendChild() { } },
      querySelector: sel => {
        if (titlebarReady && sel && sel.includes('@container/titlebar')) return titlebarEl;
        if (sel && sel.includes('conversation-view')) return convViewNode;
        return null;
      },
      querySelectorAll: sel => (titlebarReady && sel && sel.includes('@container/titlebar') ? [titlebarEl] : []),
      addEventListener(type, fn) {
        if (!lateDocListeners.has(type)) lateDocListeners.set(type, new Set());
        lateDocListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { lateDocListeners.get(type)?.delete(fn); },
      dispatchEvent(ev) { for (const fn of (lateDocListeners.get(ev?.type || ev) || [])) fn(ev); }
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } }),
        getSettings: async () => ({ ok: true, dockPosition: 'page', uiPreferences: { dockPosition: 'page' } }),
        saveSettings: async (p) => { savedBatch.push(p); return { ok: true }; }
      }
    }
  });

  try {
    const api = h.sandbox.__AGContextMeter;
    await h.flush();
    assert.equal(api.getDockPosition().dockPosition, 'flow', '冷启动历史 page 必须自动安全归位为 flow');
    assert.ok(savedBatch.some(p => p.dockPosition === 'flow'), '应清理历史 page 脏设置');
    assert.equal(h.host.parentElement, docBody, '标题栏未渲染前先暂时落入 document.body');

    // 3. 模拟 React 延迟渲染出 @container/titlebar，并测试 compact 模式与回退态均会重挂载到顶栏
    api.setDockPosition('compact');
    assert.equal(api.getDockPosition().actualDock, 'compact');
    titlebarReady = true;
    assert.equal(typeof observerCb, 'function');
    observerCb();
    const timerFn = scheduledTimeouts.pop();
    assert.equal(typeof timerFn, 'function');
    timerFn();
    assert.equal(titlebarEl.contains(h.host), true, 'compact 模式下标题栏延迟渲染后必须重挂载入顶栏');

    // 4. 运行期显式切到 page 时仅会话内有效，写入持久化偏好保持 flow，且切回 flow 必须清除 static 防止面板被顶栏裁切
    api.setDockPosition('page');
    api.repositionPanelsForTest();
    assert.equal(api.getDockPosition().actualDock, 'page');
    assert.equal(h.elements.get('panel').style.position, 'static');
    assert.equal(lStore.get('ag_dock_position'), 'flow', 'page 模式不得覆盖 localStorage 为 page');
    assert.equal(savedBatch.at(-1)?.dockPosition, 'flow', 'page 模式不得持久化为重启后的 page 锁死');

    api.setDockPosition('flow');
    api.repositionPanelsForTest();
    assert.equal(api.getDockPosition().actualDock, 'flow');
    assert.equal(h.elements.get('panel').style.position, '', '从 page 切回 flow 必须清除 inline position: static');
    assert.match(h.elements.get('panel').style.top, /^\d+px$/, '切回 flow 后必须重新计算有效的固定定位 top');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('ELV-94 2.34.0 右侧辅助栏 [data-side-panel-open="true"] 识别、展开防反关、切会话跟随与退出返回', async () => {
  let toggleClicks = 0;
  let auxExpanded = false;
  const sidePanelScopeEl = {
    children: [],
    style: {},
    parentElement: null,
    contains(n) { return this.children.includes(n); },
    appendChild(n) { n.parentElement = this; this.children.push(n); },
    insertBefore(n, ref) {
      const existingIdx = this.children.indexOf(n);
      if (existingIdx >= 0) this.children.splice(existingIdx, 1);
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, n);
      else this.children.unshift(n);
      n.parentElement = this;
    },
    querySelector(s) {
      if (s && s.includes('data-side-panel-strip')) return { getAttribute: () => 'true' };
      return null;
    },
    getBoundingClientRect: () => ({ width: auxExpanded ? 773 : 0, height: 865, top: 35, left: 649 })
  };
  const toggleBtn = {
    getAttribute(k) { return k === 'aria-expanded' ? (auxExpanded ? 'true' : 'false') : null; },
    click() {
      toggleClicks += 1;
      auxExpanded = !auxExpanded;
    }
  };
  let curTabs = [];
  const h = harness(session(), {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', search: '' }
  });
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    openDashboardBrowser: async (opts) => ({
      ok: true,
      baseUrl: 'http://127.0.0.1:56780',
      url: opts?.sessionId ? `http://127.0.0.1:56780/?sessionId=${opts.sessionId}&source=desktop` : 'http://127.0.0.1:56780/',
      openedExternal: Boolean(opts?.openExternal)
    }),
    saveSettings: async () => ({ ok: true })
  };
  h.sandbox.document.querySelector = (sel) => {
    if (sel && sel.includes('toggle-aux-sidebar')) return toggleBtn;
    if (auxExpanded && sel && (sel.includes('data-side-panel-open="true"') || sel.includes('data-aux-pane-open="true"'))) {
      return sidePanelScopeEl;
    }
    return null;
  };
  h.sandbox.document.querySelectorAll = (sel) => {
    if (sel && sel.includes('data-tab-id')) return curTabs;
    if (auxExpanded && sel && sel.includes('data-side-panel-focus-scope="true"')) return [sidePanelScopeEl];
    return [];
  };

  try {
    const api = h.sandbox.__AGContextMeter;
    // 1. 初始折叠态点击右侧入口 -> 仅点击一次 toggle 展开、挂载到 sidePanelScopeEl、停靠 aux 且显示当前会话短 ID
    const res1 = await api.openDashboardInRightPanelForTest();
    assert.equal(toggleClicks, 1);
    assert.equal(auxExpanded, true);
    assert.equal(res1.mode, 'aux_dock');
    const st1 = api.getAuxDockStateForTest();
    assert.equal(st1.actualDock, 'aux');
    assert.equal(st1.auxBarHidden, false);
    assert.match(st1.auxSessionLabel, /aaaaaaaa/);

    // 2. 已展开态再次点击右侧入口 -> 绝不误点 toggle 折叠，仍停靠于 aux
    await api.openDashboardInRightPanelForTest();
    assert.equal(toggleClicks, 1, '右侧栏已展开时不得再次点击 toggle-aux-sidebar 将其关闭');
    assert.equal(auxExpanded, true);

    // 3. 同项目内切会话 A -> B 与分屏焦点切换 -> Side Chat：右侧面板保持展开不关，并跟随新会话 ID
    h.sandbox.location.pathname = '/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    h.tick();
    let st2 = api.getAuxDockStateForTest();
    assert.equal(st2.panelHidden, false, 'aux 模式下切换会话应保持右侧面板展开跟随');
    assert.match(st2.auxSessionLabel, /bbbbbbbb/);

    h.sandbox.location.pathname = '/c/11111111-1111-4111-8111-111111111111+22222222-2222-4222-8222-222222222222';
    h.sandbox.location.search = '?focused=22222222-2222-4222-8222-222222222222';
    h.tick();
    st2 = api.getAuxDockStateForTest();
    assert.match(st2.auxSessionLabel, /22222222/);

    curTabs = [{
      getAttribute: k => (k === 'data-tab-id' ? 'side_question__33333333-3333-4333-8333-333333333333' : (k === 'aria-selected' ? 'true' : null)),
      className: 'bg-secondary',
      textContent: 'Side Question'
    }];
    h.tick();
    api.selectConversationScopeForTest('33333333-3333-4333-8333-333333333333');
    st2 = api.getAuxDockStateForTest();
    assert.match(st2.auxSessionLabel, /Side Chat.*33333333/);

    // 4. aux 停靠态下触发 host 外部点击不关闭已停靠面板；退回 flow 后再外部点击应关闭
    h.sandbox.document.dispatchEvent({ type: 'click', composedPath: () => [{ id: 'left-chat-pane' }] });
    assert.equal(h.elements.get('panel').hidden, false, 'aux 停靠态点击外部主聊天区不得误关已停靠面板');

    // 5. 点击“返回顶栏”按钮退出 aux 停靠，之后外部点击应正常收起浮动面板
    h.elements.get('btn-dock-aux-back').click();
    const stBack = api.getAuxDockStateForTest();
    assert.equal(stBack.dockPosition, 'flow');
    assert.equal(stBack.auxBarHidden, true);

    h.elements.get('badge').click();
    assert.equal(h.elements.get('panel').hidden, false);
    h.sandbox.document.dispatchEvent({ type: 'click', composedPath: () => [{ id: 'left-chat-pane' }] });
    assert.equal(h.elements.get('panel').hidden, true, '退出 aux 回到 flow 浮动态后点击外部应正常收起面板');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1 回复尾注去框、两轮独立对账不跨轮复用与 computeCacheHitSummary 口径回归', async () => {
  // 1. CSS 去框校验（主样式与宿主注入 CSS 均无边框、无背景、无阴影）
  const mainSrc = fs.readFileSync(require('node:path').join(__dirname, 'src/renderer/main.js'), 'utf8');
  assert.match(mainSrc, /\.ag-cm-turn-footer\s*\{[\s\S]*border:\s*0\s*!important;[\s\S]*background:\s*transparent\s*!important;[\s\S]*box-shadow:\s*none\s*!important;/);

  // 2. computeCacheHitSummary 全口径校验（inputIncludesCache / 排除输出 / Test Conversation 26% 汇总 / 0% vs —）
  const sIncl = core.computeCacheHitSummary([{ inputTokens: 100000, cacheReadTokens: 25000, outputTokens: 5000, inputIncludesCache: true }]);
  assert.equal(sIncl.totalInput, 100000);
  assert.equal(sIncl.uncachedInput, 75000);
  assert.equal(sIncl.cacheRead, 25000);
  assert.equal(sIncl.hitPct, 25, 'inputIncludesCache=true 时分母直接用总输入且排除输出');

  const sZero = core.computeCacheHitSummary([{ inputTokens: 31851, cacheReadTokens: 0, outputTokens: 57 }]);
  assert.equal(sZero.hitPct, 0);
  assert.equal(sZero.hitText, '0%', '确认 inputTokens>0 且 cacheRead=0 才显示 0%');

  const sMissing = core.computeCacheHitSummary([{ totalTokens: 1500 }]);
  assert.equal(sMissing.hitPct, null);
  assert.equal(sMissing.hitText, '—', '字段缺失或分母为 0 必须显示 —，绝不补成 0%');

  const real7Calls = [
    { callId: 'c1', inputTokens: 31082, cacheReadTokens: 0, outputTokens: 219 },
    { callId: 'c2', inputTokens: 32264, cacheReadTokens: 0, outputTokens: 152 },
    { callId: 'c3', inputTokens: 30625, cacheReadTokens: 0, outputTokens: 58 },
    { callId: 'c4', inputTokens: 2177, cacheReadTokens: 28573, outputTokens: 113 },
    { callId: 'c5', inputTokens: 2231, cacheReadTokens: 28699, outputTokens: 86 },
    { callId: 'c6', inputTokens: 31851, cacheReadTokens: 0, outputTokens: 57, streamingTps: 570 },
    { callId: 'c7', inputTokens: 32209, cacheReadTokens: 0, outputTokens: 57, streamingTps: 518.2 }
  ];
  const sumReal = core.computeCacheHitSummary(real7Calls);
  assert.equal(sumReal.uncachedInput, 162439);
  assert.equal(sumReal.cacheRead, 57272);
  assert.equal(sumReal.totalInput, 219711);
  assert.equal(sumReal.output, 742);
  assert.equal(sumReal.hitPct, 26);

  // 3. 两条独立回复严格尾对齐一对一绑定，且缺时间线时绝不跨轮复用
  const makeTb = () => {
    const row = {
      children: [],
      prepend(n) { n.parentElement = this; this.children.unshift(n); },
      appendChild(n) { n.parentElement = this; this.children.push(n); },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      }
    };
    return { firstElementChild: row, row, getAttribute: () => null };
  };
  const tb1 = makeTb();
  const tb2 = makeTb();
  const h = harness(session(), {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/78799486-61aa-422e-b0dc-dc61314d4c1d', search: '' }
  });
  h.sandbox.document.querySelectorAll = sel => {
    if (sel && sel.includes('cascade-system-message-toolbar')) return [tb1, tb2];
    if (sel && sel.includes('.ag-cm-turn-footer')) return [tb1.row.children[0], tb2.row.children[0]].filter(Boolean);
    return [];
  };
  try {
    const api = h.sandbox.__AGContextMeter;
    api.setTurnFooterStatsEnabledForTest(true);
    // 只有 1 条记录却有 2 个主区 toolbar 时：仅最后一个 toolbar 挂载，前者绝不复用 turns[0]
    api.setComposerStateForTest({
      sessionCalls: [{ callId: 'quwBa7eRLpW6odAPxqKKsAM', modelLabel: 'Gemini 3.8 Flash', inputTokens: 31851, cacheReadTokens: 0, outputTokens: 57, streamingTps: 570 }],
      sessionStats: { usedTokens: 31908, limitTokens: 1000000, turnCount: 1, stepCount: 1 }
    });
    assert.equal(tb1.row.children.length, 0, 'M > T 时前置回复绝不允许复用 turns[0]');
    assert.equal(tb2.row.children.length, 1);

    // 7 轮时间线就位且视图仅挂载末尾两条 OK 时：从尾部一一对应绑定 Turn 6 和 Turn 7
    const tl = core.groupSessionCallsByTurns(
      [
        { stepIndex: 1, timestamp: 1795280000000 },
        { stepIndex: 4, timestamp: 1795281000000 },
        { stepIndex: 7, timestamp: 1795282000000 },
        { stepIndex: 9, timestamp: 1795283000000 },
        { stepIndex: 11, timestamp: 1795284000000 },
        { stepIndex: 13, timestamp: 1795288200000 },
        { stepIndex: 16, timestamp: 1795305900000 }
      ],
      [
        { callId: 'c1', stepIndex: 2, modelLabel: 'Gemini 3.8 Flash', inputTokens: 31082, cacheReadTokens: 0, outputTokens: 219 },
        { callId: 'c2', stepIndex: 5, modelLabel: 'Gemini 3.8 Flash', inputTokens: 32264, cacheReadTokens: 0, outputTokens: 152 },
        { callId: 'c3', stepIndex: 8, modelLabel: 'Gemini 3.8 Flash', inputTokens: 30625, cacheReadTokens: 0, outputTokens: 58 },
        { callId: 'c4', stepIndex: 10, modelLabel: 'Gemini 3.8 Flash', inputTokens: 2177, cacheReadTokens: 28573, outputTokens: 113 },
        { callId: 'c5', stepIndex: 12, modelLabel: 'Gemini 3.8 Flash', inputTokens: 2231, cacheReadTokens: 28699, outputTokens: 86 },
        { callId: 'quwBa7eRLpW6odAPxqKKsAM', stepIndex: 14, modelLabel: 'Gemini 3.8 Flash', inputTokens: 31851, cacheReadTokens: 0, outputTokens: 57, streamingTps: 570 },
        { callId: 'wTECa8iUMJaA6tkPqLCn4Qk', stepIndex: 17, modelLabel: 'Gemini 3.8 Flash', inputTokens: 32209, cacheReadTokens: 0, outputTokens: 57, streamingTps: 518.2 }
      ],
      { cascadeId: '78799486-61aa-422e-b0dc-dc61314d4c1d' }
    );
    api.setComposerStateForTest({
      sessionCalls: tl.turns.flatMap(t => t.calls || []),
      sessionTimeline: tl,
      sessionStats: { usedTokens: 32266, limitTokens: 1000000, turnCount: 7, stepCount: 17 }
    });
    const footerSnap = api.getTurnFooterStatsForTest();
    assert.equal(footerSnap.items.length, 2);
    assert.equal(footerSnap.items[0].callId, 'quwBa7eRLpW6odAPxqKKsAM');
    assert.equal(footerSnap.items[1].callId, 'wTECa8iUMJaA6tkPqLCn4Qk');
    assert.match(footerSnap.items[0].text, /本次请求.*31\.9K.*Out 57.*0%.*570 tok\/s/);
    assert.match(footerSnap.items[1].text, /本次请求.*32\.2K.*Out 57.*0%.*518 tok\/s/);
    assert.match(api.getComposerStatusBarStateForTest().tokensText, /缓存 26%/);
    assert.match(h.elements.get('csb-group-tokens').getAttribute('data-tooltip'), /会话缓存命中率 26%/);
    assert.equal(h.elements.get('csb-group-tokens').title, '', '原生 title 必须清空以杜绝双气泡');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1 顶栏圆形入口悬停面板切换、不关闭右栏/重置会话及高亮底块内收', async () => {
  const cssRaw = fs.readFileSync(require('node:path').join(__dirname, 'src/renderer/styles.css'), 'utf8');
  assert.match(cssRaw, /\.ag-unit::before\s*\{[\s\S]*inset:\s*3px 2px;/);
  assert.match(cssRaw, /#overflow-menu::before\s*\{[\s\S]*top:\s*-16px;\s*height:\s*18px/);
  const overflowZ = Number((cssRaw.match(/#overflow-menu\s*\{[^}]*z-index\s*:\s*(\d+)/) || [])[1] || 0);
  const panelZ = Number((cssRaw.match(/\.ag-panel\s*\{[^}]*z-index\s*:\s*(\d+)/) || [])[1] || 0);
  assert.ok(overflowZ > panelZ && overflowZ >= 2147483645, `浮动面板开启时悬停菜单 z-index (${overflowZ}) 必须严格高于 .ag-panel (${panelZ})`);

  const auxBox = { children: [], appendChild(n) { n.parentElement = this; this.children.push(n); } };
  const h = harness(session(), {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', search: '' }
  });
  h.sandbox.document.querySelector = sel => (sel && sel.includes('data-aux-pane-focus-scope') ? auxBox : null);
  try {
    const api = h.sandbox.__AGContextMeter;
    api.setDockPosition('aux');
    api.showQuotaPanelForTest(true);
    assert.equal(api.getAuxDockStateForTest().actualDock, 'aux');
    assert.equal(h.elements.get('panel-quota').hidden, false);

    // 悬停额度圆形图标 -> 展开选择器并标出 quota 为当前激活项；移入菜单取消关闭
    const bQuota = h.elements.get('badge-quota');
    const om = h.elements.get('overflow-menu');
    bQuota.trigger('mouseenter');
    assert.equal(om.hidden, false);
    assert.equal(api.getPanelPickerStateForTest().currentTarget, 'quota');
    bQuota.trigger('mouseleave');
    om.trigger('mouseenter');
    assert.equal(om.hidden, false, '鼠标跨越间隙进入选择器时必须保持展开');

    // 在选择器中切到上下文详情 -> 直接原地替换且保留 aux 停靠与当前会话
    h.elements.get('overflow-context-detail-btn').click();
    assert.equal(h.elements.get('panel-quota').hidden, true);
    assert.equal(h.elements.get('panel').hidden, false);
    assert.equal(api.getAuxDockStateForTest().actualDock, 'aux');
    assert.equal(api.getConversationScopeStateForTest().activeRoute, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(api.getPanelPickerStateForTest().currentTarget, 'context_detail');

    // 悬停 -> 切到请求明细
    h.elements.get('badge').trigger('mouseenter');
    assert.equal(om.hidden, false);
    h.elements.get('overflow-requests-btn').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false);
    assert.equal(h.elements.get('requests-live-view').style.display, 'flex');
    assert.equal(api.getAuxDockStateForTest().actualDock, 'aux');

    // 误点已选项 -> 面板继续保持展开；按 Esc 时若选择器打开则仅关闭选择器并保留面板（即使焦点回到触发按钮）
    const bOverflow = h.elements.get('badge-overflow');
    bOverflow.focus = () => bOverflow.trigger('focus');
    const bQuotaFocusOrig = h.elements.get('badge-quota');
    bQuotaFocusOrig.focus = () => bQuotaFocusOrig.trigger('focus');
    bQuotaFocusOrig.trigger('focus');
    assert.equal(om.hidden, false);
    h.elements.get('overflow-requests-btn').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false, '误点当前已选面板时必须保持开启');

    // mouseenter 刚打开 badge-overflow 后紧接着 click，应保持展开不被同次点击反关
    bOverflow.trigger('mouseenter');
    assert.equal(om.hidden, false);
    bOverflow.click();
    assert.equal(om.hidden, false, 'hover 打开 overflow-menu 后立刻 click 不应反关菜单');

    h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(om.hidden, true, 'Esc 后即使触发 returnTrigger.focus() 也必须保持选择器关闭');
    assert.equal(h.elements.get('panel-tokens').hidden, false, 'Esc 仅关闭选择器，不关当前已停靠或展开的面板');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1 窄窗下回复尾注优先保留完整 tok/s 速度且缓存命中率与未知区分', async () => {
  const tl = core.groupSessionCallsByTurns(
    [
      { stepIndex: 13, timestamp: 1795288200000 },
      { stepIndex: 16, timestamp: 1795305900000 }
    ],
    [
      { callId: 'quwBa7eRLpW6odAPxqKKsAM', stepIndex: 14, modelLabel: 'Gemini 3.8 Flash', inputTokens: 31851, cacheReadTokens: 0, outputTokens: 57, streamingTps: 570 },
      { callId: 'wTECa8iUMJaA6tkPqLCn4Qk', stepIndex: 17, modelLabel: 'Gemini 3.8 Flash', inputTokens: 32209, cacheReadTokens: 0, outputTokens: 57, streamingTps: 518.2 }
    ],
    { cascadeId: '78799486-61aa-422e-b0dc-dc61314d4c1d' }
  );
  const makeToolbar = (rowW) => {
    const row = {
      clientWidth: rowW,
      children: [],
      prepend(n) { n.parentElement = this; this.children.unshift(n); },
      appendChild(n) { n.parentElement = this; this.children.push(n); },
      querySelector(sel) {
        if (sel === '.ag-cm-turn-footer') return this.children.find(c => c.className === 'ag-cm-turn-footer') || null;
        return null;
      }
    };
    return { firstElementChild: row, clientWidth: rowW, row, getAttribute: () => null };
  };
  const tb1 = makeToolbar(178);
  const tb2 = makeToolbar(178);
  const h = harness(session(), {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/78799486-61aa-422e-b0dc-dc61314d4c1d', search: '' }
  });
  h.sandbox.document.querySelectorAll = sel => {
    if (sel && sel.includes('cascade-system-message-toolbar')) return [tb1, tb2];
    if (sel && sel.includes('.ag-cm-turn-footer')) return [tb1.row.children[0], tb2.row.children[0]].filter(Boolean);
    return [];
  };
  try {
    const api = h.sandbox.__AGContextMeter;
    api.setTurnFooterStatsEnabledForTest(true);
    api.setComposerStateForTest({
      sessionCalls: tl.turns.flatMap(t => t.calls || []),
      sessionTimeline: tl,
      sessionStats: { usedTokens: 32266, limitTokens: 1000000, turnCount: 2, stepCount: 17 }
    });
    const snap178 = api.getTurnFooterStatsForTest();
    assert.equal(snap178.items.length, 2);
    assert.match(snap178.items[0].text, /In 31\.9K.*0%.*570 tok\/s/);
    assert.match(snap178.items[1].text, /In 32\.2K.*0%.*518 tok\/s/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('PR #79: 右侧分屏防抢焦点、可编辑控件保留聚焦、点空白关浮层与 aux/page 停靠保持及 Esc 守卫', () => {
  const shadowListeners = new Map();
  const docListeners = new Map();
  const elements = new Map();
  const makeNode = (tagName = 'div', id = '') => {
    const attrs = new Map();
    const classSet = new Set();
    const nodeListeners = new Map();
    if (id) attrs.set('id', id);
    const n = {
      tagName: String(tagName).toUpperCase(),
      style: { setProperty() { }, removeProperty() { }, getPropertyValue() { return ''; } },
      children: [],
      hidden: false,
      disabled: false,
      textContent: '',
      value: '',
      scrollTop: 0,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) elements.set(String(v), n); },
      get className() { return Array.from(classSet).join(' '); },
      set className(v) { classSet.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(c => classSet.add(c)); },
      classList: {
        add(c) { classSet.add(c); },
        remove(c) { classSet.delete(c); },
        contains(c) { return classSet.has(c); }
      },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') n.id = v; },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        if (!nodeListeners.has(type)) nodeListeners.set(type, []);
        nodeListeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        if (!nodeListeners.has(type)) return;
        nodeListeners.set(type, nodeListeners.get(type).filter(x => x !== fn));
      },
      appendChild(c) { if (c) { c.parentElement = this; this.children.push(c); } return c; },
      replaceChildren(...arr) { this.children = [...arr]; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 120, height: 24, right: 220, bottom: 124 }; },
      contains(other) {
        let cur = other;
        while (cur) { if (cur === n) return true; cur = cur.parentElement; }
        return false;
      },
      closest(sel) {
        const selectors = String(sel).split(',').map(s => s.trim().toLowerCase());
        let cur = n;
        while (cur) {
          const t = String(cur.tagName || '').toLowerCase();
          for (const s of selectors) {
            if (s === t) return cur;
            if (s === '[contenteditable]' && cur.getAttribute('contenteditable') != null) return cur;
            if (s.startsWith('#') && cur.id === s.slice(1)) return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      click() { (nodeListeners.get('click') || []).forEach(fn => fn({ target: n })); },
      trigger(t, e) { (nodeListeners.get(t) || []).forEach(fn => fn(e || { target: n })); }
    };
    return n;
  };

  const rightEditor = makeNode('textarea', 'host-right-editor');
  let activeElement = rightEditor;
  let shadowActive = null;
  let focusCalls = [];

  const wrapFocus = (node, label) => {
    node.focus = () => {
      focusCalls.push(label);
      activeElement = node;
    };
    return node;
  };

  let hostNode = makeNode('div', 'ag-context-meter');
  const auxBox = makeNode('div', 'aux-pane');
  auxBox.getBoundingClientRect = () => ({ left: 900, top: 0, width: 320, height: 900, right: 1220, bottom: 900 });
  const shadowObj = {
    get activeElement() { return shadowActive; },
    set innerHTML(_) { },
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.includes('input') ? 'input' : (id.includes('select') ? 'select' : 'button');
        const created = makeNode(tag, id);
        if (id === 'panel' || id === 'panel-tokens' || id === 'panel-quota' || id === 'overflow-menu' || id === 'color-picker-popover') {
          created.hidden = true;
        }
        created.remove = () => { };
        created.prepend = (...nodes) => { created.children.unshift(...nodes); };
        created.insertBefore = (c) => { created.appendChild(c); return c; };
        wrapFocus(created, id);
        elements.set(id, created);
      }
      return elements.get(id);
    },
    addEventListener(type, fn) {
      if (!shadowListeners.has(type)) shadowListeners.set(type, []);
      shadowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!shadowListeners.has(type)) return;
      shadowListeners.set(type, shadowListeners.get(type).filter(x => x !== fn));
    }
  };

  const docMock = {
    documentElement: makeNode('html'),
    body: makeNode('body'),
    hidden: false,
    get activeElement() { return activeElement; },
    getElementById(id) { return id === 'ag-context-meter' ? hostNode : elements.get(id) || null; },
    createElement(tag) {
      const node = makeNode(tag);
      node.remove = () => { };
      node.prepend = (...nodes) => { node.children.unshift(...nodes); };
      node.insertBefore = (c) => { node.appendChild(c); return c; };
      if (String(tag).toLowerCase() === 'div') {
        node.attachShadow = () => {
          hostNode = node;
          return shadowObj;
        };
      }
      return node;
    },
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (sel && sel.includes('data-aux-pane-focus-scope')) return auxBox;
      return null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!docListeners.has(type)) return;
      docListeners.set(type, docListeners.get(type).filter(x => x !== fn));
    },
    dispatchEvent(typeOrEv) {
      const ev = typeof typeOrEv === 'string' ? { type: typeOrEv } : typeOrEv;
      (docListeners.get(ev.type) || []).forEach(fn => fn(ev));
    }
  };
  docMock.body.prepend = (...nodes) => { docMock.body.children.unshift(...nodes); };
  docMock.body.insertBefore = (c) => { docMock.body.appendChild(c); return c; };

  const sandbox = {
    console, Math, Date, JSON, Number, String, Boolean, Array, Object, Set, Map, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout: () => { }, setInterval: () => 0, clearInterval: () => { },
    requestAnimationFrame: cb => { cb(); return 1; }, cancelAnimationFrame: () => { },
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/split-test', search: '' },
    document: docMock,
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); } },
    __AGContextMeterCore: core,
    ANTIGRAVITY_CONTEXT: { scan: async () => ({ activeConversationId: 'split-test', latest: {}, session: session() }) }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);

  const api = sandbox.__AGContextMeter;
  try {
    // 1. 聚焦右窗格编辑器后点击额度/上下文/速度/用量与非可编辑按钮：必须 preventDefault + stopPropagation 且不丢焦点
    const dispatchShadowMouse = (type, target) => {
      let prevented = false;
      let stopped = false;
      const ev = {
        target,
        composedPath: () => [target, hostNode],
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; }
      };
      (shadowListeners.get(type) || []).forEach(fn => fn(ev));
      return { prevented, stopped, ev };
    };

    for (const id of ['badge-quota', 'badge', 'badge-overflow', 'overflow-speed-btn', 'overflow-requests-btn']) {
      const btn = shadowObj.getElementById(id);
      const rDown = dispatchShadowMouse('mousedown', btn);
      const rPtr = dispatchShadowMouse('pointerdown', btn);
      const rClk = dispatchShadowMouse('click', btn);
      assert.equal(rDown.prevented, true, `${id} mousedown 必须阻止默认聚焦转移`);
      assert.equal(rDown.stopped, true);
      assert.equal(rPtr.stopped, true);
      assert.equal(rClk.stopped, true);
      assert.equal(activeElement, rightEditor, `点击 ${id} 后宿主右分屏焦点必须保持在 rightEditor`);
    }

    // 2. 可编辑控件 (input / textarea / select / option / label / [contenteditable]) 保留默认聚焦但隔离冒泡
    const editableInput = shadowObj.getElementById('ctx-custom-limit-input');
    const editableSelect = makeNode('select', 'ctx-model-select');
    const editableOption = makeNode('option');
    editableOption.parentElement = editableSelect;
    const editableLabel = makeNode('label');
    const editableDiv = makeNode('div');
    editableDiv.setAttribute('contenteditable', 'true');
    for (const ed of [editableInput, editableSelect, editableOption, editableLabel, editableDiv]) {
      const rEd = dispatchShadowMouse('mousedown', ed);
      assert.equal(rEd.prevented, false, `${ed.tagName} 必须保留原生聚焦与下拉/输入能力`);
      assert.equal(rEd.stopped, true);
    }

    // 3. 插件内部点击非触发空白区域应关闭取色器与 overflow-menu
    const pop = shadowObj.getElementById('color-picker-popover');
    const om = shadowObj.getElementById('overflow-menu');
    pop.hidden = false;
    om.hidden = false;
    const emptyDiv = makeNode('div');
    dispatchShadowMouse('click', emptyDiv);
    assert.equal(pop.hidden, true, '点击插件内部空白应关闭取色器');
    assert.equal(om.hidden, true, '点击插件内部空白应关闭溢出菜单');

    // 4. 在宿主右窗格按 Esc（焦点不在插件内）应关闭浮层且绝不调用任何 *.focus() 抢走焦点
    om.hidden = false;
    focusCalls = [];
    docMock.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(om.hidden, true);
    assert.equal(focusCalls.length, 0, '焦点不在插件内时 Esc 禁止抢回插件按钮');
    assert.equal(activeElement, rightEditor);

    // 5. 当焦点在插件内按 Esc 才归还聚焦到触发器；且 aux 停靠态点击宿主外部空白不关闭主面板
    activeElement = hostNode;
    shadowActive = om;
    om.hidden = false;
    focusCalls = [];
    docMock.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(om.hidden, true);
    assert.ok(focusCalls.length > 0, '焦点在插件内按 Esc 应归还聚焦到对应触发器');

    activeElement = rightEditor;
    shadowActive = null;
    api.setDockPosition('aux');
    const panelTokens = shadowObj.getElementById('panel-tokens');
    panelTokens.hidden = false;
    docMock.dispatchEvent({ type: 'click', target: rightEditor, composedPath: () => [rightEditor] });
    assert.equal(hostNode.getAttribute('data-dock'), 'aux');
    assert.equal(panelTokens.hidden, false, 'aux 常驻停靠态点击宿主空白不应关闭主面板');
  } finally {
    api.dispose();
  }
});

test('v0.9.0-beta.1: 当前会话 4 行 Bento 3 档宽度断点、双轨 <25% 构成切换、历史点保持、键盘导航与审计跳步联动', async () => {
  const extScans = [];
  const timelineMock = {
    cascadeId: 'c-bento',
    sessionTitle: '重构测试会话',
    totalCalls: 3,
    mainCallsCount: 2,
    subagentCallsCount: 1,
    sessionTokenTotals: { callCount: 3, totalTokens: 32000, inputTokens: 10000, cacheReadTokens: 20000, outputTokens: 2000 },
    cacheSummary: { evaluatedRequestCount: 3, totalInput: 30000, totalUncachedInput: 10000, totalCacheRead: 20000, cacheReadPct: 66.7, cacheStatus: 'hit' },
    timingSummary: {
      totalTtftSec: 1.5, ttftCount: 3, totalStreamingSec: 8.5, streamingCount: 3,
      totalToolExecSec: 4.0, toolExecCount: 2, activeWallSec: 14.0,
      wallClockActiveSec: 11.2, cumulativeTaskSec: 14.0, concurrencySavedSec: 2.8,
      hasConcurrentCalls: true, hasIndependentThinkingTimestamps: false,
      ttftPct: 10.7, streamingPct: 60.7, toolExecPct: 28.6
    },
    contextChangeEvents: [
      { id: 'ev-1', type: 'unknown_drop', source: 'call_sequence', stepIndex: 3, turnIndex: 2, callId: 'call-2', beforeTokens: 48000, afterTokens: 16000, deltaTokens: -32000, detail: 'context_drop_unknown' }
    ],
    fileActivities: [
      { path: 'D:/repo/src/main.js', basename: 'main.js', readCount: 1, writeCount: 2, searchCount: 0, totalCount: 3, addedLines: 20, removedLines: 5, turnNumbers: [1], lastStepIndex: 1 }
    ],
    commandExecutions: [
      { id: 'cmd-1', stepIndex: 2, turnNumber: 1, program: 'npm', command: 'npm test', status: 'done', isSlow: false, isBackground: false, durationSec: 2.1 }
    ],
    agentFleetSummary: {
      mainAgent: { callCount: 2, models: ['Gemini 4'], totalTokens: 26000 },
      subagents: [{ childCid: 'sub-1', type: 'research', parentStepIndex: 1, confidence: 'verified', callCount: 1, totalTokens: 6000, modelBreakdown: [{ modelLabel: 'Gemini 3.8 Flash', callCount: 1, totalTokens: 6000 }] }],
      unlinkedCount: 0, mainOnlyTotalTokens: 26000, fleetCombinedTotalTokens: 32000, dedupVerified: true
    },
    turns: [
      {
        turnIndex: 1, stepIndex: 0, preview: 'turn 1 question', inputTokens: 8000, cacheReadTokens: 40000, outputTokens: 800,
        lastContextTokens: 48000, deltaFromPrevTurn: 48000,
        calls: [{ callId: 'call-1', stepIndex: 1, turnIndex: 1, modelLabel: 'Gemini 4', agentRole: 'main', hasInputCacheFields: true, inputTokens: 8000, cacheReadTokens: 40000, totalInputTokens: 48000, outputTokens: 800, contextWindowTokens: 48000, deltaFromPrevStep: 48000, outcomeStatus: 'success', created_at: '2026-11-23T00:01:00Z' }]
      },
      {
        turnIndex: 2, stepIndex: 2, preview: 'turn 2 follow-up', inputTokens: 2000, cacheReadTokens: 14000, outputTokens: 1200,
        lastContextTokens: 16000, deltaFromPrevTurn: -32000,
        calls: [{ callId: 'call-2', stepIndex: 3, turnIndex: 2, modelLabel: 'Gemini 4', agentRole: 'main', hasInputCacheFields: true, inputTokens: 2000, cacheReadTokens: 14000, totalInputTokens: 16000, outputTokens: 1200, contextWindowTokens: 16000, deltaFromPrevStep: -32000, outcomeStatus: 'success', created_at: '2026-11-23T00:02:00Z' }]
      }
    ]
  };
  const h = harness(session(), {
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: id => new Promise(resolve => extScans.push({ id, resolve })),
        getSettings: async () => ({ ok: true, settings: {} }),
        getSessionTimeline: async () => ({ ok: true, data: timelineMock })
      }
    }
  });
  try {
    const sess = {
      ...session(),
      title: '重构测试会话',
      definitionsCount: 12,
      groups: {
        system: { chars: 2000, bytes: 2000, low: 400, high: 600 },
        definitions: { chars: 4000, bytes: 4000, low: 800, high: 1200 },
        user: { chars: 1200, bytes: 1200, low: 200, high: 400 },
        assistant: { chars: 2400, bytes: 2400, low: 500, high: 700 },
        thinking: { chars: 0, bytes: 0, low: 0, high: 0 },
        tools: { chars: 1600, bytes: 1600, low: 300, high: 500 },
        summaries: { chars: 0, bytes: 0, low: 0, high: 0 }
      },
      stepCompositionItems: {
        user: [{ stepIndex: 0, label: 'U#1', tokens: 150, chars: 600, preview: 'turn 1 question' }, { stepIndex: 2, label: 'U#2', tokens: 150, chars: 600, preview: 'turn 2 follow-up' }],
        assistant: [{ stepIndex: 1, label: 'A#1', tokens: 300, chars: 1200, preview: 'resp 1' }, { stepIndex: 3, label: 'A#2', tokens: 300, chars: 1200, preview: 'resp 2' }],
        tools: [{ stepIndex: 2, label: 'run_command@2', tokens: 400, chars: 1600, preview: 'npm test' }]
      }
    };
    // 1. 低占用 16K / 256K = 6.25% (<25%) 应自动开启「已用构成 100%」，隐藏缓存条且保留未归类残差段
    extScans[0]?.resolve({ ok: true, data: { session: sess, scannedAt: Date.now(), latest: { actual: 16000, budget: 256000 } } });
    h.pending[0]?.resolve(response({
      usage: { inputTokens: 2000, cacheReadTokens: 14000, outputTokens: 1200 },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
    }));
    await h.flush();

    h.elements.get('badge').click();
    await h.flush();

    const api = h.sandbox.__AGContextMeter;
    // 3 档宽度断点校验
    assert.equal(api.setPanelWidthForTest(420).tier, 'narrow');
    assert.equal(api.setPanelWidthForTest(680).tier, 'medium');
    assert.equal(api.setPanelWidthForTest(980).tier, 'wide');

    let dash = api.getSessionDashboardStateForTest();
    assert.equal(dash.widthTier, 'wide');
    assert.equal(dash.ovTitle, '重构测试会话');
    assert.equal(dash.subtrackMode, 'comp', '<25% 低占用默认应展示已用构成 100%');
    assert.equal(dash.subtrackCompHidden, false);
    assert.equal(dash.keySegTrackHidden, true, '内容构成与缓存构成禁止混在同一条显示');
    assert.equal(dash.unaccountedHidden, false, '实报高于估算时应独立展示灰色斜纹未归类开销');

    // 手动切换至「缓存结构」副轨，验证互相切换彻底隔离
    h.elements.get('ctx-subtrack-mode-cache').click();
    dash = api.getSessionDashboardStateForTest();
    assert.equal(dash.subtrackMode, 'cache');
    assert.equal(dash.subtrackCompHidden, true);
    assert.equal(dash.keySegTrackHidden, false);

    // 切换树 Delta 模式与对比基准
    h.elements.get('ctx-tree-mode-delta').click();
    h.elements.get('btn-ctx-cmp-turn').click();
    dash = api.getSessionDashboardStateForTest();
    assert.equal(dash.treeMode, 'delta');
    assert.equal(dash.compareBase, 'prev_turn');

    // 2. 固定历史点后，触发新轮询不得冲掉已固定的 callId，且显示返回最新按钮
    api.jumpToStepOrTurnForTest({ stepIndex: 1, callId: 'call-1' });
    let trend = api.getContextTrendStateForTest();
    assert.equal(trend.pinnedCallId, 'call-1');
    dash = api.getSessionDashboardStateForTest();
    assert.equal(dash.returnLatestHidden, false);

    // 模拟刷新动作，仍应保持 call-1 固定不动
    h.elements.get('ctx-subtrack-mode-comp').click();
    trend = api.getContextTrendStateForTest();
    assert.equal(trend.pinnedCallId, 'call-1', '新请求或刷新不得覆盖用户已固定的历史步骤');

    // 键盘右键移动到下一步 call-2，按 Escape 回到最新
    h.elements.get('ctx-trend-card').trigger('keydown', { key: 'ArrowRight', preventDefault() { } });
    assert.equal(api.getContextTrendStateForTest().pinnedCallId, 'call-2');
    h.elements.get('ctx-trend-card').trigger('keydown', { key: 'Escape', preventDefault() { } });
    assert.equal(api.getContextTrendStateForTest().pinnedCallId, null);
    assert.equal(api.getSessionDashboardStateForTest().returnLatestHidden, true);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1: Customizations/插件市场/详情子页(含搜索框)全面避让所有弹窗浮层与辅助栏，返回聊天后恢复', async () => {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const docListeners = new Map();
  let mode = 'chat'; // 'chat' | 'customizations' | 'plugin_detail'
  const capturedObserverCbs = [];
  const scheduledTimers = [];

  const mkEl = () => {
    const attrs = new Map();
    const el = {
      style: { display: '', opacity: '', pointerEvents: '', setProperty() { }, removeProperty() { }, getPropertyValue() { return ''; } },
      children: [], hidden: false, textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) { const a = (attrs.get('class') || '').split(/\s+/).filter(Boolean); if (!a.includes(c)) a.push(c); attrs.set('class', a.join(' ')); },
        remove(c) { attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x !== c).join(' ')); },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); },
        toggle(c, f) { const h = this.contains(c); const w = f !== undefined ? Boolean(f) : !h; if (w) this.add(c); else this.remove(c); return w; }
      },
      addEventListener(t, fn) { if (!listeners.has(el)) listeners.set(el, new Map()); listeners.get(el).set(t, fn); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id' && v) docElements.set(String(v), el); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() { },
      appendChild(x) { if (x) { x.parentElement = el; el.children.push(x); } },
      contains(t) { return t === el || el.children.some(c => c?.contains?.(t)); },
      closest() { return null; },
      querySelectorAll() { return []; },
      replaceChildren() { el.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 300, height: 400, right: 400, bottom: 500 }; },
      trigger(t, ev = {}) { listeners.get(el)?.get(t)?.(ev); }
    };
    return el;
  };

  const host = mkEl();
  host.isConnected = true;
  host.attachShadow = () => ({
    set innerHTML(_) { },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, mkEl());
      return elements.get(id);
    }
  });
  const searchTextboxNode = { tagName: 'INPUT', type: 'text', getAttribute: k => (k === 'placeholder' ? 'Search plugins...' : (k === 'role' ? 'textbox' : null)), closest: () => null, getBoundingClientRect: () => ({ width: 200, height: 32 }) };
  const chatComposerNode = { tagName: 'DIV', isContentEditable: true, getAttribute: () => null, closest: () => null, getBoundingClientRect: () => ({ width: 500, height: 80 }) };
  const customHeadingNode = { textContent: 'Customizations', closest: () => null };
  const sideNavCustomLink = { tagName: 'A', textContent: '自定义扩展', getAttribute: k => (k === 'href' ? '/customizations' : null), closest: sel => (sel && sel.includes('nav') ? {} : null) };
  const sideAuxPluginItem = { textContent: '插件', closest: sel => (sel && sel.includes('data-side-panel-open') ? {} : null) };
  const convToolbarNode = { getAttribute: k => (k === 'data-testid' ? 'cascade-system-message-toolbar' : null), closest: () => null };
  const backBtnNode = { getAttribute: k => k === 'aria-label' ? 'Back' : null, closest: sel => (mode === 'archived_chat' && sel && sel.includes('nav') ? {} : null) };
  const installBtnNode = { textContent: 'Install', closest: () => null };
  const auxContainer = mkEl();
  auxContainer.insertBefore = (n) => { auxContainer.children.unshift(n); n.parentElement = auxContainer; };

  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111', hash: '' },
    document: {
      body: mkEl(), head: mkEl(), documentElement: mkEl(), hidden: false,
      createElement() { if (first) { first = false; return host; } return mkEl(); },
      getElementById: id => docElements.get(id) || null,
      querySelector(sel) {
        if (!sel) return null;
        if (sel.includes('aux-pane') || sel.includes('side-panel-focus-scope')) return auxContainer;
        if ((mode === 'plugin_detail' || mode === 'archived_chat') && sel.includes('Back')) return backBtnNode;
        if (mode === 'archived_chat' && sel.includes('cascade-system-message-toolbar')) return convToolbarNode;
        if (mode === 'chat' && sel.includes('[contenteditable="true"]')) return chatComposerNode;
        return null;
      },
      querySelectorAll(sel) {
        if (!sel) return [];
        if (sel.includes('role="textbox"')) return mode === 'chat' ? [chatComposerNode] : [searchTextboxNode];
        if (sel.includes('role="heading"')) {
          if (mode === 'customizations') return [customHeadingNode];
          if (mode === 'archived_chat') return [sideNavCustomLink, sideAuxPluginItem];
          return [];
        }
        if (mode === 'plugin_detail' && sel === 'button, [role="button"]') return [installBtnNode];
        return [];
      },
      addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
      removeEventListener(t, fn) { docListeners.get(t)?.delete(fn); },
      dispatchEvent(ev) { for (const fn of (docListeners.get(ev?.type || ev) || [])) fn(ev); }
    },
    window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now() } }) } },
    __AGContextMeterCore: core,
    AbortController, Date,
    MutationObserver: function (cb) { capturedObserverCbs.push(cb); return { observe() { }, disconnect() { } }; },
    setTimeout(fn, ms) { scheduledTimers.push({ fn, ms }); return scheduledTimers.length; },
    clearTimeout() { }, setInterval: () => 1, clearInterval() { },
    fetch: async () => response({ usage: { inputTokens: 1000 } })
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  let timerCursor = 0;
  const flushScheduledTimers = () => {
    while (timerCursor < scheduledTimers.length) {
      const t = scheduledTimers[timerCursor++];
      try { t?.fn?.(); } catch { }
    }
  };
  try {
    await new Promise(r => setImmediate(r));
    flushScheduledTimers();
    const api = sandbox.__AGContextMeter;
    api.setRadialOrbEnabledForTest(true, { persist: false });
    api.setDockPosition('aux');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, false);
    assert.equal(elements.get('dock-aux-context-bar').hidden, false);

    // 切入 Customizations 页面（含搜索框）-> 自动全面避让且阻止一切弹窗/菜单打开
    mode = 'customizations';
    capturedObserverCbs.forEach(cb => { try { cb([{ type: 'childList', addedNodes: [{}] }]); } catch { } });
    flushScheduledTimers();

    assert.equal(host.getAttribute('data-marketplace-active'), 'true');
    assert.equal(elements.get('panel').hidden, true);
    assert.equal(elements.get('dock-aux-context-bar').hidden, true);
    assert.equal(elements.get('ctx-radial-orb').hidden, true, '自定义扩展页必须隐藏悬浮球');
    assert.equal(elements.get('ctx-radial-layer').hidden, true, '自定义扩展页必须收起径向菜单');
    elements.get('badge-overflow').click();
    assert.equal(elements.get('overflow-menu').hidden, true, '自定义扩展页点击溢出口禁止弹出 picker 菜单');
    elements.get('badge').trigger('mouseenter');
    assert.equal(elements.get('overflow-menu').hidden, true, '自定义扩展页悬停顶栏禁止弹出 picker 菜单');
    assert.equal(elements.get('context-tooltip').getAttribute('data-visible'), 'false');

    // 切入插件详情子页 (只有 Back + Install 按钮，无 Heading) -> 依然持续避让
    mode = 'plugin_detail';
    capturedObserverCbs.forEach(cb => { try { cb([{ type: 'childList', addedNodes: [{}] }]); } catch { } });
    flushScheduledTimers();
    assert.equal(host.getAttribute('data-marketplace-active'), 'true');
    elements.get('badge-overflow').click();
    assert.equal(elements.get('overflow-menu').hidden, true);

    // 切入已归档历史会话 (/c/... 无输入框，但左侧栏含「自定义扩展」链接与全局 Back 箭头、右侧含「插件」字样) -> 不得误触发避让
    mode = 'archived_chat';
    sandbox.location.pathname = '/c/1602135e-da38-4837-a3bc-3e993d35efab';
    capturedObserverCbs.forEach(cb => { try { cb([{ type: 'childList', addedNodes: [{}] }]); } catch { } });
    flushScheduledTimers();
    assert.equal(host.getAttribute('data-marketplace-active'), null, '已归档历史会话不得被左侧导航/全局后退误判为自定义扩展');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, false, '已归档历史会话中点击上下文入口应能正常打开面板');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, true, '再次点击上下文入口应正常收起面板');

    // 返回普通对话页 -> 自动恢复正常响应
    mode = 'chat';
    capturedObserverCbs.forEach(cb => { try { cb([{ type: 'childList', addedNodes: [{}] }]); } catch { } });
    flushScheduledTimers();
    assert.equal(host.getAttribute('data-marketplace-active'), null);
    assert.equal(elements.get('ctx-radial-orb').hidden, false, '返回聊天页应恢复悬浮球');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, false, '退出返回聊天页面后应恢复正常打开面板');
  } finally {
    sandbox.__AGContextMeter.dispose();
  }
});

test('v0.9.0-beta.1: 正常状态隐藏空蓝框(#ctx-ov-pinned-banner / #dock-fallback-note / #dock-open-feedback)，有有效内容展示且解除后完整收起', async () => {
  const h = harness();
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(stylesSrc, /:host\s+\[hidden\]:not\(\.ag-panel\)\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(stylesSrc, /\.ctx-dock-note\[hidden\],\s*\.ctx-dock-note:empty\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(stylesSrc, /\.ctx-ov-pinned-banner\[hidden\],\s*\.ctx-ov-pinned-banner:empty\b[^}]*display:\s*none\s*!important/s);
  assert.match(stylesSrc, /\.ctx-subtrack-wrap\s+\.key-seg-track\s*\{[^}]*margin:\s*0/s);

  try {
    const api = h.sandbox.__AGContextMeter;
    h.finishScan();
    h.pending[0]?.resolve?.(response({ usage: { inputTokens: 1000 } }));
    await h.flush();
    api.setSessionCallsForTest([
      { callId: 'c1', stepIndex: 10, inputTokens: 1000, outputTokens: 200, timestamp: 1000 },
      { callId: 'c2', stepIndex: 20, inputTokens: 1500, outputTokens: 300, timestamp: 2000 }
    ]);
    await api.setPanelLanguage('zh-CN', { persist: false });

    const pinnedBanner = h.elements.get('ctx-ov-pinned-banner');
    const dockFallbackNote = h.elements.get('dock-fallback-note');
    const dockOpenFeedback = h.elements.get('dock-open-feedback');

    // 1. 正常初始态：无内容且必须隐藏
    assert.equal(pinnedBanner.hidden, true);
    assert.equal(pinnedBanner.textContent, '');
    assert.equal(dockFallbackNote.hidden, true);
    assert.equal(dockFallbackNote.textContent, '');
    assert.equal(dockOpenFeedback.hidden, true);
    assert.equal(dockOpenFeedback.textContent, '');

    // 2. 固定历史步骤：#ctx-ov-pinned-banner 出现有效内容；返回最新后清空并隐藏
    h.elements.get('csb-group-context').click();
    api.jumpToStepOrTurnForTest({ callId: 'c1', stepIndex: 10 });
    assert.equal(pinnedBanner.hidden, false);
    assert.match(pinnedBanner.textContent, /S10/);
    h.elements.get('btn-ctx-return-latest')?.click();
    assert.equal(pinnedBanner.hidden, true);
    assert.equal(pinnedBanner.textContent, '');

    // 3. 配置页反馈条：进入不存在 aux 容器的回退态或打开反馈时正常显示，恢复后清空并隐藏
    api.setDockPosition('aux', { persist: false });
    assert.equal(dockFallbackNote.hidden, false);
    assert.ok(dockFallbackNote.textContent.trim().length > 0);
    api.setDockPosition('flow', { persist: false });
    assert.equal(dockFallbackNote.hidden, true);
    assert.equal(dockFallbackNote.textContent, '');

    await api.openStandaloneBrowserPageForTest();
    assert.equal(dockOpenFeedback.hidden, false);
    assert.ok(dockOpenFeedback.textContent.trim().length > 0);
  } finally {
    h.sandbox?.__AGContextMeter?.dispose?.();
  }
});

test('v0.9.0-beta.1: 径向菜单 3 形态 / 锁定物理动效参数 / 靠边安全扇区 / 拖拽阈值 / CLI 右键直达配置 / Customizations 避让', async () => {
  const h = harness(session());
  const api = h.sandbox.__AGContextMeter;
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  try {
    h.finishScan();
    await h.flush();

    // 1. CSS 与常量严格锁定验证（含原型双层极坐标外向内汇聚 + 正向抵消旋转）
    assert.match(stylesSrc, /border-radius:\s*50%/);
    assert.match(stylesSrc, /width:\s*38px;\s*height:\s*38px/);
    assert.match(stylesSrc, /340ms\s+cubic-bezier\(0\.22,\s*1\.18,\s*0\.36,\s*1\)\s+calc\(var\(--i\)\s*\*\s*34ms\)/);
    assert.match(stylesSrc, /240ms\s+ease-out\s+calc\(var\(--i\)\s*\*\s*34ms\)/);
    assert.match(stylesSrc, /280ms\s+ease-out\s+calc\(var\(--i\)\s*\*\s*34ms\)/);
    assert.match(stylesSrc, /190ms\s+cubic-bezier\(0\.4,\s*0,\s*1,\s*1\)\s+0ms/);
    assert.match(stylesSrc, /scale\(1\.09\)/);
    assert.match(stylesSrc, /scale\(0\.94\)/);
    assert.match(stylesSrc, /blur\(10px\)/);
    assert.match(stylesSrc, /\.ctx-radial-slot[\s\S]*rotate\(var\(--angle\)\)[\s\S]*translateY\(calc\(-1\s*\*\s*var\(--r-far\)\)\)[\s\S]*rotate\(calc\(-1\s*\*\s*var\(--angle\)\)\)/);
    assert.match(stylesSrc, /\.ctx-radial-layer\[data-state="open"\]\s+\.ctx-radial-slot[\s\S]*translateY\(calc\(-1\s*\*\s*var\(--r-rest\)\)\)[\s\S]*rotate\(calc\(-1\s*\*\s*var\(--angle\)\)\)/);
    assert.ok(!fs.existsSync(require('node:path').join(__dirname, 'antigravity_contextmeter.html')), '不得将只读原型 HTML 复制进项目目录');

    api.setRadialOrbEnabledForTest(true, { persist: false });
    const rSt0 = api.getRadialMenuStateForTest();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rSt0.constants)), {
      STAGGER_MS: 34,
      R_REST_360: 56,
      R_REST_180: 92,
      R_FAR_MULTIPLIER: 1.85,
      R_CLOSE_MULTIPLIER: 1.75,
      BLUR_START_PX: 10
    });
    assert.equal(rSt0.quickMenuStyle, 'floating');
    assert.equal(h.elements.get('ctx-radial-orb').hidden, false);

    // 2. 四周留白 >= 84px 展开完整 360° 六瓣花环；四角与四边靠边收束安全扇区且 100% 不越界
    const gCenter = api.computeRadialGeometryForTest('floating', { left: 500, top: 380, width: 40, height: 40 }, 1280, 800);
    assert.equal(gCenter.isFull360, true);
    assert.equal(gCenter.restRadius, 56);
    assert.equal(gCenter.items.length, 6);
    assert.equal(gCenter.items[0].angleDeg, 0);
    assert.equal(gCenter.items[3].angleDeg, 180);

    const checkSafeBounds = (geom, msg) => {
      for (const it of geom.items) {
        assert.ok(it.absX >= 20 && it.absX <= 1260 && it.absY >= 20 && it.absY <= 780, msg);
      }
    };
    const gCornerTL = api.computeRadialGeometryForTest('floating', { left: 10, top: 10, width: 40, height: 40 }, 1280, 800);
    const gCornerTR = api.computeRadialGeometryForTest('floating', { left: 1230, top: 10, width: 40, height: 40 }, 1280, 800);
    const gCornerBL = api.computeRadialGeometryForTest('floating', { left: 10, top: 750, width: 40, height: 40 }, 1280, 800);
    const gCornerBR = api.computeRadialGeometryForTest('floating', { left: 1230, top: 750, width: 40, height: 40 }, 1280, 800);
    assert.equal(gCornerTR.isFull360, false);
    checkSafeBounds(gCornerTL, '左上角安全扇区不得被视口裁切');
    checkSafeBounds(gCornerTR, '右上角安全扇区不得被视口裁切');
    checkSafeBounds(gCornerBL, '左下角安全扇区不得被视口裁切');
    checkSafeBounds(gCornerBR, '右下角安全扇区不得被视口裁切');
    checkSafeBounds(api.computeRadialGeometryForTest('floating', { left: 500, top: 10, width: 40, height: 40 }, 1280, 800), '顶边避让不得越界');
    checkSafeBounds(api.computeRadialGeometryForTest('floating', { left: 500, top: 750, width: 40, height: 40 }, 1280, 800), '底边避让不得越界');
    checkSafeBounds(api.computeRadialGeometryForTest('floating', { left: 10, top: 380, width: 40, height: 40 }, 1280, 800), '左边避让不得越界');
    checkSafeBounds(api.computeRadialGeometryForTest('floating', { left: 1230, top: 380, width: 40, height: 40 }, 1280, 800), '右边避让不得越界');

    const gTopCenter = api.computeRadialGeometryForTest('topbar', { left: 600, top: 6, width: 40, height: 28 }, 1280, 800);
    assert.equal(gTopCenter.restRadius, 92);
    for (const it of gTopCenter.items) {
      assert.ok(it.absY - 18 >= 34 + 6, '顶栏居中展开时 36px 卫星上边缘必须在工具栏底边下方净空区');
    }

    const gTop = api.computeRadialGeometryForTest('topbar', { left: 1220, top: 6, width: 40, height: 28 }, 1280, 800);
    assert.equal(gTop.restRadius, 96);
    for (const it of gTop.items) {
      assert.ok(it.absY - 18 >= 34 + 6 && it.absX >= 22 && it.absX <= 1258, '顶栏贴边向下扇形及防右裁切不得压顶栏或越界');
    }

    const gBot = api.computeRadialGeometryForTest('bottombar', { left: 12, top: 750, width: 60, height: 24 }, 1280, 800);
    assert.equal(gBot.restRadius, 96);
    for (const it of gBot.items) {
      assert.ok(it.absY + 18 <= 750 - 6 && it.absX >= 22 && it.absY >= 22, '底栏贴边向上扇形及防左裁切不得压底栏或越界');
    }

    // 3. 悬浮圆环点击展开 -> 右键第 6 颗 CLI 直达配置；切顶栏/底栏/经典模式验证切换与隐藏悬浮球
    h.elements.get('ctx-radial-orb').click();
    assert.equal(api.getRadialMenuStateForTest().open, true);
    assert.equal(h.elements.get('ctx-radial-layer').hidden, false);

    h.elements.get('radial-item-cli').trigger('contextmenu', { preventDefault() { }, stopPropagation() { } });
    assert.equal(api.getRadialMenuStateForTest().open, false);
    assert.equal(h.elements.get('panel').hidden, false);
    assert.equal(api.getContextPreferencesState().activeContextTab, 'settings');

    api.setQuickMenuStyleForTest('topbar', { persist: false });
    assert.equal(h.elements.get('ctx-radial-orb').hidden, true);
    h.elements.get('badge').click();
    assert.equal(api.getRadialMenuStateForTest().open, true);
    assert.equal(api.getRadialMenuStateForTest().anchorMode, 'topbar');

    api.setQuickMenuStyleForTest('bottombar', { persist: false });
    assert.equal(api.getRadialMenuStateForTest().open, false);
    h.elements.get('csb-group-context').click();
    assert.equal(api.getRadialMenuStateForTest().open, true);
    assert.equal(api.getRadialMenuStateForTest().anchorMode, 'bottombar');

    api.setQuickMenuStyleForTest('classic', { persist: false });
    assert.equal(h.elements.get('ctx-radial-orb').hidden, true);
    assert.equal(h.elements.get('ctx-radial-layer').hidden, true);
  } finally {
    api.dispose();
  }
});

test('v0.9.0-beta.1: 当前会话双栏驾驶舱(>=860/窄屏) + 零删除既有ID + 统一6Tab与组成树真实预览 + 标题栏color-mix/color(srgb)采样', async () => {
  const tplSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');

  // 1. 浅/深色作用域无黑色槽位 & 零蓝调炭黑与珍珠白 CSS 校验
  assert.match(stylesSrc, /#pane-ctx-session[\s\S]*--ctx-ck-canvas:\s*#0C0C0D[\s\S]*--ctx-ck-card:\s*#151517/);
  assert.match(stylesSrc, /:host\(\[data-theme="light"\]\)\s*#pane-ctx-session[\s\S]*--ctx-ck-canvas:\s*#F2F2F4[\s\S]*--ctx-ck-card:\s*#FCFCFD[\s\S]*--ctx-ck-track:\s*#EAEAEF/);
  assert.match(stylesSrc, /#pane-ctx-session\s+\.ctx-main-track\s*\{[^}]*height:\s*14px/);
  assert.match(stylesSrc, /#pane-ctx-session\s+\.ctx-cockpit-grid\s*\{[^}]*repeat\(12,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stylesSrc, /#pane-ctx-session\s+\.ctx-ov-kpi-row\.ctx-ov-kpi-row-bottom\s*\{[^}]*repeat\(3,/);
  assert.match(tplSrc, /id="ctx-timing-donut-wrap"|class="ctx-timing-donut-wrap"\s+hidden/);
  assert.ok(tplSrc.includes('id="ctx-bento-row3"'), '必须保留 #ctx-bento-row3 确保 0 个既有 ID 被移除');

  const overlayCalls = [];
  const h = harness(session(), {
    getComputedStyle: (target) => {
      if (target && target._tag === 'title-menu-bar') {
        return {
          backgroundColor: 'color-mix(in srgb, #ffffff 4%, #181818)',
          color: 'color(srgb 0.941176 0.941176 0.941176)',
          getPropertyValue: () => ''
        };
      }
      return { getPropertyValue: () => '' };
    }
  });
  h.sandbox.document.querySelector = (sel) => sel === '[data-testid="title-menu-bar"]'
    ? { _tag: 'title-menu-bar' }
    : null;
  h.sandbox.window.contextMeterAPI.syncOverlay = (opts) => overlayCalls.push(opts);
  h.sandbox.window.contextMeterAPI.getSessionTimeline = async () => ({ ok: true, data: { turns: [], totalCalls: 0 } });

  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    h.elements.get('theme-toggle').click();
    await h.flush();

    // 2. title-menu-bar 的 color-mix(in srgb, #ffffff 4%, #181818) 必须精准算出 #212121 并同步给宿主
    assert.ok(overlayCalls.some(o => o && o.color === '#212121'), `预期 #212121，实际: ${JSON.stringify(overlayCalls)}`);

    // 3. 宽屏 >=860 与窄屏 <860 容器档位 + 统一 6 Tab 与右子栏真实预览联动
    const sess = session();
    sess.userMessages = 2;
    sess.steps = 12;
    sess.stepCompositionItems = {
      system: [{ stepIndex: 1, label: 'System Rules', tokens: 1200, preview: 'Strictly follow evidence from tools.' }],
      tools: [{ stepIndex: 12, label: 'read_file', tokens: 800, preview: 'D:/path/to/secret/file' }]
    };
    h.elements.get('csb-group-context').click();
    api.setContextLatestForTest({ model: 'Gemini 4 Neon', actual: 18000, budget: 512000, percent: 3.5 });
    const wWide = api.setPanelWidthForTest(960);
    assert.equal(wWide.tier, 'wide');
    const wNarrow = api.setPanelWidthForTest(520);
    assert.equal(wNarrow.tier, 'narrow');

    api.switchCockpitAuditTabForTest('files');
    assert.equal(h.elements.get('ctx-composition-tree-card').hidden, true);
    assert.equal(h.elements.get('ctx-audit-workbench').hidden, false);
    api.switchCockpitAuditTabForTest('tree');
    assert.equal(h.elements.get('ctx-composition-tree-card').hidden, false);
    assert.equal(h.elements.get('ctx-audit-workbench').hidden, true);

    const dash = api.getSessionDashboardStateForTest();
    assert.equal(dash.cockpitTab, 'tree');
    assert.ok(h.elements.get('ctx-ov-pct-summary').textContent.includes('%'));

    // 4. blocked_missing_pool 按 reason 精准展示且非 noPermission 不得误报无权限
    api.setAccountsOverviewForTest({
      activeAccountEmail: 'elvis@example.com',
      accounts: [{ email: 'elvis@example.com', isActive: true, hasRefreshToken: true }],
      autoSwitch: { enabled: true, poolKey: 'shared_3p_pool', metricMode: 'remaining_pct', windowKey: '5h', thresholdPct: 10, candidates: [] },
      autoSwitchStatus: {
        state: 'blocked_missing_pool',
        blockedReason: 'target_pool_missing_in_snapshot',
        blockedMeta: { poolKey: 'shared_3p_pool', windowKey: '5h' }
      }
    });
    assert.equal(h.elements.get('auto-switch-status-pill').textContent, '已开启 · 受阻 · 所选池不可用');
    assert.match(h.elements.get('auto-switch-last-note').textContent, /尚未返回监控池/);
    assert.doesNotMatch(h.elements.get('auto-switch-last-note').textContent, /无模型权限|无权限/);

    // 5. 打开看板/复制链接 4 分支文案核验（无硬编码括号）
    await api.setPanelLanguage('zh-CN', { persist: false });
    const sCopy = api.translateForTest('settings.dock.openRightCopiedSession');
    const lCopy = api.translateForTest('settings.dock.openRightCopiedList');
    const nSess = api.translateForTest('settings.dock.openRightNoSession', { copyNote: lCopy });
    assert.match(nSess, /未识别到当前会话，已打开看板列表/);
    assert.doesNotMatch(nSess, /[()（）]/);
    assert.doesNotMatch(sCopy + lCopy, /[()（）]/);
  } finally {
    api.dispose();
  }
});

test('v0.9.0-beta.1: 顶栏悬停/点击严格互斥状态机 + 顶栏/底栏去假圆盖子原位变形 + 悬浮圆球三态与二级菜单联动', async () => {
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  const tplSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const mainSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');

  assert.ok(tplSrc.includes('id="badge-radial-close-svg"'), '顶栏 #badge 必须内置原地变形关闭图标');
  assert.ok(tplSrc.includes('id="csb-radial-close-svg"'), '底栏 #csb-group-context 必须内置原地变形关闭图标');
  assert.match(stylesSrc, /\.ctx-radial-layer\[data-mode="topbar"\]\s+\.ctx-radial-center-close/);
  assert.match(stylesSrc, /\.ctx-radial-layer\[data-mode="bottombar"\]\s+\.ctx-radial-center-close/);
  assert.match(stylesSrc, /#badge\.ag-unit-ring\[data-radial-open="true"\]\s+\.ag-ring-close-svg[\s\S]*rotate\(45deg\)/);
  assert.match(stylesSrc, /#csb-group-context\[data-radial-open="true"\]\s+\.csb-ring-close-svg[\s\S]*rotate\(45deg\)/);
  assert.match(stylesSrc, /\.ctx-radial-layer\[data-mode="topbar"\]\s+\.ctx-radial-item[\s\S]*width:\s*36px;\s*height:\s*36px/);
  assert.match(stylesSrc, /\.ctx-radial-orb\s*\{[^}]*width:\s*46px;\s*height:\s*46px/);
  assert.match(stylesSrc, /ctx-orb-swap-in\s+160ms/);
  assert.match(mainSrc, /#composer-status-bar\s+#csb-group-context\[data-radial-open="true"\]\s+\.csb-ring-close-svg[\s\S]*rotate\(45deg\)/, '宿主 Light DOM #composer-status-bar 必须同步注入底栏原地变形样式');

  const capturedTimeouts = [];
  let nextTimerId = 10;
  const h = harness(session(), {
    setTimeout: (fn, ms) => {
      const id = ++nextTimerId;
      capturedTimeouts.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      const idx = capturedTimeouts.findIndex(t => t.id === id);
      if (idx >= 0) capturedTimeouts.splice(idx, 1);
    }
  });
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    const badge = h.elements.get('badge');
    const bOverflow = h.elements.get('badge-overflow');
    const om = h.elements.get('overflow-menu');
    const csbCtx = h.elements.get('csb-group-context');

    badge.focus = () => badge.trigger('focus');

    // 1. 顶栏互斥状态机
    api.setQuickMenuStyleForTest('topbar', { persist: false });
    badge.trigger('mouseenter');
    const tip = h.elements.get('context-tooltip');
    assert.equal(om.hidden, true, 'topbar 模式下 mouseenter #badge 禁止弹出 #overflow-menu');
    assert.equal(tip.getAttribute('data-visible'), 'true', 'topbar 模式下未展开时悬停应展示轻 #context-tooltip');

    badge.trigger('focus');
    assert.equal(om.hidden, true, 'topbar 模式下 focus #badge 禁止弹出 #overflow-menu');

    badge.click();
    const layer = h.elements.get('ctx-radial-layer');
    const centerClose = h.elements.get('ctx-radial-center-close');
    assert.equal(api.getRadialMenuStateForTest().open, true);
    assert.equal(layer.getAttribute('data-mode'), 'topbar');
    assert.equal(tip.getAttribute('data-visible'), 'false', '点击展开径向菜单瞬间必须强关 #context-tooltip');
    assert.equal(om.hidden, true, '点击展开径向菜单瞬间必须强关 #overflow-menu');
    assert.equal(centerClose.hidden, true, 'topbar 模式必须隐藏独立假大圆盖子');
    assert.equal(badge.getAttribute('data-radial-open'), 'true', 'topbar 展开态必须原位激活 #badge');
    assert.equal(badge.getAttribute('aria-expanded'), 'true');

    badge.trigger('mouseenter');
    badge.trigger('focus');
    assert.equal(om.hidden, true);
    assert.equal(tip.getAttribute('data-visible'), 'false', '径向展开期间必须彻底屏蔽悬停浮层');

    h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(api.getRadialMenuStateForTest().open, false);
    assert.equal(badge.getAttribute('data-radial-open'), null);
    assert.equal(om.hidden, true);

    bOverflow.click();
    assert.equal(om.hidden, false, '显式点击 #badge-overflow 应正常展开列表');
    om.hidden = true;

    // 2. 底栏贴边原生原地变形 + 外部点击收起
    api.setQuickMenuStyleForTest('bottombar', { persist: false });
    csbCtx.click();
    assert.equal(api.getRadialMenuStateForTest().open, true);
    assert.equal(layer.getAttribute('data-mode'), 'bottombar');
    assert.equal(centerClose.hidden, true, 'bottombar 模式必须隐藏独立假大圆盖子');
    assert.equal(csbCtx.getAttribute('data-radial-open'), 'true', 'bottombar 展开态必须原位激活 #csb-group-context');
    assert.equal(csbCtx.getAttribute('aria-expanded'), 'true');

    h.sandbox.document.dispatchEvent({ type: 'click', composedPath: () => [] });
    assert.equal(api.getRadialMenuStateForTest().open, false);
    assert.equal(csbCtx.getAttribute('data-radial-open'), null);

    // 3. 悬浮圆球实时三态 + 6 项二级菜单联动 + 新请求抢占 + CLI 1.2s 回落
    api.setQuickMenuStyleForTest('floating', { persist: false });
    api.setContextLatestForTest({ model: 'Gemini 4 Neon', modelId: 'gemini-4-neon', actual: 30720, budget: 512000, percent: 6 });
    const nowTs = Date.now();
    api.setQuotaSnapshotForTest({
      snapshot: {
        fetchedAtMs: nowTs,
        currentModel: { productKey: 'product:google:gemini-4-neon', productLabel: 'Gemini 4 Neon', poolKey: 'shared_gemini_main' },
        activeStatus: 'available',
        pools: [{
          poolKey: 'shared_gemini_main',
          title: 'Gemini 主池',
          models: [{ productKey: 'product:google:gemini-4-neon', productLabel: 'Gemini 4 Neon', modelIds: ['gemini-4-neon'] }],
          buckets: [{ bucketId: 'b5h', windowKey: '5h', windowShort: '5h', remainingFraction: 0.43, percentText: '43%' }]
        }]
      }
    }, nowTs);
    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      dailyMap: { '2026-11-23': { total: 6400000, input: 1400000, cache: 4800000, output: 200000, costUSD: 2.0 } },
      summary: { grandTotalTokens: 6400000, todayTokens: 6400000, monthTokens: 6400000, yearTokens: 6400000, totalConversations: 1 }
    });
    api.setSpeedEvaluationForTest({ phase: 'final', streamSpeed: 114, overallTps: 114, outputTokens: 200, streamingSec: 1.75 });
    api.setSessionCallsForTest([
      { callId: 'c_orb_1', stepIndex: 2, modelLabel: 'Gemini 4 Neon', inputTokens: 20000, outputTokens: 200, streamingTps: 114, status: 'final' }
    ], { replace: true });

    let orbSt = api.getFloatingOrbStateForTest();
    assert.equal(orbSt.mode, 'idle');
    assert.equal(orbSt.text, '6%');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-quota').click();
    orbSt = api.getFloatingOrbStateForTest();
    assert.equal(orbSt.mode, 'panel');
    assert.equal(orbSt.subKind, 'quota');
    assert.equal(orbSt.text, '43%');

    orbSt = api.setFloatingOrbLiveOverrideForTest({ phase: 'waiting', elapsedSec: 6 });
    assert.equal(orbSt.mode, 'waiting');
    assert.equal(orbSt.text, '6s');
    assert.equal(orbSt.tone, 'mid');

    orbSt = api.setFloatingOrbLiveOverrideForTest({ phase: 'waiting', elapsedSec: 78 });
    assert.equal(orbSt.mode, 'waiting');
    assert.equal(orbSt.text, '1m18s');
    assert.equal(orbSt.tone, 'slow');

    orbSt = api.setFloatingOrbLiveOverrideForTest({ phase: 'streaming', streamSpeed: 129 });
    assert.equal(orbSt.mode, 'streaming');
    assert.equal(orbSt.text, '129/s');
    assert.equal(orbSt.tone, 'fast');

    orbSt = api.setFloatingOrbLiveOverrideForTest(null);
    assert.equal(orbSt.mode, 'panel');
    assert.equal(orbSt.text, '43%');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-tokens').click();
    assert.equal(api.getFloatingOrbStateForTest().text, '6.4M');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-speed').click();
    assert.equal(api.getFloatingOrbStateForTest().text, '114/s');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-requests').click();
    assert.equal(api.getFloatingOrbStateForTest().text, '1');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-context').click();
    assert.equal(api.getFloatingOrbStateForTest().text, '6%');

    api.toggle(false);
    orbSt = api.getFloatingOrbStateForTest();
    assert.equal(orbSt.mode, 'idle');
    assert.equal(orbSt.linkedPanel, null);
    assert.equal(orbSt.text, '6%');

    h.elements.get('ctx-radial-orb').click();
    h.elements.get('radial-item-cli').click();
    orbSt = api.getFloatingOrbStateForTest();
    assert.equal(orbSt.mode, 'cli');
    assert.equal(orbSt.text, '>_');
    const cliTimer = capturedTimeouts.find(t => t.ms === 1200);
    assert.ok(cliTimer, '点击 CLI 卫星必须注册 1200ms 自动回落定时器');
    cliTimer.fn();
    orbSt = api.getFloatingOrbStateForTest();
    assert.equal(orbSt.mode, 'idle');
    assert.equal(orbSt.text, '6%');
  } finally {
    api.dispose();
  }
});

test('v0.9.0 三项 UI 精修: 独立顶层挂载至 body 末尾 + 快捷隐藏悬浮球 + 顶/底栏正圆收缩与白滑块 Tab', async () => {
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  const tplSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const mainSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  const bundleSrc = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');

  // 1. 静态 DOM 与 CSS 契约断言（源 + 构建产物同步验证）
  for (const labelSrc of [stylesSrc, bundleSrc]) {
    assert.match(labelSrc, /#badge\.ag-unit-ring\[data-radial-open="true"\][\s\S]*width:\s*26px\s*!important;[\s\S]*height:\s*26px\s*!important;[\s\S]*border-radius:\s*50%\s*!important;[\s\S]*padding:\s*0\s*!important/);
    assert.match(labelSrc, /#badge\.ag-unit-ring\[data-radial-open="true"\]\s+#badge-pct-val[\s\S]*max-width:\s*0\s*!important;[\s\S]*opacity:\s*0\s*!important/);
    assert.match(labelSrc, /#csb-group-context\[data-radial-open="true"\]\s*\{[\s\S]*width:\s*22px\s*!important;[\s\S]*height:\s*22px\s*!important;[\s\S]*border-radius:\s*50%\s*!important;[\s\S]*padding:\s*0\s*!important/);
    assert.match(labelSrc, /#csb-group-context\[data-radial-open="true"\]\s+#csb-context-text[\s\S]*max-width:\s*0\s*!important;[\s\S]*opacity:\s*0\s*!important/);
    assert.match(labelSrc, /#ctx-tabs-bar\s+\.ctx-tab-btn\.active\s*\{[\s\S]*background:\s*#2A2A2E;[\s\S]*color:\s*#FAFAFA;[\s\S]*rgba\(255,\s*255,\s*255,\s*0\.14\)/);
    assert.match(labelSrc, /:host\(\[data-theme="light"\]\)\s+#ctx-tabs-bar\s+\.ctx-tab-btn\.active[\s\S]*background:\s*#FFFFFF;[\s\S]*color:\s*#111111;[\s\S]*1px\s+solid\s+#E4E4E7;[\s\S]*0\s+1px\s+2px\s+rgba\(0,\s*0,\s*0,\s*0\.06\)/);
  }
  const tabBlockMatch = stylesSrc.match(/#ctx-tabs-bar\s*\{[\s\S]*?#pane-ctx-session\s+\.ctx-cockpit-grid/);
  assert.ok(tabBlockMatch, '应定位到 #ctx-tabs-bar 样式块');
  assert.doesNotMatch(tabBlockMatch[0], /#FF2E88|#FCE7F3|#BE185D/i, '#ctx-tabs-bar 严禁残留旧洋红配色');
  assert.match(mainSrc, /#composer-status-bar\s+#csb-group-context\[data-radial-open="true"\]\s*\{[\s\S]*width:\s*22px\s*!important;[\s\S]*height:\s*22px\s*!important;[\s\S]*border-radius:\s*50%\s*!important/);
  assert.match(mainSrc, /#composer-status-bar\s+#csb-group-context\[data-radial-open="true"\]\s+#csb-context-text[\s\S]*max-width:\s*0\s*!important;[\s\S]*opacity:\s*0\s*!important/);
  assert.ok(tplSrc.includes('id="chk-hide-radial-orb"'), '配置页必须包含隐藏悬浮圆球开关');
  assert.ok(tplSrc.includes('id="overflow-show-orb-btn"'), '顶栏菜单必须包含一键恢复悬浮圆球项');

  // 2. 独立顶层容器 #ag-context-meter-radial-host + 孤儿清理 + 属性镜像 + 点击防误关 + 快捷隐藏全链路
  const store = new Map();
  const mockLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const docListeners = new Map();
  const listeners = new Map();
  const makeNode = (tag = 'div') => {
    const attrs = new Map();
    const props = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      hidden: false,
      checked: false,
      textContent: '',
      _innerHTML: '',
      _styleCssText: '',
      style: {
        display: '',
        zIndex: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; },
        get cssText() { return node._styleCssText; },
        set cssText(v) {
          node._styleCssText = String(v || '');
          const zM = node._styleCssText.match(/z-index\s*:\s*([^;!]+)/i);
          if (zM) node.style.zIndex = zM[1].trim();
        }
      },
      get lastElementChild() { return node.children[node.children.length - 1] || null; },
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!cur.includes(c)) cur.push(c);
          attrs.set('class', cur.join(' '));
        },
        remove(c) {
          attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c).join(' '));
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        listeners.get(node).set(type, fn);
      },
      removeEventListener(type, fn) {
        const m = listeners.get(node);
        if (m && m.get(type) === fn) m.delete(type);
      },
      trigger(type, ev = {}) { listeners.get(node)?.get(type)?.(ev); },
      click() { listeners.get(node)?.get('click')?.({ stopPropagation() { }, preventDefault() { } }); },
      appendChild(child) {
        if (!child) return child;
        if (child.parentElement && Array.isArray(child.parentElement.children)) {
          const idx = child.parentElement.children.indexOf(child);
          if (idx >= 0) child.parentElement.children.splice(idx, 1);
        }
        child.parentElement = node;
        node.children.push(child);
        return child;
      },
      remove() {
        if (node.parentElement && Array.isArray(node.parentElement.children)) {
          const idx = node.parentElement.children.indexOf(node);
          if (idx >= 0) node.parentElement.children.splice(idx, 1);
          node.parentElement = null;
        }
      },
      contains(target) {
        if (!target) return false;
        if (target === node) return true;
        return node.children.some(c => c.contains?.(target));
      },
      getElementById(id) {
        const dfs = (cur) => {
          if (!cur) return null;
          if (cur.id === id || cur.getAttribute?.('id') === id) return cur;
          for (const ch of (cur.children || [])) {
            const found = dfs(ch);
            if (found) return found;
          }
          return null;
        };
        return dfs(node);
      },
      querySelector(sel) {
        if (sel === 'style') return node.children.find(c => c.tagName === 'STYLE') || null;
        if (sel.startsWith('#')) return node.getElementById(sel.slice(1));
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        const ids = parts.filter(s => s.startsWith('#')).map(s => s.slice(1));
        const hasRadialAttr = parts.includes('[data-ag-radial-top-layer]');
        const visit = (cur) => {
          if (!cur) return;
          if (ids.includes(cur.id) || (hasRadialAttr && cur.getAttribute?.('data-ag-radial-top-layer') !== null)) out.push(cur);
          for (const ch of (cur.children || [])) visit(ch);
        };
        visit(node);
        return out;
      },
      replaceChildren(...items) {
        node.children = [];
        for (const it of items) node.appendChild(it);
      },
      getBoundingClientRect() { return { left: 100, top: 100, width: 46, height: 46, right: 146, bottom: 146 }; }
    };
    return node;
  };

  const attachShadowPoly = (targetNode) => {
    const sr = makeNode('shadow-root');
    Object.defineProperty(sr, 'innerHTML', {
      get() { return sr._innerHTML; },
      set(val) {
        sr._innerHTML = String(val || '');
        sr.children = [];
        const styleM = sr._innerHTML.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
        if (styleM) {
          const st = makeNode('style');
          st.textContent = styleM[1];
          sr.appendChild(st);
        }
        const createdById = new Map();
        const reId = /\bid="([^"]+)"/g;
        let m;
        while ((m = reId.exec(sr._innerHTML)) !== null) {
          const id = m[1];
          if (createdById.has(id)) continue;
          const elNode = makeNode('div');
          elNode.id = id;
          elNode.className = id.startsWith('overflow-') ? 'overflow-item' : '';
          createdById.set(id, elNode);
          if (id.startsWith('ctx-orb-') && id !== 'ctx-radial-orb' && createdById.has('ctx-radial-orb')) {
            createdById.get('ctx-radial-orb').appendChild(elNode);
          } else if ((id === 'ctx-radial-center-close' || id.startsWith('radial-slot-') || id.startsWith('radial-item-')) && createdById.has('ctx-radial-layer')) {
            createdById.get('ctx-radial-layer').appendChild(elNode);
          } else {
            sr.appendChild(elNode);
          }
        }
      }
    });
    targetNode.shadowRoot = sr;
    return sr;
  };

  const runInTopLayerSandbox = () => {
    docListeners.clear();
    const body = makeNode('body');
    const docEl = makeNode('html');
    docEl.appendChild(body);
    const orphanRadial = makeNode('div');
    orphanRadial.id = 'ag-context-meter-radial-host';
    attachShadowPoly(orphanRadial).innerHTML = '<button id="ctx-radial-orb">staleA</button>';
    body.appendChild(orphanRadial);
    const orphanExtra = makeNode('div');
    orphanExtra.setAttribute('data-ag-radial-top-layer', 'true');
    attachShadowPoly(orphanExtra).innerHTML = '<button id="ctx-radial-orb">staleB</button>';
    body.appendChild(orphanExtra);
    const sidebarSibling = makeNode('div');
    sidebarSibling.id = 'mock-left-sidebar';
    body.appendChild(sidebarSibling);

    const pending = [], scans = [];
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      localStorage: mockLocalStorage,
      document: {
        body,
        documentElement: docEl,
        createElement: (tag) => {
          const n = makeNode(tag);
          if (String(tag).toLowerCase() === 'div') {
            n.attachShadow = () => attachShadowPoly(n);
          }
          return n;
        },
        getElementById: (id) => docEl.getElementById(id),
        querySelector: (sel) => docEl.querySelector(sel),
        querySelectorAll: (sel) => docEl.querySelectorAll(sel),
        addEventListener(type, fn) {
          if (!docListeners.has(type)) docListeners.set(type, new Set());
          docListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
        dispatchEvent(ev) {
          for (const fn of (docListeners.get(ev?.type || ev) || [])) fn(ev);
        },
        hidden: false
      },
      window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } },
      __AGContextMeterCore: core,
      AbortController,
      Date,
      setTimeout: () => 1,
      clearTimeout() { },
      setInterval: () => 1,
      clearInterval() { },
      fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); }
    };
    vm.createContext(sandbox);
    vm.runInContext(bundleSrc, sandbox);
    return { sandbox, body, pending, scans, orphanRadial, orphanExtra };
  };

  const env1 = runInTopLayerSandbox();
  const api1 = env1.sandbox.__AGContextMeter;
  try {
    assert.equal(env1.orphanRadial.parentElement, null, '必须清除旧 #ag-context-meter-radial-host');
    assert.equal(env1.orphanExtra.parentElement, null, '必须清除无 ID 但带 data-ag-radial-top-layer 的第二颗悬浮球宿主');
    assert.equal(env1.orphanRadial.shadowRoot.innerHTML, '', '清除孤儿宿主时必须清空 shadowRoot');
    assert.equal(env1.orphanExtra.shadowRoot.innerHTML, '', '清除第二颗残留宿主时必须清空 shadowRoot');
    const topHosts = env1.body.querySelectorAll('#ag-context-meter-radial-host, [data-ag-radial-top-layer]');
    assert.equal(topHosts.length, 1, '启动时必须清除旧孤儿 #ag-context-meter-radial-host 且仅保留唯一实例');
    const radialHost = topHosts[0];
    const meterHost = env1.body.getElementById('ag-context-meter');
    assert.ok(radialHost && meterHost);
    assert.equal(env1.body.lastElementChild, radialHost, '#ag-context-meter-radial-host 必须位于 document.body 末尾');
    assert.match(radialHost.style.cssText, /position:\s*fixed/i);
    assert.match(radialHost.style.cssText, /width:\s*0\s*!important;\s*height:\s*0\s*!important/i);
    assert.doesNotMatch(radialHost.style.cssText, /app-region/);
    assert.match(radialHost.style.cssText, /pointer-events:\s*none/i);
    assert.equal(radialHost.style.zIndex, '2147483000');

    const radialShadow = radialHost.shadowRoot;
    const mainShadow = meterHost.shadowRoot;
    const orbNode = radialShadow.getElementById('ctx-radial-orb');
    const layerNode = radialShadow.getElementById('ctx-radial-layer');
    assert.ok(orbNode && layerNode, '悬浮球与径向菜单必须位于独立顶层 radialShadow 中');
    assert.equal(mainShadow.getElementById('ctx-radial-orb'), null, '主 shadow 内不应保留悬浮球重复节点');
    assert.equal(mainShadow.getElementById('ctx-radial-layer'), null, '主 shadow 内不应保留径向层重复节点');
    const radialStyle = radialShadow.querySelector('style')?.textContent || '';
    assert.doesNotMatch(radialStyle.match(/:host\s*\{[^}]*\}/)?.[0] || '', /app-region/);
    assert.match(radialStyle, /:host\s*\{[\s\S]*z-index:\s*2147483000\s*!important[\s\S]*pointer-events:\s*none\s*!important/);
    assert.match(radialStyle, /\.ctx-radial-orb\s*\{[\s\S]*pointer-events:\s*auto/);
    assert.match(radialStyle, /:host\(\[data-marketplace-active="true"\]\)\s+#ctx-radial-orb/);

    api1.setRadialOrbEnabledForTest(true, { persist: false });
    api1.setTheme('light');
    assert.equal(radialHost.getAttribute('data-theme'), 'light', 'data-theme 必须实时镜像到独立顶层宿主');
    const rSt = api1.getRadialMenuStateForTest();
    assert.equal(rSt.topLayerMounted, true);
    assert.equal(rSt.topLayerHostId, 'ag-context-meter-radial-host');
    assert.equal(rSt.topLayerParentTag, 'BODY');
    assert.equal(rSt.topLayerZIndex, '2147483000');
    assert.equal(rSt.radialOrbHidden, false);

    const lateOverlay = env1.sandbox.document.createElement('div');
    lateOverlay.id = 'late-host-panel';
    env1.body.appendChild(lateOverlay);
    orbNode.click();
    assert.equal(env1.body.lastElementChild, radialHost, '展开径向菜单前必须确保顶层容器位于 body 末尾');
    assert.equal(api1.getRadialMenuStateForTest().open, true);
    env1.sandbox.document.dispatchEvent({ type: 'click', composedPath: () => [orbNode, radialHost] });
    assert.equal(api1.getRadialMenuStateForTest().open, true, '点击独立顶层中的悬浮球路径不得被 outside 误关');
    env1.sandbox.document.dispatchEvent({ type: 'click', composedPath: () => [lateOverlay] });
    assert.equal(api1.getRadialMenuStateForTest().open, false, '点击外部宿主区域必须干净关闭径向菜单');

    let prevented = false;
    let stopped = false;
    orbNode.trigger('contextmenu', {
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; }
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(orbNode.hidden, true, '右键悬浮球必须立即隐藏悬浮球');
    assert.equal(store.get('ag_radial_orb_hidden'), 'true', '快捷隐藏状态必须持久化到 localStorage');
    const toast = mainShadow.getElementById('cli-launch-toast');
    const chkHideOrb = mainShadow.getElementById('chk-hide-radial-orb');
    const showOrbBtn = mainShadow.getElementById('overflow-show-orb-btn');
    assert.equal(toast.hidden, false, '右键隐藏悬浮球后应弹出轻提示');
    assert.equal(chkHideOrb.checked, true, '配置页隐藏悬浮球开关必须同步勾选');
    assert.equal(showOrbBtn.hidden, false, '隐藏悬浮球后顶栏恢复入口必须显现');

    showOrbBtn.click();
    assert.equal(orbNode.hidden, false, '点击顶栏恢复入口必须重新显示悬浮球');
    assert.equal(store.get('ag_radial_orb_hidden'), 'false');
    assert.equal(chkHideOrb.checked, false);
    assert.equal(showOrbBtn.hidden, true, '悬浮球显示后应自动收起顶栏恢复入口');

    chkHideOrb.checked = true;
    chkHideOrb.trigger('change', { target: chkHideOrb });
    assert.equal(orbNode.hidden, true);
    assert.equal(store.get('ag_radial_orb_hidden'), 'true');
  } finally {
    api1.dispose();
  }
  assert.equal(env1.body.getElementById('ag-context-meter-radial-host'), null, 'dispose 后必须移除独立顶层宿主容器');
  api1.setRadialOrbHiddenForTest(false, { persist: false });
  assert.equal(env1.body.querySelectorAll('[data-ag-radial-top-layer]').length, 0, 'dispose 后调用显隐控制不得将悬浮球重新插回 body');

  const env2 = runInTopLayerSandbox();
  const api2 = env2.sandbox.__AGContextMeter;
  try {
    const radialHost2 = env2.body.getElementById('ag-context-meter-radial-host');
    const meterHost2 = env2.body.getElementById('ag-context-meter');
    assert.equal(radialHost2.shadowRoot.getElementById('ctx-radial-orb').hidden, true, '重启后应保留悬浮球隐藏持久化状态');
    assert.equal(meterHost2.shadowRoot.getElementById('chk-hide-radial-orb').checked, true);
    assert.equal(meterHost2.shadowRoot.getElementById('overflow-show-orb-btn').hidden, false);
    api2.setRadialOrbHiddenForTest(false, { persist: true });
    assert.equal(radialHost2.shadowRoot.getElementById('ctx-radial-orb').hidden, false);
  } finally {
    api2.dispose();
  }
});

test('径向Tooltip朝外防遮挡 + 去套娃叠环去12点圆点 + 溢出菜单CLI树莓色与缓存命中率 + 会话缓存命中率直达实时请求', () => {
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  const i18nSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
  const tplSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');

  // A. CSS 与模板契约验证（z-index、去套娃叠环与光晕、12点圆点属性、56px 半径与极细描边、树莓色 CLI 图标）
  const orbZ = Number((stylesSrc.match(/\.ctx-radial-orb\s*\{[^}]*z-index\s*:\s*(\d+)/) || [])[1] || 0);
  const layerZ = Number((stylesSrc.match(/\.ctx-radial-layer\s*\{[^}]*z-index\s*:\s*(\d+)/) || [])[1] || 0);
  assert.ok(layerZ > orbZ && orbZ >= 2147483645, `径向浮层 z-index(${layerZ}) 必须严格高于悬浮球 z-index(${orbZ})`);
  assert.match(stylesSrc, /\.ctx-radial-label\s*\{[\s\S]*z-index:\s*90;/);
  assert.match(stylesSrc, /\.ctx-radial-slot:hover,\s*\.ctx-radial-slot:focus-within\s*\{\s*z-index:\s*40;/);
  assert.match(stylesSrc, /\.ctx-radial-item\[data-label-pos="bottom"\]\s+\.ctx-radial-label/);
  assert.match(stylesSrc, /\.ctx-radial-item\[data-label-pos="right"\]\s+\.ctx-radial-label/);
  assert.match(stylesSrc, /\.ctx-radial-item\[data-label-pos="left"\]\s+\.ctx-radial-label/);
  assert.match(stylesSrc, /\.ctx-radial-orb\[aria-expanded="true"\]\s+\.ctx-orb-ring-svg\s*\{[^}]*opacity:\s*0;/);
  assert.doesNotMatch(stylesSrc, /\.ctx-radial-orb\[aria-expanded="true"\][^{]*\{[^}]*0 0 0 4px/);
  assert.match(stylesSrc, /\.ctx-orb-ring-fill\[data-empty="true"\]\s*\{[^}]*opacity:\s*0;[^}]*stroke:\s*none;/);
  assert.match(stylesSrc, /\.ctx-radial-slot\s*\{[\s\S]*--r-rest:\s*56px;/);
  assert.match(stylesSrc, /\.ctx-radial-item\s*\{[^}]*border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.10\);/);
  assert.match(stylesSrc, /#overflow-cli-btn\s+\.cli-icon\s*\{\s*color:\s*#FF2E88;/);
  assert.match(stylesSrc, /:host\(\[data-theme="light"\]\)\s+#overflow-cli-btn\s+\.cli-icon[\s\S]*color:\s*#E11D74;/);
  assert.match(i18nSrc, /'overflow\.cacheHit':\s*\{\s*'zh-CN':\s*'缓存命中率',\s*'zh-TW':\s*'快取命中率',\s*en:\s*'Cache hit rate'\s*\}/);
  assert.match(tplSrc, /id="overflow-cache-btn"[\s\S]*id="overflow-cache-val"/);

  // B. 四方向径向 Tooltip + 贴边翻转 + 12 点残余圆点彻底清除
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const gCenter = api.computeRadialGeometryForTest('floating', { left: 500, top: 380, width: 40, height: 40 }, 1280, 800);
    assert.deepStrictEqual(
      Array.from(gCenter.items.map(it => it.labelPos)),
      ['top', 'right', 'right', 'bottom', 'left', 'left'],
      '360° 六瓣卫星必须按方位沿径向朝外弹出 Tooltip（top/right/right/bottom/left/left）'
    );
    const gRightEdge = api.computeRadialGeometryForTest('floating', { left: 1230, top: 380, width: 40, height: 40 }, 1280, 800);
    assert.ok(gRightEdge.items.every(it => ['top', 'bottom', 'left'].includes(it.labelPos)), '贴右边缘不得向外右侧裁切');
    const gTopEdge = api.computeRadialGeometryForTest('topbar', { left: 900, top: 4, width: 58, height: 26 }, 1280, 800);
    assert.equal(gTopEdge.items[0].labelPos, 'right', 'topbar 最右翼应向右朝外弹出');
    assert.equal(gTopEdge.items[gTopEdge.items.length - 1].labelPos, 'left', 'topbar 最左翼应向左朝外弹出');
    const gBottomEdge = api.computeRadialGeometryForTest('bottombar', { left: 600, top: 760, width: 58, height: 22 }, 1280, 800);
    assert.ok(gBottomEdge.items.every(it => it.labelPos !== 'bottom'), 'bottombar 卫星 Tooltip 严禁向下撞底栏');

    const ringFill = h.elements.get('ctx-orb-ring-fill');
    assert.equal(ringFill.getAttribute('data-empty'), 'true', '无数据 --% 初始必须隐藏进度弧以防 12 点小圆点');
    assert.equal(ringFill.getAttribute('stroke-opacity'), '0');
    api.setContextLatestForTest({ model: 'Gemini 4 Neon', actual: 0, budget: 512000, percent: 0 });
    assert.equal(ringFill.getAttribute('data-empty'), 'true', '0% 时同样必须隐藏进度弧 stroke');
    assert.equal(ringFill.getAttribute('stroke-opacity'), '0');
    api.setContextLatestForTest({ model: 'Gemini 4 Neon', actual: 215040, budget: 512000, percent: 42 });
    assert.equal(ringFill.getAttribute('data-empty'), null, '非零进度时必须恢复显示进度弧');
    assert.equal(ringFill.getAttribute('stroke-opacity'), '1');

    // C. 溢出菜单「缓存命中率」真实数据展示 + 点击直达实时请求 + 底部入口两次点击零闪烁直达「实时请求」
    const oCacheVal = h.elements.get('overflow-cache-val');
    const om = h.elements.get('overflow-menu');
    assert.ok(oCacheVal && h.elements.get('overflow-cache-btn'));
    h.elements.get('badge-overflow').click();
    assert.equal(om.hidden, false);
    assert.equal(oCacheVal.textContent, '--', '无会话调用记录时溢出菜单缓存命中率应显示 --');

    api.setComposerStateForTest({
      sessionCalls: [{ callId: 'c_hit_1', stepIndex: 1, inputTokens: 460, cacheReadTokens: 9540, outputTokens: 200, status: 'final' }],
      sessionStats: { usedTokens: 10200, limitTokens: 512000, turnCount: 1, stepCount: 1 }
    });
    h.elements.get('badge-overflow').click();
    assert.equal(oCacheVal.textContent, '95.4%', '有真实数据时溢出菜单缓存命中率必须复用会话数据并显示精确百分比');
    h.elements.get('overflow-cache-btn').click();
    assert.equal(h.elements.get('panel-tokens').hidden, false);
    assert.equal(h.elements.get('requests-live-view').style.display, 'flex');

    // 切回 Token 统计并关闭面板，测试第 7 项两次零闪烁点击
    h.elements.get('tok-view-tokens').click();
    assert.equal(h.elements.get('tokens-main-view').style.display, 'block');
    api.toggle(false);
    assert.equal(h.elements.get('panel-tokens').hidden, true);

    // 通过劫持 panel-tokens.hidden setter 记录首次显现瞬间视图状态，证明 0 帧闪出旧页
    const pTokens = h.elements.get('panel-tokens');
    const reqView = h.elements.get('requests-live-view');
    const mainView = h.elements.get('tokens-main-view');
    const tokReqTab = h.elements.get('tok-view-requests');
    const revealSnapshots = [];
    let hiddenVal = pTokens.hidden;
    Object.defineProperty(pTokens, 'hidden', {
      configurable: true,
      get() { return hiddenVal; },
      set(v) {
        const prev = hiddenVal;
        hiddenVal = Boolean(v);
        if (prev && !hiddenVal) {
          revealSnapshots.push({
            reqDisplay: reqView.style.display,
            mainDisplay: mainView.style.display,
            reqActive: tokReqTab.classList.contains('active')
          });
        }
      }
    });

    const csbTokensBtn = h.elements.get('csb-group-tokens');
    // 验证 A：首次从其他旧页记忆态直接点击「会话缓存命中率」
    csbTokensBtn.click();
    assert.equal(pTokens.hidden, false);
    assert.equal(reqView.style.display, 'flex');
    assert.equal(tokReqTab.classList.contains('active'), true);
    assert.deepStrictEqual(revealSnapshots[0], { reqDisplay: 'flex', mainDisplay: 'none', reqActive: true }, '首次展开瞬间即须为实时请求，严禁先闪出 Token 统计');

    // 验证 B：手动切到「Token 统计」→ 关闭 → 再次点击「会话缓存命中率」
    h.elements.get('tok-view-tokens').click();
    assert.equal(mainView.style.display, 'block');
    api.toggle(false);
    csbTokensBtn.click();
    assert.equal(pTokens.hidden, false);
    assert.equal(reqView.style.display, 'flex');
    assert.equal(tokReqTab.classList.contains('active'), true);
    assert.deepStrictEqual(revealSnapshots[1], { reqDisplay: 'flex', mainDisplay: 'none', reqActive: true }, '第二次展开瞬间同样即须为实时请求');

    // 底栏 Token 胶囊作为唯一点击入口直达实时请求
    api.toggle(false);
    csbTokensBtn.click();
    assert.equal(pTokens.hidden, false);
    assert.equal(reqView.style.display, 'flex');
  } finally {
    api.dispose();
  }
});

test('上下文直达零闪烁 + 底栏消除硬裁切自适应换行 + 悬浮圆球悬停同心居中契约', async () => {
  const stylesSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  const tplSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  const mainSrc = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');

  // 1. 第 2 项 CSS 与 Light DOM 样式契约（禁止全局 72px 裁切、允许 wrap + overflow visible、保留径向收缩）
  assert.doesNotMatch(stylesSrc, /\.csb-text\s*\{[^}]*max-width:\s*72px/);
  assert.match(stylesSrc, /\.composer-status-bar\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow:\s*visible;/s);
  assert.match(stylesSrc, /\.csb-quota-pill\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(mainSrc, /#composer-status-bar\s*\{[^}]*flex-wrap:\s*wrap\s*!important;[^}]*overflow:\s*visible\s*!important;/s);
  assert.match(mainSrc, /#composer-status-bar\s+\.csb-text\s*\{[^}]*max-width:\s*none\s*!important;[^}]*overflow:\s*visible\s*!important;/s);
  assert.match(mainSrc, /#composer-status-bar\s+\.csb-quota-pill\s*\{[^}]*overflow:\s*visible\s*!important;/s);

  // 2. 第 3 项悬浮球同心居中契约（严格 border-box、grid 居中、hover 不放大位移、svg inset:0 100% 匹配 cx=cy=23）
  assert.match(stylesSrc, /\.ctx-radial-orb\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*46px;[^}]*height:\s*46px;[^}]*margin:\s*0;[^}]*padding:\s*0;[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
  assert.doesNotMatch(stylesSrc, /\.ctx-radial-orb:hover\s*\{[^}]*scale\(/);
  assert.match(stylesSrc, /\.ctx-orb-ring-svg\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*display:\s*block;/s);
  assert.match(tplSrc, /<svg class="ctx-orb-ring-svg" viewBox="0 0 46 46" aria-hidden="true">/);
  assert.match(tplSrc, /class="ctx-orb-ring-track" cx="23" cy="23" r="19\.5"/);

  // 3. 第 1 项行为与零闪烁验证
  const h = harness(session());
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    const pCtx = h.elements.get('panel');
    const paneSess = h.elements.get('pane-ctx-session');
    const paneSet = h.elements.get('pane-ctx-settings');
    const tabSess = h.elements.get('tab-ctx-session');
    const tabSet = h.elements.get('tab-ctx-accounts');
    const revealSnaps = [];
    let pHidden = pCtx.hidden;
    Object.defineProperty(pCtx, 'hidden', {
      configurable: true,
      get() { return pHidden; },
      set(v) {
        const prev = pHidden;
        pHidden = Boolean(v);
        if (prev && !pHidden) {
          revealSnaps.push({
            sessHidden: paneSess.hidden,
            setHidden: paneSet.hidden,
            sessActive: tabSess.classList.contains('active'),
            setActive: Boolean(tabSet?.classList?.contains('active'))
          });
        }
      }
    });

    // (a) 切到配置 -> 不关闭直接点底栏 #csb-group-context / 径向上下文 / 溢出菜单上下文均立即回「当前会话」且面板不关闭
    api.openContextSettingsForTest({ forceFallbackPane: true });
    assert.equal(pCtx.hidden, false);
    assert.equal(api.getContextPreferencesState().activeContextTab, 'settings');
    assert.equal(api.getPanelPickerStateForTest().currentTarget, 'settings');

    h.elements.get('csb-group-context').click();
    assert.equal(pCtx.hidden, false, '停在配置页点底栏上下文入口应切回当前会话，不应直接关闭面板');
    assert.equal(api.getContextPreferencesState().activeContextTab, 'session');
    assert.equal(api.getContextPreferencesState().isContextSettingsView, false);

    // 停在当前会话再次点击同一入口才执行关闭
    h.elements.get('csb-group-context').click();
    assert.equal(pCtx.hidden, true, '停在当前会话再次点击同一入口应正常关闭面板');

    // (b) 停在「配置」后关闭面板 -> 分别点各上下文入口，首帧即须呈现「当前会话」零闪烁
    api.openContextSettingsForTest();
    api.toggle(false);
    h.elements.get('csb-group-context').click();
    assert.equal(pCtx.hidden, false);
    assert.deepStrictEqual(revealSnaps[revealSnaps.length - 1], {
      sessHidden: false,
      setHidden: true,
      sessActive: true,
      setActive: false
    }, '关闭后点底栏上下文入口，首帧即须是当前会话');

    api.openContextSettingsForTest();
    api.toggle(false);
    h.elements.get('radial-item-context').click();
    assert.equal(pCtx.hidden, false);
    assert.deepStrictEqual(revealSnaps[revealSnaps.length - 1], {
      sessHidden: false,
      setHidden: true,
      sessActive: true,
      setActive: false
    }, '关闭后点径向菜单上下文入口，首帧即须是当前会话');

    api.openContextSettingsForTest();
    api.toggle(false);
    h.elements.get('overflow-context-btn').click();
    assert.equal(pCtx.hidden, false);
    assert.deepStrictEqual(revealSnaps[revealSnaps.length - 1], {
      sessHidden: false,
      setHidden: true,
      sessActive: true,
      setActive: false
    }, '关闭后点溢出菜单上下文入口，首帧即须是当前会话');

    // 非径向模式下直接点顶栏 #badge 也遵循同规则（先停在配置时切回当前会话，再点才关闭）
    api.setQuickMenuStyleForTest('floating', { persist: false });
    api.openContextSettingsForTest();
    h.elements.get('badge').click();
    assert.equal(pCtx.hidden, false);
    assert.equal(api.getContextPreferencesState().activeContextTab, 'session');
    h.elements.get('badge').click();
    assert.equal(pCtx.hidden, true);

    // (c) 专用配置入口与右键 CLI 仍直达配置
    h.elements.get('btn-quick-settings').click();
    assert.equal(pCtx.hidden, false);
    assert.equal(api.getContextPreferencesState().activeContextTab, 'settings');
    api.toggle(false);
    h.elements.get('radial-item-cli').trigger('contextmenu', { preventDefault() { }, stopPropagation() { } });
    assert.equal(pCtx.hidden, false);
    assert.equal(api.getContextPreferencesState().activeContextTab, 'settings');
  } finally {
    api.dispose();
  }
});



test('v0.9.1 第19轮 / A: 三算法切换数值与冠军同步重算', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(src, /const speedResolvedMetrics = \(group\) =>/, '必须有统一的算法解析函数');
  assert.match(src, /speedAlgorithm === 'composite'/, '必须实现综合效率分支');
  assert.match(src, /500 \/ \(medianTtft \+ 500 \/ medianTps\)/, '综合效率公式必须是 500 / (TTFT + 500 / tok_s)');
  assert.match(src, /: medianTps;/, '缺 TTFT 时必须回退 tok_s');
  assert.match(src, /if \(speedAlgorithm === 'mean'\)/, '必须实现均值分支');
  // 冠军判定不得再依赖下标 0
  assert.doesNotMatch(src, /if \(index === 0\) \{\s*const badge/, '冠军判定不得写死第一张卡');
  assert.match(src, /const championId = \(\(\) => \{/, '必须有动态冠军判定');
  assert.match(src, /speedMetric === 'tps' \? b\.v - a\.v : a\.v - b\.v/, '冠军排序必须区分越大越快与越小越快');
});

test('v0.9.1 第19轮 / B: 折线图按日聚合 + P95 压平 + Y 轴锁 0', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(src, /Math\.floor\(ts \/ 86400000\)/, '必须按自然日分桶');
  assert.match(src, /const val = speedAlgorithm === 'mean'/, '每日聚合必须随算法联动');
  assert.match(src, /Math\.floor\(sortedVals\.length \* 0\.95\)/, '必须有 P95 上限保护');
  assert.match(src, /if \(pt\.val > cap\) pt\.val = cap;/, '超过 P95 的点必须被压平');
  assert.match(src, /const yMin = Math\.max\(0, rawMin - span \* 0\.15\);/, 'Y 轴下限必须锁 0');
  assert.match(src, /const yMax = Math\.max\(yMin \+ 1,/, '必须保证 yMax > yMin');
});

test('v0.9.1 第19轮 / C: 折线图图例使用 speedDisplayName 区分档位且零括号', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(src, /text\.textContent = speedDisplayName\(group\);/, '图例必须走 speedDisplayName');
  assert.doesNotMatch(src, /text\.textContent = String\(group\.productLabel \|\| group\.modelExactId \|\| ''\)\.split/, '不得再截断到无档位的短名');
  // 档位分隔符与零括号契约
  assert.match(src, /\.join\(' · '\)/, '档位必须用中点连接');
  assert.match(src, /composed\.replace\(/, 'speedDisplayName must strip brackets');
});

function openSpeedTrend() {
  const h = harness();
  const doc = h.sandbox.document;
  doc.createElementNS = (_ns, tag) => Object.assign(doc.createElement(tag), { tagName: tag });
  const api = h.sandbox.__AGContextMeter;
  api.switchContextTabForTest('speed');
  return { h, api, svg: h.elements.get('speed-line-svg') };
}

test('speed trend selects local days, hours and raw timestamps from plottable samples', () => {
  const { h, api, svg } = openSpeedTrend();
  const now = Date.now() - 10_000;
  try {
    for (const [interval, label] of [[86400000, '按日聚合'], [3600000, '按小时聚合'], [1100, '按采样序列']]) {
      api.setSpeedRecordsForTest([0, 1, 2, 3].map(i => ({
        callId: 'trend-' + i, modelExactId: 'gemini-4-hydrogen', status: 'final', timestamp: now - i * interval,
        outputTokens: 400, durationSec: 10, tps: 40 + i * 3
      })));
      assert.equal(h.elements.get('speed-trend-foot').children[0].textContent, label);
      const marks = svg.children.filter(node => node.className === 'ctx-speed-x-tick' || node.getAttribute('class') === 'ctx-speed-x-tick');
      assert.ok(marks.length >= 3 && marks.length <= 7);
      assert.equal(new Set(marks.map(node => node.textContent)).size, marks.length);
      assert.equal(svg.children.find(node => node.tagName === 'polyline').getAttribute('points').split(' ').length, 4);
    }
    api.setSpeedRecordsForTest([]);
    assert.equal(svg.children.length, 0);
    assert.equal(h.elements.get('speed-trend-foot').children.length, 0);
  } finally {
    api.dispose();
  }
});

test('speed trend colors and names match each plotted model, including duplicate display names', () => {
  const { h, api, svg } = openSpeedTrend();
  const ids = ['gemini-4-hydrogen-ultra', 'gemini-4-hydrogen-ultra-preview', 'gemini-4-hydrogen-low',
    'gemini-4-carbon-mid', 'gemini-3.8-flash-high', 'claude-opus-4-6', 'gpt-5.4', 'gemini-3.1-pro-high'];
  try {
    api.setSpeedRecordsForTest(ids.map((modelExactId, i) => ({
      callId: 'color-' + i, modelExactId, status: 'final', timestamp: Date.now() - 2000 + i,
      modelLabel: i < 2 ? 'Gemini 4 Hydrogen (Ultra)' : modelExactId, effort: i < 2 ? 'ultra' : undefined,
      outputTokens: 400, durationSec: 10, tps: 40 + i
    })));
    for (const id of ids) {
      const row = h.elements.get('speed-rank-rows').children.find(node => node.getAttribute('data-rank-id') === id);
      const checkbox = row.children[0].children[0];
      checkbox.checked = true;
      checkbox.trigger('change');
    }
    const legend = h.elements.get('speed-trend-legend').children;
    const names = legend.map(item => item.children[1].textContent);
    const colors = legend.map(item => item.children[0].style.background);
    assert.equal(new Set(names).size, 8);
    assert.equal(new Set(colors).size, 8);
    assert.ok(names.every(name => !/[（）()]/.test(name)));
    assert.deepEqual(svg.children.filter(node => node.tagName === 'polyline').map(node => node.getAttribute('stroke')), colors);
  } finally {
    api.dispose();
  }
});


test('Phase 1.3: 账号与自动切号迁入设置页专卡、移除弹窗顶层化、双入口共享状态与草稿', async () => {
  const tpl = fs.readFileSync(path.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  const settingsPaneIdx = tpl.indexOf('id="pane-ctx-settings"');
  const settingsAcctsIdx = tpl.indexOf('id="settings-accounts-card"');
  const restartModalIdx = tpl.indexOf('id="global-restart-modal"');
  const removeModalIdx = tpl.indexOf('id="account-remove-modal"');
  const quotaPanelIdx = tpl.indexOf('id="panel-quota"');
  const quotaEntryIdx = tpl.indexOf('id="quota-accounts-entry-card"');
  const keepaliveIdx = tpl.indexOf('id="quota-keepalive-section"');
  assert.ok(settingsPaneIdx > 0 && settingsAcctsIdx > settingsPaneIdx, '设置页必须包含 #settings-accounts-card');
  assert.ok(settingsAcctsIdx < restartModalIdx, '#settings-accounts-card 必须在 #pane-ctx-settings 内部');
  assert.ok(removeModalIdx > restartModalIdx && removeModalIdx < quotaPanelIdx, '#account-remove-modal 必须提升至顶层且位于 #panel-quota 外部');
  assert.ok(quotaEntryIdx > quotaPanelIdx && keepaliveIdx > quotaEntryIdx, '额度面板必须保留摘要入口卡与缓存保活诊断');
  assert.match(tpl, /data-nav-target="settings-accounts-card"/, '设置页快捷导航必须包含账号与切号入口');

  for (const key of [
    'settings.nav.accounts', 'accounts.manageBtn', 'accounts.refreshEntry',
    'accounts.entryActiveLabel', 'accounts.entryNoActive', 'accounts.entryRuleUnsaved', 'accounts.entryRuleSummary'
  ]) {
    const m = i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*\\{[^\\n]+\\}`));
    assert.ok(m, `必须包含词条 ${key}`);
    assert.doesNotMatch(m[0], /[（）()]/, `新增三语词条 ${key} 不得包含括号`);
  }

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    api.setAccountsOverviewForTest({
      accounts: [
        { email: 'a@example.com', maskedEmail: 'a***@example.com', isActive: true, hasRefreshToken: true, quotaSnapshot: { pools: [] } },
        { email: 'b@example.com', maskedEmail: 'b***@example.com', isActive: false, hasRefreshToken: true, quotaSnapshot: { pools: [] } }
      ],
      autoSwitch: { enabled: true, poolKey: 'shared_gemini_main', metricMode: 'remaining_pct', windowKey: '5h', thresholdPct: 20, candidates: ['b@example.com'] },
      autoSwitchStatus: { state: 'watching' }
    });
    assert.match(h.elements.get('quota-entry-active-account').textContent, /a@example\.com/);
    assert.equal(h.elements.get('quota-entry-autoswitch-pill').textContent, '已开启 · 监控中');
    assert.match(h.elements.get('quota-entry-rule-summary').textContent, /20%/);

    const th = h.elements.get('inp-auto-switch-threshold');
    th.value = '35';
    th.trigger('input');
    assert.match(h.elements.get('quota-entry-rule-summary').textContent, /未保存/);
    assert.match(h.elements.get('auto-switch-save-status').textContent, /未保存/);
    api.setAccountsOverviewForTest({
      accounts: [
        { email: 'a@example.com', maskedEmail: 'a***@example.com', isActive: true, hasRefreshToken: true, quotaSnapshot: { pools: [] } },
        { email: 'b@example.com', maskedEmail: 'b***@example.com', isActive: false, hasRefreshToken: true, quotaSnapshot: { pools: [] } }
      ],
      autoSwitch: { enabled: true, poolKey: 'shared_gemini_main', metricMode: 'remaining_pct', windowKey: '5h', thresholdPct: 20, candidates: ['b@example.com'] },
      autoSwitchStatus: { state: 'watching' }
    });
    assert.equal(th.value, '35', '后台刷新不得冲掉正在编辑的草稿');

    h.elements.get('btn-quota-open-accounts-settings').click();
    assert.equal(h.elements.get('panel').hidden, false);
    assert.equal(h.elements.get('pane-ctx-accounts').hidden, false);
  } finally {
    api.dispose();
  }
});


test('Phase 2C (PR #102 & Issue #106): 无独立菜单栏/macOS隐藏标题栏注入空白拖区且全屏径向宿主保持0x0无全屏no-drag', async () => {
  const h = harness();
  try {
    if (!h.sandbox.document.head) h.sandbox.document.head = h.sandbox.document.createElement();
    const api = h.sandbox.__AGContextMeter;

    // 1. 径向顶层容器保持 0x0 不覆盖视口
    const src = fs.readFileSync(path.join(__dirname, 'src/renderer/main.js'), 'utf8');
    assert.match(src, /radialHost\.style\.cssText\s*=\s*`position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;/);
    assert.doesNotMatch(src.slice(src.indexOf('function extractRadialTopLayerCss()'), src.indexOf('function ensureRadialHostAtBodyEnd()')), /-webkit-app-region:\s*no-drag/);

    // 2. Windows 顶栏 WCO / 无独立菜单栏时声明 @container/titlebar -webkit-app-region: drag，交互按钮保持 no-drag
    h.sandbox.navigator = { platform: 'Win32' };
    h.sandbox.window.innerWidth = 1280;
    h.sandbox.window.outerWidth = 1280;
    const tb = h.sandbox.document.createElement();
    tb.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1280, bottom: 40, width: 1280, height: 40 });
    h.sandbox.document.querySelector = sel => (sel.includes('@container/titlebar') ? tb : null);
    api.syncWindowControlsOverlayForTest();
    const fixEl = h.sandbox.document.getElementById('ag-topbar-host-fix');
    assert.ok(fixEl);
    assert.match(fixEl.textContent, /\[class\*="@container\/titlebar"\][\s\S]*-webkit-app-region:\s*drag;/);
    assert.match(fixEl.textContent, /#ag-context-meter:not\(\[hidden\]\):not\(\[data-collapsed-hidden="true"\]\),\s*#ag-context-meter:not\(\[hidden\]\):not\(\[data-collapsed-hidden="true"\]\) \*:not\(\[hidden\]\) \{ -webkit-app-region: no-drag !important;/);

    // 3. macOS 隐藏标题栏（computeWindowControlsWidth 为 0）仍补齐空白拖动区
    h.sandbox.navigator = { platform: 'MacIntel' };
    api.syncWindowControlsOverlayForTest();
    assert.match(fixEl.textContent, /-webkit-app-region:\s*drag;/);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('Phase 4A (图 3): 右侧辅助分栏插件/浏览器共存切换(浏览器在最右)、保留滚动与网页状态、左缘宽窄拖拽与收起展开及设置持久化', async () => {
  const tpl = fs.readFileSync(path.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const auxBarPos = tpl.indexOf('id="dock-aux-context-bar"');
  const panelPos = tpl.indexOf('id="panel"');
  assert.ok(auxBarPos > 0 && panelPos > auxBarPos, '#dock-aux-context-bar 必须位于 #panel 外部，切换浏览器或收起后仍保留入口');
  const tabPlugPos = tpl.indexOf('id="btn-dock-aux-view-plugin"');
  const tabBrwPos = tpl.indexOf('id="btn-dock-aux-view-browser"');
  assert.ok(tabPlugPos > 0 && tabBrwPos > tabPlugPos, '辅助栏标签切换中 浏览器 按钮必须位于最右侧');

  const h = harness();
  try {
    if (!h.sandbox.document.head) h.sandbox.document.head = h.sandbox.document.createElement();
    const api = h.sandbox.__AGContextMeter;

    // 构造模拟宿主右侧辅助栏与 webview 浏览器节点
    const hostSidebar = h.sandbox.document.createElement('div');
    hostSidebar.setAttribute('data-aux-pane-focus-scope', 'true');
    hostSidebar.getBoundingClientRect = () => ({ left: 800, top: 0, width: 420, height: 800, right: 1220, bottom: 800 });
    const hostWebviewContainer = h.sandbox.document.createElement('div');
    hostWebviewContainer.id = 'mock-host-browser-pane';
    const webview = h.sandbox.document.createElement('webview');
    webview.style.pointerEvents = 'auto';
    hostSidebar.appendChild(hostWebviewContainer);
    h.sandbox.document.body = h.sandbox.document.createElement('body');
    h.sandbox.document.body.appendChild(hostSidebar);

    const winListeners = new Map();
    h.sandbox.window.addEventListener = (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    };
    h.sandbox.window.removeEventListener = (type, fn) => {
      winListeners.get(type)?.delete(fn);
    };
    h.sandbox.window.trigger = (type, ev = {}) => {
      for (const fn of (winListeners.get(type) || [])) fn(ev);
    };

    const prevQueryAll = h.sandbox.document.querySelectorAll;
    const prevQuery = h.sandbox.document.querySelector;
    h.sandbox.document.querySelector = sel => (sel.includes('aux-pane-focus-scope') ? hostSidebar : prevQuery(sel));
    h.sandbox.document.querySelectorAll = sel => {
      if (sel.includes('webview')) return [webview];
      return prevQueryAll ? prevQueryAll(sel) : [];
    };

    api.setDockPosition('aux', { persist: false });
    let st = api.getAuxDockStateForTest();
    assert.equal(st.auxBarHidden, false);
    assert.equal(st.auxResizerHidden, false);
    assert.equal(st.auxViewTab, 'plugin');
    assert.equal(hostWebviewContainer.style.display, 'none', '插件态时宿主兄弟容器仅隐藏而不销毁 DOM');

    // 记录面板滚动位置 -> 切至浏览器保留浏览器容器与面板滚动位置 -> 切回插件还原滚动位置
    h.elements.get('panel').scrollTop = 240;
    h.elements.get('btn-dock-aux-view-browser').click();
    st = api.getAuxDockStateForTest();
    assert.equal(st.auxViewTab, 'browser');
    assert.equal(h.host.getAttribute('data-aux-view'), 'browser');
    assert.equal(hostWebviewContainer.style.display, '', '切换浏览器后宿主原生浏览器内容立即可见且未被卸载');
    assert.equal(st.auxBarHidden, false, '浏览器态仍保留辅助切换栏以便一键切回插件');

    h.elements.get('btn-dock-aux-view-plugin').click();
    st = api.getAuxDockStateForTest();
    assert.equal(st.auxViewTab, 'plugin');
    assert.equal(h.elements.get('panel').scrollTop, 240, '切回插件必须无损恢复先前滚动位置');
    assert.equal(hostWebviewContainer.style.display, 'none');

    // 收起 / 展开测试
    h.elements.get('btn-dock-aux-collapse').click();
    assert.equal(api.getAuxDockStateForTest().auxCollapsed, true);
    assert.equal(h.host.getAttribute('data-aux-collapsed'), 'true');
    h.elements.get('btn-dock-aux-collapse').click();
    assert.equal(api.getAuxDockStateForTest().auxCollapsed, false);

    // 拖拽左缘 resizer 期间禁用 webview pointer-events，结束后必还原并钳位宽度
    const resizer = h.elements.get('dock-aux-resizer');
    resizer.trigger('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 900, preventDefault() { } });
    assert.equal(webview.style.pointerEvents, 'none', '拖拽分栏宽窄期间必须禁用 webview pointer-events');
    h.sandbox.window.trigger('pointermove', { clientX: 820 });
    h.sandbox.window.trigger('pointerup', { clientX: 820 });
    assert.equal(webview.style.pointerEvents, 'auto', '拖拽结束后必须恢复 webview pointer-events');
    st = api.getAuxDockStateForTest();
    assert.ok(st.auxWidthPx >= 280 && st.auxWidthPx <= 920);
    assert.equal(hostSidebar.style.width, `${st.auxWidthPx}px`);

    // 退出 aux 模式后必须清理隐藏标记恢复宿主浏览器显示
    h.elements.get('btn-dock-aux-back').click();
    assert.equal(hostWebviewContainer.style.display, '');
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('01 批回归：对调标签顺序、唯一 speed-line-empty ID 与真实模板下 v0.9.2 vs 候选版全维度对照', async () => {
  const pathMod = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tplHtml = fs.readFileSync(pathMod.join(__dirname, 'src/renderer/template.html'), 'utf8');
  const stylesCss = fs.readFileSync(pathMod.join(__dirname, 'src/renderer/styles.css'), 'utf8');
  const candidateSource = fs.readFileSync(pathMod.join(__dirname, 'meter-renderer.js'), 'utf8');

  // 1. 静态模板检查：ID 零重复、speed-line-empty 唯一落于趋势面板、标签顺序为 会话 -> 速度对比 -> 模型设置 -> 配置
  const allIds = [...tplHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seenIds = new Set();
  const dupIds = [];
  for (const id of allIds) {
    if (seenIds.has(id)) dupIds.push(id);
    seenIds.add(id);
  }
  assert.deepEqual(dupIds, [], `template.html 不应存在重复 DOM ID: ${dupIds.join(', ')}`);
  assert.equal(allIds.filter(id => id === 'speed-line-empty').length, 1, 'speed-line-empty 只能保留唯一节点');

  const tabsBarStart = tplHtml.indexOf('id="ctx-tabs-bar"');
  const tabsBarEnd = tplHtml.indexOf('</div>', tabsBarStart);
  const tabsBarSlice = tplHtml.slice(tabsBarStart, tabsBarEnd);
  const tabOrder = [...tabsBarSlice.matchAll(/data-ctx-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabOrder, ['session', 'speed', 'models', 'accounts'], '标签顺序必须为 当前会话 -> 速度对比 -> 模型设置 -> 账号与共享池');

  const speedPaneStart = tplHtml.indexOf('id="pane-ctx-speed"');
  const settingsPaneStart = tplHtml.indexOf('id="pane-ctx-settings"', speedPaneStart);
  const speedPaneSlice = tplHtml.slice(speedPaneStart, settingsPaneStart);
  assert.ok(speedPaneSlice.indexOf('id="speed-hero"') > 0 && speedPaneSlice.indexOf('id="speed-line-empty"') > speedPaneSlice.indexOf('id="speed-hero"'));
  assert.ok(speedPaneSlice.indexOf('id="speed-line-empty"') < speedPaneSlice.indexOf('class="ctx-speed-legacy"'), '唯一 speed-line-empty 必须位于趋势面板内而非 legacy 隐藏区');

  // 校验窄栏 CSS 容器查询与防溢出规则，以及排行方形复选框不被全局胶囊开关劫持
  assert.match(stylesCss, /#pane-ctx-speed\s*\{[\s\S]*container-type:\s*inline-size/);
  assert.match(stylesCss, /@container\s*\(max-width:\s*760px\)\s*\{\s*\.ctx-speed-hero-body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(stylesCss, /@container\s*\(max-width:\s*560px\)\s*\{\s*\.ctx-speed-pk-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(stylesCss, /:not\(\.ctx-toggle-input,\s*\.ctx-speed-rank-check\)/);

  // 2. 真实模板 HTML 解析沙箱：禁止暗自伪造不存在的 DOM，getElementById 严格只返回真实模板挂载节点
  function parseHtmlIntoRoot(html, makeNode) {
    const body = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const root = makeNode('shadow-root');
    const byId = new Map();
    const stack = [root];
    const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'circle', 'line', 'rect', 'path', 'polygon', 'polyline']);
    const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = tagRe.exec(body)) !== null) {
      if (m[3]) {
        const text = m[3].replace(/\s+/g, ' ');
        if (text.trim() && stack.length > 1) {
          const cur = stack[stack.length - 1];
          cur.textContent = (cur.textContent ? cur.textContent + ' ' : '') + text.trim();
        }
        continue;
      }
      const raw = m[0];
      const tag = m[1].toLowerCase();
      const attrStr = m[2] || '';
      if (raw.startsWith('</')) {
        for (let i = stack.length - 1; i >= 1; i--) {
          if (stack[i].tagName === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const node = makeNode(tag);
      const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s>]+))?/g;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) {
        const k = am[1];
        const v = am[2] ?? am[3] ?? am[4] ?? '';
        if (k === 'hidden') node.hidden = true;
        else if (k === 'value') node.value = v;
        else node.setAttribute(k, v);
        if (k === 'id' && v && !byId.has(v)) byId.set(v, node);
      }
      stack[stack.length - 1].appendChild(node);
      if (!raw.endsWith('/>') && !voidTags.has(tag)) {
        stack.push(node);
      }
    }
    return { root, byId };
  }

  function createRealTemplateHarness(bundleSource, initialSavedPrefs = null) {
    const docListeners = new Map();
    const listeners = new Map();
    const blobs = [];
    const anchors = [];
    const savedCalls = [];
    const lStore = new Map();
    let shadowById = new Map();
    let shadowRootTree = null;

    function makeNode(tag = 'div') {
      const attrs = new Map();
      const props = new Map();
      const node = {
        tagName: String(tag).toLowerCase(),
        style: {
          display: '', opacity: '', width: '', left: '', top: '', right: '', background: '',
          setProperty(k, v) { props.set(k, v); },
          removeProperty(k) { props.delete(k); },
          getPropertyValue(k) { return props.get(k) || ''; }
        },
        children: [],
        parentElement: null,
        hidden: false,
        disabled: false,
        checked: false,
        focused: false,
        scrolledIntoView: false,
        value: '',
        textContent: '',
        offsetWidth: 140,
        clientWidth: 520,
        get id() { return attrs.get('id') || ''; },
        set id(v) { attrs.set('id', String(v)); },
        get className() { return attrs.get('class') || ''; },
        set className(v) { attrs.set('class', String(v || '')); },
        classList: {
          add(c) {
            const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
            if (!cur.includes(c)) cur.push(c);
            attrs.set('class', cur.join(' '));
          },
          remove(c) {
            const cur = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
            attrs.set('class', cur.join(' '));
          },
          toggle(c, force) {
            const on = force === undefined ? !this.contains(c) : Boolean(force);
            if (on) this.add(c); else this.remove(c);
            return on;
          },
          contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
        },
        addEventListener(type, fn) {
          if (!listeners.has(node)) listeners.set(node, new Map());
          listeners.get(node).set(type, fn);
        },
        removeEventListener(type) { listeners.get(node)?.delete(type); },
        setAttribute(k, v) {
          attrs.set(k, String(v));
          if (k === 'hidden') node.hidden = true;
        },
        getAttribute(k) { return attrs.get(k) ?? null; },
        removeAttribute(k) {
          attrs.delete(k);
          if (k === 'hidden') node.hidden = false;
        },
        append(...items) { for (const it of items) node.appendChild(it); },
        appendChild(x) {
          if (x) {
            x.parentElement = node;
            node.children.push(x);
          }
          return x;
        },
        replaceChildren(...items) {
          node.children = [];
          for (const it of items) node.appendChild(it);
        },
        remove() {
          if (node.tagName === 'a') anchors.push({ href: node.href, download: node.download, clicked: Boolean(node._clicked) });
        },
        focus() { node.focused = true; },
        scrollIntoView() { node.scrolledIntoView = true; },
        click() {
          node._clicked = true;
          const fn = listeners.get(node)?.get('click');
          if (fn) fn({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
        },
        trigger(type, ev = {}) {
          const payload = { target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...ev };
          const fn = listeners.get(node)?.get(type);
          if (fn) fn(payload);
          const propHandler = node[`on${type}`];
          if (typeof propHandler === 'function') propHandler(payload);
        },
        matches(sel) {
          if (!sel) return false;
          if (sel.startsWith('#')) return node.id === sel.slice(1);
          if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
          const attrM = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
          if (attrM) {
            const actual = node.getAttribute(attrM[1]);
            return attrM[2] !== undefined ? actual === attrM[2] : actual !== null;
          }
          return node.tagName === sel.toLowerCase();
        },
        closest(sel) {
          let cur = node;
          while (cur) {
            if (cur.matches?.(sel)) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
        querySelectorAll(sel) {
          const found = [];
          const walk = (n) => {
            for (const c of n.children || []) {
              if (c.matches?.(sel)) found.push(c);
              walk(c);
            }
          };
          walk(node);
          return found;
        },
        querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
        getBoundingClientRect() { return { left: 0, top: 0, width: node.clientWidth || 520, height: 200, right: node.clientWidth || 520, bottom: 200 }; }
      };
      return node;
    }

    const host = makeNode('div');
    const shadow = {
      _html: '',
      set innerHTML(val) {
        this._html = String(val || '');
        const parsed = parseHtmlIntoRoot(this._html, makeNode);
        shadowRootTree = parsed.root;
        shadowById = parsed.byId;
      },
      get innerHTML() { return this._html; },
      getElementById(id) { return shadowById.get(id) || null; },
      querySelectorAll(sel) { return shadowRootTree ? shadowRootTree.querySelectorAll(sel) : []; },
      querySelector(sel) { return shadowRootTree ? shadowRootTree.querySelector(sel) : null; }
    };
    host.attachShadow = () => shadow;

    let firstCreate = true;
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/speed-real-tpl-1' },
      document: {
        hidden: false,
        body: makeNode('body'),
        documentElement: makeNode('html'),
        createElement: (tag) => {
          if (firstCreate) { firstCreate = false; return host; }
          return makeNode(tag);
        },
        createElementNS: (_ns, tag) => makeNode(tag),
        getElementById: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: (t, fn) => {
          if (!docListeners.has(t)) docListeners.set(t, new Set());
          docListeners.get(t).add(fn);
        },
        removeEventListener: (t, fn) => docListeners.get(t)?.delete(fn)
      },
      window: {
        innerWidth: 1280,
        innerHeight: 800,
        __APP_CONFIG__: { csrfToken: 'test-csrf' },
        contextMeterAPI: {
          scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } }),
          getSettings: async () => ({
            ok: true,
            ...(initialSavedPrefs ? { defaultViewPrefs: initialSavedPrefs, uiPreferences: { defaultViewPrefs: initialSavedPrefs } } : {})
          }),
          saveSettings: async (payload) => { savedCalls.push(payload); return { ok: true }; }
        }
      },
      localStorage: {
        getItem: k => lStore.get(k) ?? null,
        setItem: (k, v) => lStore.set(k, String(v)),
        removeItem: k => lStore.delete(k)
      },
      Blob: class MockBlob {
        constructor(parts, opts) { this.text = parts.join(''); this.type = opts?.type || ''; blobs.push(this); }
      },
      URL: {
        createObjectURL: () => 'blob:mock-speed-csv',
        revokeObjectURL: () => {}
      },
      __AGContextMeterCore: core,
      AbortController,
      Date,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({ generatorMetadata: [] }) })
    };
    vm.createContext(sandbox);
    vm.runInContext(bundleSource, sandbox);
    return {
      sandbox,
      api: sandbox.__AGContextMeter,
      el: id => shadow.getElementById(id),
      shadow,
      blobs,
      anchors,
      savedCalls
    };
  }

  // 3. 构造同一组历史样本（严格锚定今日零点，跨 1d/3d/5d/7d/30d/all、含 chat 与 speed-test 来源、含 <3 低样本）
  const dayMs = 86400000;
  const hourMs = 3600000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today0 = todayStart.getTime();
  const fmtYmd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fixedRecords = [
    // Gemini 4 Carbon (4 条 chat: 今日 1 条, 1 天前 1 条, 2 天前 1 条, 4 天前 1 条)
    { callId: 'sp-c1', modelExactId: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon', status: 'final', origin: 'chat', outputTokens: 300, durationSec: 3.0, ttftSec: 0.6, tps: 100, timestamp: today0 + 2 * hourMs },
    { callId: 'sp-c2', modelExactId: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon', status: 'final', origin: 'chat', outputTokens: 400, durationSec: 3.5, ttftSec: 0.8, tps: 120, timestamp: today0 - 1 * dayMs + 12 * hourMs },
    { callId: 'sp-c3', modelExactId: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon', status: 'final', origin: 'chat', outputTokens: 500, durationSec: 4.0, ttftSec: 1.0, tps: 140, timestamp: today0 - 2 * dayMs + 12 * hourMs },
    { callId: 'sp-c4', modelExactId: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon', status: 'final', origin: 'chat', outputTokens: 600, durationSec: 4.5, ttftSec: 1.2, tps: 160, timestamp: today0 - 4 * dayMs + 12 * hourMs },
    // Gemini 4 Hydrogen High (3 条 chat + 1 条 speed-test 探针 -> 检验 origin='all' vs 'chat')
    { callId: 'sp-h1', modelExactId: 'gemini-4-hydrogen-high', modelLabel: 'Gemini 4 Hydrogen (High)', effort: 'high', status: 'final', origin: 'chat', outputTokens: 240, durationSec: 3.0, ttftSec: 0.9, tps: 80, timestamp: today0 + 1 * hourMs },
    { callId: 'sp-h2', modelExactId: 'gemini-4-hydrogen-high', modelLabel: 'Gemini 4 Hydrogen (High)', effort: 'high', status: 'final', origin: 'chat', outputTokens: 270, durationSec: 3.2, ttftSec: 1.1, tps: 90, timestamp: today0 - 1 * dayMs + 10 * hourMs },
    { callId: 'sp-h3', modelExactId: 'gemini-4-hydrogen-high', modelLabel: 'Gemini 4 Hydrogen (High)', effort: 'high', status: 'final', origin: 'chat', outputTokens: 300, durationSec: 3.5, ttftSec: 1.3, tps: 100, timestamp: today0 - 2 * dayMs + 10 * hourMs },
    { callId: 'sp-h4', modelExactId: 'gemini-4-hydrogen-high', modelLabel: 'Gemini 4 Hydrogen (High)', effort: 'high', status: 'final', origin: 'speed-test', outputTokens: 500, durationSec: 2.5, ttftSec: 0.4, tps: 200, timestamp: today0 + 2.5 * hourMs },
    // Claude Sonnet 4.6 (2 条 <3 低样本, 位于 12-13 天前 -> 7d 不含, 30d 含)
    { callId: 'sp-a1', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', origin: 'chat', outputTokens: 200, durationSec: 4.0, ttftSec: 1.5, tps: 50, timestamp: today0 - 12 * dayMs + 12 * hourMs },
    { callId: 'sp-a2', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', origin: 'chat', outputTokens: 280, durationSec: 4.0, ttftSec: 1.7, tps: 70, timestamp: today0 - 13 * dayMs + 12 * hourMs },
    // Gemini 3.8 Flash (2 条位于 45-46 天前 -> 30d 不含, all 含)
    { callId: 'sp-f1', modelExactId: 'gemini-3-8-flash', modelLabel: 'Gemini 3.8 Flash', status: 'final', origin: 'chat', outputTokens: 450, durationSec: 2.5, ttftSec: 0.3, tps: 180, timestamp: today0 - 45 * dayMs + 12 * hourMs },
    { callId: 'sp-f2', modelExactId: 'gemini-3-8-flash', modelLabel: 'Gemini 3.8 Flash', status: 'final', origin: 'chat', outputTokens: 550, durationSec: 2.5, ttftSec: 0.5, tps: 220, timestamp: today0 - 46 * dayMs + 12 * hourMs }
  ];
  const flashCustomStart = fmtYmd(today0 - 47 * dayMs);
  const flashCustomEnd = fmtYmd(today0 - 44 * dayMs);

  function runFullSpeedSuite(bundleSource, label) {
    const h = createRealTemplateHarness(bundleSource);
    const api = h.api;
    try {
      // 验证真实模板下所有正式版速度对照 DOM ID 均真实存在（绝非假节点）
      for (const reqId of [
        'speed-filter-bar', 'speed-range-1d', 'speed-range-3d', 'speed-range-5d', 'speed-range-7d',
        'speed-range-30d', 'speed-range-all', 'speed-range-custom', 'speed-custom-dates',
        'speed-date-start', 'speed-date-end', 'speed-date-error',
        'speed-origin-all', 'speed-origin-chat', 'speed-metric-tps', 'speed-metric-ttft', 'speed-metric-duration',
        'speed-algo-median', 'speed-algo-mean', 'speed-algo-composite', 'btn-save-default-view-speed',
        'speed-hero', 'speed-pk-count', 'speed-pk-chips', 'speed-pk-add', 'speed-pk-clear', 'speed-pk-cards',
        'speed-trend-title', 'speed-trend-legend', 'speed-line-chart-wrap', 'speed-line-svg', 'speed-line-empty', 'speed-trend-foot',
        'speed-rank', 'speed-rank-count', 'speed-rank-search', 'speed-rank-sort', 'speed-rank-rows', 'speed-rank-export', 'speed-rank-reset'
      ]) {
        assert.ok(h.el(reqId), `${label}: 真实模板必须存在 #${reqId}`);
      }

      // 确认唯一 speed-line-empty 位于 #speed-hero 内（仅候选版去重后唯一）
      assert.ok(h.el('speed-line-empty').closest('#speed-hero'), `${label}: #speed-line-empty 必须在 #speed-hero 内`);
      const speedLineEmptyNodes = h.shadow.querySelectorAll('[id="speed-line-empty"]');
      if (label === 'candidate') {
        assert.equal(speedLineEmptyNodes.length, 1, '候选版只能有 1 个 #speed-line-empty');
      } else {
        assert.equal(speedLineEmptyNodes.length, 2, 'v0.9.2 原模板存在重复 #speed-line-empty');
      }

      h.el('badge').click();
      h.el('tab-ctx-speed').click();
      api.setContextLatestForTest({
        model: 'Gemini 4 Carbon',
        modelId: 'gemini-4-carbon',
        status: 'reported',
        used: 12000,
        budget: 256000
      });
      api.setSpeedRecordsForTest(fixedRecords);

      // A. 默认 7d 视图：Carbon + Hydrogen High（2 款模型）
      const defaultRankIds = h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id'));
      assert.deepEqual(defaultRankIds, ['gemini-4-carbon', 'gemini-4-hydrogen-high'], `${label}: 默认 7d 仅包含近 7 天模型`);
      assert.equal(h.el('speed-pk-count').textContent, '2');

      // B. 时间范围切换：1d / 3d / 5d / 30d / all / custom
      h.el('speed-range-30d').click();
      assert.deepEqual(
        h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id')),
        ['gemini-4-carbon', 'gemini-4-hydrogen-high', 'claude-sonnet-4-6']
      );
      h.el('speed-range-all').click();
      const allRankIds = h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id'));
      assert.deepEqual(allRankIds, ['gemini-3-8-flash', 'gemini-4-carbon', 'gemini-4-hydrogen-high', 'claude-sonnet-4-6']);

      // 1d / 3d / 5d 检查
      h.el('speed-range-1d').click();
      assert.equal(h.el('speed-rank-rows').children.length, 2);
      h.el('speed-range-3d').click();
      assert.equal(h.el('speed-rank-rows').children.length, 2);
      h.el('speed-range-5d').click();
      assert.equal(h.el('speed-rank-rows').children.length, 2);

      // custom 自定义起止日期 + 非法日期校验
      h.el('speed-range-custom').click();
      assert.equal(h.el('speed-custom-dates').hidden, false);
      h.el('speed-date-start').value = '2026-11-20';
      h.el('speed-date-end').value = '2026-11-10';
      h.el('speed-custom-dates').trigger('submit');
      assert.equal(h.el('speed-date-error').hidden, false, `${label}: 起止日期倒挂必须报错`);

      h.el('speed-date-start').value = flashCustomStart;
      h.el('speed-date-end').value = flashCustomEnd;
      h.el('speed-custom-dates').trigger('submit');
      assert.equal(h.el('speed-date-error').hidden, true);
      assert.deepEqual(
        h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id')),
        ['gemini-3-8-flash'],
        `${label}: 自定义 10-01~10-15 仅命中 45 天前的 Flash`
      );

      // 回到 all（先点重置筛选验证 resetSpeedFilters 恢复默认选中，再切 all）检查算法（median / mean / composite）与来源（all vs chat）
      h.el('speed-rank-reset').click();
      h.el('speed-range-all').click();
      const readPkCardVal = (id) => {
        const card = h.el('speed-pk-cards').children.find(c => c.getAttribute('data-pk-id') === id);
        return card ? card.querySelector('.ctx-speed-pk-value').textContent : null;
      };
      // Hydrogen High 在 all+median 下含 speed-test=200 -> 样本 [80,90,100,200] 中位数 95.0；切 chat 后 [80,90,100] 中位数 90.0
      h.el('speed-origin-all').click();
      const hydrogenAllMedian = readPkCardVal('gemini-4-hydrogen-high');
      h.el('speed-origin-chat').click();
      const hydrogenChatMedian = readPkCardVal('gemini-4-hydrogen-high');
      h.el('speed-origin-all').click();

      h.el('speed-algo-mean').click();
      const hydrogenAllMean = readPkCardVal('gemini-4-hydrogen-high');
      h.el('speed-algo-composite').click();
      const hydrogenAllComposite = readPkCardVal('gemini-4-hydrogen-high');
      h.el('speed-algo-median').click();

      // C. 指标切换 (ttft / duration / tps) 与走势图标题联动
      h.el('speed-metric-ttft').click();
      assert.match(h.el('speed-trend-title').textContent, /首字延迟/);
      const carbonTtftVal = readPkCardVal('gemini-4-carbon');
      h.el('speed-metric-duration').click();
      assert.match(h.el('speed-trend-title').textContent, /总耗时/);
      h.el('speed-metric-tps').click();
      assert.match(h.el('speed-trend-title').textContent, /速度走势/);

      // D. 全量排行搜索过滤、空匹配与三档排序
      h.el('speed-rank-search').value = 'claude';
      h.el('speed-rank-search').trigger('input', { target: h.el('speed-rank-search') });
      assert.deepEqual(h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id')), ['claude-sonnet-4-6']);

      h.el('speed-rank-search').value = 'non-existent-model-xyz';
      h.el('speed-rank-search').trigger('input', { target: h.el('speed-rank-search') });
      assert.equal(h.el('speed-rank-rows').children[0].textContent, '没有匹配的模型');

      h.el('speed-rank-search').value = '';
      h.el('speed-rank-search').trigger('input', { target: h.el('speed-rank-search') });

      const clickSort = (sortKey) => {
        const btn = h.el('speed-rank-sort').querySelector(`[data-rank-sort="${sortKey}"]`);
        assert.ok(btn);
        h.el('speed-rank-sort').trigger('click', { target: btn });
        return h.el('speed-rank-rows').children.map(r => r.getAttribute('data-rank-id'));
      };
      const sortTps = clickSort('tps');
      const sortTtft = clickSort('ttft');
      const sortSamples = clickSort('samples');
      assert.deepEqual(sortTps, ['gemini-3-8-flash', 'gemini-4-carbon', 'gemini-4-hydrogen-high', 'claude-sonnet-4-6']);
      assert.deepEqual(sortTtft, ['gemini-3-8-flash', 'gemini-4-carbon', 'gemini-4-hydrogen-high', 'claude-sonnet-4-6']);
      assert.equal(sortSamples[3], 'claude-sonnet-4-6');

      // E. 两模型 PK 对比、+ 添加模型对比聚焦、多系列走势图与 tooltip
      h.el('speed-pk-clear').click();
      if (label === 'candidate') {
        assert.equal(h.el('speed-pk-count').textContent, '0', '候选版清空选择后计数必须归零');
      }
      assert.equal(h.el('speed-line-empty').hidden, false);
      assert.equal(h.el('speed-line-chart-wrap').hidden, true);

      h.el('speed-pk-add').click();
      assert.equal(h.el('speed-rank-search').focused, true);

      for (const pickId of ['gemini-4-carbon', 'gemini-4-hydrogen-high']) {
        const row = h.el('speed-rank-rows').children.find(r => r.getAttribute('data-rank-id') === pickId);
        const cb = row.querySelector('.ctx-speed-rank-check');
        cb.checked = true;
        cb.trigger('change');
      }
      assert.equal(h.el('speed-pk-count').textContent, '2');
      assert.equal(h.el('speed-pk-chips').children.length, 2);
      assert.equal(h.el('speed-pk-cards').children.length, 2);
      const pkTwoSnapshots = h.el('speed-pk-cards').children.map(c => ({
        id: c.getAttribute('data-pk-id'),
        top: c.querySelector('.ctx-speed-pk-top').textContent,
        val: c.querySelector('.ctx-speed-pk-value').textContent
      }));

      // 多系列走势图校验（2 条 polyline、图例零括号、粒度注脚、pointermove tooltip）
      assert.equal(h.el('speed-line-empty').hidden, true);
      assert.equal(h.el('speed-line-chart-wrap').hidden, false);
      const polylines = h.el('speed-line-svg').querySelectorAll('polyline');
      assert.equal(polylines.length, 2);
      const legendTexts = h.el('speed-trend-legend').children.map(n => n.children[1].textContent);
      assert.ok(legendTexts.every(s => !/[()（）]/.test(s)), `${label}: 走势图例严禁含括号`);
      const trendFootTexts = h.el('speed-trend-foot').children.map(n => n.textContent);
      h.el('speed-line-svg').trigger('pointermove', { clientX: 240 });
      assert.equal(h.el('speed-line-tooltip').hidden, false);
      h.el('speed-line-svg').trigger('pointerleave');
      assert.equal(h.el('speed-line-tooltip').hidden, true);

      // F. 导出 CSV
      h.el('speed-rank-export').click();
      assert.equal(h.blobs.length, 1);
      const csvText = h.blobs[0].text.replace(/^\uFEFF/, '');
      assert.equal(h.anchors[0].download, 'speed-alld.csv');

      // G. 窄栏容器宽度下走势图自适应 viewBox
      h.el('speed-line-chart-wrap').clientWidth = 260;
      api.setSpeedRecordsForTest(fixedRecords);
      const narrowViewBox = h.el('speed-line-svg').getAttribute('viewBox');
      assert.equal(narrowViewBox, '0 0 260 200');
      h.el('speed-line-chart-wrap').clientWidth = 520;

      // H. 设为默认视图并校验持久化参数
      h.el('speed-range-30d').click();
      h.el('btn-save-default-view-speed').click();
      const savedSpeedPrefs = h.savedCalls[h.savedCalls.length - 1]?.defaultViewPrefs;

      // I. 空数据空态
      api.setSpeedRecordsForTest([]);
      if (label === 'candidate') {
        assert.equal(h.el('speed-pk-count').textContent, '0', '候选版空数据时计数必须归零');
      }
      assert.equal(h.el('speed-line-empty').hidden, false);
      assert.equal(h.el('speed-line-empty').textContent, '暂无对比曲线');
      assert.equal(h.el('speed-line-chart-wrap').hidden, true);
      assert.equal(h.el('speed-rank-rows').children[0].textContent, '没有匹配的模型');
      assert.match(h.el('speed-pk-cards').children[0].textContent, /还没有可用的速度记录/);

      return {
        hydrogenAllMedian,
        hydrogenChatMedian,
        hydrogenAllMean,
        hydrogenAllComposite,
        carbonTtftVal,
        pkTwoSnapshots,
        legendTexts,
        trendFootTexts,
        csvText,
        savedSpeedRange: savedSpeedPrefs?.speedRangeDays
      };
    } finally {
      api.dispose();
    }
  }

  // 4. 运行当前候选版，并在有 git history 时同数据跑正式版 v0.9.2 (2303c0bdd268067f) 对照
  const candResult = runFullSpeedSuite(candidateSource, 'candidate');
  assert.equal(candResult.hydrogenAllMedian, '95.0');
  assert.equal(candResult.hydrogenChatMedian, '90.0');
  assert.equal(candResult.hydrogenAllMean, '117.5');
  assert.equal(candResult.hydrogenAllComposite, '79.8');
  assert.equal(candResult.carbonTtftVal, '0.90s');
  assert.equal(candResult.savedSpeedRange, '30');

  let v092Source = null;
  try {
    v092Source = execFileSync('git', ['show', 'v0.9.2:meter-renderer.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch { }
  if (v092Source) {
    assert.match(v092Source, /2303c0bdd268067f/, 'v0.9.2 正式版构建 ID 必须为 2303c0bdd268067f');
    const v092Result = runFullSpeedSuite(v092Source, 'v0.9.2');
    assert.deepEqual(candResult, v092Result, '同一历史样本下候选版与正式版 v0.9.2 全部计算与 CSV 口径必须一致');
  }

  // 5. 默认视图冷恢复到新候选实例（基于真实模板验证 active 状态）
  const hCold = createRealTemplateHarness(candidateSource, { speedRangeDays: '30' });
  try {
    await hCold.api.restoreSettingsForTest();
    hCold.api.switchContextTabForTest('speed');
    assert.equal(hCold.el('speed-range-30d').classList.contains('active'), true);
    assert.equal(hCold.el('speed-range-7d').classList.contains('active'), false);
  } finally {
    hCold.api.dispose();
  }
});