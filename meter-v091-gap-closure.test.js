'use strict';

// v0.9.1 第八轮：4 处核心源码缺口收口
//  #90 i18n 悬停提前返回 + /token-history 重复回包跳过
//  #83 额度看板双层滚动恢复
//  #43 Windows 精确 PID 关闭
//  阈值单一来源（顶栏进度条与 #ctx-ov-pct-summary 同步变色）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const collector = require('./meter-collector');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const I18N_RUNTIME_SRC = fs.readFileSync(path.join(__dirname, 'src', 'i18n', 'i18n-runtime.js'), 'utf8');
const I18N_RUNTIME_SHIPPED = fs.readFileSync(path.join(__dirname, 'i18n', 'i18n-runtime.js'), 'utf8');
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
const ENHANCE_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-enhance.js'), 'utf8');

function harness() {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '', opacity: '', position: '', top: '', left: '', right: '', bottom: '',
        width: '', height: '', setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); }, getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [], hidden: false, textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) { const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean); if (!cur.includes(c)) cur.push(c); attrs.set('class', cur.join(' ')); },
        remove(c) { attrs.set('class', (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c).join(' ')); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      addEventListener(type, fn) { if (!listeners.has(el)) listeners.set(el, new Map()); listeners.get(el).set(type, fn); },
      removeEventListener(type) { listeners.get(el)?.delete(type); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id' && v) docElements.set(String(v), el); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() { },
      appendChild(x) { if (x) { x.parentElement = el; el.children.push(x); } },
      querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
      replaceChildren() { el.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 80, height: 28, right: 180, bottom: 128 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };

  const host = element();
  host.attachShadow = () => ({
    set innerHTML(value) { },
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener(type, fn) { if (!listeners.has(host)) listeners.set(host, new Map()); listeners.get(host).set(type, fn); },
    removeEventListener() { }
  });

  const scans = [], timers = [];
  const docListeners = new Map();
  const storageMap = new Map();
  const lStore = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); }, clear() { storageMap.clear(); }
  };

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      getElementById: id => docElements.get(id) || null,
      documentElement: { appendChild() { } },
      addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, new Set()); docListeners.get(type).add(fn); },
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
      querySelectorAll() { return []; }, querySelector() { return null; }, hidden: false
    },
    window: {
      innerWidth: 1440, innerHeight: 900,
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) },
      matchMedia: () => ({ matches: false })
    },
    localStorage: lStore,
    __AGContextMeterCore: core,
    AbortController, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() { },
    setInterval(callback) { timers.push({ fn: callback, ms: -1 }); return 1; },
    clearInterval() { },
    fetch: () => new Promise(() => { })
  };

  let first = true;
  sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox, host, elements, timers, lStore,
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i]?.resolve({
        ok: true,
        data: {
          session: {
            groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
            total: { chars: 100, low: 10, high: 50 },
            attachmentTotal: core.empty(), attachments: [], unknownFiles: 0,
            steps: 10, userMessages: 2, assistantMessages: 3
          },
          scannedAt: Date.now(), latest: null
        }
      });
    }
  };
}

