'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const {
  sanitizeSessionCockpitLayout,
  savePluginSettings,
  getPluginSettings,
  extractSessionToolInsights
} = require('./meter-collector');

const rendererPath = path.join(__dirname, 'meter-renderer.js');
const stylesSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
const templateSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');

function createDomHarness(options = {}) {
  const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
  const elements = new Map();
  const listeners = new Map();
  const savedSettingsCalls = [];

  const makeEl = (tagName = 'div', id = '') => {
    const attrs = new Map();
    if (id) attrs.set('id', id);
    const props = new Map();
    const classSet = new Set();
    let _className = '';
    const node = {
      tagName: String(tagName || 'div').toUpperCase(),
      id,
      parentElement: null,
      children: [],
      options: [],
      hidden: false,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      title: '',
      tabIndex: 0,
      scrollTop: 0,
      scrollLeft: 0,
      get className() {
        return _className;
      },
      set className(val) {
        _className = String(val || '');
        classSet.clear();
        for (const c of _className.split(/\s+/).filter(Boolean)) classSet.add(c);
      },
      classList: {
        add(...names) {
          for (const n of names) {
            if (!n) continue;
            classSet.add(n);
          }
          _className = Array.from(classSet).join(' ');
        },
        remove(...names) {
          for (const n of names) classSet.delete(n);
          _className = Array.from(classSet).join(' ');
        },
        toggle(n, force) {
          const on = typeof force === 'boolean' ? force : !classSet.has(n);
          if (on) classSet.add(n);
          else classSet.delete(n);
          _className = Array.from(classSet).join(' ');
          return on;
        },
        contains(n) {
          return classSet.has(n);
        }
      },
      style: {
        display: '',
        opacity: '',
        left: '',
        bottom: '',
        right: '',
        top: '',
        setProperty(k, v) { props.set(k, v); this[k] = v; },
        removeProperty(k) { props.delete(k); delete this[k]; },
        getPropertyValue(k) { return this[k] || props.get(k) || ''; }
      },
      addEventListener(type, fn) {
        if (!listeners.has(node)) listeners.set(node, new Map());
        const map = listeners.get(node);
        if (!map.has(type)) map.set(type, []);
        map.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(node)?.get(type);
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      trigger(type, ev = {}) {
        const list = listeners.get(node)?.get(type) || [];
        for (const fn of list.slice()) {
          fn({ target: node, currentTarget: node, stopPropagation() {}, preventDefault() {}, ...ev });
        }
      },
      click() {
        node.trigger('click');
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) {
          node.id = String(v);
          elements.set(String(v), node);
        }
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        if (!child) return child;
        child.remove();
        child.parentElement = node;
        node.children.push(child);
        if (child.tagName === 'OPTION') node.options.push(child);
        return child;
      },
      replaceChildren(...items) {
        for (const child of node.children.slice()) child.remove();
        for (const it of items) node.appendChild(it);
      },
      insertBefore(newNode, refNode) {
        if (!newNode) return newNode;
        if (newNode === refNode) return newNode;
        if (newNode.parentElement) newNode.remove();
        newNode.parentElement = node;
        const idx = node.children.indexOf(refNode);
        if (idx >= 0) node.children.splice(idx, 0, newNode);
        else node.children.push(newNode);
        return newNode;
      },
      remove() {
        if (node.parentElement) {
          const idx = node.parentElement.children.indexOf(node);
          if (idx >= 0) node.parentElement.children.splice(idx, 1);
          node.parentElement = null;
        }
      },
      querySelector(sel) {
        return node.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const mAttr = sel.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
        const mCls = sel.startsWith('.') ? sel.slice(1) : null;
        const walk = (cur) => {
          for (const ch of cur.children || []) {
            if (mAttr) {
              const av = ch.getAttribute?.(mAttr[1]);
              if (av !== null && (mAttr[2] === undefined || av === mAttr[2])) out.push(ch);
            } else if (mCls) {
              if (ch.classList?.contains?.(mCls)) out.push(ch);
            }
            walk(ch);
          }
        };
        walk(node);
        return out;
      },
      closest(sel) {
        let cur = node;
        const mAttr = sel.match(/^\[([a-z0-9-]+)\]$/i);
        const mCls = sel.startsWith('.') ? sel.slice(1) : null;
        const mId = sel.startsWith('#') ? sel.slice(1) : null;
        const tag = /^[a-z]+$/i.test(sel) ? sel.toUpperCase() : null;
        while (cur) {
          if (tag && cur.tagName === tag) return cur;
          if (mId && cur.id === mId) return cur;
          if (mCls && cur.classList?.contains?.(mCls)) return cur;
          if (mAttr && cur.getAttribute?.(mAttr[1]) !== null) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 320, height: 220, right: 420, bottom: 320 };
      },
      scrollIntoView() {},
      focus() {}
    };
    if (id) elements.set(id, node);
    return node;
  };

  // 从 template.html 预注册全部 widget 卡片与其 data-widget-id 到 #ctx-bento-grid
  const ensureEl = (id) => {
    if (!elements.has(id)) makeEl('div', id);
    return elements.get(id);
  };
  const bentoGrid = ensureEl('ctx-bento-grid');
  const timingCard = makeEl('section', 'ctx-widget-timing-speed');
  timingCard.setAttribute('data-widget-id', 'timing-speed');
  const foldBox = ensureEl('ctx-timing-diag-fold');
  foldBox.hidden = true;
  timingCard.appendChild(foldBox);
  bentoGrid.appendChild(timingCard);

  for (const wid of [
    'overview-kpi', 'token-breakdown', 'trend-pulse', 'context-inspector',
    'execution-trace', 'context-events', 'file-radar', 'command-audit',
    'agent-collab', 'tech-drawer', 'request-cost'
  ]) {
    if (wid === 'timing-speed') continue;
    const card = makeEl('section', `ctx-w-${wid}`);
    card.setAttribute('data-widget-id', wid);
    card.setAttribute('data-span', '6');
    card.setAttribute('data-height-mode', 'standard');
    const hdr = makeEl('header');
    hdr.className = 'ctx-widget-hdr';
    const act = makeEl('div');
    act.className = 'ctx-widget-hdr-actions';
    const spanBtn = makeEl('button');
    spanBtn.setAttribute('data-widget-action', 'cycle-span');
    const hBtn = makeEl('button');
    hBtn.setAttribute('data-widget-action', 'cycle-height');
    act.appendChild(spanBtn);
    act.appendChild(hBtn);
    hdr.appendChild(act);
    const body = makeEl('div');
    body.className = 'ctx-widget-body';
    card.appendChild(hdr);
    card.appendChild(body);
    bentoGrid.appendChild(card);
  }

  const host = makeEl('div', 'ag-context-meter');
  const shadow = makeEl('div', 'ag-shadow-root');
  shadow.getElementById = (id) => ensureEl(id);
  Object.defineProperty(shadow, 'innerHTML', { set() {} });
  host.attachShadow = () => shadow;

  let restoredSettings = options.initialSettings || { ok: true, customPlan: null };
  const pending = [];
  const scans = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    document: {
      createElement: (tag) => makeEl(tag),
      createElementNS: (_ns, tag) => makeEl(tag),
      documentElement: makeEl('html'),
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      hidden: false
    },
    window: {
      ...makeEl('window'),
      __APP_CONFIG__: { csrfToken: 'test' },
      innerWidth: 1440,
      innerHeight: 900,
      contextMeterAPI: {
        scan: (id) => new Promise(resolve => scans.push({ id, resolve })),
        getSettings: async () => restoredSettings,
        saveSettings: async (req) => {
          savedSettingsCalls.push(req);
          if (req?.sessionCockpitLayout) {
            restoredSettings = { ...restoredSettings, sessionCockpitLayout: req.sessionCockpitLayout };
          }
          if (req?.customPlan) {
            restoredSettings = { ...restoredSettings, customPlan: req.customPlan };
          }
          return { ok: true, customPlan: restoredSettings.customPlan || null, sessionCockpitLayout: restoredSettings.sessionCockpitLayout || null };
        }
      }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    __AGContextMeterCore: core,
    AbortController: global.AbortController,
    ...(options.scheduler || {}),
    Date,
    setTimeout: (cb) => { if (typeof cb === 'function') global.setTimeout(cb, 0); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: (url, opts) => new Promise(resolve => pending.push({ url, opts, resolve }))
  };
  let hostCreated = false;
  const origCreate = sandbox.document.createElement;
  sandbox.document.createElement = (tag) => {
    if (!hostCreated) {
      hostCreated = true;
      return host;
    }
    return origCreate(tag);
  };
  vm.createContext(sandbox);
  vm.runInContext(rendererSrc, sandbox);
  return {
    sandbox,
    host,
    shadow,
    elements,
    scans,
    pending,
    savedSettingsCalls,
    getSettingsSnapshot: () => restoredSettings,
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

// ----------------------------------------------------------------------------
// 1. 模块五后端：14 地区 × 6 套餐二维矩阵、权益规格与 Plus / EG(EGP) 验证
// ----------------------------------------------------------------------------
test('v0.9.0 模块五: 14 地区 × 6 套餐二维价格矩阵与权益规格完整精确', () => {
  const expectedRegions = ['US', 'JP', 'KR', 'TW', 'HK', 'EU', 'GB', 'AU', 'SG', 'CA', 'IN', 'TR', 'BR', 'EG'];
  for (const rId of expectedRegions) {
    assert.ok(core.SUBSCRIPTION_TIER_REGION_PRICES[rId], `矩阵缺少地区 ${rId}`);
    for (const sk of ['plus', 'pro', 'ultra_5x', 'ultra_20x']) {
      const ref = core.getRegionPlanReferencePrice(rId, sk);
      assert.equal(ref.available, true, `${rId} × ${sk} 必须有可用价格`);
      assert.ok(ref.monthlyPrice > 0, `${rId} × ${sk} 月付价必须为正数`);
    }
    assert.equal(core.getRegionPlanReferencePrice(rId, 'free').monthlyPrice, 0);
    const unsplit = core.getRegionPlanReferencePrice(rId, 'ultra');
    assert.equal(unsplit.available, false);
    assert.equal(unsplit.isRange, true);
  }

  // 埃及 EGP 与 Google AI Plus 核心数值校验
  const egPlus = core.getRegionPlanReferencePrice('EG', 'plus');
  assert.equal(egPlus.currency, 'EGP');
  assert.equal(egPlus.monthlyPrice, 239.99);
  const usPlus = core.getRegionPlanReferencePrice('US', 'plus');
  assert.equal(usPlus.monthlyPrice, 4.99);
  const plusSpec = core.getPlanTierSpec('plus');
  assert.equal(plusSpec.name, 'Google AI Plus');
  assert.match(plusSpec.flowOfficialZh, /200\/月/);
  assert.match(core.getPlanTierSpec('ultra_20x').cloudCreditsZh, /\$100\/月/);
  assert.equal(core.getPlanTierSpec('ultra_20x').storage, '30 TB');
});

// ----------------------------------------------------------------------------
// 2. 模块一：12 列驾驶舱布局引擎、5 套预设、拖拽/跨列/高度、4 档宽度与持久化往返
// ----------------------------------------------------------------------------
test('personal presets persist independently without truncation and retain card dimensions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-preset-library-'));
  try {
    const customPresets = Array.from({ length: 8 }, (_, i) => ({
      id: `custom-${i}`,
      name: `Layout ${i}`,
      presetId: 'speed_cost',
      widgets: [
        { id: 'token-breakdown', widthRatio: 0.42, heightPx: 215, visible: true },
        { id: 'timing-speed', visible: false }
      ]
    }));
    assert.equal(savePluginSettings({
      sessionCockpitLayout: {
        ...customPresets[7],
        customPresets,
        activeCustomId: 'custom-7'
      }
    }, { agDir: tmpDir }).ok, true);
    const layout = getPluginSettings({ agDir: tmpDir }).sessionCockpitLayout;
    assert.equal(layout.activeCustomId, 'custom-7');
    assert.equal(layout.customPresets.length, 8);
    for (const preset of layout.customPresets) {
      assert.equal(preset.widgets[0].widthRatio, 0.42);
      assert.equal(preset.widgets[0].customHeightPx, 215);
      assert.equal(preset.widgets[1].id, 'request-cost');
      assert.equal(preset.widgets[2].visible, false);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v0.9.0 模块一: 12 列驾驶舱 5 预设 / 顺序调整 / Span / Height / 持久化与 4 档容器断点和诊断折叠', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v090-cockpit-'));
  try {
    // 后端清洗与往返持久化
    const dirtyLayout = {
      version: 1,
      presetId: 'debug',
      widgets: [
        { id: 'execution-trace', span: 9, height: 'expanded', visible: true, customHeightPx: 999, customWidth: true },
        { id: 'invalid-widget', span: 99, height: 'bogus', visible: true }
      ]
    };
    const sanitized = sanitizeSessionCockpitLayout(dirtyLayout);
    assert.equal(sanitized.presetId, 'debug');
    assert.equal(sanitized.widgets[0].id, 'execution-trace');
    assert.equal(sanitized.widgets[0].span, 9);
    assert.equal(sanitized.widgets[0].customWidth, true);
    assert.equal(sanitized.widgets[0].customHeightPx, 680);
    assert.ok(!sanitized.widgets.some(w => w.id === 'invalid-widget'));
    assert.equal(sanitized.widgets.length, 12, '自动补齐包括请求费用在内的全部模块');
    assert.equal(sanitized.widgets.find(w => w.id === 'request-cost').visible, false);

    const saveRes = savePluginSettings({ sessionCockpitLayout: sanitized }, { agDir: tmpDir });
    assert.equal(saveRes.ok, true);
    const loaded = getPluginSettings({ agDir: tmpDir });
    assert.equal(loaded.sessionCockpitLayout.presetId, 'debug');
    assert.equal(loaded.sessionCockpitLayout.widgets[0].id, 'execution-trace');
    assert.equal(loaded.sessionCockpitLayout.widgets[0].span, 9);
    assert.equal(loaded.sessionCockpitLayout.widgets[0].customWidth, true);

    // 前端驾驶舱全交互验证
    const h = createDomHarness();
    await h.flush();
    const api = h.sandbox.__AGContextMeter;

    // 4 档响应宽度阈值
    assert.equal(api.setPanelWidthForTest(1280).tier, 'xl');
    assert.equal(api.setPanelWidthForTest(960).tier, 'wide');
    assert.equal(api.setPanelWidthForTest(640).tier, 'medium');
    assert.equal(api.setPanelWidthForTest(460).tier, 'narrow');

    // timing-speed 8 项详细诊断默认折叠，点击切换展开
    assert.equal(h.elements.get('ctx-timing-diag-fold').hidden, true);
    h.elements.get('btn-ctx-timing-diag-toggle').click();
    assert.equal(h.elements.get('ctx-timing-diag-fold').hidden, false);

    // 切换 5 套预设并验证各预设差异
    for (const preset of ['minimal', 'debug', 'speed_cost', 'collab', 'cockpit']) {
      const pLayout = api.applyCockpitPresetForTest(preset, { persist: true });
      assert.equal(pLayout.presetId, preset);
    }

    // 拖拽重排 + 跨列 + 高度调整 + 持久化重载恢复
    api.reorderCockpitWidgetForTest('execution-trace', 'overview-kpi', false);
    api.setCockpitWidgetSpanForTest('execution-trace', 8);
    const afterH = api.setCockpitWidgetHeightForTest('execution-trace', 'expanded', 420);
    assert.equal(afterH.widgets[0].id, 'execution-trace');
    assert.equal(afterH.widgets[0].span, 8);
    assert.equal(afterH.widgets[0].customHeightPx, 420);

    // 销毁并重建实例（携带刚才持久化的 sessionCockpitLayout）验证完整复原
    const savedSnap = h.getSettingsSnapshot();
    api.dispose();
    const h2 = createDomHarness({ initialSettings: savedSnap });
    await h2.flush();
    const api2 = h2.sandbox.__AGContextMeter;
    const restoredLayout = api2.getCockpitLayoutStateForTest();
    assert.equal(restoredLayout.widgets[0].id, 'execution-trace');
    assert.equal(restoredLayout.widgets[0].span, 8);
    assert.equal(restoredLayout.widgets[0].customHeightPx, 420);
    api2.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// 3. 模块二 & 三：执行轨迹 / 解剖台切片 / 协作中枢 / KPI 雷达命令审计 / 跨会话热力图联动
// ----------------------------------------------------------------------------
test('v0.9.0 模块三: 六大深度分析模块与热力图选日联动', async () => {
  const sampleCalls = [
    {
      index: 1, stepIndex: 1, turnIndex: 1, callId: 'c1',
      model: 'gemini-4-neon', modelLabel: 'Gemini 4 Neon',
      inputTokens: 12000, cacheReadTokens: 8000, outputTokens: 600, thinkingTokens: 200,
      totalTokens: 12600, totalInputTokens: 20000, contextWindowTokens: 20000,
      ttftSec: 0.9, streamingSec: 1.5, durationSec: 2.4, toolExecSeconds: 0.6,
      timestamp: Date.parse('2026-11-22T08:00:00.000Z'),
      agentRole: 'main', costUSD: 0.042,
      toolNames: ['read_file', 'mcp_github_search']
    },
    {
      index: 2, stepIndex: 2, turnIndex: 1, callId: 'c2',
      model: 'gemini-4-flash', modelLabel: 'Gemini 4 Flash',
      inputTokens: 3000, cacheReadTokens: 2000, outputTokens: 350, thinkingTokens: 50,
      totalTokens: 3350, totalInputTokens: 5000, contextWindowTokens: 5000,
      ttftSec: 0.4, streamingSec: 0.8, durationSec: 1.2,
      timestamp: Date.parse('2026-11-22T08:00:05.000Z'),
      agentRole: 'subagent', subagentType: 'research', parentStepIndex: 1, childCid: 'sub-1',
      costUSD: 0.008, toolNames: ['run_command']
    }
  ];
  const sampleSteps = [
    {
      stepIndex: 0,
      userInput: { userResponse: 'Inspect <script>alert(1)</script> dashboard' },
      timestamp: '2026-11-22T07:59:58.000Z'
    },
    {
      stepIndex: 1,
      plannerResponse: { thinking: 'Checking trace & tools', modifiedResponse: '### Done\n- Updated **grid**' },
      tool_calls: [{ name: 'edit_file', args: { Path: 'src/renderer/main.js', Target: 'a', Replacement: 'b\nc' }, durationSec: 0.4 }],
      timestamp: '2026-11-22T08:00:02.000Z'
    }
  ];

  // 后端聚合校验
  const trace = core.buildExecutionTrace(sampleSteps, sampleCalls, {
    turns: [{ turnIndex: 1, stepIndex: 0, calls: sampleCalls, timestamp: Date.parse('2026-11-22T08:00:00.000Z') }]
  });
  assert.ok(trace.nodes.length >= 3);
  assert.ok(Array.isArray(trace.ganttTracks.subagent));
  assert.ok(trace.ganttTracks.subagent.length >= 1);
  assert.ok(trace.stepQuickSummaries.length >= 2);

  const insights = extractSessionToolInsights([
    { name: 'read_file', args: { Path: 'd:/sample-workspace/app.js' }, stepIndex: 1, timestamp: 1700000001000 },
    { name: 'edit_file', args: { Path: 'd:/sample-workspace/app.js', Target: 'x', Replacement: 'y\nz' }, stepIndex: 2, timestamp: 1700000002000 },
    { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run tests' }, stepIndex: 3, durationSec: 6.2, output: 'exited with code 1', timestamp: 1700000003000 }
  ], []);
  assert.equal(insights.fileActivitySummary.uniqueFiles, 1);
  assert.equal(insights.fileActivities[0].addedLines, 2);
  assert.equal(insights.commandSummary.failedCount, 1);
  assert.equal(insights.commandSummary.slowCount, 1);

  const h = createDomHarness();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;

  // 注入会话 + 时间线 + 跨会话洞察载荷
  const timelinePayload = {
    turns: [{
      turnIndex: 1,
      stepIndex: 0,
      turnKey: 'turn-1-0',
      calls: sampleCalls,
      lastContextTokens: 20000
    }],
    totalCalls: 2,
    sessionTokenTotals: { freshInputTokens: 15000, cacheReadTokens: 10000, outputTokens: 950, thinkingTokens: 250, totalTokens: 25950 },
    cacheSummary: { cacheStatus: 'ok', cacheReadPct: 40 },
    contextChangeEvents: [{ type: 'compaction', stepIndex: 1, tokensSaved: 3200, label: 'Auto compact' }],
    attachmentsDetail: [{ id: 'att-1', name: 'preview.png', mime: 'image/png', width: 1280, height: 720, dimensions: '1280×720', sizeBytes: 40960, estimatedTokens: 258 }],
    executionTrace: trace,
    agentCollabHub: {
      mainAgent: { modelLabel: 'Gemini 4 Neon', callCount: 1, totalTokens: 12600, inputTokens: 12000, cacheReadTokens: 8000, outputTokens: 600, durationSec: 2.4, status: 'completed' },
      subagents: [{ childCid: 'sub-1', role: 'research', type: 'research', modelLabel: 'Gemini 4 Flash', callCount: 1, totalTokens: 3350, inputTokens: 3000, cacheReadTokens: 2000, outputTokens: 350, durationSec: 1.2, status: 'completed' }],
      collaborationTimeline: [{ stepIndex: 2, role: 'research', status: 'completed', totalTokens: 3350, detail: 'Subagent finished' }],
      delegatedTasks: [{ id: 'dt-1', role: 'research', type: 'research', summary: 'Run tests', status: 'completed', stepIndex: 2 }],
      interactionReceipts: [{ id: 'rcpt-1', stepIndex: 2, fromAgent: 'main', toAgent: 'research', kind: 'task', summary: 'Delegated verify', detail: 'Verify exit code' }]
    },
    fileActivities: insights.fileActivities,
    fileActivitySummary: insights.fileActivitySummary,
    commandExecutions: insights.commandExecutions,
    commandSummary: insights.commandSummary
  };

  h.scans[0]?.resolve({
    ok: true,
    data: {
      scannedAt: Date.now(),
      session: {
        title: 'Cockpit Smoke',
        steps: 3,
        userMessages: 1,
        assistantMessages: 1,
        groups: {
          system: { chars: 4000, low: 1000, high: 1200 },
          definitions: { chars: 2000, low: 500, high: 600 },
          user: { chars: 800, low: 200, high: 240 },
          assistant: { chars: 1200, low: 300, high: 360 },
          thinking: { chars: 400, low: 100, high: 120 },
          tools: { chars: 1600, low: 400, high: 480 },
          summaries: core.empty()
        },
        stepCompositionItems: {
          user: [{ stepIndex: 0, seqOrder: 1, sourceTag: 'builtin', label: 'User', tokens: 200, preview: '<script>alert(1)</script>' }],
          assistant: [{ stepIndex: 1, seqOrder: 2, sourceTag: 'mcp', label: 'Assistant', tokens: 300, preview: '### Heading\n- safe line' }]
        },
        sequentialSlices: [
          { id: 'slice-1', seqOrder: 1, stepIndex: 0, category: 'user', sourceTag: 'builtin', label: 'User Input', tokens: 200, lineCount: 1, preview: '<script>alert(1)</script>', fullSnippet: '<script>alert(1)</script>' },
          { id: 'slice-2', seqOrder: 2, stepIndex: 1, category: 'assistant', sourceTag: 'mcp', label: 'mcp_github_search', tokens: 300, lineCount: 2, preview: '### Heading\n- safe line', fullSnippet: '### Heading\n- safe line' }
        ],
        total: { chars: 10000, low: 2500, high: 3000 },
        attachmentsDetail: timelinePayload.attachmentsDetail
      }
    }
  });
  await h.flush();
  api.setSessionTimelineForTest?.(timelinePayload);
  h.elements.get('csb-group-context').click();
  api.setContextLatestForTest({ model: 'Gemini 4 Neon', actual: 20000, budget: 512000, percent: 3.9 });

  const m3 = api.getModule3WidgetsStateForTest();
  assert.ok(m3.traceRows >= 3, '执行轨迹流必须渲染节点');
  assert.ok(m3.traceGanttBars >= 3, '执行轨迹 5 泳道甘特必须渲染条块');
  assert.equal(m3.kpiPills.length, 6, '总览底部 6 枚 KPI 联动胶囊齐备');
  assert.ok(m3.tokenDonutSegs >= 2, 'Token 构成环形图必须渲染');
  assert.equal(m3.fileRadarRows, 1, '文件变更雷达必须渲染');
  assert.equal(m3.cmdAuditRows, 1, '命令审计流必须渲染');
  assert.equal(m3.collabEmptyHidden, true, '存在子代理时多代理工作区激活且空态隐藏');

  // 解剖台切换到顺序切片视图与安全渲染模式
  h.elements.get('btn-inspector-view-slices').click();
  h.elements.get('ctx-comp-preview-mode-render').click();
  assert.equal(h.elements.get('ctx-slices-list').hidden, false);
  assert.ok(h.elements.get('ctx-slices-list').children.length >= 2);
  assert.equal(h.elements.get('ctx-inspector-attachments').hidden, false);

  // 趋势全量压缩带 + 耗时叠加
  h.elements.get('btn-trend-compress-all').click();
  h.elements.get('btn-trend-latency-overlay').click();
  assert.ok(h.elements.get('ctx-trend-step-quickbar').children.length >= 3);

  // 跨会话洞察大盘 + 热力图日期点选联动
  api.setTokenHistoryForTest({
    dailyMap: {
      '2026-11-21': { total: 50000, input: 20000, cache: 25000, output: 5000, steps: 10 },
      '2026-11-22': { total: 80000, input: 30000, cache: 40000, output: 10000, steps: 14 }
    },
    crossSessionInsights: {
      dailyInsights: {
        '2026-11-21': { tokens: 50000, input: 20000, cache: 25000, output: 5000, costUSD: 0.12, calls: 10, sessions: 1, cacheReadPct: 55.6 },
        '2026-11-22': { tokens: 80000, input: 30000, cache: 40000, output: 10000, costUSD: 0.25, calls: 14, sessions: 2, cacheReadPct: 57.1 }
      },
      topTools: [{ name: 'read_file', count: 9, pct: 60, byDate: { '2026-11-22': 5 } }],
      topCommands: [{ program: 'npm', count: 4, byDate: { '2026-11-22': 4 } }],
      topSkills: [{ name: 'tdd', count: 2, byDate: { '2026-11-22': 2 } }],
      sessionArchives: [
        { cascadeId: 'arch-1', title: 'Alpha Task', date: '2026-11-21', updatedAt: 100, workspaceTag: 'RepoA', modelLabel: 'Gemini 4 Neon', totalTokens: 50000, costUSD: 0.12, cacheReadPct: 55.6, callCount: 10, compositionRatios: { inputPct: 40, cachePct: 50, outputPct: 10 } },
        { cascadeId: 'arch-2', title: 'Beta Task', date: '2026-11-22', updatedAt: 200, workspaceTag: 'RepoB', modelLabel: 'Gemini 4 Flash', totalTokens: 80000, costUSD: 0.25, cacheReadPct: 57.1, callCount: 14, compositionRatios: { inputPct: 37.5, cachePct: 50, outputPct: 12.5 } }
      ]
    }
  });
  let csiState = api.getCrossSessionInsightsStateForTest();
  assert.equal(csiState.archiveCount, 2);
  assert.ok(csiState.chartNodesCount >= 2);

  api.selectHeatmapDateForTest('2026-11-22');
  csiState = api.getCrossSessionInsightsStateForTest();
  assert.equal(csiState.selectedDate, '2026-11-22');
  assert.equal(csiState.archiveCount, 1);
  assert.ok(csiState.dateFilterText.includes('2026-11-22'), '日期筛选胶囊应包含选中日期');
  assert.equal(csiState.dateFilterText.includes('{date}'), false, '日期筛选胶囊不得残留未插值 {date}');
  h.elements.get('btn-csi-clear-date').click();
  assert.equal(api.getCrossSessionInsightsStateForTest().archiveCount, 2);
  api.dispose();
});

// ----------------------------------------------------------------------------
// 4. 模块四：全局丁香紫复选框矢量 CSS 与候选芯片高亮门禁
// ----------------------------------------------------------------------------
test('v0.9.0 模块四: 全局丁香紫自定义矢量复选框 CSS 与候选项高亮契约', () => {
  assert.match(stylesSrc, /input\[type="checkbox"\][\s\S]*appearance:\s*none;/);
  assert.match(stylesSrc, /input\[type="checkbox"\]:checked[\s\S]*#C084FC/);
  assert.match(stylesSrc, /:host\(\[data-theme="light"\]\)[\s\S]*input\[type="checkbox"\]:checked[\s\S]*#A855F7/);
  assert.match(stylesSrc, /\.auto-switch-cand-chip\.is-checked/);
  assert.doesNotMatch(templateSrc, /<input[^>]*type="checkbox"[^>]*accent-color/);
});

// ----------------------------------------------------------------------------
// 5. 模块五前端：全链路级联切换 (Pro -> Ultra 5x -> Ultra 20x -> Plus -> Free -> Auto) 与零括号断言
// ----------------------------------------------------------------------------
test('v0.9.0 模块五: 套餐切换全链路清旧价 + Prompt/Flow 胶囊 + 地区联动 + 三语零括号', async () => {
  const h = createDomHarness();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;

  // 预置一个带宿主实报 pro 与旧自定义 $19.99 的账号状态
  const baseLive = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'elvis@example.com',
    promptCredits: { available: 480, monthly: 1000 },
    flowCredits: { available: 90, monthly: 1000 }
  };
  api.setTokenHistoryForTest({
    rawPlanStatus: baseLive,
    planStatus: core.resolveEffectivePlanStatus(baseLive, {
      email: 'elvis@example.com',
      subscriptionCountry: 'US 美国',
      subscriptionRegion: 'US 美国',
      region: 'US 美国',
      currency: 'USD',
      priceMode: 'preset',
      actualPricePaid: 19.99
    }),
    dailyMap: {}
  });

  const selTier = h.elements.get('direct-tier-select');
  assert.ok(selTier);

  // 确认单参 resolvePlanSpecKey 识别 ultra_5x / ultra_20x，避免地区下拉回落 Pro 价
  assert.equal(core.resolvePlanSpecKey('ultra_5x'), 'ultra_5x');
  assert.equal(core.resolvePlanSpecKey('ultra_20x'), 'ultra_20x');

  // 逐级测试切换，验证 stale $19.99 被清理、参考价与规格精准联动
  selTier.value = 'ultra_5x';
  selTier.trigger('change', { target: { value: 'ultra_5x' } });
  let snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /\$99\.99/);
  assert.doesNotMatch(snap.priceDetail, /19\.99/);
  assert.match(snap.specsText, /5x/);
  assert.match(snap.regionLabel, /\$99\.99/, 'ultra_5x 下订阅地区触发器应显示 $99.99 而非回落 $19.99');

  selTier.value = 'ultra_20x';
  selTier.trigger('change', { target: { value: 'ultra_20x' } });
  snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /\$199\.99/);
  assert.match(snap.specsText, /30 TB/);

  selTier.value = 'plus';
  selTier.trigger('change', { target: { value: 'plus' } });
  snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /\$4\.99/);
  assert.match(snap.flowCredits, /200/);

  selTier.value = 'free';
  selTier.trigger('change', { target: { value: 'free' } });
  snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /\$0/);

  selTier.value = 'auto';
  selTier.trigger('change', { target: { value: 'auto' } });
  snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /\$19\.99/);
  assert.match(snap.promptCredits, /480/);

  // 切回 ultra_5x 后连切 US -> JP -> TW
  selTier.value = 'ultra_5x';
  selTier.trigger('change', { target: { value: 'ultra_5x' } });
  for (const regKw of ['日本', '台湾']) {
    h.elements.get('direct-region-trigger').click();
    const menu = h.elements.get('direct-region-menu');
    const items = menu.children.find(c => c.className === 'ag-dropdown-list-container')?.children || [];
    const target = items.find(it => it.textContent?.includes(regKw) || it.children?.some(c => c.textContent?.includes(regKw)));
    assert.ok(target, `地区下拉必须包含 ${regKw}`);
    target.click();
    await h.flush();
  }
  snap = api.getPlanDetailTextStateForTest();
  assert.match(snap.priceDetail, /NT\$3250/);

  // 三语零括号 & 零子档未知 & en 下零汉字门禁
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    await api.setPanelLanguage(lang, { persist: false });
    const txt = api.getPlanDetailTextStateForTest();
    for (const [field, val] of Object.entries(txt)) {
      assert.equal(/[()（）]/.test(String(val || '')), false, `${lang} 下 ${field} 含禁用括号: ${val}`);
      assert.equal(/子档未知|子檔未知|Sub-tier unknown/i.test(String(val || '')), false, `${lang} 下 ${field} 含禁用文案: ${val}`);
      if (lang === 'en') {
        assert.equal(/[\u4e00-\u9fff]/.test(String(val || '')), false, `en 下 ${field} 不得残留汉字: ${val}`);
      }
    }
  }
  assert.equal(/子档未知|子檔未知|Sub-tier unknown/.test(i18nSrc), false, 'i18n 字典不得保留子档未知文案');
  api.dispose();
});

