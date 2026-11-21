const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k,core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
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
  const host = element(); host.attachShadow = () => ({ set innerHTML(value) {}, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const pending = [], scans = [], timers = [];
  const docListeners = new Map();
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() {} },
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
    clearTimeout() {},
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() {},
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
    ...(extraSandbox && typeof extraSandbox === 'object' ? extraSandbox : {})
  };
  // First createElement call is the host; later calls are safe text-only file rows.
  let first = true; sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  return { sandbox, host, pending, scans, elements, tick: () => timers[0](), flush: () => new Promise(resolve => setImmediate(resolve)), finishScan(i = 0) { scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } }); } };
}
function response(chatModel) { return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) }; }
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
  assert.equal(h.elements.get('p-det-region').textContent, '日本 (JP)');
  assert.match(h.elements.get('p-det-acq').textContent, /学生.*优惠/);
  assert.match(h.elements.get('p-det-price').textContent, /\$0/);
  assert.equal(h.elements.get('p-det-price-tag').textContent, '手动确认 · 免费');

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
  assert.equal(priceCny.textContent, '(≈ ¥147.9 CNY)');
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
  assert.equal(priceCny.textContent, '(≈ ¥146.8 CNY)');
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
  assert.equal(api.getPlanSettings().country, '中国台湾 (TW)');
  assert.equal(h.elements.get('direct-country-label').textContent, '🇹🇼 中国台湾 (TW)');

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
  assert.equal(h.elements.get('direct-currency-label').textContent, 'AUD (AU$ 澳元)');

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
    const canceled = core.summarize({ chatModel: {
      retryInfos: [{ error: 'request failed: Post "https://example.invalid/api": context canceled' }],
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    } }, { previousValidContext: previous });
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
  h.elements.get('ctx-conflict-rows').replaceChildren = function(...nodes) { this.children = nodes; };
  h.elements.get('ctx-card-observed-speed').replaceChildren = function(...nodes) { this.children = nodes; };
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
  h.elements.get('speed-bar-svg').replaceChildren = function(...nodes) { this.children = nodes; };
  h.elements.get('speed-line-svg').replaceChildren = function(...nodes) { this.children = nodes; };

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
  console.warn = () => {};

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
  console.warn = () => {};

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
  console.warn = () => {};

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
  console.warn = () => {};

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
  console.warn = () => {};

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
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
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
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
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
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
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

    h.elements.get('badge-quota').click();
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
        latestVersion: '0.9.1',
        tagName: 'v0.9.1',
        releaseNotes: 'Fix update flow',
        htmlUrl: 'https://github.com/elviscjn-cjn/antigravity-context-viewer/releases/tag/v0.9.1'
      }),
      applyUpdate: async () => ({
        ok: true,
        version: '0.9.1',
        installedVersion: '0.9.1',
        liveInjected: mockLiveInjected,
        backendHotReloaded: mockLiveInjected
      })
    };

    h.elements.get('btn-check-update').click();
    await h.flush();
    assert.equal(h.elements.get('up-pop-ver').textContent, 'v0.8.3 → v0.9.1');

    h.elements.get('btn-apply-update').click();
    await h.flush();

    assert.equal(h.elements.get('v').textContent, '');
    assert.match(h.elements.get('up-pop-ver').textContent, /0\.9\.1/);
    assert.doesNotMatch(h.elements.get('up-pop-status').textContent, /currentVer|异常|失败/i);
    assert.match(h.elements.get('up-pop-status').textContent, /0\.9\.1/);

    mockLiveInjected = true;
    h.elements.get('btn-apply-update').click();
    await h.flush();
    assert.equal(h.elements.get('v').textContent, 'v0.9.1');
  } finally {
    api.dispose();
  }
});

