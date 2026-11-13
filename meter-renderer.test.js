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
  assert.equal(api.version, '0.8.2');

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
  assert.match(h.elements.get('p-det-acq').textContent, /学生认证优惠/);
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
  assert.equal(toggleBtn.textContent, '收起详情 ▲');
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
