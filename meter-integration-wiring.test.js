'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;

function readUtf8(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

function createMiniDom() {
  const makeNode = (tagName = 'div') => {
    const attrs = new Map();
    const listeners = new Map();
    const styleProps = new Map();
    const children = [];
    const node = {
      tagName: String(tagName || 'div').toUpperCase(),
      id: '',
      className: '',
      hidden: false,
      textContent: '',
      title: '',
      parentElement: null,
      children,
      style: {
        setProperty: (k, v) => styleProps.set(k, String(v)),
        getPropertyValue: (k) => styleProps.get(k) || ''
      },
      classList: {
        add: (...cls) => {
          const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          node.className = Array.from(set).join(' ');
        },
        remove: (...cls) => {
          const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          node.className = Array.from(set).join(' ');
        },
        toggle: (c, force) => {
          const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
          const shouldAdd = force !== undefined ? Boolean(force) : !set.has(c);
          if (shouldAdd) set.add(c); else set.delete(c);
          node.className = Array.from(set).join(' ');
        },
        contains: (c) => String(node.className || '').split(/\s+/).includes(c)
      },
      setAttribute: (k, v) => {
        attrs.set(k, String(v));
        if (k === 'id') node.id = String(v);
        if (k === 'class') node.className = String(v);
      },
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      appendChild: (child) => {
        if (!child) return child;
        child.parentElement = node;
        children.push(child);
        return child;
      },
      insertBefore: (child, refNode) => {
        if (!child) return child;
        child.parentElement = node;
        const idx = refNode ? children.indexOf(refNode) : -1;
        if (idx >= 0) children.splice(idx, 0, child);
        else children.push(child);
        return child;
      },
      remove: () => {
        if (!node.parentElement) return;
        const idx = node.parentElement.children.indexOf(node);
        if (idx >= 0) node.parentElement.children.splice(idx, 1);
        node.parentElement = null;
      },
      addEventListener: (evt, fn) => {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      removeEventListener: (evt, fn) => {
        const list = listeners.get(evt) || [];
        listeners.set(evt, list.filter(x => x !== fn));
      },
      click: () => {
        for (const fn of (listeners.get('click') || [])) fn({ target: node, stopPropagation() {}, preventDefault() {} });
      },
      get nextSibling() {
        if (!node.parentElement) return null;
        const idx = node.parentElement.children.indexOf(node);
        return idx >= 0 ? (node.parentElement.children[idx + 1] || null) : null;
      },
      querySelectorAll: (sel) => {
        const out = [];
        const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
        const matches = (el, p) => {
          if (p.startsWith('#')) return el.id === p.slice(1);
          if (p.startsWith('.')) return el.classList.contains(p.slice(1));
          const attrMatch = p.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (attrMatch) {
            const val = el.getAttribute(attrMatch[1]);
            return attrMatch[2] !== undefined ? val === attrMatch[2] : val !== null;
          }
          return el.tagName.toLowerCase() === p.toLowerCase();
        };
        const walk = (root) => {
          for (const ch of root.children) {
            if (parts.some(p => matches(ch, p))) out.push(ch);
            walk(ch);
          }
        };
        walk(node);
        return out;
      },
      querySelector: (sel) => node.querySelectorAll(sel)[0] || null,
      getRootNode: () => doc
    };
    return node;
  };
  const head = makeNode('head');
  const body = makeNode('body');
  const doc = {
    head,
    body,
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
    getElementById: (id) => body.querySelector(`#${id}`) || head.querySelector(`#${id}`),
    querySelector: (sel) => body.querySelector(sel) || head.querySelector(sel),
    querySelectorAll: (sel) => [...head.querySelectorAll(sel), ...body.querySelectorAll(sel)],
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  return doc;
}

test('Integration Wiring: all 11 newly inlined modules have real non-comment runtime call sites', () => {
  const mainJs = stripComments(readUtf8('src/renderer/main.js'));
  const hostSettingsJs = stripComments(readUtf8('src/renderer/host-settings.js'));
  const dashboardGridJs = stripComments(readUtf8('src/renderer/dashboard-grid.js'));
  const nextPromptJs = stripComments(readUtf8('src/renderer/next-prompt.js'));
  const collectorJs = stripComments(readUtf8('meter-collector.js'));
  const bundleJs = readUtf8('meter-renderer.js');

  // 1. AGAuxQuickSwitch (real contract: onApplyAuxViewTab + onSwapPaneOrder)
  assert.match(mainJs, /AGAuxQuickSwitch[\s\S]{0,160}createAuxQuickSwitchController/);
  assert.match(mainJs, /onApplyAuxViewTab:/);
  assert.match(mainJs, /onSwapPaneOrder:/);
  // 2. AGHostSettingsNavAlign
  assert.match(hostSettingsJs, /AGHostSettingsNavAlign\??\.buildAlignedHostSettingsNavCss/);
  assert.match(hostSettingsJs, /window\.AGHostSettingsNavAlign/);
  // 3. AGReqSortDropdown
  assert.match(mainJs, /AGReqSortDropdown[\s\S]{0,180}createReqSortDropdownController/);
  assert.match(mainJs, /AGReqSortDropdown[\s\S]{0,180}sortRequestRecords/);
  // 4. AGPresetBoardUpgrades
  assert.match(dashboardGridJs, /AGPresetBoardUpgrades[\s\S]{0,180}normalizePresetCatalog/);
  assert.match(dashboardGridJs, /AGPresetBoardUpgrades[\s\S]{0,180}deletePresetFromCatalog/);
  assert.match(dashboardGridJs, /AGPresetBoardUpgrades[\s\S]{0,240}syncPresetActionPillsDom/);
  assert.match(dashboardGridJs, /AGPresetBoardUpgrades[\s\S]{0,180}resolveFreeResizeGeometry/);
  // 5. AGMorphIndicatorToolbar (v3 contract: main-window 5-slot capsule + retracted/showRetractHandle + quota5h/quota7d + taskQuotaObservation)
  assert.match(mainJs, /AGMorphIndicatorToolbar[\s\S]{0,180}createMorphIndicatorToolbarController/);
  assert.match(mainJs, /retracted,\s*\r?\n\s*showRetractHandle\b/);
  assert.match(mainJs, /quota5h:\s*b5/);
  assert.match(mainJs, /quota7d:\s*b7/);
  assert.match(mainJs, /formatTurnFooterCompactLine\(\{\s*taskQuotaObservation:\s*summary\s*\}/);
  assert.match(mainJs, /AGMorphIndicatorToolbar\??\.stripComposerQuotaMoreBadge/);
  // 6. AGQuickModelEffortPicker removed (Regression #2: native model selector 100% untouched)
  assert.equal(fs.existsSync(path.join(ROOT, 'src/renderer/quick-model-effort-picker.js')), false, 'quick-model-effort-picker.js must be deleted');
  assert.doesNotMatch(mainJs, /AGQuickModelEffortPicker|syncQuickModelEffortPicker/);
  assert.doesNotMatch(readUtf8('scripts/build-renderer.js'), /quick-model-effort-picker|INSERT_QUICK_MODEL_EFFORT_PICKER_MODULE/);
  assert.equal(bundleJs.includes('AGQuickModelEffortPicker'), false, 'meter-renderer.js must not include AGQuickModelEffortPicker');
  assert.equal(bundleJs.includes('syncQuickModelEffortPicker'), false, 'meter-renderer.js must not include syncQuickModelEffortPicker');
  // 7. AGNextPromptAlignment (real contract: setColor, NOT selectColor)
  assert.match(nextPromptJs, /AGNextPromptAlignment[\s\S]{0,160}ALIGNED_GHOST_CSS/);
  assert.match(nextPromptJs, /AGNextPromptAlignment[\s\S]{0,160}syncAlignedInlineGhostGeometry/);
  assert.match(nextPromptJs, /dbgCtrl(?:\?\.)?setColor(?:\?\.)?\(/);
  assert.doesNotMatch(nextPromptJs, /selectColor/);
  // 8. AGOrbPositioning
  assert.match(mainJs, /AGOrbPositioning[\s\S]{0,160}detectBlockingHostModal/);
  assert.match(mainJs, /AGOrbPositioning\??\.clampOrbCoord/);
  // 9. AGInsightsAndViews (v3 contract: createSidebarInsightsHostController/syncMount, syncSessionFourViewsHost under conversation header, flattened render)
  assert.match(mainJs, /AGInsightsAndViews[\s\S]{0,400}createSidebarInsightsHostController/);
  assert.match(mainJs, /insightsHostCtrl\.syncMount\(/);
  assert.match(mainJs, /syncSessionFourViewsHost\(/);
  assert.match(mainJs, /mapOrchestratorTelemetryToVisualState\(/);
  assert.doesNotMatch(mainJs, /mountSidebarEntry|insightsPageCtrl\.syncData|sessionFourViewsCtrl\.mount\(/);
  // 10. __AGQuotaScrollGuard
  assert.match(mainJs, /__AGQuotaScrollGuard\??\.createQuotaScrollGuard/);
  // 11. __AGTaskQuota / meter-task-quota.js (real contract: recordSnapshot / beginTask / finishTask / getTaskObservation)
  assert.match(mainJs, /__AGTaskQuota\??\.createTaskQuotaTracker/);
  assert.match(mainJs, /tracker\.recordSnapshot\(/);
  assert.match(mainJs, /tracker\.beginTask\(/);
  assert.match(mainJs, /tracker\.finishTask\(/);
  assert.match(mainJs, /tracker\.getTaskObservation\(/);
  assert.match(mainJs, /attachTaskQuotaToReplies\(obs,\s*\[replyId\]\)/);
  assert.doesNotMatch(mainJs, /ingestSnapshot|listTasks/);
  assert.match(collectorJs, /require\(['"]\.\/meter-task-quota(?:\.js)?['"]\)/);
  assert.match(collectorJs, /sharedTaskQuotaTracker\.recordSnapshot\(out/);
  assert.match(collectorJs, /sharedTaskQuotaTracker\.beginTask\(/);
  assert.match(collectorJs, /sharedTaskQuotaTracker\.finishTask\(/);
  assert.doesNotMatch(collectorJs, /ingestSnapshot|listTasks/);

  for (const sym of [
    'AGAuxQuickSwitch',
    'AGHostSettingsNavAlign',
    'AGReqSortDropdown',
    'AGPresetBoardUpgrades',
    'AGMorphIndicatorToolbar',
    'AGNextPromptAlignment',
    'AGOrbPositioning',
    'AGInsightsAndViews',
    '__AGQuotaScrollGuard',
    '__AGTaskQuota'
  ]) {
    assert.ok(bundleJs.includes(sym), `meter-renderer.js must include ${sym}`);
  }
});

test('Behavioral Wiring: meter-task-quota, AGMorphIndicatorToolbar, AGInsightsAndViews, and AGNextPromptAlignment produce real outputs under mock DOM', () => {
  const tq = require('./meter-task-quota.js');
  const mtb = require('./src/renderer/morph-indicator-toolbar.js');
  const iv = require('./src/renderer/insights-and-views.js');
  const npAlign = require('./src/renderer/next-prompt-alignment.js');
  const core = require('./meter-core.js');

  // 1. meter-task-quota end-to-end: recordSnapshot -> beginTask -> finishTask -> recordSnapshot -> attachTaskQuotaToReplies -> formatTurnFooterCompactLine
  const tracker = tq.createTaskQuotaTracker();
  const baseMs = 1795800000000;
  const makeHostSnap = (f5h, f7d, ts) => ({
    ok: true,
    accountScopeKey: 'acct_test_1',
    email: 'tester@example.com',
    fetchedAtMs: ts,
    snapshot: {
      pools: [{
        poolKey: 'shared_gemini_main',
        sourceType: 'quota_summary_and_configs',
        buckets: [
          { windowKey: '5h', remainingFraction: f5h, resetTimeIso: new Date(ts + 3600000).toISOString() },
          { windowKey: 'weekly', remainingFraction: f7d, resetTimeIso: new Date(ts + 86400000 * 5).toISOString() }
        ]
      }]
    }
  });
  tracker.recordSnapshot(makeHostSnap(0.80, 0.90, baseMs), { nowMs: baseMs });
  tracker.beginTask({ taskId: 'task-1', sessionId: 'sess-1', accountScopeKey: 'acct_test_1', modelId: 'gemini-4-neon', nowMs: baseMs + 1000 });
  tracker.finishTask('task-1', { taskStatus: 'completed', nowMs: baseMs + 4000 });
  tracker.recordSnapshot(makeHostSnap(0.75, 0.89, baseMs + 6000), { nowMs: baseMs + 6000 });
  const obs = tracker.getTaskObservation('task-1', baseMs + 6000);
  assert.equal(obs.windows['5h'].status, 'observed');
  assert.equal(obs.windows['5h'].deltaPp, 5);
  assert.equal(obs.windows.weekly.status, 'observed');
  assert.equal(obs.windows.weekly.deltaPp, 1);

  const attached = tq.attachTaskQuotaToReplies(obs, ['reply-1', 'reply-2']);
  assert.equal(attached[0].taskQuotaSummary, null);
  assert.equal(attached[1].isTaskTerminalReply, true);
  assert.ok(attached[1].taskQuotaSummary);
  const footerLine = mtb.formatTurnFooterCompactLine({ taskQuotaObservation: attached[1].taskQuotaSummary }, 'zh-CN');
  assert.match(footerLine, /5H −5% 观测/);
  assert.match(footerLine, /7D −1% 观测/);

  // 2. AGMorphIndicatorToolbar: auxViewerVisible hides on browser-only, quota5h/quota7d renders real percentage
  const doc = createMiniDom();
  const mtbHost = doc.createElement('div');
  doc.body.appendChild(mtbHost);
  const mtbCtrl = mtb.createMorphIndicatorToolbarController({ document: doc, lang: 'zh-CN' });
  const mtbRoot = mtbCtrl.mount(mtbHost, doc.head);
  mtbCtrl.setActiveScope('acct_test_1::sess-1');
  const shown = mtbCtrl.render({
    auxViewerVisible: true,
    scopeKey: 'acct_test_1::sess-1',
    poolTitle: 'Gemini Models',
    quota5h: { remainingFraction: 0.75 },
    quota7d: { remainingFraction: 0.89 },
    contextUsed: 42000,
    contextBudget: 200000,
    cacheHitPct: 80
  });
  assert.equal(shown.applied, true);
  assert.equal(shown.visible, true);
  assert.equal(mtbRoot.hidden, false);
  assert.equal(shown.quotaText, '5H 75% · 7D 89%');
  const hiddenRes = mtbCtrl.render({ auxViewerVisible: false, scopeKey: 'acct_test_1::sess-1' });
  assert.equal(hiddenRes.visible, false);
  assert.equal(mtbRoot.hidden, true);
  mtbCtrl.destroy();

  // 3. AGInsightsAndViews: sidebar anchor + openPage/closePage + mountSwitcher + Orchestrator flattened render
  const sidebar = doc.createElement('nav');
  const custBtn = doc.createElement('button');
  custBtn.textContent = 'Customizations';
  const projBtn = doc.createElement('button');
  projBtn.textContent = 'Projects';
  sidebar.appendChild(custBtn);
  sidebar.appendChild(projBtn);
  doc.body.appendChild(sidebar);
  const anchor = iv.findSidebarInsightsAnchor(doc);
  assert.ok(anchor && anchor.parent === sidebar && anchor.insertBefore === projBtn);

  const insightsCtrl = iv.createContextInsightsPageController({ lang: 'zh-CN' });
  const openRes = insightsCtrl.openPage({ route: 'sess-1' });
  assert.equal(openRes.active, true);
  assert.equal(openRes.networkRequestCountOnOpen, 0);
  const closeRes = insightsCtrl.closePage();
  assert.equal(closeRes.active, false);
  assert.equal(closeRes.restoredConversation.route, 'sess-1');

  const viewsHost = doc.createElement('div');
  const viewsCtrl = iv.createSessionFourViewsController({ document: doc, lang: 'zh-CN' });
  const mountedViews = viewsCtrl.mountSwitcher(viewsHost, 'sess-1');
  assert.ok(mountedViews && mountedViews.bar);
  assert.equal(mountedViews.bar.querySelectorAll('.ag-session-view-tab').length, 4);

  const orchTel = core.extractOrchestratorTelemetry({
    cascadeModelConfigs: [{ modelId: 'gemini-pro-orchestrator', label: 'Orchestrator', plannerModel: 'Gemini 4 Pro', executorModel: 'Gemini 3.8 Flash' }],
    sessionCalls: [
      { callId: 'c1', orchestratorRole: 'planner', modelLabel: 'Gemini 4 Pro', status: 'completed', totalTokens: 1000 },
      { callId: 'c2', orchestratorRole: 'executor', modelLabel: 'Gemini 3.8 Flash', status: 'streaming', totalTokens: 500 }
    ],
    trajectoryEvents: [
      { eventId: 'ev1', fromRole: 'planner', toRole: 'executor', actionLabel: '执行测试脚本', stepIndex: 3, timestamp: baseMs }
    ]
  });
  const orchHost = doc.createElement('div');
  const orchCtrl = iv.createOrchestratorVisualController({ document: doc, lang: 'zh-CN' });
  orchCtrl.mount(orchHost, doc.head);
  const norm = orchCtrl.render({
    lang: 'zh-CN',
    containerWidth: 420,
    plannerModel: orchTel.roles.planner.models[0],
    executorModel: orchTel.roles.executor.models[0],
    plannerBusy: orchTel.plannerBusy,
    executorBusy: orchTel.executorBusy,
    hasVerifiedRuntime: orchTel.runtimeRecorded,
    handoffDirection: 'planner-to-executor',
    confirmedActionText: orchTel.handoffs[0].actionLabel,
    events: orchTel.events
  });
  assert.equal(norm.hasRuntimeEvidence, true);
  assert.equal(norm.plannerModel, 'Gemini 4 Pro');
  assert.equal(norm.executorModel, 'Gemini 3.8 Flash');
  assert.equal(norm.direction, 'planner-to-executor');
  assert.equal(norm.actionText, '执行测试脚本');
  orchCtrl.destroy();

  // 4. AGNextPromptAlignment: setColor applies CSS custom property and attribute on ghost element
  const ghost = doc.createElement('div');
  const dbg = npAlign.createNextPromptColorDebugController({ initialColor: '#9A9A9A', ghostEl: ghost });
  const colorRes = dbg.setColor('#7E7E7E');
  assert.equal(colorRes.color, '#7E7E7E');
  assert.equal(ghost.style.getPropertyValue('--ag-np-ghost-color'), '#7E7E7E');
  assert.equal(ghost.getAttribute('data-np-debug-color'), '#7E7E7E');
});

test('Integration Wiring: all 5 meter-core.js 02/07 data functions have real production call sites', () => {
  const mainJs = stripComments(readUtf8('src/renderer/main.js'));
  const collectorJs = stripComments(readUtf8('meter-collector.js'));

  assert.match(mainJs, /__AGContextMeterCore\??\.reconcileCompactionTerminalState/);
  assert.match(mainJs, /__AGContextMeterCore\??\.summarizeSessionCompactions/);
  assert.match(mainJs, /__AGContextMeterCore\??\.resolveTurnFooterModelAttribution/);
  assert.match(mainJs, /buildUsageOverviewReconciliation\(/);
  assert.match(mainJs, /extractOrchestratorTelemetry\(/);

  assert.match(collectorJs, /summarizeSessionCompactions\(/);
  assert.match(collectorJs, /resolveTurnFooterModelAttribution\(/);
  assert.match(collectorJs, /buildUsageOverviewReconciliation\(/);
  assert.match(collectorJs, /extractOrchestratorTelemetry\(/);
});

test('Integration Wiring: template.html #req-sort-bar uses compact dropdown slot without 5 static buttons', () => {
  const tpl = readUtf8('src/renderer/template.html');
  const match = tpl.match(/<div[^>]*id="req-sort-bar"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(match, '#req-sort-bar must exist in template.html');
  assert.match(match[0], /data-req-sort-dropdown-slot="true"/);
  assert.equal((match[0].match(/data-req-sort=/g) || []).length, 0, '#req-sort-bar must not contain 5 static sort buttons');
  assert.match(tpl, /端到端速度/);
});

test('Regression #1: meter-accounts.js restores preview_tools and non-active CloudCode verify without hostOnlyBoundary lockdown', async () => {
  const accounts = require('./meter-accounts.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wiring-p1-'));
  try {
    const storePath = path.join(tmpDir, 'accounts_v1.json');
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      activeAccountEmail: 'active@example.com',
      accounts: {
        'active@example.com': {
          email: 'active@example.com',
          name: 'Active',
          accountScopeKey: accounts.buildAccountScopeKey('active@example.com'),
          credential: {}
        },
        'other@example.com': {
          email: 'other@example.com',
          name: 'Other',
          accountScopeKey: accounts.buildAccountScopeKey('other@example.com'),
          credential: {}
        }
      }
    }, null, 2));

    let remoteCalled = false;
    const mgr = accounts.createAccountsManager({
      stateDir: tmpDir,
      fetch: async () => {
        remoteCalled = true;
        throw new Error('simulated_network_error');
      }
    });

    const previewRes = await accounts.dispatchAccountsAction(
      mgr,
      { action: 'preview_tools' },
      {}
    );
    assert.notEqual(previewRes.reason, 'cross_tool_credential_import_disabled', '回归 #1 严禁拦截 preview_tools');

    const nonActiveVerify = await accounts.dispatchAccountsAction(
      mgr,
      { action: 'verify_account', email: 'other@example.com' },
      {
        fetchActiveHostSnapshot: async () => ({
          ok: true,
          fetchedAtMs: Date.now(),
          snapshot: { pools: [{ poolKey: 'shared_gemini_main', buckets: [{ windowKey: '5h', remainingFraction: 0.9 }] }] }
        })
      }
    );
    assert.notEqual(nonActiveVerify.reason, 'cloudcode_direct_disabled', '回归 #1 严禁以 cloudcode_direct_disabled 拦截非活跃账号刷新');

    const activeVerify = await accounts.dispatchAccountsAction(
      mgr,
      { action: 'verify_account', email: 'active@example.com' },
      {
        fetchActiveHostSnapshot: async () => ({
          ok: true,
          fetchedAtMs: Date.now(),
          snapshot: { pools: [{ poolKey: 'shared_gemini_main', buckets: [{ windowKey: '5h', remainingFraction: 0.9 }] }] }
        })
      }
    );
    assert.equal(remoteCalled, false);
    assert.equal(activeVerify.ok, true);
    assert.equal(activeVerify.source, 'host_local_snapshot');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P2(1) native_guide overlay re-verify callback reuses runVerifyActiveAccount instead of only updating notice', () => {
  const mainJs = readUtf8('src/renderer/main.js');
  assert.match(mainJs, /const runVerifyActiveAccount = \(\) => \{/);
  const matches = mainJs.match(/onVerify:\s*runVerifyActiveAccount/g) || [];
  assert.ok(matches.length >= 2, 'Both initial and retry native_guide overlays must bind onVerify: runVerifyActiveAccount');
});
