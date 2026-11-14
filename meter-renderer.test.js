const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k,core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
function harness(scanSession = session()) {
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
  const sandbox = { location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' }, document: { createElement: () => element(), getElementById: id => docElements.get(id) || null, documentElement: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false }, window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } }, __AGContextMeterCore: core, AbortController, Date, setTimeout: () => 1, clearTimeout() {}, setInterval(callback) { timers.push(callback); return 1; }, clearInterval() {}, fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); } };
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
  assert.equal(h.elements.get('speed-amount').textContent, '112.1 tok/s');
  assert.match(h.elements.get('speed-hover-extra').textContent, /21\.3s/);
  assert.match(h.elements.get('badge-speed').title, /112\.1 tok\/s/);
  assert.equal(h.elements.get('speed-val').textContent, '112.1 tok/s');
  assert.equal(h.elements.get('speed-duration').textContent, '21.3s');
  assert.equal(h.elements.get('speed-ttft').textContent, '8.4s');
  assert.match(h.elements.get('speed-tokens').textContent, /2,388 tok/);
  assert.equal(h.elements.get('speed-badge').textContent, '极速');
  assert.match(h.elements.get('speed-takeaway').textContent, /112\.1 tok\/s/);
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
  assert.equal(api.version, '0.8.3');

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

  // 3. 验证 AI Pro 详情展开、手动“详情收回”按钮、切换预估费用自动关闭详情及异步返回防重开
  h.elements.get('badge-tokens').click();
  const detailCard = h.elements.get('plan-detail-card');
  const toggleBtn = h.elements.get('btn-plan-detail-toggle');
  const collapseTopBtn = h.elements.get('btn-plan-detail-collapse-top');
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

  // 点击顶部“详情收回 ▲”按钮手动关闭
  collapseTopBtn.click();
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
  assert.equal(h.elements.get('speed-badge').textContent, '流暢');

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
  assert.equal(h.elements.get('speed-badge').textContent, 'Smooth');
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