// ----------------------------------------------------------------------------
// 6. 阶段 2: 会话总览状态行 data-usage-tier 6 档按档变色、三语零括号与阈值联动定向测试
// ----------------------------------------------------------------------------
test('v0.9.0 阶段 2: 会话总览状态行 data-usage-tier 6 档按档变色、三语零括号与阈值联动定向测试', async () => {
  const h = createDomHarness();
  const api = h.sandbox.__AGContextMeter;
  const summaryEl = h.elements.get('ctx-ov-pct-summary');
  assert.ok(summaryEl, '会话总览状态行元素 #ctx-ov-pct-summary 必须存在');

  // 1. 未知状态与初始占位
  assert.equal(summaryEl.getAttribute('data-usage-tier'), 'unknown');
  assert.equal(summaryEl.textContent, '—');
  h.elements.get('csb-group-context').click();

  // 2. 覆盖全部 10 个百分比节点及其档位映射
  const cases = [
    { used: 0, limit: 1000, expectedTier: 'safe', expectedPct: '0%' },
    { used: 59, limit: 1000, expectedTier: 'safe', expectedPct: '6%' },
    { used: 490, limit: 1000, expectedTier: 'safe', expectedPct: '49%' },
    { used: 500, limit: 1000, expectedTier: 'moderate', expectedPct: '50%' },
    { used: 620, limit: 1000, expectedTier: 'moderate', expectedPct: '62%' },
    { used: 740, limit: 1000, expectedTier: 'moderate', expectedPct: '74%' },
    { used: 750, limit: 1000, expectedTier: 'warn', expectedPct: '75%' },
    { used: 800, limit: 1000, expectedTier: 'warn', expectedPct: '80%' },
    { used: 890, limit: 1000, expectedTier: 'warn', expectedPct: '89%' },
    { used: 900, limit: 1000, expectedTier: 'danger', expectedPct: '90%' },
    { used: 940, limit: 1000, expectedTier: 'danger', expectedPct: '94%' },
    { used: 1000, limit: 1000, expectedTier: 'full', expectedPct: '100%' },
    { used: 1020, limit: 1000, expectedTier: 'full', expectedPct: '100%' }
  ];

  for (const c of cases) {
    api.setContextLatestForTest({
      actual: c.used,
      budget: c.limit,
      percent: Math.min(100, Math.round((c.used / c.limit) * 100)),
      exceeded: c.used > c.limit
    });
    assert.equal(
      summaryEl.getAttribute('data-usage-tier'),
      c.expectedTier,
      `用量 ${c.used}/${c.limit} (${c.expectedPct}) 档位映射期望 ${c.expectedTier}，实际为 ${summaryEl.getAttribute('data-usage-tier')}`
    );
  }

  // 3. 自定义阈值联动: 自定义警告线设为 50%，危急线设为 80%
  api.setCustomThresholdsForTest({ warning: 50, critical: 80 });
  api.setContextLatestForTest({ actual: 550, budget: 1000, percent: 55 });
  assert.equal(summaryEl.getAttribute('data-usage-tier'), 'warn', '自定义 50% 警告线生效后 55% 应当属于 warn 档');
  api.setCustomThresholdsForTest({ warning: 75, critical: 90 }); // 恢复默认

  // 4. 超限状态 100% 对应的三语词条严格零括号
  api.setContextLatestForTest({ actual: 1200, budget: 1000, percent: 100, exceeded: true });
  assert.equal(summaryEl.getAttribute('data-usage-tier'), 'full');
  for (const [lang, expectedWord] of [
    ['zh-CN', '已触及上限'],
    ['zh-TW', '已觸及上限'],
    ['en', 'Limit reached']
  ]) {
    await api.setPanelLanguage(lang, { persist: false });
    assert.ok(summaryEl.textContent.includes(expectedWord), `期望包含 ${expectedWord}，实际为 ${summaryEl.textContent}`);
    assert.equal(/[()（）]/.test(summaryEl.textContent), false, `${lang} 下超限状态行包含中英文括号: ${summaryEl.textContent}`);
  }

  // 5. 切回无数据会话不会残留上一会话档位
  api.setContextLatestForTest(null);
  assert.equal(summaryEl.getAttribute('data-usage-tier'), 'unknown');
  assert.equal(summaryEl.textContent, '—');

  // 6. CSS 色值契约验证: 包含 6 档深浅色及 full 背景样式，不含旧写死洋红
  const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /data-usage-tier="safe"\][\s\S]*?#6EE7B7/);
  assert.match(css, /data-usage-tier="safe"\][\s\S]*?#059669/);
  assert.match(css, /data-usage-tier="moderate"\][\s\S]*?#FCD34D/);
  assert.match(css, /data-usage-tier="moderate"\][\s\S]*?#B45309/);
  assert.match(css, /data-usage-tier="warn"\][\s\S]*?#FDBA74/);
  assert.match(css, /data-usage-tier="warn"\][\s\S]*?#C2410C/);
  assert.match(css, /data-usage-tier="danger"\][\s\S]*?#F87171/);
  assert.match(css, /data-usage-tier="danger"\][\s\S]*?#DC2626/);
  assert.match(css, /data-usage-tier="full"\][\s\S]*?#FCA5A5/);
  assert.match(css, /data-usage-tier="full"\][\s\S]*?#B91C1C/);
  assert.match(css, /data-usage-tier="full"\][\s\S]*?rgba\(239,\s*68,\s*68,\s*0\.16\)/);
  assert.match(css, /data-usage-tier="full"\][\s\S]*?#FEF2F2/);
  assert.doesNotMatch(css, /#pane-ctx-session \.ctx-ov-hero-pct\s*\{\s*font-weight:\s*700;\s*color:\s*#E11D74;\s*\}/);

  api.dispose();
});

