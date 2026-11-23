'use strict';

// v0.9.1 模块二：卡片拖拽/缩放质感重做（中性磨砂槽 + 合法列数吸格 + 短促弹簧）
//                与手动刷新按钮三态微交互 + 原始 i18n 键泄漏修复

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const TPL_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
const GRID_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'dashboard-grid.js'), 'utf8');

function ruleOf(css, selector) {
  const needle = selector.replace(/\s*\{\s*$/, '') + ' {';
  const idx = css.indexOf(needle);
  if (idx < 0) return '';
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return '';
  return css.slice(open + 1, close);
}

function harness() {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '', opacity: '', position: '', top: '', left: '', right: '', bottom: '', width: '', height: '',
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
        toggle(c, on) {
          if (on === undefined) on = !this.contains(c);
          if (on) this.add(c); else this.remove(c);
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      removeEventListener(type) { listeners.get(el)?.delete(type); },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() { },
      appendChild(x) { if (x) { x.parentElement = el; el.children.push(x); } },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
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
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, fn) {
      if (!listeners.has(host)) listeners.set(host, new Map());
      listeners.get(host).set(type, fn);
    },
    removeEventListener() { }
  });

  const scans = [], timers = [];
  const docListeners = new Map();
  const storageMap = new Map();
  const lStore = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    clear() { storageMap.clear(); },
    get(k) { return storageMap.get(k); }
  };

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
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
      dispatchEvent(ev) {
        const type = ev?.type || ev;
        for (const fn of (docListeners.get(type) || [])) fn(ev);
      },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      hidden: false
    },
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) },
      matchMedia: () => ({ matches: false })
    },
    localStorage: lStore,
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout() { },
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval() { },
    fetch: () => new Promise(() => { })
  };

  let first = true;
  sandbox.document.createElement = () => {
    if (first) { first = false; return host; }
    return element();
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    host,
    elements,
    lStore,
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i]?.resolve({
        ok: true,
        data: {
          session: {
            groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
            total: { chars: 100, low: 10, high: 50 },
            attachmentTotal: core.empty(),
            attachments: [],
            unknownFiles: 0,
            steps: 10,
            userMessages: 2,
            assistantMessages: 3
          },
          scannedAt: Date.now(),
          latest: null
        }
      });
    }
  };
}

test('v0.9.1 模块二 / A: 吸附列数严格锁死合法档位，绝不出现 5 列 7 列 9 列 11 列', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.finishScan();
    await h.flush();

    const spans = (tier) => Array.from(api.legalCockpitSpansForTest(tier));
    assert.deepStrictEqual(spans('xl'), [4, 6, 8, 12], 'xl 宽屏仅允许 4/6/8/12 列');
    assert.deepStrictEqual(spans('wide'), [6, 12], 'wide 侧栏仅允许 6/12 列');
    assert.deepStrictEqual(spans('medium'), [6, 12], 'medium 侧栏仅允许 6/12 列');
    assert.deepStrictEqual(spans('narrow'), [12], 'narrow 窄栏锁死 12 列仅调高度');

    const legalXl = [4, 6, 8, 12];
    for (let raw = 1; raw <= 12; raw++) {
      const snapped = api.snapCockpitSpanForTest(raw, 'xl');
      assert.ok(legalXl.includes(snapped), `xl 下 ${raw} 列必须吸附到合法档位，实际 ${snapped}`);
    }
    assert.equal(api.snapCockpitSpanForTest(7, 'xl'), 8, '7 列必须吸附为 8 列，等距时优先更大一档');
    assert.equal(api.snapCockpitSpanForTest(5, 'xl'), 6, '5 列到 4 与 6 等距，按优先更大一档吸附为 6 列');
    assert.equal(api.snapCockpitSpanForTest(9, 'xl'), 8, '9 列必须吸附为 8 列');
    assert.equal(api.snapCockpitSpanForTest(11, 'xl'), 12, '11 列必须吸附为 12 列');
    for (let raw = 1; raw <= 12; raw++) {
      assert.ok([6, 12].includes(api.snapCockpitSpanForTest(raw, 'wide')), `wide 下 ${raw} 列必须吸附到 6 或 12`);
      assert.equal(api.snapCockpitSpanForTest(raw, 'narrow'), 12, 'narrow 下任何列数都必须锁死 12 列');
    }
  } finally {
    api.dispose();
  }
});

