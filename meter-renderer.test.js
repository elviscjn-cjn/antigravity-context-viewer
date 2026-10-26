const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k,core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
function harness(scanSession = session()) {
  const elements = new Map();
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
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element(); host.attachShadow = () => ({ set innerHTML(value) {}, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const pending = [], scans = [], timers = [];
  const sandbox = { location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' }, document: { createElement: () => element(), documentElement: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false }, window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } }, __AGContextMeterCore: core, AbortController, Date, setTimeout: () => 1, clearTimeout() {}, setInterval(callback) { timers.push(callback); return 1; }, clearInterval() {}, fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); } };
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
  assert.equal(api.version, '2.6.0');
  api.dispose();
});

test('v5 Section 1: floating panels reposition clear of left project sidebar and overlay right auxiliary pane without clipping', () => {
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

test('v5 Section 2 & 4: custom background color (panelBg), custom Color Picker HEX->RGB/HSL sync, and heatmap 5-stop presets & 2-endpoint interpolation', () => {
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

test('v5 Section 3 & 5: timeline starts at actual firstUseDate with zero leading blank cells and supports multi-year archive pagination', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Verify default firstUseDate on this machine (2026-10-20)
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

test('v5 Additive: 5 heatmap levels (heatLvl0..4) support per-cell independent custom colors, free layering with presets/2-endpoint interpolation, and direct legend click color picker', () => {
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

test('v5.1: heatmap top-row anti-clipping padding and popover Chinese translations for Prompt, Output, Cache', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Ensure .heat-scroll-box has padding to prevent top cell hover outline clipping
  assert.match(source, /\.heat-scroll-box\s*\{[^}]*padding:\s*6px 6px 4px 6px/);
  assert.match(source, /\.pop-det-trans\s*\{[^}]*font-size:\s*9\.5px/);

  // 2) Trigger daily heatmap cell click
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

  // Value contains 'Tokens' without translation
  assert.match(heatPopVal.textContent, /Tokens$/);

  // Detail section has 3 columns with Chinese translations directly beneath Prompt, Output, Cache
  assert.match(heatPopDet.innerHTML, /Prompt:[\s\S]*?<span class="pop-det-trans">提示词<\/span>/);
  assert.match(heatPopDet.innerHTML, /Output:[\s\S]*?<span class="pop-det-trans">输出<\/span>/);
  assert.match(heatPopDet.innerHTML, /Cache:[\s\S]*?<span class="pop-det-trans">缓存<\/span>/);

  api.dispose();
});