// ----------------------------------------------------------------------------
// 7. 阶段 3 / 补充任务 A: 底栏四组按钮悬停浮卡居中(<=2px)与点击首帧直达二次点击关闭
// ----------------------------------------------------------------------------
test('v0.9.0 阶段 3 / 补充任务 A: 底栏四组按钮悬停浮卡居中(<=2px)与点击首帧直达二次点击关闭', async () => {
  const h = createDomHarness();
  const api = h.sandbox.__AGContextMeter;

  const btnSpeed = h.elements.get('csb-group-speed');
  const btnTokens = h.elements.get('csb-group-tokens');
  const btnContext = h.elements.get('csb-group-context');
  const btnQuota = h.elements.get('csb-group-quota');

  const cardSpeed = h.elements.get('csb-card-speed');
  const cardTokens = h.elements.get('csb-card-tokens');
  const cardContext = h.elements.get('csb-card-context');
  const cardQuota = h.elements.get('csb-card-quota');

  assert.ok(btnSpeed && btnTokens && btnContext && btnQuota, '四组底栏按钮必须完整存在');
  assert.ok(cardSpeed && cardTokens && cardContext && cardQuota, '四组顶层悬停缩略卡必须完整存在');

  // 1. 原生 title 必须清空以杜绝系统黑框双气泡
  assert.equal(btnSpeed.title || '', '', '速度按钮 title 必须清空');
  assert.equal(btnTokens.title || '', '', 'Token 按钮 title 必须清空');
  assert.equal(btnContext.title || '', '', '上下文按钮 title 必须清空');
  assert.equal(btnQuota.title || '', '', '额度按钮 title 必须清空');

  // 2. 模拟按钮在正常视口位置 (left: 400, width: 80)，验证水平居中偏差 <= 2px
  btnSpeed.getBoundingClientRect = () => ({ left: 400, top: 750, width: 80, height: 26, right: 480, bottom: 776 });
  btnSpeed.trigger('mouseenter');
  assert.equal(cardSpeed.hidden, false, '悬停速度项时浮卡必须可见');
  const cardLeft = parseFloat(cardSpeed.style.left || cardSpeed.style.getPropertyValue('left') || '0');
  const cardW = 228;
  const idealCenter = 400 + 40; // 440
  const actualCenter = cardLeft + cardW / 2;
  const centerDiff = Math.abs(actualCenter - idealCenter);
  assert.ok(centerDiff <= 2, `浮卡中心偏差必须 <= 2px，实际偏差: ${centerDiff}px`);

  // 3. 移开鼠标立即收起
  btnSpeed.trigger('mouseleave');
  assert.equal(cardSpeed.hidden, true, '移开鼠标后浮卡必须立即隐藏');

  // 4. 模拟在右边界靠边 (按钮靠右边界，理想中心会超出视口)，验证 clamp 留安全边距不遮挡右下角
  const screenW = h.sandbox.window ? h.sandbox.window.innerWidth : 1440;
  btnQuota.getBoundingClientRect = () => ({ left: screenW - 80, top: 750, width: 70, height: 26, right: screenW - 10, bottom: 776 });
  btnQuota.trigger('mouseenter');
  assert.equal(cardQuota.hidden, false, '悬停额度项时浮卡必须可见');
  const clampedQuotaLeft = parseFloat(cardQuota.style.left || cardQuota.style.getPropertyValue('left') || '0');
  assert.ok(clampedQuotaLeft + cardW <= screenW - 8, '浮卡右侧必须留有安全边界，严禁向右溢出');
  assert.ok(clampedQuotaLeft >= 8, '浮卡左侧必须大于等于安全边距');
  btnQuota.trigger('mouseleave');
  assert.equal(cardQuota.hidden, true);

  // 5. 点击直达与二次点击关闭
  // (a) 速度项: 直达速度对比，再点关闭
  btnSpeed.click();
  assert.equal(h.elements.get('panel').hidden, false, '点击速度按钮打开面板');
  assert.equal(h.elements.get('tab-ctx-speed').classList.contains('active'), true, '首帧直达速度对比');
  btnSpeed.click();
  assert.equal(h.elements.get('panel').hidden, true, '二次点击速度按钮关闭面板');

  // (b) Token 项: 直达实时请求，再点关闭
  btnTokens.click();
  assert.equal(h.elements.get('panel-tokens').hidden, false, '点击 Token 按钮打开实时请求');
  btnTokens.click();
  assert.equal(h.elements.get('panel-tokens').hidden, true, '二次点击 Token 按钮关闭实时请求');

  // (c) 上下文项: 直达当前会话，再点关闭
  btnContext.click();
  assert.equal(h.elements.get('panel').hidden, false, '点击上下文按钮打开当前会话');
  assert.equal(h.elements.get('tab-ctx-session').classList.contains('active'), true, '首帧直达当前会话');
  btnContext.click();
  assert.equal(h.elements.get('panel').hidden, true, '二次点击上下文按钮关闭当前会话');

  // (d) 额度项: 直达模型额度，再点关闭
  btnQuota.click();
  assert.equal(h.elements.get('panel-quota').hidden, false, '点击额度按钮打开模型额度看板');
  btnQuota.click();
  assert.equal(h.elements.get('panel-quota').hidden, true, '二次点击额度按钮关闭模型额度看板');

  api.dispose();
});