test('ELV-84: 静止浮层避免常驻合成层与冗余模糊，混合 DPI 坐标对齐像素网格并在跨屏变更时重排与清理', async () => {
  // 1. CSS 静态防虚契约断言（构建产物 meter-renderer.js）
  assert.match(source, /font:12px\/1\.4 [^;]*"Microsoft YaHei UI"/, '应优先使用 Microsoft YaHei UI 改善 100% 缩放 ClearType');
  assert.match(source, /\.ag-panel\{[^}]*transform:none;[^}]*\}/, '.ag-panel 静止打开态必须回退到 transform:none');
  assert.doesNotMatch(source, /\.ag-panel\{[^}]*will-change:opacity,transform;/, '.ag-panel 不应常驻 will-change:opacity,transform');
  assert.doesNotMatch(source, /\.ag-panel\{[^}]*contain:layout paint;/, '.ag-panel 不应常驻 contain:layout paint');
  assert.match(source, /#context-tooltip\[data-visible="true"\]\{[^}]*transform:none;/, '悬停气泡可见态应使用 transform:none');
  assert.doesNotMatch(source, /#overflow-menu\{[^}]*will-change:opacity,transform;/, '溢出菜单不应常驻 will-change');
  assert.match(source, /\.ag-dropdown-wrapper\.is-open \.ag-dropdown-menu\{[^}]*transform:none;/, '打开的下拉列表应使用 transform:none');
  assert.doesNotMatch(source, /\.ag-dropdown-menu\{[^}]*backdrop-filter:blur\(24px\)/, '不透明背景的下拉列表不得叠加 backdrop-filter:blur(24px)');
  assert.match(source, /@keyframes agSmoothExpand\{\s*0%\{[^}]*\}\s*100%\{[^}]*transform:none;/, '展开关键帧结束态应使用 transform:none');
  assert.doesNotMatch(source, /animation:\s*agSmoothExpand[^;]*forwards/, '折叠展开动画不得使用 forwards 永久锁定合成层');
  assert.match(source, /\.view-pane-fade\{[^}]*transform:none/, '视图切换容器静止态应使用 transform:none');

  // 2. 运行态设备像素网格对齐与跨屏 DPI change 事件测试
  const ctx = {};
  const winListeners = new Map();
  const mqlListeners = new Map();
  let mqlRemoved = 0;
  const mockHost = {
    style: { setProperty() {}, removeProperty() {}, top: '', right: '', left: '', zIndex: '' },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    remove() {},
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
      style: { display: '', top: '', left: '', right: '', maxWidth: '', maxHeight: '', transformOrigin: '', setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() {},
      removeEventListener() {},
      replaceChildren() {},
      appendChild() {},
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
    body: { appendChild() {}, children: [] },
    documentElement: { appendChild() {} },
    createElement: () => {
      if (isFirstCreate) {
        isFirstCreate = false;
        return mockHost;
      }
      return makeEl('dyn');
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null
  };
  Object.assign(ctx, {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    __AGContextMeterCore: core,
    window: Object.assign(winObj, { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } }) } }),
    document: docObj,
    globalThis: null,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => new Promise(() => {}),
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
    assert.match(stylesCssText, /:host\(\[data-layout="ring-only"\]\)\s*#badge-overflow\{\s*display:inline-flex!important;/);
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

test('v0.8.10 (0.8.10) 稳定正式版展示与更新检查', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.8.10');
  assert.equal(pkg.displayVersion, '0.8.10');

  // 1. 默认构建模板中 #v 与 #up-pop-ver 均为 0.8.10，且 beta 通道开关默认未勾选
  const builtCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  assert.match(builtCode, /<span id="v"[^>]*>0\.8\.10<\/span>/);
  assert.match(builtCode, /<span id="up-pop-ver"[^>]*>0\.8\.10<\/span>/);
  assert.equal(builtCode.includes('id="check-allow-beta-updates"'), true);

  // 2. 0.8.10 vs 0.8.10 判为已是最新，且文案展示 0.8.10
  {
    const h = harness();
    const api = h.sandbox.__AGContextMeter;
    assert.equal(h.elements.get('check-allow-beta-updates').checked, false);
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      checkUpdate: async (req) => {
        assert.equal(req.currentVersion, '0.8.10');
        assert.equal(req.allowBetaUpdates, false);
        return { ok: true, hasUpdate: false, currentVersion: '0.8.10', installedVersion: '0.8.10' };
      }
    };
    try {
      await api.checkUpdate(true);
      await h.flush();
      assert.equal(h.elements.get('up-pop-ver').textContent, '0.8.10 (已是最新)');
      assert.match(h.elements.get('up-pop-body').textContent, /0\.8\.10/);
    } finally {
      api.dispose();
    }
  }

  // 3. 0.8.10 -> 0.9.0 展示格式，以及开启 beta 通道开关持久化
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
        assert.equal(req.currentVersion, '0.8.10');
        assert.equal(req.allowBetaUpdates, true);
        return { ok: true, hasUpdate: true, currentVersion: '0.8.10', latestVersion: '0.9.0', releaseNotes: 'v0.9.0 stable' };
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
      assert.equal(h.elements.get('up-pop-ver').textContent, '0.8.10 → v0.9.0');
      assert.match(h.elements.get('up-pop-body').textContent, /v0\.9\.0/);
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
    try { api.dispose(); } catch {}
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
          if (h.type === 'click') h.fn({ target: el, stopPropagation() {} });
        }
      },
      trigger(type, ev = {}) {
        const handlers = listeners.get(el) || [];
        for (const h of handlers) {
          if (h.type === type) h.fn({ target: el, preventDefault() {}, stopPropagation() {}, ...ev });
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
      documentElement: { appendChild() {} },
      addEventListener(type, fn) { docListeners.push({ type, fn }); },
      removeEventListener() {},
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
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => new Promise(() => {}),
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
    assert.equal(h.elements.get('input-custom-country').value, 'United States (US)');
    assert.equal(h.elements.get('input-custom-region').value, 'United States (USD)');
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
    try { api.dispose(); } catch {}
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
    assert.equal(h.elements.get('input-custom-country').value, '美國 (US)');
    assert.equal(h.elements.get('input-custom-region').value, '美國 (USD)');

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
    try { api.dispose(); } catch {}
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

    // 3. 停靠位置收口为顶栏默认靠在打开 IDE 左侧 (安全回退 flow)
    mockQueryMode = 'none';
    api.setDockPosition('aux');
    assert.equal(api.getDockPosition().dockPosition, 'flow', '历史或外部传入 aux 自动安全回退到 flow');
    assert.equal(api.getDockPosition().actualDock, 'flow');

    mockQueryMode = 'aux';
    api.setDockPosition('hide');
    assert.equal(api.getDockPosition().dockPosition, 'flow', '历史或外部传入 hide 自动安全回退到 flow');
    assert.equal(api.getDockPosition().actualDock, 'flow');

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

    // 右键 #badge-quota 从 auto 轮转到 5h 并当场刷新
    h.elements.get('badge-quota').trigger('contextmenu', { preventDefault() {} });
    assert.equal(api.getQuotaBadgeWindowMode(), '5h');
    assert.equal(h.elements.get('quota-badge-val').textContent, '92%');

    // Alt+点击 #badge-quota 切换到 weekly 且不打开额度面板
    assert.equal(h.elements.get('panel-quota').hidden, true);
    h.elements.get('badge-quota').trigger('click', { altKey: true, preventDefault() {} });
    assert.equal(api.getQuotaBadgeWindowMode(), 'weekly');
    assert.equal(h.elements.get('quota-badge-val').textContent, '64%');
    assert.equal(h.elements.get('panel-quota').hidden, true);
    assert.ok(savedPayloads.some(p => p.quotaBadgeWindowMode === 'both'));

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
    try { api.dispose(); } catch {}
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
    assert.match(proText, /Hydrogen: 5h 0% \/ 7d 70%/);
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
    assert.match(freeText, /Hydrogen: 7d 100%/);
    assert.doesNotMatch(freeText, /Carbon/);

    // 3) 验证 Ultra 账号卡片
    const ultraCard = listEl.children[2];
    const ultraMeta = ultraCard.children.find(c => c.className === 'quota-acct-meta');
    assert.ok(ultraMeta);
    const ultraText = ultraMeta.textContent;
    assert.match(ultraText, /Hydrogen: 5h 90% \/ 7d 95%/);
    assert.match(ultraText, /Carbon: 5h 100% \/ 7d 100%/);
  } finally {
    try { api.dispose(); } catch {}
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
    assert.match(sumTxt.textContent, /Google AI Ultra \(5x\)/);

    // 5. 验证额度面板顶部套餐胶囊展示带子档套餐名
    const quotaPill = h.elements.get('quota-plan-tier-pill');
    assert.equal(quotaPill.hidden, false);
    assert.equal(quotaPill.textContent, 'Google AI Ultra (5x)');

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
    assert.match(acctEmail.textContent, /ultra-user@example\.com · Google AI Ultra \(5x\)/);

    // 7. 验证切换英文 en 模式下，全 DOM 零汉字门禁通过
    await api.setPanelLanguage('en', { persist: false });
    assert.doesNotMatch(labelEl.textContent, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(sumTxt.textContent, /[\u4e00-\u9fff]/);
  } finally {
    try { api.dispose(); } catch {}
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
    if (sel.includes('toggle-aux-sidebar')) return { click() {} };
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

test('停靠模式最小化收口: 历史写入 hide 或 aux 自动安全回退为顶栏默认 flow 显示, 界面仅保留验稳选项', async () => {
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
    // 1. 初始化时历史配置 hide 自动纠偏为 flow
    assert.equal(api.getDockPosition().dockPosition, 'flow', '本地历史写入 hide 时初始化自动回退到 flow');
    assert.equal(api.getDockPosition().actualDock, 'flow', '实际挂载始终保持为顶栏默认显示');
    assert.equal(extraSandbox.localStorage.getItem('ag_dock_position'), 'flow', 'localStorage 纠偏写回 flow');

    // 2. 外部即使再尝试设置 aux 或 hide，也一律安全规范为 flow
    api.setDockPosition('aux');
    assert.equal(api.getDockPosition().dockPosition, 'flow');
    assert.equal(api.getDockPosition().actualDock, 'flow');

    api.setDockPosition('hide');
    assert.equal(api.getDockPosition().dockPosition, 'flow');
    assert.equal(api.getDockPosition().actualDock, 'flow');

    // 3. 静态模板门禁: 验证 template.html 中已彻底移除未成熟的 aux、hide 及展开挂载提示条
    const templatePath = path.resolve(__dirname, 'src/renderer/template.html');
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    assert.ok(templateHtml.includes('id="btn-dock-flow"'), '必须保留默认顶栏按钮 btn-dock-flow');
    assert.ok(!templateHtml.includes('id="btn-dock-aux"'), '必须移除 btn-dock-aux');
    assert.ok(!templateHtml.includes('id="btn-dock-hide"'), '必须移除 btn-dock-hide');
    assert.ok(!templateHtml.includes('id="dock-fallback-note"'), '必须移除 dock-fallback-note');
    assert.ok(!templateHtml.includes('id="badge-dock-wake"'), '必须移除 badge-dock-wake');
    assert.ok(!templateHtml.includes('id="dock-toast"'), '必须移除 dock-toast');
  } finally {
    try { api.dispose(); } catch {}
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
    try { api.dispose(); } catch {}
  }
});