test('v0.9.1 模块二 / A: 拖拽与缩放背后的虚框/定位槽已彻底删除，零紫色零虚线零占位大字', () => {
  // v0.9.1 实机反馈：中空虚框与定位槽非常廉价，必须整体删除
  assert.equal(STYLES_SOURCE.includes('.ag-widget-resize-snap-ghost'), false, '缩放吸附虚框样式必须彻底删除');
  assert.equal(STYLES_SOURCE.includes('.ctx-widget-resize-slot'), false, '缩放定位槽样式必须彻底删除');
  assert.equal(STYLES_SOURCE.includes('.ctx-widget-placeholder'), false, '拖拽占位槽样式必须彻底删除');
  assert.equal(GRID_SOURCE.includes('resize-snap-ghost'), false, '严禁再创建缩放虚框元素');
  assert.equal(GRID_SOURCE.includes('ctx-widget-resize-slot'), false, '严禁再创建缩放定位槽元素');
  assert.equal(GRID_SOURCE.includes('ctx-widget-placeholder'), false, '严禁再创建拖拽占位槽元素');
  assert.doesNotMatch(GRID_SOURCE, /session\.widget\.dropHere/, '拖拽严never写入占位提示文字');
  assert.doesNotMatch(TPL_SOURCE, /松开以调整卡片位置|松开以移动到此位置/, '严禁出现占位提示大字');

  // 缩放角标任何交互态都必须是纯透明热区
  const neutralStates = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ctx-widget-resize-handle:hover');
  assert.equal(neutralStates, '', '悬停态严禁单独定义色块底框规则');
  assert.match(STYLES_SOURCE, /#pane-ctx-session \.ctx-widget-resize-handle:hover,[\s\S]{0,900}background:\s*transparent;[\s\S]{0,120}border:\s*none;[\s\S]{0,80}box-shadow:\s*none;[\s\S]{0,80}outline:\s*none/,
    '缩放角标所有交互态必须统一为透明、无边框、无阴影、无 outline');
  assert.doesNotMatch(STYLES_SOURCE, /ctx-widget-resize-handle:hover\s*\{\s*background:\s*rgba\(192,\s*132,\s*252/, '严禁残留紫色悬停底框');
});

test('v0.9.1 模块二 / A: 拖动期零尺寸过渡、短促弹簧时长与精细化抓手全部落地', () => {
  // .is-resizing 同时出现在「min-height 保底」组合选择器里，这里必须取真正带绝对定位的那条规则
  const resizingRule = (STYLES_SOURCE.match(/#pane-ctx-session \.ctx-widget-card\.is-resizing\s*\{([^}]*)\}/g) || [])
    .map(block => block.replace(/^[^{]*\{/, '').replace(/\}$/, ''))
    .find(body => /position:\s*absolute/.test(body)) || '';
  assert.match(resizingRule, /transition:\s*none\s*!important/, '拖动期间严禁对 width / height 挂任何过渡');

  // 抓起浮起 150ms / 邻居让位 190ms / 松手回弹 220ms
  assert.match(STYLES_SOURCE, /\.is-squish-pop\s*\{\s*animation:\s*agWidgetSquishPop\s+150ms\s+cubic-bezier\(0\.22,\s*1\.25,\s*0\.36,\s*1\)/,
    '抓起浮起必须为 150ms cubic-bezier(0.22, 1.25, 0.36, 1)');
  assert.match(STYLES_SOURCE, /\.is-settling\s*\{\s*animation:\s*agWidgetJellySettle\s+220ms/,
    '松手落位与缩放吸格回弹必须收紧为 220ms');
  assert.match(STYLES_SOURCE, /0%\s*\{\s*transform:\s*scale\(1\.016,\s*0\.986\)/, '回弹关键帧必须为 scale(1.016, 0.986) 起手');
  assert.match(STYLES_SOURCE, /55%\s*\{\s*transform:\s*scale\(0\.995,\s*1\.005\)/, '回弹关键帧必须过 scale(0.995, 1.005)');
  assert.match(GRID_SOURCE, /duration:\s*190/, '邻居卡 FLIP 让位必须为 190ms');
  assert.match(GRID_SOURCE, /COCKPIT_FLIP_EASING = 'cubic-bezier\(0\.2, 1\.08, 0\.32, 1\)'/,
    '邻居卡 FLIP 缓动必须为 cubic-bezier(0.2, 1.08, 0.32, 1)');

  // 右下角缩放抓手：24×24 热区、零方块、极低噪 0.18 → 0.72
  const handleRule = ruleOf(STYLES_SOURCE, '#pane-ctx-session .ag-widget-resize-handle {');
  assert.match(handleRule, /width:\s*24px/, '缩放抓手热区必须为 24px');
  assert.match(handleRule, /height:\s*24px/);
  assert.match(handleRule, /cursor:\s*nwse-resize/);
  assert.match(handleRule, /opacity:\s*0\.18/, '抓手常态必须极低噪 0.18');
  assert.match(handleRule, /background:\s*transparent/, '抓手严禁画显眼方块或彩色块');
  assert.match(STYLES_SOURCE, /\.ag-widget-resize-handle:hover[\s\S]{0,160}opacity:\s*0\.72/, '悬停时必须亮至 0.72');
  assert.match(STYLES_SOURCE, /\.ag-widget-resize-handle::after[\s\S]{0,320}border-bottom-right-radius/, '抓手视觉必须是极细圆弧角标');
  assert.match(STYLES_SOURCE, /\.ag-widget-resize-handle::after[\s\S]{0,240}border-right:\s*1\.5px\s+solid\s+currentColor/,
    '抓手细线必须为 1.5px 低噪中性斜细线');

  // 触发阈值：手柄 3px 立即跟手、标题栏长按 160ms
  assert.match(GRID_SOURCE, /dist > 3/, '6 点手柄移动超 3px 必须立即浮起');
  assert.match(GRID_SOURCE, /\}, 160\)/, '标题栏长按阈值必须收紧到 160ms');
  assert.doesNotMatch(GRID_SOURCE, /\}, 220\)/, '标题栏长按不得残留 220ms 旧阈值');

  // 边缘自动滚动独立 rAF 循环且可被松手 / 失焦 / Esc 停止
  assert.match(GRID_SOURCE, /const updateResizeScroll = \(frameTime\)/, '缩放必须拥有独立 rAF 自动滚动循环');
  assert.match(GRID_SOURCE, /scroller\.scrollTop = target/, '自动滚动必须真实写入 scrollTop');
  assert.match(GRID_SOURCE, /stopAutoScroll\(\)/, '松手时必须立即停止自动滚动');
  assert.match(GRID_SOURCE, /pointerY < bounds\.top \+ 48/, '必须使用 48px 边缘区判定');
});

test('v0.9.1 模块二 / B: 刷新按钮三态微交互与主进度条单次轻扫全部落地', () => {
  const refreshBtn = TPL_SOURCE.match(/<button id="btn-ctx-session-refresh"[\s\S]*?<\/button>/)?.[0] || '';
  assert.ok(refreshBtn, '必须保留刷新按钮');
  assert.match(refreshBtn, /data-refresh-state="idle"/, '刷新按钮必须维护 data-refresh-state 初始 idle');
  assert.match(refreshBtn, /class="ctx-refresh-svg"[^>]*width="13"[^>]*height="13"/, '必须补 13px 细线刷新图标');
  assert.match(refreshBtn, /class="ctx-refresh-check"[^>]*width="13"[^>]*height="13"/, '必须补 13px 完成态勾号图标');
  assert.match(refreshBtn, /stroke-width="1\.5"/, '刷新图标必须是细线风格');
  assert.match(refreshBtn, /data-i18n="session\.ov\.refresh"/, '必须保留原按钮文本兼容');

  const btnRule = ruleOf(STYLES_SOURCE, '.ctx-action-pill.ctx-refresh-btn');
  assert.match(btnRule, /min-width:\s*60px/, '刷新按钮必须有固定 min-width 防抖动');
  assert.match(STYLES_SOURCE, /\.ctx-refresh-btn:active\s*\{\s*transform:\s*scale\(0\.95\)/, '必须有 active 缩放反馈');
  assert.match(STYLES_SOURCE, /\.ctx-refresh-btn:hover/, '必须有清晰 hover 反馈');
  assert.match(STYLES_SOURCE, /agRefreshSpin\s*\{\s*from\s*\{\s*transform:\s*rotate\(0deg\)[\s\S]{0,80}to\s*\{\s*transform:\s*rotate\(360deg\)/,
    '加载中图标必须顺滑旋转');
  assert.match(STYLES_SOURCE, /data-refresh-state="loading"\]\s*\.ctx-refresh-svg\s*\{\s*animation:\s*agRefreshSpin\s+600ms\s+linear\s+infinite/,
    '加载中旋转必须为 600ms linear infinite');
  assert.match(STYLES_SOURCE, /data-refresh-state="done"\]\s*\{[\s\S]{0,200}color:\s*#22E09B/, '完成态深色必须为薄荷绿 #22E09B');
  assert.match(STYLES_SOURCE, /data-panel-tone="light"\]\)[\s\S]{0,160}data-refresh-state="done"\][\s\S]{0,160}color:\s*#059669/,
    '完成态浅色必须为 #059669');
  assert.match(STYLES_SOURCE, /data-refresh-state="error"\]/, '必须有失败态');

  // 主进度条单次轻扫：只动 transform 与 opacity，且 420ms
  const shimmerRule = ruleOf(STYLES_SOURCE, '.ctx-main-track[data-refresh-shimmer="on"]::after {');
  assert.ok(shimmerRule, '必须定义主进度条轻扫伪元素');
  assert.match(shimmerRule, /animation:\s*agRefreshTrackShimmer\s+420ms/, '轻扫必须为 420ms');
  assert.match(shimmerRule, /transform:\s*translate3d/, '轻扫只允许动 transform');
  assert.match(shimmerRule, /opacity:\s*0/, '轻扫只允许动 opacity');
  assert.doesNotMatch(shimmerRule, /\b(width|height|left|top|margin|padding)\s*:/, '轻扫严禁触碰布局属性');

  // reduced-motion 降级
  assert.match(STYLES_SOURCE, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ctx-refresh-btn\[data-refresh-state="loading"\] \.ctx-refresh-svg\s*\{\s*animation:\s*none/,
    'reduced-motion 下必须禁用旋转');
  assert.match(STYLES_SOURCE, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?data-refresh-shimmer="on"\]::after\s*\{\s*animation:\s*none/,
    'reduced-motion 下必须禁用扫光');

  // 状态机常量与防重复点击
  assert.match(source, /REFRESH_MIN_SPIN_MS = 420/, '最小旋转时长必须为 420ms');
  assert.match(source, /REFRESH_TERMINAL_HOLD_MS = 800/, '完成态与失败态必须持续 800ms');
  assert.match(source, /if \(refreshFeedbackInFlight\) return false;/, '加载中必须防重复点击');
  assert.match(source, /triggerOverviewTrackShimmer\(\)/, '成功进入 done 必须触发主进度条轻扫');
  assert.doesNotMatch(source, /scheduleRefreshTerminal\('done'\);\s*\n\s*triggerOverviewTrackShimmer\(\);\s*\n\s*\}\s*else \{[\s\S]{0,80}triggerOverviewTrackShimmer/,
    '失败态绝不触发扫光');
});

test('v0.9.1 模块二 / C: 原始 i18n 键泄漏修复，session.ov.cacheHitLabel 与 costLabel 三语齐全', () => {
  const bracketRegex = /[（）\(\)]/;
  for (const key of ['session.ov.cacheHitLabel', 'session.ov.costLabel']) {
    const line = I18N_SOURCE.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]*\\}`))?.[0] || '';
    assert.ok(line, `必须补齐三语词条: ${key}`);
    for (const langTag of ["'zh-CN'", "'zh-TW'", 'en']) {
      assert.ok(line.includes(langTag), `${key} 缺少 ${langTag} 语种`);
    }
    assert.doesNotMatch(line, bracketRegex, `${key} 三语词条严禁含中英文括号`);
  }

  // 所有渲染层引用的 i18n 键必须真实存在，杜绝再次泄漏原始键名
  const dir = path.join(__dirname, 'src', 'renderer');
  const defined = new Set();
  for (const m of I18N_SOURCE.matchAll(/'([A-Za-z0-9_.]+)':\s*\{\s*'zh-CN'/g)) defined.add(m[1]);
  const namespace = /^(session|settings|composer|radial|tokens|speed|quota|enhance|models|reqLog|heat|status|key|turnFooter|header|msg|overlay|cli|update|unlock|audit|trace|trend|insight|collab)\b/;
  const missing = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'i18n.js')) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g)) {
      const key = m[1];
      if (!namespace.test(key)) continue;
      if (!defined.has(key)) missing.push(`${key} <- ${file}`);
    }
  }
  // models.dev 是数据源品牌名而非 i18n 键，白名单放行
  const realMissing = missing.filter(item => !item.startsWith('models.dev '));
  assert.deepStrictEqual(realMissing, [], `渲染层引用了不存在的 i18n 键: ${realMissing.join(' | ')}`);
});