// ----------------------------------------------------------------------------
// 8. 阶段 3 / 补充任务 B: 12 列驾驶舱 Pointer Events 拖拽换位、自由缩放吸格与果冻落位
// ----------------------------------------------------------------------------
test('v0.9.0 阶段 3 / 补充任务 B: 12 列驾驶舱 Pointer Events 拖拽换位、自由缩放吸格与果冻落位', async () => {
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  const h = createDomHarness({ scheduler: {
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    }
  } });
  const tickFrame = () => {
    const batch = [...frames.values()];
    frames.clear();
    batch.forEach(fn => fn());
  };
  const api = h.sandbox.__AGContextMeter;
  const grid = h.elements.get('ctx-bento-grid');
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 1400 });
  grid.clientWidth = 800;
  h.elements.get('panel').setAttribute('data-ctx-width-tier', 'wide');
  assert.ok(observers.some(o => o.targets.has(h.elements.get('ctx-w-trend-pulse'))));

  // 1. 验证 DOM 手柄契约: 支持 .ag-widget-drag-handle 与 .ag-widget-resize-handle
  const tpl = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  assert.match(tpl, /class="[^"]*ag-widget-drag-handle[^"]*"/, 'template.html 必须包含 ag-widget-drag-handle 类名');
  assert.match(tpl, /class="[^"]*ag-widget-resize-handle[^"]*"/, 'template.html 必须包含 ag-widget-resize-handle 类名');

  // 2. 模拟真实 Pointer Events 拖拽手柄移动 >4px 触发拖拽
  const card1 = h.elements.get('ctx-widget-timing-speed');
  const card2 = h.elements.get('ctx-w-token-breakdown');
  card1.getBoundingClientRect = () => ({
    left: 20, top: 100, width: parseFloat(card1.style.width) || (card1.getAttribute('data-span') === '12' ? 800 : 400),
    height: parseFloat(card1.style.height) || 260, right: 420, bottom: 360
  });
  card2.getBoundingClientRect = () => ({ left: 20, top: 400, width: 400, height: 260, right: 420, bottom: 660 });

  const fakeHeader = { closest: () => card1 };
  const fakeHandle = {
    closest: (sel) => {
      if (sel === '.ctx-widget-hdr') return fakeHeader;
      if (sel.includes('ag-widget-drag-handle') || sel.includes('ctx-widget-drag-handle')) return fakeHandle;
      if (sel.includes('widget-id')) return card1;
      return null;
    },
    setPointerCapture: () => {}
  };

  // 模拟 pointerdown -> pointermove (移动 8px > 4px)
  grid.trigger('pointerdown', {
    clientX: 30,
    clientY: 110,
    pointerId: 1,
    target: fakeHandle
  });

  // 验证在手柄上移动超过 4px 激活拖拽态
  const moveEv = { clientX: 30, clientY: 125, pointerId: 1 };
  h.sandbox.window.trigger('pointermove', moveEv);
  assert.equal(card1.classList.contains('is-dragging'), true);
  h.sandbox.window.trigger('pointercancel', moveEv);
  assert.equal(card1.classList.contains('is-dragging'), false);

  // 3. 验证右下角缩放手柄拖拽与吸格角标 (文案零括号)
  const fakeResizeHandle = {
    closest: (sel) => {
      if (sel.includes('ag-widget-resize-handle') || sel.includes('ctx-widget-resize-handle')) return fakeResizeHandle;
      if (sel.includes('widget-id')) return card1;
      return null;
    },
    setPointerCapture: () => {}
  };

  // 模拟缩放时的跟手宽高与右边缘角标
  const resizeWidget = api.getCockpitLayoutForTest().widgets.find(widget => widget.id === 'timing-speed');
  resizeWidget.widthRatio = 0.5;
  api.applyCockpitLayoutForTest();
  assert.equal(card1.getBoundingClientRect().width, 400);
  const body = h.sandbox.document.createElement('div');
  body.getBoundingClientRect = () => ({ height: 260 });
  const queryCard = card1.querySelector.bind(card1);
  card1.querySelector = selector => selector === '.ctx-widget-body' ? body : queryCard(selector);
  grid.trigger('pointerdown', { target: fakeResizeHandle, clientX: 415, clientY: 355, pointerId: 2 });
  const resizeMove = {
    clientX: 495,
    clientY: 420,
    pointerId: 2
  };
  h.sandbox.window.trigger('pointermove', resizeMove);
  tickFrame();
  assert.equal(card1.style.height, '325px');
  assert.equal(card1.style.width, '480px');
  // v0.9.1：缩放全程不再渲染任何虚框/定位槽，卡片本体即时呈现最终尺寸
  assert.equal(grid.children.some(child => child && typeof child.className === 'string' && /resize-snap-ghost|resize-slot|ctx-widget-placeholder/.test(child.className)), false,
    '缩放与拖拽期间严禁再渲染虚框或占位槽');
  h.sandbox.window.trigger('pointercancel', resizeMove);
  assert.equal(card1.style.height, '');
  await h.flush();
  assert.equal(h.savedSettingsCalls.filter(call => call.sessionCockpitLayout).length, 0);

  const animations = [];
  card1.animate = (frames, options) => {
    animations.push({ frames, options });
    return { cancel() {}, finished: Promise.resolve() };
  };
  grid.trigger('pointerdown', { target: fakeResizeHandle, clientX: 1100, clientY: 355, pointerId: 3 });
  h.sandbox.window.trigger('pointermove', { clientX: 1410, clientY: 0, pointerId: 3 });
  tickFrame();
  // v0.9.1：最小高度下限收紧到 180px，宽度与高度全程逐像素跟手
  assert.equal(card1.style.height, '180px');
  const dragWidthPx = parseFloat(card1.style.width);
  // 自由缩放：宽度逐像素跟手并夹紧在容器宽内，且不得吸附到 6 列或 12 列的整列宽
  assert.ok(dragWidthPx > 600, `拖动期宽度必须跟手放大，实际 ${dragWidthPx}`);
  assert.ok(dragWidthPx <= 715, `拖动期宽度不得超过容器宽度，实际 ${dragWidthPx}`);
  const badge = h.shadow.children.find(child => child.className === 'ag-widget-resize-badge');
  assert.ok(badge && parseFloat(badge.style.left) + 112 <= 1432);
  assert.match(String(badge.textContent || ''), /^\d+ × \d+px$/, '尺寸胶囊只显示简洁中性像素，严禁括号');
  h.sandbox.window.trigger('pointerup', { pointerId: 3 });
  // v0.9.1：松手按 widthRatio 持久化并落地 2D 排版，宽度允许 1–8px 的容器换算误差，高度严格保留
  assert.equal(card1.style.height, '180px');
  const settledWidthPx = parseFloat(card1.style.width);
  // 松手后自由宽度保留：绝不被吸回 6 列或 12 列整列宽，允许行尾贴齐带来的小幅增宽
  assert.ok(settledWidthPx >= dragWidthPx - 8, `松手后宽度不得回缩，实际 ${settledWidthPx}`);
  assert.ok(settledWidthPx <= 1000, `松手后宽度必须落在容器范围内，实际 ${settledWidthPx}`);
  assert.ok(settledWidthPx > 0 && settledWidthPx <= 1000, '自由宽度必须落在容器范围内');
  assert.equal(animations[0].options.duration, 190);
  assert.equal(animations[0].options.easing, 'cubic-bezier(0.2, 1.08, 0.32, 1)');
  assert.match(animations[0].frames[0].transform, /translate3d.*scale\(/);

  // 4. 双击缩放手柄还原预设尺寸
  grid.trigger('dblclick', {
    target: fakeResizeHandle
  });
  assert.equal(card1.style.gridColumn, '');

  // 5. CSS 动效契约验证: 必须包含 Squish & Pop 与 Jelly Settle 关键帧，仅动画 transform/opacity
  const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /@keyframes\s+agWidgetSquishPop/);
  assert.match(css, /@keyframes\s+agWidgetJellySettle/);
  // v0.9.1：松手落位收紧为 220ms 清脆回弹，回弹关键帧为 1.016/0.986 起手
  assert.match(css, /scale\(1\.016,\s*0\.986\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  api.dispose();
});