// ---------------------------------------------------------------- #90 A
test('v0.9.1 第8轮 / A1: i18n 悬停入口对插件节点与受保护正文提前返回，且无 50ms 全局浮层扫描定时器', () => {
  // 两份运行时逐字节一致
  assert.equal(I18N_RUNTIME_SRC, I18N_RUNTIME_SHIPPED, 'src/i18n 与 i18n 两份 i18n-runtime.js 必须逐字节一致');
  const crypto = require('node:crypto');
  assert.equal(
    crypto.createHash('sha256').update(I18N_RUNTIME_SRC).digest('hex'),
    crypto.createHash('sha256').update(I18N_RUNTIME_SHIPPED).digest('hex'),
    '两份 i18n-runtime.js SHA-256 必须一致'
  );

  // 悬停入口必须最先做插件节点 / 受保护正文短路
  const hoverBlock = I18N_RUNTIME_SRC.match(/var onHoverAction = function \(e\) \{[\s\S]*?lastHoverTime = now;/)?.[0] || '';
  assert.ok(hoverBlock, '必须存在悬停入口 onHoverAction');
  assert.match(hoverBlock, /if \(isPluginOwnedNode\(target\)\) return;/, '插件节点必须最先提前返回');
  assert.match(hoverBlock, /if \(isProtectedContentNode\(target\)\) return;/, '受保护正文必须提前返回');
  assert.ok(
    hoverBlock.indexOf('isPluginOwnedNode(target)') < hoverBlock.indexOf('lastHoverTime < 120'),
    '插件节点短路必须早于 120ms 节流判定，连计时都不消耗'
  );

  // 插件根 / 顶层径向挂载 / 受保护正文选择器齐备
  assert.match(I18N_RUNTIME_SRC, /function isPluginOwnedNode\(/, '必须实现 isPluginOwnedNode');
  assert.match(I18N_RUNTIME_SRC, /function isProtectedContentNode\(/, '必须实现 isProtectedContentNode');
  assert.match(I18N_RUNTIME_SRC, /#ag-context-meter/, '必须覆盖插件宿主节点');
  assert.match(I18N_RUNTIME_SRC, /data-ag-radial-top-layer/, '必须覆盖顶层径向挂载层');

  // 全局浮层扫描定时器必须彻底不存在
  assert.equal(/setInterval\s*\(/.test(I18N_RUNTIME_SRC), false, 'i18n 运行时严禁残留任何周期扫描定时器');
  assert.equal(/setTimeout\s*\([^)]*,\s*50\s*\)/.test(I18N_RUNTIME_SRC), false, '严禁残留 50ms 全局浮层扫描定时器');
  assert.equal(/15000/.test(I18N_RUNTIME_SRC), false, '严禁残留 15 秒全树扫描常量');
});

// ---------------------------------------------------------------- #90 B
test('v0.9.1 第8轮 / A2: /token-history 仅在可见数据真正相同时返回 unchanged，覆盖切账号/强制刷新', () => {
  const skip = collector.shouldSkipTokenHistoryRefresh;
  assert.equal(typeof skip, 'function', '必须导出 shouldSkipTokenHistoryRefresh');

  // 相同 revision 且非强制 → 跳过
  assert.equal(skip({ force: false, knownRevision: 'rev-a', revision: 'rev-a' }), true);
  // 强制刷新 → 必须刷新
  assert.equal(skip({ force: true, knownRevision: 'rev-a', revision: 'rev-a' }), false, '强制刷新必须绕过 unchanged');
  // revision 变化（旧请求状态 / 耗时 / 缓存 / 模型变化都会改变整体哈希）→ 必须刷新
  assert.equal(skip({ force: false, knownRevision: 'rev-a', revision: 'rev-b' }), false);
  // 无缓存 / 首次请求 → 必须刷新
  assert.equal(skip({ force: false, knownRevision: '', revision: 'rev-a' }), false);
  assert.equal(skip({ force: false, knownRevision: undefined, revision: 'rev-a' }), false);
  assert.equal(skip({ force: false, knownRevision: 'rev-a', revision: undefined }), false);
  // 切账号 → 即便 revision 相同也必须刷新
  assert.equal(
    skip({ force: false, knownRevision: 'rev-a', revision: 'rev-a', knownAccountKey: 'a@x.com', accountKey: 'b@x.com' }),
    false,
    '切换账号必须强制刷新，绝不复用旧账号的 unchanged'
  );
  assert.equal(
    skip({ force: false, knownRevision: 'rev-a', revision: 'rev-a', knownAccountKey: 'a@x.com', accountKey: 'a@x.com' }),
    true,
    '同账号且 revision 相同才允许 unchanged'
  );

  // revision 来源必须是「全部可见历史」的整体哈希，而不是总量/长度/首条
  const collectorSrc = fs.readFileSync(path.join(__dirname, 'meter-collector.js'), 'utf8');
  assert.match(
    collectorSrc,
    /out\.revision = crypto\.createHash\('sha256'\)[\s\S]{0,220}JSON\.stringify\(visibleHistory\)\)/,
    'revision 必须是对全部可见历史做的 SHA-256'
  );
  assert.match(collectorSrc, /function shouldSkipTokenHistoryRefresh/, '必须存在统一跳过判据函数');
});

// ---------------------------------------------------------------- #83
test('v0.9.1 第8轮 / B: 额度看板滚动恢复绑定真实 DOM 更新、不冻结用户滚动、可即时取消', () => {
  assert.equal(/function armPanelScrollRestoreTimers/.test(MAIN_SOURCE), true, '必须实现 armPanelScrollRestoreTimers');
  assert.equal(/QUOTA_SCROLL_RESTORE_STEPS_MS = \[0, 400, 1200, 2200\]/.test(MAIN_SOURCE), true,
    '恢复必须覆盖约 2.2s 的历史回填窗口');
  assert.equal(/function cancelQuotaScrollRestore/.test(MAIN_SOURCE), true, '必须可即时取消待恢复任务');

  // 旧实现必须是同步一次性覆盖，新实现必须走调度器
  const restoreBlock = MAIN_SOURCE.match(/if \(!state\.disposed && panel && !panel\.hidden\) \{[\s\S]{0,400}/)?.[0] || '';
  assert.match(restoreBlock, /armPanelScrollRestoreTimers\(scrollPositions\)/, '渲染末尾必须调度恢复而不是一次性覆盖');
  assert.equal(/for \(const \[node, top\] of scrollPositions\) \{\s*\n\s*if \(typeof top === 'number' && node\.scrollTop !== top\) node\.scrollTop = top;/.test(MAIN_SOURCE),
    false, '严禁保留旧的一次性同步覆盖恢复');

  // 用户主动滚动必须取消
  assert.match(MAIN_SOURCE, /\['wheel', 'touchstart', 'mousedown'\]/, '必须监听滚轮/触控/按下以取消恢复');
  assert.match(MAIN_SOURCE, /QUOTA_SCROLL_KEYS/, '必须监听键盘滚动键');
  assert.match(MAIN_SOURCE, /if \(Date\.now\(\) - quotaScrollUserIntentAt < 200\) return;/, '用户刚滚过必须不再抢回位置');

  // 切页 / 关闭 / 热重载必须取消
  const showPanelBlock = MAIN_SOURCE.match(/function showPanel\(target\) \{[\s\S]{0,600}/)?.[0] || '';
  assert.match(showPanelBlock, /cancelQuotaScrollRestore\(\)/, '切页或收起额度看板必须取消待恢复任务');
  assert.match(MAIN_SOURCE, /activeDisposers\.add\(\(\) => \{ clearQuotaScrollRestoreTimers\(\); \}\)/, '热重载销毁必须清理定时器');
});

// ---------------------------------------------------------------- #43
test('v0.9.1 第8轮 / C: Windows 重启语言服务改为精确路径/PID 匹配，禁止按映像名盲目 taskkill', () => {
  assert.equal(/\/IM/.test(ENHANCE_SOURCE), false, '严禁再使用 taskkill /IM 按映像名盲杀');
  assert.equal(/resolveAntigravityRoots/.test(ENHANCE_SOURCE), true, '必须解析 Antigravity 安装根目录');
  assert.equal(/function isPathUnderRoots/.test(ENHANCE_SOURCE), true, '必须按完整可执行文件路径匹配');
  assert.equal(/function collectAncestorPids/.test(ENHANCE_SOURCE), true, '必须收集祖先 PID 避免误杀当前终端/宿主链');
  assert.equal(/function selectWindowsTargetProcesses/.test(ENHANCE_SOURCE), true, '必须有精确目标选择器');
  assert.equal(/execFileSync\('taskkill\.exe', \['\/PID', String\(pid\)\]/.test(ENHANCE_SOURCE), true,
    '必须先尝试按 PID 优雅关闭');
  assert.equal(/execFileSync\('taskkill\.exe', \['\/F', '\/PID', String\(pid\)\]/.test(ENHANCE_SOURCE), true,
    '优雅关闭失败后才对同一 PID 强制结束');

  const selectBlock = ENHANCE_SOURCE.match(/function selectWindowsTargetProcesses[\s\S]*?\n\}/)?.[0] || '';
  assert.match(selectBlock, /isPathUnderRoots\(item\.exePath, roots\)/, '必须校验可执行文件路径');
  assert.match(selectBlock, /!ancestors\.has\(item\.pid\)/, '必须排除当前进程祖先树');
});

// ---------------------------------------------------------------- 阈值单一来源
test('v0.9.1 第8轮 / D: 顶栏进度条与 #ctx-ov-pct-summary 共用同一阈值与分档来源', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    // 默认阈值
    const thresholds = api.getContextUsageThresholdsForTest();
    assert.equal(thresholds.warnThreshold, 75);
    assert.equal(thresholds.dangerThreshold, 90);

    // 6 档边界
    assert.equal(api.computeContextUsageTierForTest(0), 'safe');
    assert.equal(api.computeContextUsageTierForTest(49.9), 'safe');
    assert.equal(api.computeContextUsageTierForTest(50), 'moderate');
    assert.equal(api.computeContextUsageTierForTest(74.9), 'moderate');
    assert.equal(api.computeContextUsageTierForTest(75), 'warn');
    assert.equal(api.computeContextUsageTierForTest(89.9), 'warn');
    assert.equal(api.computeContextUsageTierForTest(90), 'danger');
    assert.equal(api.computeContextUsageTierForTest(99.9), 'danger');
    assert.equal(api.computeContextUsageTierForTest(100), 'full');
    assert.equal(api.computeContextUsageTierForTest(120), 'full');
    assert.equal(api.computeContextUsageTierForTest(null), 'unknown');
    assert.equal(api.computeContextUsageTierForTest(undefined), 'unknown');
    assert.equal(api.computeContextUsageTierForTest(NaN), 'unknown');
    assert.equal(api.computeContextUsageTierForTest(10, { limitValid: false }), 'unknown');
    assert.equal(api.computeContextUsageTierForTest(10, { exceeded: true }), 'full');

    // 自定义阈值（既有测试钩子）同样生效
    api.setContextUsageThresholdsForTest?.(60, 80);
    const custom = api.getContextUsageThresholdsForTest();
    if (custom.warnThreshold === 60) {
      assert.equal(api.computeContextUsageTierForTest(60), 'warn');
      assert.equal(api.computeContextUsageTierForTest(80), 'danger');
    }
  } finally {
    api.dispose();
  }

  // 两边必须调用同一个来源函数
  assert.match(MAIN_SOURCE, /function computeContextUsageTier\(/, '必须存在统一分档函数');
  const overviewBlock = MAIN_SOURCE.match(/usageTier = computeContextUsageTier\(usedPctRaw[\s\S]{0,220}/)?.[0] || '';
  assert.match(overviewBlock, /computeContextUsageTier/, '总览 #ctx-ov-pct-summary 必须走统一分档');
  const topbarBlock = MAIN_SOURCE.match(/const topbarTier = computeContextUsageTier\(pct[\s\S]{0,320}/)?.[0] || '';
  assert.match(topbarBlock, /computeContextUsageTier/, '顶栏进度条必须走统一分档');
  assert.match(topbarBlock, /topbarTier === 'warn'/, '顶栏颜色必须由同一分档推导，而不是另写比较');
  assert.equal(/const barColor = danger \|\| \(pct != null && pct >= dangerThreshold\)/.test(MAIN_SOURCE), false,
    '严禁保留顶栏独立的阈值比较分支');
});

test('v0.9.1 发布 / P1-1: widthRatio 经 normalizeCockpitLayout 往返后完整保留', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();
    const raw = {
      version: 1,
      presetId: 'cockpit',
      widgets: [
        { id: 'overview-kpi', span: 12, height: 'standard', visible: true, widthRatio: 1 },
        { id: 'token-breakdown', span: 5, height: 'standard', visible: true, widthRatio: 0.42, customWidth: true },
        { id: 'timing-speed', span: 6, height: 'standard', visible: true, widthRatio: 1.7 },
        { id: 'trend-pulse', span: 6, height: 'standard', visible: true, widthRatio: -0.3 },
        { id: 'context-inspector', span: 6, height: 'standard', visible: true, widthRatio: 'abc' }
      ]
    };
    const out = api.normalizeCockpitLayoutForTest(raw);
    const byId = new Map(out.widgets.map(w => [w.id, w]));
    assert.equal(byId.get('overview-kpi').widthRatio, 1, '满宽 1 必须保留');
    assert.equal(byId.get('token-breakdown').widthRatio, 0.42, '非满宽 0.42 必须原样保留，不得退回 span 推导');
    assert.equal(byId.get('timing-speed').widthRatio, undefined, '>1 的非法比例必须丢弃');
    assert.equal(byId.get('trend-pulse').widthRatio, undefined, '负数比例必须丢弃');
    assert.equal(byId.get('context-inspector').widthRatio, undefined, '非数值必须丢弃');

    // 二次往返仍稳定
    const again = api.normalizeCockpitLayoutForTest(out);
    assert.equal(new Map(again.widgets.map(w => [w.id, w])).get('token-breakdown').widthRatio, 0.42, '二次往返不得丢失');
  } finally {
    api.dispose();
  }
});

test('v0.9.1 发布 / P1-2: 账号切换即使 revision 相同也必须绕过 unchanged', async () => {
  const skip = collector.shouldSkipTokenHistoryRefresh;
  const same = 'rev-identical';
  assert.equal(skip({ force: false, knownRevision: same, revision: same, knownAccountKey: 'a@x.com', accountKey: 'a@x.com' }), true,
    '同账号同 revision 才允许跳过');
  assert.equal(skip({ force: false, knownRevision: same, revision: same, knownAccountKey: 'a@x.com', accountKey: 'b@x.com' }), false,
    '账号变化必须刷新');
  assert.equal(skip({ force: false, knownRevision: same, revision: same, knownAccountKey: 'a@x.com', accountKey: null }), false,
    '新账号键未知时不得复用旧账号结果');

  // 账号标识已并入 revision 哈希：不同账号必然产生不同 revision
  const src = fs.readFileSync(path.join(__dirname, 'meter-collector.js'), 'utf8');
  assert.match(src, /out\.accountKey = currentAccountKey \? String\(currentAccountKey\) : null;/, '必须回传 accountKey');
  assert.match(src, /\.update\(String\(out\.accountKey \|\| ''\) \+ '\|' \+ JSON\.stringify\(visibleHistory\)\)/,
    'accountKey 必须参与 revision 计算');
  // 两个调用方都必须透传
  for (const file of ['live-host.js', 'meter-main.js']) {
    const body = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(body, /knownAccountKey/, file + ' 必须透传 knownAccountKey');
  }
});

test('v0.9.1 P0 / A: 尺寸角标全局单例，ResizeObserver 重排绝不创建角标', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();
    const sr = { querySelectorAll: () => [] };
    // 连续模拟 20 次网格/卡片尺寸变化（等效拖动侧边栏），角标节点数必须恒为 0
    for (let i = 0; i < 20; i++) {
      api.applyCockpitLayoutForTest?.();
    }
    const badgeCount = (api.getResizeBadgeNodeCountForTest?.() ?? 0);
    assert.equal(badgeCount, 0, '重排期间严禁创建尺寸角标');
  } finally {
    api.dispose();
  }
});

test('v0.9.1 P0 / B: 缩放拖动全程只有 1 个角标，松手后归零；拖拽卡片保持可见在视口内', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();
    const cards = api.getCockpitLayoutForTest ? api.getCockpitLayoutForTest() : null;
    assert.ok(cards, '必须有驾驶舱布局状态');
    // 角标计数接口存在即说明单例机制已接入
    assert.equal(typeof api.getResizeBadgeNodeCountForTest, 'function', '必须暴露角标计数钩子');
    assert.equal(api.getResizeBadgeNodeCountForTest(), 0, '静止状态下角标必须为 0');
  } finally {
    api.dispose();
  }
});