test('模块管理折行到最左侧时保持 8px 边距，窗口变化后重新夹紧并按可用空间翻转', () => {
  const h = createDomHarness();
  try {
    const toolbar = h.elements.get('ctx-cockpit-toolbar');
    const button = h.elements.get('btn-ctx-widget-mgr');
    const panel = h.elements.get('panel');
    const popover = h.elements.get('ctx-widget-mgr-popover');
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    panel.getBoundingClientRect = () => rect(100, 40, 340, 400);
    button.getBoundingClientRect = () => rect(117, 104, 72, 22);
    popover.getBoundingClientRect = () => rect(parseFloat(popover.style.left), parseFloat(popover.style.top),
      Math.min(268, parseFloat(popover.style.getPropertyValue('--ctx-widget-mgr-max-width'))),
      Math.min(310, parseFloat(popover.style.getPropertyValue('--ctx-widget-mgr-max-height'))));

    toolbar.trigger('click', { target: button });
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(popover.getBoundingClientRect().left, 117, '左侧按钮向右展开');
    assert.ok(popover.getBoundingClientRect().right <= 432);

    panel.getBoundingClientRect = () => rect(100, 40, 236, 400);
    button.getBoundingClientRect = () => rect(254, 374, 72, 22);
    h.sandbox.window.innerWidth = 322;
    h.sandbox.window.trigger('resize');
    const shrunk = popover.getBoundingClientRect();
    assert.equal(shrunk.left, 108);
    assert.equal(shrunk.right, 314, '同时夹紧到可见视口');
    assert.ok(shrunk.bottom <= 368, '下方空间不足时向上展开');
    assert.ok(shrunk.top >= 48);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});

test('模块管理 Pointer Events 浮起实体行，实时移动空槽并同步排序，Esc 恢复且控件免拖拽', async () => {
  const h = createDomHarness();
  try {
    await h.flush();
    let clearedSelection = 0;
    h.sandbox.window.getSelection = () => ({ removeAllRanges: () => { clearedSelection += 1; } });
    const toolbar = h.elements.get('ctx-cockpit-toolbar');
    toolbar.trigger('click', { target: h.elements.get('btn-ctx-widget-mgr') });
    const list = h.elements.get('ctx-widget-mgr-list');
    const popover = h.elements.get('ctx-widget-mgr-popover');
    const grid = h.elements.get('ctx-bento-grid');
    const orderOf = (parent, key) => Array.from(parent.children, child => child.getAttribute(key));
    const before = orderOf(list, 'data-mgr-order-id');
    const initial = Array.from(list.children);
    const floating = () => popover.querySelector('.ctx-widget-mgr-float');
    const slotIndex = () => list.children.findIndex(child => child.classList.contains('ctx-widget-mgr-slot'));
    const press = (target, clientY) => list.trigger('pointerdown', { target, button: 0, pointerId: 1, clientX: 10, clientY });
    const pointer = (type, clientY) => h.sandbox.window.trigger(type, { pointerId: 1, clientX: 10, clientY });
    const animations = [];
    assert.equal(before.length, 12);
    const lastRowY = (before.length - 1) * 30 + 6;
    list.getBoundingClientRect = () => ({ left: 0, top: 0, width: 268, height: 330, bottom: 330 });
    initial.forEach((row, index) => {
      Object.defineProperty(row, 'offsetTop', { get: () => Math.max(0, list.children.indexOf(row)) * 30 });
      row.offsetHeight = 26;
      row.getBoundingClientRect = () => ({ left: 0, top: list.children.includes(row) ? row.offsetTop : index * 30, width: 268, height: 26 });
      row.animate = (frames, options) => { animations.push({ frames, options }); return { cancel() {} }; };
    });

    const [grip, label, arrows] = initial.at(-1).children;
    for (const control of [label.children[0], ...arrows.children]) {
      press(control, lastRowY);
      pointer('pointermove', 2);
      await h.flush();
      assert.equal(floating(), null);
      pointer('pointerup', 2);
    }
    assert.equal(clearedSelection, 0);

    press(grip, lastRowY);
    pointer('pointermove', lastRowY - 4);
    assert.equal(floating().children[0], initial.at(-1), '手柄位移超过 3px 即浮起真实行');
    pointer('pointermove', 2);
    assert.equal(slotIndex(), 0);
    h.sandbox.window.trigger('keydown', { key: 'Escape', stopImmediatePropagation() {} });
    assert.equal(floating(), null);
    assert.deepEqual(orderOf(list, 'data-mgr-order-id'), before);
    assert.deepEqual(orderOf(grid, 'data-widget-id'), before);

    press(label.children[1], lastRowY);
    assert.equal(floating(), null, '点在文字上时先等待长按');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(floating().children[0], initial.at(-1));
    assert.equal(slotIndex(), before.length - 1);
    pointer('pointermove', 2);
    assert.equal(slotIndex(), 0, '跨越行中线时空槽已移动');
    assert.match(floating().style.transform, /^translate3d/);
    assert.ok(animations.some(animation => animation.options.duration === 220));
    assert.equal(clearedSelection, 2);
    pointer('pointerup', 2);
    const expected = [before.at(-1), ...before.slice(0, -1)];
    assert.equal(floating(), null);
    assert.deepEqual(orderOf(list, 'data-mgr-order-id'), expected);
    assert.deepEqual(orderOf(grid, 'data-widget-id'), expected);
    assert.deepEqual(Array.from(h.getSettingsSnapshot().sessionCockpitLayout.widgets, item => item.id), expected);
  } finally {
    h.sandbox.__AGContextMeter.dispose();
  }
});
