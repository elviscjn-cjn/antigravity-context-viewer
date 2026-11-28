'use strict';

/**
 * 第 03 批「预设、辅助栏与会话交互 · 5 个小任务」综合回归测试
 * 严格隔离测试模式，严禁触碰主力用户目录与注册表。
 */
process.env.AG_METER_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const { runEvaluation, EVAL_CASES } = require('./scripts/eval-next-prompt');

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
const GRID_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'dashboard-grid.js'), 'utf8');
const HOST_SETTINGS_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'host-settings.js'), 'utf8');
const SETTINGS_UI_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'context-settings-ui.js'), 'utf8');
const NEXT_PROMPT_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'next-prompt.js'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'i18n.js'), 'utf8');
const TEMPLATE_SOURCE = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');

function createBatch03Harness(opts = {}) {
  const elements = new Map();
  const docElements = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const savedSettings = [];

  function makeEl(tag = 'div') {
    const attrs = new Map();
    const listeners = new Map();
    const props = new Map();
    let _innerHTML = '';
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      children: [],
      parentElement: null,
      hidden: false,
      disabled: false,
      checked: false,
      value: tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : undefined,
      textContent: '',
      title: '',
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 200,
      clientWidth: 800,
      offsetWidth: 800,
      offsetHeight: 200,
      isConnected: true,
      style: {
        display: '', opacity: '', visibility: '', position: '', top: '', left: '', right: '', bottom: '',
        width: '', height: '', minWidth: '', maxWidth: '', minHeight: '', maxHeight: '',
        gridColumn: '', justifySelf: '', transform: '', cursor: '', overflowY: '', flexDirection: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      get innerHTML() { return _innerHTML; },
      set innerHTML(v) { _innerHTML = String(v || ''); },
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        attrs.set('id', String(v || ''));
        if (v) docElements.set(String(v), el);
      },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(...cs) {
          const list = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          for (const c of cs) if (c && !list.includes(c)) list.push(c);
          attrs.set('class', list.join(' '));
        },
        remove(...cs) {
          const list = (attrs.get('class') || '').split(/\s+/).filter(x => x && !cs.includes(x));
          attrs.set('class', list.join(' '));
        },
        toggle(c, on) {
          const cur = this.contains(c);
          const next = on === undefined ? !cur : Boolean(on);
          if (next) this.add(c); else this.remove(c);
          return next;
        },
        contains(c) { return (attrs.get('class') || '').split(/\s+/).includes(c); }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        if (!child) return child;
        if (child.parentElement && child.parentElement !== el) {
          child.parentElement.children = child.parentElement.children.filter(c => c !== child);
        }
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (!child) return child;
        child.parentElement = el;
        const idx = el.children.indexOf(ref);
        if (idx >= 0) el.children.splice(idx, 0, child);
        else el.children.push(child);
        return child;
      },
      replaceChildren(...items) {
        el.children = [];
        for (const item of items) el.appendChild(item);
      },
      get firstChild() { return el.children[0] || null; },
      get firstElementChild() { return el.children[0] || null; },
      get lastElementChild() { return el.children[el.children.length - 1] || null; },
      get nextElementSibling() {
        const p = el.parentElement;
        if (!p || !Array.isArray(p.children)) return null;
        const idx = p.children.indexOf(el);
        return idx >= 0 ? (p.children[idx + 1] || null) : null;
      },
      get previousElementSibling() {
        const p = el.parentElement;
        if (!p || !Array.isArray(p.children)) return null;
        const idx = p.children.indexOf(el);
        return idx > 0 ? (p.children[idx - 1] || null) : null;
      },
      after(...nodes) {
        const p = el.parentElement;
        if (!p || !Array.isArray(p.children)) return;
        for (const node of nodes) {
          if (!node) continue;
          if (node.parentElement) {
            node.parentElement.children = node.parentElement.children.filter(c => c !== node);
          }
          const idx = p.children.indexOf(el);
          node.parentElement = p;
          if (idx >= 0) p.children.splice(idx + 1, 0, node);
          else p.children.push(node);
        }
      },
      prepend(child) {
        if (!child) return child;
        child.parentElement = el;
        el.children.unshift(child);
        return child;
      },
      remove() {
        if (el.parentElement) {
          el.parentElement.children = el.parentElement.children.filter(c => c !== el);
          el.parentElement = null;
        }
      },
      cloneNode() {
        const cl = makeEl(tag);
        cl.textContent = el.textContent;
        return cl;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(ev) {
        for (const fn of (listeners.get(ev.type) || [])) fn(ev);
        return true;
      },
      click() { el.dispatchEvent({ type: 'click', target: el, preventDefault() {}, stopPropagation() {} }); },
      focus() {},
      closest(sel) {
        let cur = el;
        while (cur) {
          if (sel.includes('.surface-composer') && cur.classList?.contains?.('surface-composer')) return cur;
          if (sel.includes('[role="dialog"]') && cur.getAttribute?.('role') === 'dialog') return cur;
          if (sel.includes('[data-turn-index]') && cur.hasAttribute?.('data-turn-index')) return cur;
          if (sel.includes('[data-side-panel-open="true"]') && cur.getAttribute?.('data-side-panel-open') === 'true') return cur;
          if (sel.includes('form') && cur.tagName === 'FORM') return cur;
          if (sel.includes('article') && cur.tagName === 'ARTICLE') return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const ch of (node.children || [])) {
            let matched = false;
            const hasCls = (c) => Boolean(ch.classList?.contains?.(c) || String(ch.className || '').split(/\s+/).includes(c));
            if (sel.includes('.surface-composer') && hasCls('surface-composer')) matched = true;
            if (sel.includes('[data-lexical-editor="true"]') && ch.getAttribute?.('data-lexical-editor') === 'true') matched = true;
            if (sel.includes('[contenteditable="true"]') && ch.getAttribute?.('contenteditable') === 'true') matched = true;
            if (/\btextarea\b/i.test(sel) && ch.tagName === 'TEXTAREA') matched = true;
            if (/\bwebview\b/i.test(sel) && ch.tagName === 'WEBVIEW') matched = true;
            if (/\biframe\b/i.test(sel) && ch.tagName === 'IFRAME') matched = true;
            if (sel.includes('[role="dialog"]') && ch.getAttribute?.('role') === 'dialog') matched = true;
            if (sel.includes('.ag-np-inline-ghost') && hasCls('ag-np-inline-ghost')) matched = true;
            if (sel.includes('[data-widget-id]') && ch.hasAttribute?.('data-widget-id')) matched = true;
            if (sel.includes('[data-cockpit-preset]') && ch.hasAttribute?.('data-cockpit-preset')) matched = true;
            if (sel.includes('.ag-cm-turn-footer') && hasCls('ag-cm-turn-footer')) matched = true;
            if (sel.includes('.ag-cm-compact-footer-detail') && hasCls('ag-cm-compact-footer-detail')) matched = true;
            if (sel.includes('[data-slash-command="compact"]') && ch.getAttribute?.('data-slash-command') === 'compact') matched = true;
            if (sel.includes('cascade-system-message-toolbar') && ch.getAttribute?.('data-testid') === 'cascade-system-message-toolbar') matched = true;
            if (sel.includes('[data-ag-np-hidden-placeholder="true"]') && ch.getAttribute?.('data-ag-np-hidden-placeholder') === 'true') matched = true;
            const roleM = sel.match(/\[data-csb-role="([^"]+)"\]/);
            if (roleM && ch.getAttribute?.('data-csb-role') === roleM[1]) matched = true;
            const grpM = sel.match(/\[data-csb-group="([^"]+)"\]/);
            if (grpM && ch.getAttribute?.('data-csb-group') === grpM[1]) matched = true;
            if (/^div,\s*span,\s*p$/i.test(sel.trim()) && ['DIV', 'SPAN', 'P'].includes(ch.tagName)) matched = true;
            if (matched) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      getBoundingClientRect() {
        return el._rect || { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, right: el.clientWidth, bottom: el.clientHeight };
      }
    };
    return el;
  }

  const head = makeEl('head');
  const body = makeEl('body');
  const html = makeEl('html');
  html.appendChild(head);
  html.appendChild(body);

  let hostNode = null;
  let shadowRoot = null;
  let first = true;
  const storageMap = new Map();

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: opts.pathname || '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', search: opts.search || '' },
    localStorage: {
      getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: k => storageMap.delete(k),
      clear: () => storageMap.clear()
    },
    document: {
      head, body, documentElement: html, hidden: false,
      activeElement: body,
      createElement(tag) {
        if (first) {
          first = false;
          hostNode = makeEl('div');
          hostNode.attachShadow = () => {
            shadowRoot = {
              host: hostNode,
              children: [],
              innerHTML: '',
              appendChild(c) { shadowRoot.children.push(c); return c; },
              getElementById(id) {
                if (!elements.has(id)) {
                  const n = makeEl('div');
                  n.id = id;
                  elements.set(id, n);
                }
                return elements.get(id);
              },
              querySelectorAll() { return []; },
              querySelector() { return null; },
              addEventListener() {},
              removeEventListener() {}
            };
            return shadowRoot;
          };
          return hostNode;
        }
        return makeEl(tag);
      },
      getElementById: id => docElements.get(id) || null,
      querySelector: sel => body.querySelector(sel),
      querySelectorAll: sel => body.querySelectorAll(sel),
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
      dispatchEvent(ev) {
        for (const fn of (docListeners.get(ev.type) || [])) fn(ev);
        return true;
      }
    },
    window: {
      innerWidth: opts.innerWidth || 1440,
      innerHeight: opts.innerHeight || 900,
      __APP_CONFIG__: { csrfToken: 'batch03-test-token' },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      getComputedStyle: (node) => ({
        display: node?.style?.display || 'block',
        flexDirection: node?.style?.flexDirection || 'column',
        overflowY: node?.style?.overflowY || 'auto',
        fontFamily: 'Inter, sans-serif',
        fontSize: '14px',
        lineHeight: '20px',
        paddingTop: '8px',
        paddingLeft: '12px',
        paddingRight: '12px',
        width: `${node?.clientWidth || 800}px`,
        columnGap: '10px'
      }),
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        saveSettings: async (payload) => {
          savedSettings.push(payload);
          return { ok: true };
        },
        ...(opts.apiOverrides || {})
      }
    },
    __AGContextMeterCore: core,
    AbortController,
    Date,
    setTimeout: opts.useRealTimers
      ? ((fn, ms = 0) => {
        if (Number(ms) <= 80) {
          const t = setTimeout(fn, 1);
          t.unref?.();
          return t;
        }
        return 1;
      })
      : (() => 1),
    clearTimeout: opts.useRealTimers ? clearTimeout : (() => {}),
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    fetch: () => new Promise(() => {})
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE, sandbox);

  return {
    sandbox,
    api: sandbox.__AGContextMeter,
    elements,
    body,
    host: hostNode,
    makeEl,
    savedSettings,
    dispose() {
      try { sandbox.__AGContextMeter?.dispose?.(); } catch { }
    }
  };
}

// =========================================================================
// 任务 1：统一中键按住滚动、预设长按拖动与全插件过渡
// =========================================================================

test('Batch03 任务 1: 共享中键按住滚动、预设长按拖动与平滑面板过渡契约齐全', () => {
  // 1.1 中键按住滚动核心机制：Shadow DOM composedPath、死区、速率上限、交互控件放行、边界不外溢与完整清理
  assert.match(MAIN_SOURCE, /MIDDLE_SCROLL_DEADZONE_PX\s*=\s*8/, '中键按住滚动必须有舒适死区');
  assert.match(MAIN_SOURCE, /MIDDLE_SCROLL_MAX_SPEED_PX_PER_FRAME\s*=\s*26/, '中键按住滚动必须有平稳速率上限');
  assert.match(MAIN_SOURCE, /findInnermostPluginScrollContainer/, '必须沿 composedPath 查找最内层插件自有纵向滚动容器');
  assert.match(MAIN_SOURCE, /isInteractiveMiddleClickTarget/, '必须保护链接、输入框与按钮，不劫持链接中键开新页');
  assert.match(MAIN_SOURCE, /stopPluginMiddleScroll/, '必须实现松开/Esc/失焦/卸载清理函数');
  assert.match(MAIN_SOURCE, /ev\.button !== 1/, '仅在按下鼠标中键时接管');
  assert.match(MAIN_SOURCE, /ev\?\.key === 'Escape'/, 'Esc 必须立即停止中键滚动');
  assert.match(MAIN_SOURCE, /addEventListener\?\.\('blur',\s*stopPluginMiddleScroll\)/, '窗口失焦必须立即停止中键滚动');

  // 1.2 预设长按拖动：140ms / 5px / 11px 死区 / 140ms 冷却 / 250ms FLIP / 3.5° 倾角 / 浮层与原位占位 / 2D 冻结原坑位直接互换
  assert.match(GRID_SOURCE, /PRESET_LONG_PRESS_MS\s*=\s*140/, '预设长按触发阈值必须为 140ms');
  assert.match(GRID_SOURCE, /PRESET_DRAG_THRESHOLD_PX\s*=\s*5/, '预设拖动激活位移必须为 5px');
  assert.match(GRID_SOURCE, /PRESET_DEADZONE_PX\s*=\s*11/, '预设换位死区必须为 11px');
  assert.match(GRID_SOURCE, /PRESET_COOLDOWN_MS\s*=\s*140/, '预设换位冷却必须为 140ms');
  assert.match(GRID_SOURCE, /PRESET_FLIP_MS\s*=\s*250/, '预设邻居 FLIP 时长必须为 250ms');
  assert.match(GRID_SOURCE, /PRESET_MAX_TILT_DEG\s*=\s*0\b/, '06 规范：预设浮层必须零倾角不变形');
  assert.match(GRID_SOURCE, /PRESET_LOWPASS_KEEP\s*=\s*0\.72/, '预设浮层速度低通权重必须为 0.72');
  assert.match(GRID_SOURCE, /PRESET_LOWPASS_NEW\s*=\s*0\.28/, '预设浮层当前帧权重必须为 0.28');
  assert.match(GRID_SOURCE, /PRESET_MAX_STRETCH\s*=\s*0\b/, '06 规范：预设浮层必须零拉伸不变形');
  assert.match(GRID_SOURCE, /PRESET_POINTER_WEIGHT\s*=\s*0\.65/, '预设 2D 命中指针权重必须为 0.65');
  assert.match(GRID_SOURCE, /PRESET_GHOST_CENTER_WEIGHT\s*=\s*0\.35/, '预设 2D 命中卡片中心权重必须为 0.35');
  assert.match(GRID_SOURCE, /ag-preset-drag-ghost/, '预设拖动必须挂载独立浮层');
  assert.match(GRID_SOURCE, /is-drag-placeholder/, '原位置必须留柔和占位而非整行塌陷');
  assert.match(GRID_SOURCE, /hitTestFrozenHomeSlots/, '必须使用冻结原坑位 2D 命中算法');
  assert.match(GRID_SOURCE, /applyDirectSwapOrder/, '必须使用点对点直接互换而不顺移中间项');
  assert.match(GRID_SOURCE, /if \(presetDragInProgress\) return;/, '拖动期间外部渲染不得覆写预设轨道');

  // 1.3 全插件过渡恢复与统一节奏 token
  assert.match(STYLES_SOURCE, /--ag-motion-chip:\s*120ms/, '必须定义 120ms 快反馈 token');
  assert.match(STYLES_SOURCE, /--ag-motion-popover:\s*150ms/, '必须定义 150ms 基础过渡 token');
  assert.match(STYLES_SOURCE, /--ag-motion-panel-in:\s*220ms/, '必须定义 220ms 面板进场 token');
  assert.match(STYLES_SOURCE, /--ag-motion-panel-out:\s*180ms/, '必须定义 180ms 面板退场 token');
  assert.match(STYLES_SOURCE, /--ag-motion-tab:\s*160ms/, '必须定义 160ms 标签切换 token');
  assert.match(MAIN_SOURCE, /function setPanelVisibleSmooth\(/, 'showPanel 必须经过可打断平滑进出场控制器');
  assert.match(STYLES_SOURCE, /@media \(prefers-reduced-motion: reduce\)/, '必须完整支持 prefers-reduced-motion 降级');
});

// =========================================================================
// 任务 2：启动与归档冲突、辅助栏默认与三栏共存、滚动锚点、零闪切与 PR #121
// =========================================================================

test('Batch03 任务 2: 归档弹窗严禁被误判为宿主设置页、三栏共存与 PR #121 挂载校验', () => {
  // 2.1 归档通知 / 确认 dialog 绝不能被误判为宿主 Settings
  assert.match(HOST_SETTINGS_SOURCE, /function isLikelyRealHostSettingsModal\(/, '必须具备严格宿主设置弹窗判别函数');
  assert.match(HOST_SETTINGS_SOURCE, /dismiss\|undo\|archive/i, '必须识别并排除归档/撤销/确认提示框');

  // 2.2 辅助栏三栏共存与滚动锚点保护
  assert.match(MAIN_SOURCE, /AUX_TRIPANE_MIN_WIDTH\s*=\s*660/, '三栏共存最小宽度阈值必须明确定义');
  assert.match(MAIN_SOURCE, /data-ag-aux-tripane/, '必须写入三栏共存标记属性');
  assert.match(MAIN_SOURCE, /function markAuxUserScrolling\(/, '必须记录用户主动滚动时间保护辅助栏滚动锚点');
  assert.match(MAIN_SOURCE, /auxUserScrollingUntil/, '用户主动滚动期内禁止旧 scrollTop 盖写当前位置');

  // 2.3 停稳后零闪切：滞回 + 单次写入 + 阻断 ResizeObserver 反馈环
  assert.match(GRID_SOURCE, /COCKPIT_CARD_SIZE_HYSTERESIS_PX\s*=\s*10/, '必须设置 ±10px 卡片尺寸滞回防边界抖动');
  assert.match(GRID_SOURCE, /function resolveCardSizeTierWithHysteresis\(/, '必须按滞回区间决定 compact/regular/wide');
  assert.match(GRID_SOURCE, /grid\.__agLayoutApplying\s*=\s*true/, '排版期间必须立起写锁阻断 ResizeObserver 反馈循环');
  assert.match(GRID_SOURCE, /if \(grid\.__agLayoutApplying\) return;/, 'ResizeObserver 回调在写锁期间必须跳过');

  // 2.4 PR #121：ensureComposerStatusBarMounted 严禁爬升到横排 flex / 多列 grid / 聊天流
  assert.match(MAIN_SOURCE, /function isValidComposerMountHost\(/, 'PR #121 必须校验挂载宿主容器合法性');
  assert.match(MAIN_SOURCE, /fDir === 'row'/, 'PR #121 必须拒绝挂载到横排 flex 行容器');
  assert.match(MAIN_SOURCE, /disp === 'grid' \|\| disp === 'inline-grid'/, 'PR #121 必须拒绝挂载到多列 grid 容器');
});

// =========================================================================
// 任务 3：实时请求归属、Issue #114 速度口径与 Issue #117 字号对比度
// =========================================================================

test('Batch03 任务 3: Gemini 4 Neon 归属不被末尾空子调用挤掉、Issue #114 速度口径与 Issue #117 设置', () => {
  // 3.1 本轮汇总模型归属函数存在且处理单调用/多调用/末尾空子调用/全缺证据
  assert.match(MAIN_SOURCE, /const resolveTurnFooterModelInfo = \(\) =>/, '必须实现独立本轮汇总模型归属函数');
  assert.match(MAIN_SOURCE, /未返回可靠模型标识/, '全部子调用缺模型时必须记录明确原因而非盲猜');

  // 3.2 Issue #114 速度口径精确数值验证（123575 / 1377.42s = 89.7 tok/s，123575 / 3031.97s = 40.8 tok/s）
  const outTokens = 123575;
  const streamSec = 1377.42;
  const wallSec = 3031.97;
  assert.equal((outTokens / streamSec).toFixed(1), '89.7', '流式输出速度口径必须严格匹配 89.7 tok/s');
  assert.equal((outTokens / wallSec).toFixed(1), '40.8', '端到端综合速度口径必须严格匹配 40.8 tok/s');
  assert.match(MAIN_SOURCE, /speedDisplayMode/, '必须实现 speedDisplayMode 统一偏好');
  assert.match(MAIN_SOURCE, /wantE2e = speedDisplayMode === 'e2e'/, '顶栏与详情口径必须随 speedDisplayMode 同步切换');
  assert.match(SETTINGS_UI_SOURCE, /speedDisplayMode/, '宿主设置页必须暴露速度显示口径选择器');

  // 3.3 Issue #117 底栏与尾标字号档和对比度档
  assert.match(SETTINGS_UI_SOURCE, /barFontScale/, '宿主设置页必须暴露底栏与尾标字号档');
  assert.match(SETTINGS_UI_SOURCE, /footerContrast/, '宿主设置页必须暴露底栏与尾标对比度档');
  assert.match(MAIN_SOURCE, /data-ag-bar-font-scale/, '必须把字号档同步至底栏与尾标 DOM 属性');
  assert.match(MAIN_SOURCE, /data-ag-footer-contrast/, '必须把对比度档同步至底栏与尾标 DOM 属性');
});

// =========================================================================
// 任务 4：输入框内浅色内联预测、Tab 一次填入与 18 条评估复验
// =========================================================================

test('Batch03 任务 4: 输入框内浅色内联预览、连续两轮不坏子节点、保护原生联想与 18 条评估通过', async () => {
  // 4.1 已彻底移除底部虚线建议条与 Tab/Esc 按钮组，改为编辑器内浅色内联预览
  assert.equal(NEXT_PROMPT_SOURCE.includes('ag-np-tab-btn'), false, '必须移除旧底部 Tab 按钮');
  assert.equal(NEXT_PROMPT_SOURCE.includes('ag-np-esc-btn'), false, '必须移除旧底部 Esc 按钮');
  assert.match(NEXT_PROMPT_SOURCE, /ag-np-inline-ghost/, '必须使用输入框内浅色内联预览层');
  assert.match(NEXT_PROMPT_SOURCE, /state\.sessionTimeline\?\.turns/, '必须从真实的 state.sessionTimeline.turns 抽取上下文');
  assert.match(NEXT_PROMPT_SOURCE, /function isHostNativeCompletionOpen\(/, '必须检测并避让宿主原生联想菜单');
  assert.match(NEXT_PROMPT_SOURCE, /function placeCaretAtEnd\(/, 'Tab 填入后必须把光标移至末尾');

  // 4.2 验证连续两轮显示 -> Esc 隐藏 -> 第二轮仍正常显示（修掉 textContent='' 毁子节点 bug）
  let pendingResolve = null;
  const h = createBatch03Harness({
    apiOverrides: {
      predictNextPrompt: () => new Promise(r => { pendingResolve = r; })
    }
  });
  try {
    const conv = h.makeEl('div');
    conv.setAttribute('data-cascade-id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const comp = h.makeEl('div');
    comp.classList.add('surface-composer');
    const editor = h.makeEl('div');
    editor.setAttribute('data-lexical-editor', 'true');
    editor.setAttribute('contenteditable', 'true');
    comp.appendChild(editor);
    conv.appendChild(comp);
    h.body.appendChild(conv);
    h.sandbox.document.activeElement = editor;
    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('stop-button') || sel.includes('approval') || sel.includes('alertdialog')) return null;
      if (sel.includes('.surface-composer')) return comp;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => (sel.includes('.surface-composer') ? [comp] : []);

    h.api.setNextPromptEnabledForTest(true);
    const p1 = h.api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: comp,
      turnKey: 'round-1',
      turns: [{ role: 'user', text: '测试第一轮' }, { role: 'assistant', text: '第一轮完成' }]
    });
    assert.equal(typeof pendingResolve, 'function', '第一轮必须真实触发预测调用');
    pendingResolve({ ok: true, suggestion: '继续核对第二项测试结果', model: 'gemini-3-flash' });
    await p1;
    assert.equal(h.api.getNextPromptStateForTest().ghostHidden, false, '第一轮预测结果必须内联显示');

    // Esc 消除
    h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape', target: editor, preventDefault() {} });
    assert.equal(h.api.getNextPromptStateForTest().ghostHidden, true, 'Esc 必须立即隐藏内联预测');

    // 第二轮仍能正常显示并单按 Tab 一次填入同一真编辑器
    pendingResolve = null;
    const p2 = h.api.maybeRequestNextPromptForTest({
      routeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      composer: comp,
      turnKey: 'round-2',
      turns: [{ role: 'user', text: '测试第二轮' }, { role: 'assistant', text: '第二轮完成' }]
    });
    assert.equal(typeof pendingResolve, 'function', '第二轮必须真实触发预测调用');
    pendingResolve({ ok: true, suggestion: '跑完回归后输出最终报告', model: 'gemini-3-flash' });
    await p2;
    assert.equal(h.api.getNextPromptStateForTest().ghostHidden, false, '第二轮复用容器后必须正常显示');

    // Shift+Tab 不误触发
    h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true, target: editor, preventDefault() {} });
    assert.equal(editor.textContent, '', 'Shift+Tab 绝不能误填入预测');

    // 单按 Tab 一次填入并读回确认，绝不自动发送
    h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false, target: editor, preventDefault() {} });
    assert.equal(editor.textContent, '跑完回归后输出最终报告', '单按 Tab 必须真实填入当前编辑器');
    assert.equal(h.api.getNextPromptStateForTest().ghostHidden, true, 'Tab 填入后内联预览必须立即收起');
  } finally {
    h.dispose();
  }

  // 4.3 重跑 18 条脱敏中英文评估案例
  assert.equal(EVAL_CASES.length, 18, '评估集必须包含 18 条中英文案例');
  const evalReport = await runEvaluation({ live: false });
  assert.equal(evalReport.groups.enhanced.samples, 18);
  assert.equal(evalReport.groups.enhanced.intentHits, 18, '增强组 18/18 必须全部命中');
  assert.equal(evalReport.groups.enhanced.falsePositiveOnAbstain, 0, '应留空样例误弹率必须为 0');
});

// =========================================================================
// 任务 5：压缩停用与实时进度、上下文实报双轨、宽屏流体字号与四张卡同一行
// =========================================================================

test('Batch03 任务 5: 压缩停用原子阻断、独立「压缩进度」页、上下文实报双轨与四张卡同行', () => {
  // 5.1 压缩停用原子撤回 + 派发代次校验 + 宿主设置操作行实时反馈
  assert.match(MAIN_SOURCE, /function revokeLocalAutoCompactDispatch\(/, '必须提供原子停用与派发代次递增函数');
  assert.match(MAIN_SOURCE, /compactDispatchEpoch\s*\+=\s*1/, '每次停用必须递增派发代次阻断在途异步步骤');
  assert.match(MAIN_SOURCE, /const canStillAutoDispatch = \(\) => !auto \|\| \(autoCompactEnabled && compactDispatchEpoch === dispatchEpochAtStart\)/, '每个 await 后必须复验开关与派发代次');
  assert.match(SETTINGS_UI_SOURCE, /ag-ns-rehydrate-feedback/, '操作行必须包含 aria-live 实时反馈区');
  assert.match(SETTINGS_UI_SOURCE, /ag-ns-sw-autoCompactEnabled/, '必须明确展示独立的「自动发送压缩命令」开关');
  assert.match(SETTINGS_UI_SOURCE, /ag-ns-inp-autoCompactThreshold/, '必须提供可编辑的自动压缩触发阈值');

  // 5.2 宿主 Settings 左栏同级独立入口「压缩进度」与共用状态机
  assert.match(HOST_SETTINGS_SOURCE, /NAV_COMPACT_ID\s*=\s*'ag-cm-host-settings-compact-nav'/, '左栏必须新增独立压缩进度入口');
  assert.match(HOST_SETTINGS_SOURCE, /PAGE_COMPACT_ID\s*=\s*'ag-cm-host-compact-progress-page'/, '右侧必须新增独立压缩进度页面');
  assert.match(SETTINGS_UI_SOURCE, /function buildCompactionProgressPageHtml\(/, '必须实现独立压缩进度页渲染');
  assert.match(MAIN_SOURCE, /function updateCompactionProgress\(/, '必须提供统一压缩进度状态机更新入口');
  assert.match(MAIN_SOURCE, /function buildCompactionProgressSnapshot\(/, '必须向进度页导出统一快照');

  // 5.3 上下文实报双轨防跨口径：主轨绑定实报窗口比例，估算 3.38M 时副轨不出现 1144.1%
  const breakdown = core.buildSessionCompositionBreakdown(
    {
      groups: {
        user: { low: 25000, high: 35000 },
        assistant: { low: 15000, high: 25000 },
        tools: { low: 3300000, high: 3320000 }
      }
    },
    { actual: 289100, budget: 512000 },
    { budgetTokens: 512000 }
  );
  assert.equal(breakdown.actualTokens, 289100, '实报上下文必须保持 289100');
  assert.equal(breakdown.estimateExceedsActual, true, '估算总量超过实报总量时必须显式标记 estimateExceedsActual');
  assert.equal(breakdown.pctDenomSource, 'estimate', '估算超过实报时副轨百分比必须按估算总量归一');
  for (const cat of (breakdown.items || [])) {
    assert.ok(cat.pctOfUsed <= 100.01, `分类 ${cat.key} 占已用比例不得突破 100%，实际 ${cat.pctOfUsed}%`);
  }
  assert.match(MAIN_SOURCE, /const mainUsedPct = hasReportedRatio/, '主轨填充宽度必须严格锚定实报窗口比例');

  // 5.4 宽屏流体字号与四张卡同一行 + 同行底边对齐
  assert.match(STYLES_SOURCE, /container-type:\s*inline-size/, '宽屏流体字号必须基于容器查询 @container');
  assert.match(STYLES_SOURCE, /clamp\(/, '关键指标与数字必须使用 clamp() 流体缩放');

  const h = createBatch03Harness();
  try {
    // 1000px 宽容器下，4 张 3 列宽卡（overview-kpi / trend-pulse / timing-speed / context-inspector）必须落在同一行（y===0）且同行底边对齐
    const w4 = h.api.resolveSkylineCardWidthForTest({ span: 3 }, 1000, 10);
    assert.ok(w4 >= 176 && w4 <= 245, `1000px 下 3 列卡宽应落在 [176, 245]，实际 ${w4}`);
    const placed4 = h.api.packSkylineBoxesForTest([
      { w: w4, h: 210 },
      { w: w4, h: 245 },
      { w: w4, h: 190 },
      { w: w4, h: 230 },
      { w: 495, h: 200 }
    ], 1000, 10);
    // 前四张卡全部在 y === 0，且统一行底高度 rowHeight === 245
    for (let i = 0; i < 4; i++) {
      assert.equal(placed4[i].y, 0, `第 ${i + 1} 张卡必须落在首行 y=0，实际 y=${placed4[i].y}`);
      assert.equal(placed4[i].rowHeight, 245, `同行第 ${i + 1} 张卡行底必须对齐至最大行高 245，实际 ${placed4[i].rowHeight}`);
    }
    // 第五张卡必须从 245 + 10 = 255 开始，绝不钻进短卡下方空洞
    assert.equal(placed4[4].y, 255, `下一行起点必须对齐上一行最大底边 + gap = 255，实际 ${placed4[4].y}`);
    assert.equal(placed4[3].x + placed4[3].w, 1000, '四张卡同行右缘必须贴齐容器右缘 1000px');
  } finally {
    h.dispose();
  }
});

// =========================================================================
// 三语文案质量红线：第 03 批所有新增可见文案严格零中英文括号
// =========================================================================

test('Batch03 文案合规: 本批新增全部简中、繁中、英文词条严格零中英文括号', () => {
  const newKeys = [
    'quota.unknownModel',
    'ns.hostGuard.statusDrift',
    'compactProgress.title',
    'compactProgress.subtitle',
    'compactProgress.btnOpen',
    'compactProgress.btnBackSettings',
    'compactProgress.btnManual',
    'compactProgress.sec.live',
    'compactProgress.sec.context',
    'compactProgress.sec.events',
    'compactProgress.lbl.session',
    'compactProgress.lbl.source',
    'compactProgress.lbl.elapsed',
    'compactProgress.lbl.autoState',
    'compactProgress.lbl.before',
    'compactProgress.lbl.after',
    'compactProgress.lbl.checkpoint',
    'compactProgress.lbl.rehydrate',
    'compactProgress.stage.idle',
    'compactProgress.stage.accepted',
    'compactProgress.stage.compacting',
    'compactProgress.stage.waiting_checkpoint',
    'compactProgress.stage.checkpoint_ready',
    'compactProgress.stage.rehydrating',
    'compactProgress.stage.completed',
    'compactProgress.stage.cancelled',
    'compactProgress.stage.failed',
    'compactProgress.source.plugin_auto',
    'compactProgress.source.plugin_manual',
    'compactProgress.source.host_or_manual',
    'compactProgress.source.none',
    'compactProgress.emptyEvents',
    'session.dual.subTitleCompEst',
    'session.dual.basisEstExceeds',
    'ns.speedMode.title',
    'ns.speedMode.desc',
    'ns.speedMode.streaming',
    'ns.speedMode.e2e',
    'ns.barFontScale.title',
    'ns.barFontScale.desc',
    'ns.barFontScale.compact',
    'ns.barFontScale.standard',
    'ns.barFontScale.large',
    'ns.footerContrast.title',
    'ns.footerContrast.desc',
    'ns.footerContrast.standard',
    'ns.footerContrast.high',
    'settings.dock.auxTriPane',
    'settings.dock.auxTriPaneHint',
    'compact.settings.nativeNodeFailed',
    'composer.card.radialHint',
    'settings.dock.auxViewBoth'
  ];

  const i18nLines = I18N_SOURCE.split(/\r?\n/);
  const bracketRe = /[（）()]/;
  for (const key of newKeys) {
    const line = i18nLines.find(l => l.includes(`'${key}':`));
    assert.ok(line, `缺少词条: ${key}`);
    assert.ok(line.includes("'zh-CN'"), `${key} 缺少 zh-CN`);
    assert.ok(line.includes("'zh-TW'"), `${key} 缺少 zh-TW`);
    assert.ok(line.includes('en:'), `${key} 缺少 en`);
    assert.doesNotMatch(line, bracketRe, `词条 ${key} 严禁包含任何中英文括号: ${line}`);
  }
});

// =========================================================================
// 本轮实机硬验收定向回归：原生 compact 节点、压缩完成收口冻结、rawSteps 预测提取、
// 单浏览器原生退场、预设 2D 浮起拖拽、1500ms 轻提示与径向/悬停零重叠
// =========================================================================

test('Batch03 硬验收补证 1: 原生 compact 命令节点粘贴还原、裸文本/字面量强拒发与 handoff 预留', async () => {
  const routeId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const h = createBatch03Harness({ useRealTimers: true, pathname: `/c/${routeId}` });
  try {
    assert.equal(
      h.api.formatNativeSlashCommandPayloadForTest('compact'),
      '[/compact](slashCommand;compact)',
      '原生 compact 序列化格式必须精确为 [/compact](slashCommand;compact)'
    );
    assert.equal(
      h.api.formatNativeSlashCommandPayloadForTest('handoff'),
      '[/handoff](slashCommand;handoff)',
      '底层参数化函数必须同构支持 handoff'
    );

    const composer = h.makeEl('div');
    composer.classList.add('surface-composer');
    const editor = h.makeEl('div');
    editor.setAttribute('data-lexical-editor', 'true');
    editor.setAttribute('contenteditable', 'true');
    editor.getClientRects = () => [{ width: 320, height: 32 }];
    editor.isConnected = true;
    editor.focus = () => { h.sandbox.document.activeElement = editor; };
    const origEditorQsa = editor.querySelectorAll.bind(editor);
    editor.querySelectorAll = (sel) => {
      if (sel.includes('data-lexical-decorator')) {
        return editor.children.filter(c => c.getAttribute('data-lexical-decorator') || c.getAttribute('data-slash-command'));
      }
      return origEditorQsa(sel);
    };
    const origEditorQs = editor.querySelector.bind(editor);
    editor.querySelector = (sel) => {
      if (sel.includes('data-lexical-decorator')) {
        return editor.children.find(c => c.getAttribute('data-lexical-decorator') || c.getAttribute('data-slash-command')) || null;
      }
      return origEditorQs(sel);
    };
    const origEditorTextDesc = Object.getOwnPropertyDescriptor(editor, 'textContent');
    let editorOwnText = '';
    Object.defineProperty(editor, 'textContent', {
      get() {
        return editorOwnText + editor.children.map(c => c.textContent || '').join('');
      },
      set(v) {
        editorOwnText = String(v ?? '');
        if (!editorOwnText) editor.children.length = 0;
      }
    });
    const modelTrigger = h.makeEl('button');
    modelTrigger.setAttribute('data-testid', 'model-selector-trigger');
    modelTrigger.textContent = 'Gemini 4 Neon High';
    const sendBtn = h.makeEl('button');
    sendBtn.setAttribute('data-testid', 'send-button');
    let sendClicks = 0;
    sendBtn.addEventListener('click', () => {
      sendClicks += 1;
      editor.replaceChildren();
      editor.textContent = '';
    });
    composer.appendChild(editor);
    composer.appendChild(modelTrigger);
    composer.appendChild(sendBtn);
    composer.querySelector = (sel) => {
      if (sel.includes('model-selector-trigger')) return modelTrigger;
      if (sel.includes('send-button')) return sendBtn;
      if (sel.includes('attachment')) return null;
      return null;
    };
    h.body.appendChild(composer);
    h.sandbox.document.querySelector = () => null;
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('data-lexical-editor')) return [editor];
      return [];
    };

    // 场景 A：宿主 paste 未反序列化而留下裸字面量 -> 必须严禁发送且清理残留
    let pasteHandler = (ev) => {
      const txt = ev?.clipboardData?.getData?.('text/plain') || '';
      editor.textContent = txt;
    };
    editor.addEventListener('paste', (ev) => pasteHandler(ev));

    const blockedOk = await h.api.requestOfficialCompactForTest(false, 'compact');
    assert.equal(blockedOk, false, '未还原成实体命令节点时严禁点击发送');
    assert.equal(sendClicks, 0, '未能生成实体命令节点时发送按钮点击数必须为 0');
    assert.equal(editor.textContent.trim(), '', '失败后必须清空由本次写入的序列化字面量');

    // 场景 B：宿主 paste 正确反序列化为单个实体命令节点 -> 允许提交且记录 accepted
    pasteHandler = (ev) => {
      const txt = ev?.clipboardData?.getData?.('text/plain') || '';
      if (txt === '[/compact](slashCommand;compact)') {
        const chip = h.makeEl('span');
        chip.setAttribute('data-lexical-decorator', 'true');
        chip.setAttribute('data-slash-command', 'compact');
        chip.textContent = 'compact';
        editor.textContent = '';
        editor.appendChild(chip);
      }
    };
    const sentOk = await h.api.requestOfficialCompactForTest(false, 'compact');
    assert.equal(sentOk, true, '还原出唯一原生实体节点后必须成功提交');
    assert.equal(sendClicks, 1, '合法实体节点必须恰好触发 1 次发送');
    const snapAfterSend = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snapAfterSend.phase, 'accepted', '提交后进度页必须立即进入 accepted');
  } finally {
    h.dispose();
  }
});

test('Batch03 硬验收补证 2: 压缩完成后立即收口并冻结耗时，防止 232.6s 滞留与历史 DOM 重燃', () => {
  const cid = '274d1a3c-89c4-434f-a9ce-24977dfccb58';
  const h = createBatch03Harness({ pathname: `/c/${cid}` });
  try {
    const startTs = Date.now() - 25000;
    h.api.updateCompactionProgressForTest(cid, {
      isNewTask: true,
      taskKey: `${cid}:${startTs}`,
      source: 'plugin_manual',
      phase: 'compacting',
      startedAtMs: startTs,
      beforeTokens: 216500,
      budget: 512000,
      checkpointIndexBefore: 458
    }, '压缩上下文中');

    // 模拟宿主出现新检查点 #592、上下文实报回落到 61.5K / 512K (12.0%) 且宿主已离开压缩
    const settled = h.api.reconcileCompactionCompletionForTest(cid, {
      scannedCpIdx: 592,
      inProgressCpIdx: -1,
      afterTokens: 61500,
      budget: 512000,
      latestCompacted: true,
      skipRender: true
    });
    assert.equal(settled, true, '新检查点 #592 + 实报回落必须触发立即收口');
    const snap1 = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snap1.phase, 'completed', '阶段必须立即切为 completed');
    assert.equal(snap1.active, false, '完成后不得再处于进行中状态');
    assert.equal(snap1.progressPct, 100, '完成后进度条必须为 100%');
    assert.ok(snap1.completedAtMs > 0, '必须记录冻结完成时间 completedAtMs');
    const frozenElapsed = snap1.elapsedLabel;

    // 迟到历史 DOM / 旧信号试图把同一任务写回 compacting -> 必须被拒绝且冻结耗时不变
    h.api.updateCompactionProgressForTest(cid, {
      taskKey: `${cid}:${startTs}`,
      phase: 'compacting'
    }, '压缩上下文中');
    const snap2 = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snap2.phase, 'completed', '迟到信号严禁重燃已结案压缩');
    assert.equal(snap2.elapsedLabel, frozenElapsed, '刷新或折返页面时已冻结耗时不得继续增长');
  } finally {
    h.dispose();
  }
});

test('Batch03 硬验收补证 3: rawSteps 提取下一句预测上下文 + 单浏览器零占位 + 1500ms 轻提示 + 径向零重叠 + 预设浮起', () => {
  // 3.1 后端 extractTurnsFromRawSteps 真实结构提取
  const { extractTurnsFromRawSteps } = require('./meter-next-prompt');
  const extracted = extractTurnsFromRawSteps([
    { userInput: { userResponse: '帮我修复原生 compact 命令节点' } },
    { type: 'TOOL_RESULT', toolName: 'edit_file', content: 'Updated src/renderer/main.js' },
    { plannerResponse: { response: '已改为合成 paste 粘贴 [/compact](slashCommand;compact) 并加上实体节点校验。' } }
  ]);
  assert.equal(extracted.length, 2, 'rawSteps 必须正确提取用户与助手轮次');
  assert.equal(extracted[0].role, 'user');
  assert.equal(extracted[1].role, 'assistant');
  assert.match(extracted[1].toolSummary, /edit_file/, '必须保留工具摘要辅助下一句预测');

  // 3.2 样式与交互源码契约核验：单浏览器零占位、1500ms 轻提示、径向门禁、分段器滑块、预设 2D 浮起
  assert.match(STYLES_SOURCE, /:host\(\[data-dock="aux"\]\[data-aux-view="browser"\]\)\s*\{[\s\S]*display:\s*none\s*!important/, '单浏览器模式必须用 CSS 让插件外壳零占位退出布局流');
  assert.match(STYLES_SOURCE, /\.ag-panel\.is-entering/, '面板平滑过渡必须命中真实的 .ag-panel 类');
  assert.match(STYLES_SOURCE, /\.ag-preset-drag-ghost\.is-dropping/, '预设拖动松手必须具备平滑落位动画而非瞬移');
  assert.match(GRID_SOURCE, /ag-ghost-surface/, '预设拖动浮层必须采用三层浮起克隆结构');
  assert.match(MAIN_SOURCE, /TRANSIENT_TOAST_TOTAL_MS\s*=\s*1500/, '瞬态轻提示默认时长必须收口为 1500ms 内');
  assert.match(MAIN_SOURCE, /if \(type === 'context' && \(state\.radialMenuOpen \|\| state\.radialClosing\)\) return;/, '径向菜单打开或退场期间严禁弹出底栏上下文预览卡');
  assert.match(SETTINGS_UI_SOURCE, /ag-ns-seg-indicator/, '设置分段器必须具备平滑滑动高亮底块');
  assert.match(NEXT_PROMPT_SOURCE, /ag-np-has-suggestion/, '显示内联预测时必须临时隐藏宿主默认 placeholder');
});

test('Batch03 续跑硬验收 4: 07:52 压缩终态防误标取消、晚到证据自纠、持久化历史与压缩轮次可点尾标', () => {
  const cid = '274d1a3c-89c4-434f-a9ce-24977dfccb58';
  const h = createBatch03Harness({ pathname: `/c/${cid}` });
  try {
    // 4.1 模拟 07:52 场景：41.5s 检查点尚未落盘超时 -> 严禁伪造 cancelled，必须停在 waiting_checkpoint 等待晚到证据
    const startTs = Date.now() - 41500;
    h.api.updateCompactionProgressForTest(cid, {
      isNewTask: true,
      taskKey: `${cid}:${startTs}`,
      source: 'plugin_manual',
      phase: 'compacting',
      startedAtMs: startTs,
      beforeTokens: 216800,
      budget: 512000,
      checkpointIndexBefore: 458
    }, '压缩上下文中');

    h.api.clearCompactingTransitionForTest('timeout_waiting');
    const snapWait = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snapWait.phase, 'waiting_checkpoint', '检查点尚未落盘超时不得伪造为 cancelled');
    assert.notEqual(snapWait.phase, 'cancelled', '超时无新检查点严禁写入压缩已取消');

    // 4.2 晚到的可信完成证据（#458 -> #597、216.8K -> 61.5K）到达 -> 立即纠正为 completed 并持久化历史
    const corrected = h.api.reconcileCompactionCompletionForTest(cid, {
      scannedCpIdx: 597,
      inProgressCpIdx: -1,
      afterTokens: 61500,
      budget: 512000,
      latestCompacted: true,
      skipRender: true
    });
    assert.equal(corrected, true, '晚到可信新检查点与实报回落必须自动纠正为 completed');
    const snapDone = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snapDone.phase, 'completed', '纠正后阶段必须为 completed');
    assert.equal(snapDone.progressPct, 100);
    const frozenElapsed = snapDone.elapsedLabel;

    // 4.3 迟到取消回调 / 停用自动开关 / 切会话 -> 绝不可覆写已确认 completed
    h.api.updateCompactionProgressForTest(cid, { taskKey: `${cid}:${startTs}`, phase: 'cancelled' }, '压缩已取消');
    h.api.revokeLocalAutoCompactDispatchForTest('disabled_by_user');
    h.api.clearCompactingTransitionForTest('route_switched');
    const snapProtected = h.api.buildCompactionProgressSnapshotForTest();
    assert.equal(snapProtected.phase, 'completed', '已确认 completed 严禁被迟到取消或停用覆写');
    assert.equal(snapProtected.elapsedLabel, frozenElapsed, '已冻结耗时严禁变动');

    const hist = h.api.getCompactionHistoryForTest(cid);
    assert.ok(Array.isArray(hist) && hist.length >= 1, '已完成压缩记录必须持久化保存');
    const latestHist = hist[hist.length - 1];
    assert.equal(latestHist.phase, 'completed');
    assert.equal(latestHist.checkpointIndexBefore, 458);
    assert.equal(latestHist.checkpointIndexAfter, 597);
    assert.equal(latestHist.releasedTokens, 155300);
    assert.equal(latestHist.releasedPct, 71.6);

    // 4.4 压缩轮次简洁可点尾标（实体 compact 气泡 -> 仅显示「压缩已完成」，点击展开实值详情；普通回复不受影响）
    const conv = h.makeEl('div');
    const compactTurnWrap = h.makeEl('article');
    const compactEntity = h.makeEl('span');
    compactEntity.setAttribute('data-slash-command', 'compact');
    compactEntity.textContent = 'compact';
    compactTurnWrap.appendChild(compactEntity);
    const compactTb = h.makeEl('div');
    compactTb.setAttribute('data-testid', 'cascade-system-message-toolbar');
    const compactRow = h.makeEl('div');
    compactTb.appendChild(compactRow);
    compactTurnWrap.appendChild(compactTb);
    conv.appendChild(compactTurnWrap);

    const normalTurnWrap = h.makeEl('article');
    const normalP = h.makeEl('p');
    normalP.textContent = '普通消息里提到 compact 单词不应触发压缩已完成尾标';
    normalTurnWrap.appendChild(normalP);
    const normalTb = h.makeEl('div');
    normalTb.setAttribute('data-testid', 'cascade-system-message-toolbar');
    const normalRow = h.makeEl('div');
    normalTb.appendChild(normalRow);
    normalTurnWrap.appendChild(normalTb);
    conv.appendChild(normalTurnWrap);
    h.body.appendChild(conv);

    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('cascade-system-message-toolbar')) return [compactTb, normalTb];
      if (sel.includes('.ag-cm-turn-footer')) return conv.querySelectorAll('.ag-cm-turn-footer');
      return [];
    };

    compactTurnWrap.setAttribute('data-turn-index', '1');
    normalTurnWrap.setAttribute('data-turn-index', '2');
    const nowTs = Date.now();
    h.api.setSessionCallsForTest([
      { callId: 'c-compact-1', cascadeId: cid, status: 'final', stepIndex: 592, timestamp: nowTs - 300000, inputTokens: 415900, outputTokens: 4300, cacheReadTokens: 411700, totalTokens: 420200 },
      { callId: 'c-normal-2', cascadeId: cid, status: 'final', stepIndex: 600, timestamp: nowTs, modelExactId: 'M533', modelLabel: 'Gemini 4 Neon', inputTokens: 12000, outputTokens: 800, cacheReadTokens: 10000, totalTokens: 12800 }
    ]);
    h.api.renderTurnFooterStatsForTest();

    const compactBadge = compactRow.querySelector('.ag-cm-turn-footer');
    assert.ok(compactBadge, '压缩轮次必须渲染独立尾标');
    assert.equal(compactBadge.getAttribute('data-ag-turn-footer-kind'), 'compaction');
    assert.equal(compactBadge.textContent, '压缩已完成', '压缩轮次尾标必须简洁显示「压缩已完成」且移除未知模型与 In/Out');
    assert.equal(compactBadge.textContent.includes('未知模型'), false);
    assert.equal(compactBadge.textContent.includes('415.9K'), false);

    const detailNode = compactTb.querySelector('.ag-cm-compact-footer-detail');
    assert.ok(detailNode, '压缩轮次必须附带可展开详情容器');
    assert.equal(detailNode.hidden, true, '初始默认收起');
    compactBadge.click();
    assert.equal(detailNode.hidden, false, '点击后必须展开前后占用与检查点详情');
    assert.match(detailNode.textContent, /216\.8K.*61\.5K/, '详情必须展示该次压缩可信前后占用');
    assert.match(detailNode.textContent, /#458 -> #597/, '详情必须展示检查点区间');

    const normalBadge = normalRow.querySelector('.ag-cm-turn-footer');
    assert.ok(normalBadge, '普通回复仍应正常渲染尾标');
    assert.notEqual(normalBadge.getAttribute('data-ag-turn-footer-kind'), 'compaction', '普通消息提到 compact 不得误判为压缩轮次');

    // 4.5 真实用户取消任务维持 cancelled
    const cancelTs = Date.now();
    h.api.updateCompactionProgressForTest(cid, {
      isNewTask: true,
      taskKey: `${cid}:${cancelTs}`,
      source: 'plugin_manual',
      phase: 'compacting',
      startedAtMs: cancelTs,
      beforeTokens: 120000,
      budget: 512000,
      checkpointIndexBefore: 597
    }, '压缩上下文中');
    h.api.clearCompactingTransitionForTest('cancelled');
    assert.equal(h.api.buildCompactionProgressSnapshotForTest().phase, 'cancelled', '真实取消必须维持 cancelled');
  } finally {
    h.dispose();
  }

  // 4.6 本轮新增 7 组可见文案三语零括号门禁
  const r2Keys = [
    'turnFooter.compacted',
    'turnFooter.compactTip',
    'turnFooter.compactReleased',
    'turnFooter.compactCheckpoint',
    'turnFooter.compactStatsPending',
    'compactProgress.detail.waitingEvidence',
    'compactProgress.stage.correctedCompleted'
  ];
  const BRACKET_RE = /[()（）]/;
  for (const key of r2Keys) {
    const m = I18N_SOURCE.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{([^\\n]+)\\}`));
    assert.ok(m, `i18n.js 必须包含本轮新增词条 ${key}`);
    assert.equal(BRACKET_RE.test(m[1]), false, `词条 ${key} 严禁包含任何中英文括号: ${m[1]}`);
  }
});

test('Batch03 续跑硬验收 5: 07:49 面板关闭时 timeline 导出 recentConversationTurns、OAuth 401 刷新重试与原生占位隐藏还原', async () => {
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-np-r2-'));
  try {
    const cid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const convDir = path.join(tmpDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    const jsonl = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '帮我跑完单元测试再发构建报告' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '已经修完 src/renderer/next-prompt.js，接下来需要运行 npm test 验证。' })
    ].join('\n');
    fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), jsonl, 'utf8');

    const { collectSessionTimelineAsync } = require('./meter-collector');
    const tl = await collectSessionTimelineAsync(cid, { agDir: tmpDir, force: true, disableWorker: true });
    assert.ok(Array.isArray(tl.recentConversationTurns) && tl.recentConversationTurns.length === 2, 'collectSessionTimelineAsync 必须返回 recentConversationTurns 供面板关闭时使用');
    assert.equal(tl.recentConversationTurns[0].role, 'user');
    assert.equal(tl.recentConversationTurns[1].role, 'assistant');
    assert.match(tl.recentConversationTurns[1].text, /npm test/, 'recentConversationTurns 必须保留最新真实助手回复正文');

    // 验证 OAuth 401 自动刷新并有界重试 1 次
    const { callCloudCodeGenerateContent } = require('./meter-next-prompt');
    let apiCalls = 0;
    let tokenCalls = 0;
    const mockFetch = async (url, init) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        tokenCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'fresh_tok_123', expires_in: 3600 })
        };
      }
      apiCalls++;
      const auth = init?.headers?.Authorization || '';
      if (apiCalls === 1 && auth.includes('expired_tok')) {
        return { ok: false, status: 401, text: async () => '{"error":"unauthorized"}' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          response: { candidates: [{ content: { parts: [{ text: '现在运行 npm test 看全部回归结果' }] } }] }
        })
      };
    };
    const fakeAccountStore = {
      activeAccountEmail: 'user@example.com',
      accounts: {
        'user@example.com': {
          projectId: 'proj-test',
          credential: { accessToken: 'expired_tok', refreshToken: 'ref_tok_1', expiresAt: Date.now() + 600000 }
        }
      }
    };
    const origMgrMod = require('./meter-accounts');
    const origGetMgr = origMgrMod.getSharedAccountsManager;
    // 通过 options.fetch 与过期 store 测试刷新链路
    const res401 = await callCloudCodeGenerateContent(
      { systemPrompt: 'sys', userPrompt: 'usr' },
      {
        fetch: mockFetch,
        baseUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
        managerOpts: {
          stateDir: tmpDir
        }
      }
    );
    // 若无本地账户文件则返回 missing_oauth_credential；写入临时账户存储后再测完整 401 -> refresh -> retry
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(fakeAccountStore), 'utf8');
    assert.ok(typeof origGetMgr === 'function');
    assert.equal(res401.reason, 'missing_oauth_credential');

    // 验证前端面板关闭时隐藏/还原宿主原生 Ask anything placeholder 节点
    const h = createBatch03Harness({
      pathname: `/c/${cid}`,
      apiOverrides: {
        predictNextPrompt: async () => ({ ok: true, suggestion: '运行 npm test 验证修复', model: 'gemini-3-flash' })
      }
    });
    try {
      const comp = h.makeEl('div');
      comp.classList.add('surface-composer');
      const editorWrap = h.makeEl('div');
      const placeholderDiv = h.makeEl('div');
      placeholderDiv.className = 'pointer-events-none text-muted';
      placeholderDiv.textContent = 'Ask anything, @ to mention, / for actions';
      const editor = h.makeEl('div');
      editor.setAttribute('data-lexical-editor', 'true');
      editor.setAttribute('contenteditable', 'true');
      editorWrap.appendChild(placeholderDiv);
      editorWrap.appendChild(editor);
      comp.appendChild(editorWrap);
      h.body.appendChild(comp);
      h.sandbox.document.activeElement = editor;
      h.sandbox.document.querySelector = (sel) => {
        if (sel.includes('stop-button') || sel.includes('approval') || sel.includes('alertdialog')) return null;
        return sel.includes('.surface-composer') ? comp : null;
      };
      h.sandbox.document.querySelectorAll = (sel) => (sel.includes('.surface-composer') ? [comp] : []);

      // 确保右侧面板处于关闭状态
      assert.equal(h.elements.get('panel').hidden, true, '本用例要求右侧面板全程关闭');
      h.api.setNextPromptEnabledForTest(true);
      const r = await h.api.maybeRequestNextPromptForTest({
        routeId: cid,
        composer: comp,
        turnKey: 'closed-panel-round-1',
        turns: tl.recentConversationTurns
      });
      assert.equal(r.ok, true);
      assert.equal(placeholderDiv.getAttribute('data-ag-np-hidden-placeholder'), 'true', '显示灰字建议时必须临时隐藏原生 Ask anything 占位节点');
      assert.equal(placeholderDiv.style.opacity, '0');

      // 单按 Tab 一次填入并还原原生 placeholder 标记
      h.sandbox.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false, target: editor, preventDefault() {} });
      assert.equal(editor.textContent, '运行 npm test 验证修复', '单按 Tab 必须填入同一真编辑器');
      assert.equal(placeholderDiv.getAttribute('data-ag-np-hidden-placeholder'), null, 'Tab 接受后必须清除占位隐藏标记');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Batch03 续跑硬验收 6: 07:43/07:45 顶栏与侧栏分离、悬浮球避让、浮层视口安全区与预设胶囊 2d.html 规格及顶层 z-index', () => {
  // 6.1 顶栏指标绝不渲染在 aux 侧栏内部 + 预设胶囊严格对齐 2d.html + 浮起卡片 z-index 高于面板 2147483500
  assert.match(STYLES_SOURCE, /:host\(\[data-dock="aux"\]\)\s*\.ag-bar\s*\{[\s\S]*display:\s*none\s*!important/, 'aux 停靠态必须彻底隐藏右栏内部的 .ag-bar 顶栏指标条');
  assert.match(STYLES_SOURCE, /#pane-ctx-session\s+\.ctx-cockpit-presets\s*\{[\s\S]*gap:\s*7px/, '预设栏间距必须严格对齐 2d.html 的 7px');
  assert.match(STYLES_SOURCE, /#pane-ctx-session\s+\.ctx-preset-btn\.ctx-preset-pill[\s\S]*flex-direction:\s*row[\s\S]*height:\s*30px[\s\S]*padding:\s*0 10px 0 7px[\s\S]*font-size:\s*12px/, '预设胶囊必须对齐 2d.html 横向 inline-flex、30px 高、0 10px 0 7px 内边距与 12px 字号');
  assert.match(STYLES_SOURCE, /\.ctx-preset-grip[\s\S]*width:\s*14px;[\s\S]*height:\s*20px;/, '左侧六点手柄必须对齐 2d.html 的 14x20px');
  assert.match(STYLES_SOURCE, /\.ag-preset-drag-ghost\s*\{[\s\S]*z-index:\s*2147483647\s*!important/, '浮起拖拽卡片 z-index 必须为 2147483647，高于 .ag-panel 的 2147483500');
  assert.match(GRID_SOURCE, /ghost\.style\.zIndex\s*=\s*'2147483647'/, '拖拽创建 ghost 时必须显式置顶层级');

  // 6.2 验证悬浮球打开浮层不挤在下半截，以及悬浮球在右栏展开时自动左移避让
  const h = createBatch03Harness();
  try {
    h.sandbox.window.innerWidth = 1440;
    h.sandbox.window.innerHeight = 900;
    const orb = h.elements.get('ctx-radial-orb');
    if (orb) {
      orb.getBoundingClientRect = () => ({ left: 1380, top: 836, right: 1424, bottom: 880, width: 44, height: 44 });
    }
    const panelQuota = h.elements.get('panel-quota');
    const badgeQuota = h.elements.get('badge-quota');
    if (badgeQuota) {
      badgeQuota.getBoundingClientRect = () => ({ left: 780, top: 6, right: 860, bottom: 38, width: 80, height: 32 });
    }
    h.host.getBoundingClientRect = () => ({ left: 680, top: 6, right: 980, bottom: 38, width: 300, height: 32 });
    // 模拟宿主右栏展开（宽 460px，位于 980..1440）
    const fakeAux = h.makeEl('div');
    fakeAux.setAttribute('data-side-panel-open', 'true');
    fakeAux.setAttribute('data-side-panel-focus-scope', 'true');
    fakeAux.getBoundingClientRect = () => ({ left: 980, top: 38, right: 1440, bottom: 900, width: 460, height: 862 });
    h.body.appendChild(fakeAux);
    h.sandbox.document.querySelector = (sel) => (sel.includes('data-side-panel-open') || sel.includes('data-aux-pane-focus-scope') ? fakeAux : null);
    h.sandbox.document.querySelectorAll = (sel) => (sel.includes('data-side-panel-open') ? [fakeAux] : []);

    // 从悬浮球打开配额面板 -> top 必须在顶安全区（<= 60px），绝不能被挤到 vh-120=780px 处只显半高；且右缘贴齐视口右侧（1440-12=1428）
    h.api.setFloatingOrbLiveOverrideForTest?.({ phase: 'idle' });
    h.api.showPanelForTest?.('quota');
    h.api.positionFloatingPanelsForTest();
    const qTop = Number.parseFloat(panelQuota.style.top || '999');
    const qMaxH = Number.parseFloat(panelQuota.style.maxHeight || '0');
    assert.ok(qTop <= 60, `配额浮层 top 必须位于顶部安全区而非屏幕下半截，实际 ${qTop}px`);
    assert.ok(qMaxH >= 700, `配额浮层 maxHeight 必须提供完整视口可用高度，实际 ${qMaxH}px`);

    // 悬浮球在右栏展开（left=980）时必须自动避让到右栏左缘外侧（x <= 980 - 44 - 16 = 920）
    h.api.applyOrbPositionToDomForTest();
    const orbLeftAfter = Number.parseFloat(orb.style.left || '9999');
    assert.ok(orbLeftAfter <= 920, `右栏展开占据 980..1440 时悬浮球必须左移避让，实际 left=${orbLeftAfter}px`);
  } finally {
    h.dispose();
  }
});

test('Batch03 09:21 硬验收 7: 删旧排序、保存/新建0模块空分组持久化、2D直接互换与三语零括号', () => {
  // 7.1 DOM 与源码契约：无旧排序按钮，保留「保存」与轨道末尾锁定的「新建分组」，拖动期间「新建分组」零高亮
  assert.doesNotMatch(TEMPLATE_SOURCE, /id="btn-ctx-preset-sort"/, '旧「排序」按钮必须彻底移除');
  assert.match(TEMPLATE_SOURCE, /id="btn-ctx-preset-save"/, '必须保留精简保存按钮');
  assert.match(TEMPLATE_SOURCE, /id="btn-ctx-preset-new-group"/, '轨道末尾必须固定「新建分组」按钮');
  assert.match(STYLES_SOURCE, /:host\(\[data-preset-dragging="true"\]\)\s+\.ag-preset-add-btn/, '拖动期间「新建分组」按钮不得出现高亮或悬停态');

  // 7.2 本轮新增及修改的简中/繁中/英文可见文案严格零中英文括号
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  const checkedKeys = [
    'session.preset.saveNew',
    'session.preset.newGroup',
    'session.preset.newGroupDefaultName',
    'session.preset.emptyTitle',
    'session.preset.emptyDesc',
    'session.preset.emptyOpenMgr',
    'settings.dock.auxSwapOrder',
    'settings.dock.auxSwapOrderTitle',
    'settings.dock.auxLayoutCenter',
    'settings.dock.auxLayoutFull',
    'settings.dock.auxLayoutToggleTitle',
    'settings.dock.auxInnerResizeAria',
    'settings.dock.auxInnerResizeTitle'
  ];
  for (const key of checkedKeys) {
    const escaped = key.replace(/\./g, '\\.');
    const m = i18nSrc.match(new RegExp(`'${escaped}'\\s*:\\s*\\{([^\\n]+)\\}`));
    assert.ok(m, `i18n 必须定义 ${key}`);
    assert.doesNotMatch(m[1], /[()（）]/, `三语词条 ${key} 严禁包含任何中英文括号，实际: ${m[1]}`);
  }

  // 7.3 collector 持久化校验：0 模块空分组与旧缺字段预设严格区分
  const { savePluginSettings, getPluginSettings } = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-b03-empty-group-'));
  try {
    const saveRes = savePluginSettings({
      sessionCockpitLayout: {
        presetId: 'custom-empty-1',
        emptyGroup: true,
        modules: [],
        widgets: [
          { id: 'overview-kpi', visible: false, span: 12, order: 0 },
          { id: 'trend-pulse', visible: false, span: 12, order: 1 }
        ],
        customPresets: [
          { id: 'custom-empty-1', name: '空白分组 1', emptyGroup: true, modules: [], widgets: [] }
        ]
      }
    }, { agDir: tmpDir });
    assert.equal(saveRes.ok, true);
    const loaded = getPluginSettings({ agDir: tmpDir }).sessionCockpitLayout;
    assert.equal(loaded.emptyGroup, true, '已保存的 0 模块空分组必须保留 emptyGroup=true');
    assert.deepEqual(loaded.modules, [], '0 模块空分组读取后 modules 必须仍为空数组');
    assert.equal(loaded.widgets.filter(w => w.visible).length, 0, '0 模块空分组冷重启后不得自动塞回默认模块');
    assert.equal(loaded.customPresets[0].emptyGroup, true);
    assert.deepEqual(loaded.customPresets[0].modules, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 7.4 运行时交互：点击新建 0 模块空分组、显示空态、加入 1 张卡不污染原预设、2D 点对点直接互换不顺移中间项
  const h = createBatch03Harness();
  try {
    const created = h.api.createEmptyCustomCockpitGroupForTest('自定义空组');
    assert.ok(created && created.activeCustomId, '新建空分组必须生成新自定义预设 ID');
    assert.equal(created.emptyGroup, true, '新建分组初始必须标记 emptyGroup=true');
    assert.deepEqual(Array.from(created.modules || []), [], '新建分组初始 modules 必须为空数组');
    assert.equal(created.widgets.filter(w => w.visible).length, 0, '新建空分组初始可见模块数必须严格为 0');
    const trackState = h.api.getPresetTrackStateForTest();
    assert.equal(trackState.emptyStateHidden, false, '0 模块空分组必须显示空态引导卡片');
    assert.equal(trackState.hasNewGroupBtn, true, '轨道末尾必须存在「新建分组」按钮');
    assert.ok(!trackState.domOrder.includes('btn-ctx-preset-new-group'), '「新建分组」按钮严禁混入可换位预设 ID 序列');

    // 加入 1 个模块并保存，随后切回原预设，确认互不污染
    h.api.toggleCockpitWidgetVisibleForTest('overview-kpi', true);
    const afterAdd = h.api.getCockpitLayoutForTest();
    assert.equal(afterAdd.widgets.filter(w => w.visible).length, 1, '手动添加 1 个模块后应精确为 1 个可见模块');
    const backSystem = h.api.applyCockpitPresetForTest('cockpit', { persist: true });
    assert.ok(backSystem.widgets.filter(w => w.visible).length > 1, '切回系统预设后系统默认模块必须完好无损');

    // 校验 2D 点对点直接互换算法与硬性参数
    const swapApi = h.api.getPresetSwapApiForTest();
    assert.ok(swapApi, 'presetTrack 必须挂载 __agPresetSwapApi');
    assert.equal(swapApi.params.longPressMs, 140);
    assert.equal(swapApi.params.dragThresholdPx, 5);
    assert.equal(swapApi.params.deadzonePx, 11);
    assert.equal(swapApi.params.cooldownMs, 140);
    assert.equal(swapApi.params.flipMs, 250);
    assert.equal(swapApi.params.maxTiltDeg, 0);
    assert.equal(swapApi.params.pointerWeight, 0.65);
    assert.equal(swapApi.params.ghostCenterWeight, 0.35);
    assert.equal(swapApi.params.lowpassKeep, 0.72);
    assert.equal(swapApi.params.lowpassNew, 0.28);
    assert.equal(swapApi.params.maxStretch, 0);

    const beforeSwapOrder = Array.from(h.api.getPresetTrackStateForTest().presetOrder);
    assert.ok(beforeSwapOrder.length >= 4);
    const sFirst = beforeSwapOrder[0];
    const sLast = beforeSwapOrder[beforeSwapOrder.length - 1];
    h.api.swapCockpitPresetsForTest(sFirst, sLast);
    const afterSwapOrder = Array.from(h.api.getPresetTrackStateForTest().presetOrder);
    assert.equal(afterSwapOrder[0], sLast, '2D 直接交换后目标项应落到首槽');
    assert.equal(afterSwapOrder[afterSwapOrder.length - 1], sFirst, '2D 直接交换后来源项应落到末槽');
    assert.deepEqual(
      afterSwapOrder.slice(1, -1),
      beforeSwapOrder.slice(1, -1),
      '2D 直接交换只能互换起止两项，中间兄弟必须纹丝不动'
    );
    // 2D 跨行命中测试（2 行每行 2 格）
    const frozenSlots = [
      { id: 'p0', rect: { left: 0, top: 0, right: 90, bottom: 30, width: 90, height: 30 } },
      { id: 'p1', rect: { left: 97, top: 0, right: 187, bottom: 30, width: 90, height: 30 } },
      { id: 'p2', rect: { left: 0, top: 37, right: 90, bottom: 67, width: 90, height: 30 } },
      { id: 'p3', rect: { left: 97, top: 37, right: 187, bottom: 67, width: 90, height: 30 } }
    ];
    assert.equal(swapApi.hitTestFrozenHomeSlots(140, 50, frozenSlots), 3, '第二行右侧点必须命中索引 3');
    assert.equal(swapApi.hitTestFrozenHomeSlots(45, 15, frozenSlots), 0, '第一行左侧点必须命中索引 0');
    assert.equal(swapApi.hitTestFrozenHomeSlots(500, 500, frozenSlots), -1, '拖出有效槽区必须返回 -1');
  } finally {
    h.dispose();
  }
});

test('Batch03 09:21 硬验收 8: 三栏顺序一键互换不重建浏览器、单浏览器退场隐藏灰条与 PR #121 错挂转重挂恢复', () => {
  const h = createBatch03Harness();
  try {
    h.sandbox.window.innerWidth = 1480;
    h.sandbox.window.innerHeight = 900;

    // 8.1 构造含真实宿主浏览器 webview 的右侧辅助栏（宽 920px，足够三栏并排）
    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.getBoundingClientRect = () => ({ left: 560, top: 38, right: 1480, bottom: 900, width: 920, height: 862 });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    const webview = h.makeEl('webview');
    browserPane.appendChild(webview);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);
    h.body.appendChild(auxOuter);

    // 同时放一个双会话第二聊天窗格（含 .surface-composer 但无 webview）确认不被误判为辅助栏
    const splitChatPane = h.makeEl('div');
    splitChatPane.setAttribute('data-testid', 'conversation-view');
    const chatForm = h.makeEl('form');
    const chatEd = h.makeEl('div');
    chatEd.setAttribute('contenteditable', 'true');
    chatForm.appendChild(chatEd);
    splitChatPane.appendChild(chatForm);
    h.body.appendChild(splitChatPane);

    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('webview')) return [webview];
      return [];
    };

    // 切到 aux 并排模式
    h.api.setDockPositionForTest?.('aux');
    h.api.setAuxViewTabForTest('both', { persist: true });
    let auxSt = h.api.getAuxDockStateForTest();
    assert.equal(auxSt.auxViewTab, 'both', '应成功进入三栏并排共存态');
    assert.equal(auxSt.auxTripaneAttr, 'true', `宽屏并排时 host 必须标上 data-aux-tripane=true，实际: ${JSON.stringify(auxSt)}`);
    assert.equal(auxSt.auxInnerResizerHidden, false, '三栏并排时第二条内分隔线必须可见');
    assert.equal(browserPane.style.display, '', '三栏并排时宿主浏览器必须可见而非被 display:none 隐藏');

    // 一键互换中右顺序（plugin-first <-> browser-first），确认浏览器节点引用完全不变（未销毁重建）
    const origBrowserRef = browserPane;
    h.api.setAuxOrderForTest('browser-first', { persist: true });
    auxSt = h.api.getAuxDockStateForTest();
    assert.equal(auxSt.auxOrder, 'browser-first');
    assert.equal(h.host.style.order, '2', 'browser-first 时查看器 order 应切至右侧 2');
    assert.equal(browserPane.style.order, '1', 'browser-first 时宿主浏览器 order 应切至中间 1');
    assert.equal(browserPane, origBrowserRef, '互换三栏顺序严禁销毁重建宿主浏览器 DOM');

    h.api.setAuxOrderForTest('plugin-first', { persist: true });
    assert.equal(h.host.style.order, '1', '切回 plugin-first 时查看器应回到中间 1');
    assert.equal(browserPane.style.order, '2', '切回 plugin-first 时浏览器应回到右侧 2');

    // 调整第二条内分隔线比例并持久化
    const nextShare = h.api.setAuxPluginShareForTest(480, { persist: true });
    assert.equal(nextShare, 480);
    assert.ok(h.savedSettings.some(s => s && s.auxPluginSharePx === 480), '内分隔线拖拽后的插件栏宽必须持久化');

    // 切到单浏览器模式：插件退场到顶栏原生位并打上 data-aux-browser-detached=true 隐藏顶栏多余控制条
    h.api.setAuxViewTabForTest('browser', { persist: true });
    auxSt = h.api.getAuxDockStateForTest();
    assert.equal(auxSt.auxBrowserDetachedAttr, 'true', '单浏览器退场时必须标上 data-aux-browser-detached=true 以隐藏顶栏多余灰条');
    assert.equal(browserPane.style.display, '', '单浏览器态宿主浏览器必须恢复原生显示');

    // 8.2 PR #121 补证：先错挂候选（conversation-view 下的横排 flex 行容器）拒绝隐藏 -> 合法纵向 composer 出现后实际重挂到输入框下方
    h.api.setRadialBottombarEnabledForTest(true);
    const csb = h.elements.get('composer-status-bar');
    const convRoot = h.makeEl('div');
    convRoot.setAttribute('data-testid', 'conversation-view');
    const badRow = h.makeEl('div');
    const badForm = h.makeEl('form');
    const badInput = h.makeEl('textarea');
    badForm.appendChild(badInput);
    badRow.appendChild(badForm);
    convRoot.appendChild(badRow);
    h.body.appendChild(convRoot);

    const goodCol = h.makeEl('div');
    const goodForm = h.makeEl('form');
    const goodInput = h.makeEl('textarea');
    goodForm.appendChild(goodInput);
    goodCol.appendChild(goodForm);

    const origGetComputedStyle = h.sandbox.window.getComputedStyle;
    h.sandbox.window.getComputedStyle = (node) => {
      if (node === badRow || node === convRoot) return { display: 'flex', flexDirection: 'row', gridTemplateColumns: '' };
      if (node === goodCol) return { display: 'flex', flexDirection: 'column', gridTemplateColumns: '' };
      return origGetComputedStyle ? origGetComputedStyle(node) : { display: 'block', flexDirection: '', gridTemplateColumns: '' };
    };
    let activeForms = [badForm];
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('form')) return activeForms;
      return [];
    };
    h.sandbox.document.querySelector = () => null;

    // 阶段 1：仅存在横排容器内的 form -> 必须拒绝挂载并隐藏
    h.api.renderComposerStatusBarForTest();
    assert.equal(csb.hidden, true, 'PR #121: 横排 flex 宿主中严禁挂载底栏');

    // 阶段 2：合法纵向 composer 出现 -> 必须实际重挂到 goodForm 之后并显示
    h.body.appendChild(goodCol);
    activeForms = [goodForm];
    h.api.renderComposerStatusBarForTest();
    assert.equal(csb.hidden, false, 'PR #121: 合法纵向 composer 出现后底栏必须恢复显示');
    assert.equal(goodForm.nextElementSibling, csb, 'PR #121: 底栏必须真实挂载在合法 composer 节点之后');
  } finally {
    h.dispose();
  }
});

test('Batch03 09:21 硬验收 9: 双会话各自独立底栏与回复尾标、保留真实0%缓存、压缩已完成与同会话双开', () => {
  const sessA = '11111111-1111-4111-8111-111111111111';
  const sessB = '22222222-2222-4222-8222-222222222222';
  const h = createBatch03Harness({
    pathname: `/c/${sessA}+${sessB}`,
    search: `?focused=${sessA}`
  });
  try {
    h.api.setRadialBottombarEnabledForTest(true);
    // 构造左右两个独立会话窗格 DOM（各自包含 2 条回复工具栏 + 1 个合法纵向 composer）
    const makePaneDom = (sid, leftPx) => {
      const pane = h.makeEl('div');
      pane.setAttribute('data-testid', 'conversation-view');
      pane.setAttribute('data-cascade-id', sid);
      const tb1 = h.makeEl('div');
      tb1.setAttribute('data-testid', 'cascade-system-message-toolbar');
      const tb1Row = h.makeEl('div');
      tb1Row.clientWidth = 520;
      tb1.appendChild(tb1Row);
      const tb2 = h.makeEl('div');
      tb2.setAttribute('data-testid', 'cascade-system-message-toolbar');
      const tb2Row = h.makeEl('div');
      tb2Row.clientWidth = 520;
      tb2.appendChild(tb2Row);
      const compWrap = h.makeEl('div');
      const form = h.makeEl('form');
      form.getBoundingClientRect = () => ({ left: leftPx, top: 760, right: leftPx + 420, bottom: 840, width: 420, height: 80 });
      const ed = h.makeEl('div');
      ed.setAttribute('contenteditable', 'true');
      form.appendChild(ed);
      compWrap.appendChild(form);
      pane.appendChild(tb1);
      pane.appendChild(tb2);
      pane.appendChild(compWrap);
      return { pane, tb1, tb2, form, compWrap };
    };

    const paneA = makePaneDom(sessA, 40);
    const paneB = makePaneDom(sessB, 520);
    const splitRoot = h.makeEl('div');
    splitRoot.appendChild(paneA.pane);
    splitRoot.appendChild(paneB.pane);
    h.body.appendChild(splitRoot);

    const origQsa = h.sandbox.document.querySelectorAll;
    const collectMatches = (root, sel) => {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        const tid = n.getAttribute?.('data-testid') || '';
        const cls = String(n.className || '');
        const tag = String(n.tagName || '');
        if (
          (sel.includes('form') && tag === 'FORM')
          || (sel.includes('cascade-system-message-toolbar') && tid === 'cascade-system-message-toolbar')
          || (sel.includes('ag-csb-pane-clone') && cls.includes('ag-csb-pane-clone'))
          || (sel.includes('ag-cm-turn-footer') && cls.includes('ag-cm-turn-footer'))
          || (sel.includes('ag-cm-compact-footer-detail') && cls.includes('ag-cm-compact-footer-detail'))
        ) {
          out.push(n);
        }
        for (const ch of (n.children || [])) walk(ch);
      };
      walk(root);
      return out;
    };
    for (const p of [paneA.pane, paneB.pane]) {
      p.querySelectorAll = (sel) => collectMatches(p, sel);
    }
    h.sandbox.document.querySelectorAll = (sel) => {
      const hits = collectMatches(h.body, sel);
      if (hits.length > 0) return hits;
      return origQsa ? origQsa(sel) : [];
    };

    // 注入 sessA（0% 真实缓存、Gemini 4 Neon Medium）到当前焦点会话，并注入 sessB（80% 缓存、Claude Sonnet 4.6 + 第2轮压缩已完成）到独立会话快照
    const callsA = [
      { callId: 'call-a-1', turnIndex: 0, stepIndex: 0, model: 'Gemini 4 Neon Medium', inputTokens: 60000, cacheReadTokens: 0, outputTokens: 1200, streamingTps: 100, status: 'final' },
      { callId: 'call-a-2', turnIndex: 1, stepIndex: 1, model: 'Gemini 4 Neon Medium', inputTokens: 60000, cacheReadTokens: 0, outputTokens: 1800, streamingTps: 98, status: 'final' }
    ];
    const callsB = [
      { callId: 'call-b-1', turnIndex: 0, stepIndex: 0, model: 'Claude Sonnet 4.6', inputTokens: 100000, cacheReadTokens: 400000, outputTokens: 2000, streamingTps: 65, status: 'final' },
      { callId: 'call-b-2', turnIndex: 1, stepIndex: 1, model: 'Claude Sonnet 4.6', inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 800, streamingTps: 60, status: 'final' }
    ];
    h.api.seedSessionSnapshotForTest(sessA, {
      latest: { actual: 120000, budget: 1000000, model: 'Gemini 4 Neon Medium' },
      sessionCalls: callsA,
      sessionTimeline: {
        cascadeId: sessA,
        turns: [
          { turnIndex: 1, calls: [callsA[0]] },
          { turnIndex: 2, calls: [callsA[1]] }
        ]
      }
    }, { applyToActiveState: true });
    h.api.seedSessionSnapshotForTest(sessB, {
      latest: { actual: 500000, budget: 1000000, model: 'Claude Sonnet 4.6' },
      sessionCalls: callsB,
      sessionTimeline: {
        cascadeId: sessB,
        turns: [
          { turnIndex: 1, calls: [callsB[0]] },
          {
            turnIndex: 2,
            isCompactionTurn: true,
            compactionRecord: { phase: 'completed', taskKey: 'cmp-b-2', beforeTokens: 500000, afterTokens: 120000, budget: 1000000 },
            calls: [callsB[1]]
          }
        ]
      }
    });

    h.api.renderComposerStatusBarForTest();
    h.api.renderTurnFooterStatsForTest();

    // 校验两个窗格各自挂载独立输入框状态条且互不串值（阶段二已去除底栏重复缓存与额度项，保留独立上下文占比与回复尾标）
    const bars = h.api.getMultiPaneComposerBarsForTest();
    assert.equal(bars.length, 2, '双会话同屏必须分别挂载 2 条独立输入框状态条');
    const barA = bars.find(b => b.sessionId === sessA);
    const barB = bars.find(b => b.sessionId === sessB);
    assert.ok(barA && barB, '左右两会话必须各自匹配正确 sessionId');
    assert.equal(barA.contextText, '12%', `左会话上下文占比应为 12%，实际: ${barA.contextText}`);
    assert.equal(barB.contextText, '50%', `右会话上下文占比应为 50%，实际: ${barB.contextText}`);

    // 校验左右两边每条助手回复各自独立显示所属尾标（包括右会话第 2 轮「压缩已完成」）
    const footersA = collectMatches(paneA.pane, 'ag-cm-turn-footer');
    const footersB = collectMatches(paneB.pane, 'ag-cm-turn-footer');
    assert.equal(footersA.length, 2, '左会话 2 条回复必须各自有独立尾标');
    assert.equal(footersB.length, 2, '右会话 2 条回复必须各自有独立尾标');
    assert.match(footersA[0].textContent, /Gemini 4 Neon Medium.*0%/, `左第1轮尾标应归属 sessA，实际: ${footersA[0].textContent}`);
    assert.match(footersA[1].textContent, /Gemini 4 Neon Medium.*0%/, `左第2轮尾标应归属 sessA，实际: ${footersA[1].textContent}`);
    assert.match(footersB[0].textContent, /Claude Sonnet 4\.6.*80%/, `右第1轮尾标应归属 sessB，实际: ${footersB[0].textContent}`);
    assert.equal(footersB[1].getAttribute('data-ag-turn-footer-kind'), 'compaction', '右第2轮压缩轮次必须标记为 compaction 尾标');
    assert.match(footersB[1].textContent, /压缩已完成|Compaction done|壓縮已完成/, `右第2轮压缩尾标应简洁显示压缩已完成，实际: ${footersB[1].textContent}`);

    // 校验同会话双开：右窗格改为与左窗格相同的 sessA -> 共享实时数据且各自挂载独立 DOM 状态条与尾标
    paneB.pane.setAttribute('data-cascade-id', sessA);
    h.api.renderComposerStatusBarForTest();
    h.api.renderTurnFooterStatsForTest();
    const sameBars = h.api.getMultiPaneComposerBarsForTest();
    assert.equal(sameBars.length, 2, '同会话双开仍须为每个窗格挂载独立 DOM 底栏');
    assert.equal(sameBars[0].contextText, '12%');
    assert.equal(sameBars[1].contextText, '12%');
    assert.equal(collectMatches(paneB.pane, 'ag-cm-turn-footer').length, 2, '同会话双开第二个窗格的 2 条回复也必须独立渲染尾标');

    // 校验关闭第二个窗格后，旧克隆底栏被彻底清理
    paneB.pane.remove();
    h.api.renderComposerStatusBarForTest();
    assert.equal(h.api.getMultiPaneComposerBarsForTest().length, 1, '关闭分屏后必须清理不再存在的克隆底栏');
  } finally {
    h.dispose();
  }
});

test('Batch03 09:21 硬验收 10: 看板卡片 8 方向全方位调尺寸、上沿手柄真实缩放与紧凑下限任意高度保存', () => {
  // 10.1 源码契约：卡片必须同时创建 4 角 + 4 纯边共 8 个手柄，且最小高度下限已解除 140px 硬锁（<= 140）
  const minHeightMatch = GRID_SOURCE.match(/COCKPIT_MIN_HEIGHT\s*=\s*(\d+)/);
  assert.ok(minHeightMatch && Number(minHeightMatch[1]) > 0 && Number(minHeightMatch[1]) <= 140, `JS 最小自定义高度下限必须在 (0, 140] 内，实得 ${minHeightMatch?.[1]}`);
  assert.match(GRID_SOURCE, /vertical:\s*'top',\s*edge:\s*'left'/, '必须包含左上角缩放柄');
  assert.match(GRID_SOURCE, /vertical:\s*'top',\s*edge:\s*'right'/, '必须包含右上角缩放柄');
  assert.match(GRID_SOURCE, /vertical:\s*'bottom',\s*edge:\s*'left'/, '必须包含左下角缩放柄');
  assert.match(GRID_SOURCE, /axis:\s*'y',\s*vertical:\s*'top'/, '必须包含上沿纯纵向缩放柄');
  assert.match(GRID_SOURCE, /axis:\s*'y',\s*vertical:\s*'bottom'/, '必须包含下沿纯纵向缩放柄');
  assert.match(GRID_SOURCE, /axis:\s*'x',\s*edge:\s*'left'/, '必须包含左沿纯横向缩放柄');
  assert.match(GRID_SOURCE, /axis:\s*'x',\s*edge:\s*'right'/, '必须包含右沿纯横向缩放柄');
  assert.match(GRID_SOURCE, /allowX\s*=\s*resizeAxis\s*!==\s*'y'/, '纯水平边柄必须仅改宽不改高');
  assert.match(GRID_SOURCE, /allowY\s*=\s*resizeAxis\s*!==\s*'x'/, '纯垂直边柄必须仅改高不改宽');
  assert.match(GRID_SOURCE, /if \(!card\.classList\?\.contains\?\.\('is-resizing'\)\)/, '单列布局同步期间必须跳过正在缩放卡片的高度/位置覆写');

  // 10.2 collector 与前端任意自定义高度持久化校验（如 156px、140px 下限）
  const { savePluginSettings, getPluginSettings } = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-b03-card-resize-'));
  try {
    const saved = savePluginSettings({
      sessionCockpitLayout: {
        presetId: 'cockpit',
        widgets: [
          { id: 'overview-kpi', visible: true, span: 6, heightMode: 'custom', customHeightPx: 156, order: 0 },
          { id: 'agent-collab', visible: true, span: 6, heightMode: 'custom', customHeightPx: 140, order: 1 }
        ]
      }
    }, { agDir: tmpDir });
    assert.equal(saved.ok, true);
    const loaded = getPluginSettings({ agDir: tmpDir }).sessionCockpitLayout;
    const ov = loaded.widgets.find(w => w.id === 'overview-kpi');
    const col = loaded.widgets.find(w => w.id === 'agent-collab');
    assert.equal(ov.customHeightPx, 156, '任意自定义中间高度 156px 必须原样持久化不弹回固定档');
    assert.equal(col.customHeightPx, 140, '140px 下限高度必须被 collector 允许保存');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Batch03 03.html 接入 11: 新增三语文案零中英文括号且 collector 持久化工作区比例、会话权重并忽略历史手动折叠', () => {
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  const addedKeys = [
    'settings.dock.auxRatioCompact', 'settings.dock.auxRatioBalanced', 'settings.dock.auxRatioWide',
    'settings.dock.auxRatioCompactTitle', 'settings.dock.auxRatioBalancedTitle', 'settings.dock.auxRatioWideTitle',
    'settings.dock.auxTierNarrow', 'settings.dock.auxTierMedium', 'settings.dock.auxTierWide',
    'settings.dock.auxSessionSelectAria', 'settings.dock.auxLockFollow', 'settings.dock.auxLockPinned',
    'settings.dock.auxLockTitle', 'settings.dock.auxToastLocked', 'settings.dock.auxToastUnlocked',
    'settings.dock.auxToastResetOuter', 'settings.dock.auxToastResetSessions', 'settings.dock.auxToastWideCap',
    'settings.dock.auxToastWideBento', 'settings.dock.auxNarrowDegraded', 'settings.dock.auxNarrowRestore',
    'settings.dock.auxAutoFoldLabel', 'settings.dock.auxAutoFoldTitle',
    'settings.dock.auxRestoreSession', 'settings.dock.auxRulerSessions', 'settings.dock.auxRulerPlugin',
    'settings.dock.auxRulerBrowser', 'settings.dock.auxSubSplitterTitle', 'settings.dock.auxOuterSplitterTitle',
    'settings.dock.auxToastPresetCompact', 'settings.dock.auxToastPresetBalanced', 'settings.dock.auxToastPresetWide',
    'settings.dock.auxSessionIndexed', 'settings.dock.auxSessionTagLocked', 'settings.dock.auxSessionTagFocused'
  ];
  for (const key of addedKeys) {
    const m = i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{([^\\n}]+)\\}`));
    assert.ok(m, `i18n.js 必须包含词条 ${key}`);
    assert.doesNotMatch(m[1], /[()（）]/, `三语词条 ${key} 严禁包含任何中英文括号，实际: ${m[1]}`);
  }
  // 确认手动「收起会话／收纳此会话」词条已彻底移除
  assert.doesNotMatch(i18nSrc, /'settings\.dock\.auxFoldSession'/, '手动收起会话词条必须已删除');
  assert.doesNotMatch(i18nSrc, /'settings\.dock\.auxFoldSessionTitle'/, '手动收起会话标题词条必须已删除');

  const { savePluginSettings, getPluginSettings } = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-b03-ws-prefs-'));
  try {
    // 模拟历史旧配置文件中已残留 auxManualCollapsedPanes，兼容读取时必须忽略并返回空数组
    fs.writeFileSync(path.join(tmpDir, 'custom_plan_v1.json'), JSON.stringify({
      auxManualCollapsedPanes: ['pane-id-pane-2', 'pane-0-legacy']
    }), 'utf8');
    const legacyLoaded = getPluginSettings({ agDir: tmpDir });
    assert.deepEqual(legacyLoaded.auxManualCollapsedPanes, [], '旧配置中残留的 auxManualCollapsedPanes 读取时必须被忽略为空数组');

    const res = savePluginSettings({
      auxWidthPx: 1280,
      auxPluginSharePx: 540,
      auxRatios: {
        tripane: { sessions: 0.42, plugin: 0.28, browser: 0.30 },
        pluginOnly: { sessions: 0.64, plugin: 0.36 }
      },
      auxSessionWeights: { 'pane-id-p1': 1.35, 'pane-id-p2': 0.65 },
      auxAutoCollapseSessions: false,
      auxManualCollapsedPanes: ['pane-id-p2']
    }, { agDir: tmpDir });
    assert.equal(res.ok, true);
    const loaded = getPluginSettings({ agDir: tmpDir });
    assert.equal(loaded.auxWidthPx, 1280, '宽屏三栏 auxWidthPx=1280 必须被持久化保留');
    assert.equal(loaded.auxPluginSharePx, 540, 'auxPluginSharePx=540 必须被持久化保留');
    assert.deepEqual(loaded.auxRatios.tripane, { sessions: 0.42, plugin: 0.28, browser: 0.30 });
    assert.deepEqual(loaded.auxRatios.pluginOnly, { sessions: 0.64, plugin: 0.36 });
    assert.equal(loaded.auxSessionWeights['pane-id-p1'], 1.35);
    assert.equal(loaded.auxAutoCollapseSessions, false);
    assert.deepEqual(loaded.auxManualCollapsedPanes, [], '写盘后严禁继续持久化任何手动折叠记录');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Batch03 03.html 接入 12: browser-first 外左分隔条、先浏览器后插件并排、窄窗降级恢复与辅助栏重开防空白', () => {
  const h = createBatch03Harness({ innerWidth: 1600 });
  try {
    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    auxOuter.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });
    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.clientWidth = 780;
    auxInner.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    const webview = h.makeEl('webview');
    browserPane.appendChild(webview);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);
    h.body.appendChild(auxOuter);

    const findOwnInTree = (root, pred) => {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (pred(n)) out.push(n);
        for (const ch of (n.children || [])) walk(ch);
      };
      walk(root);
      return out;
    };
    let auxOpenNow = true;
    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('data-ag-ws-splitter="outer-left"')) {
        return findOwnInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left')[0] || null;
      }
      if (auxOpenNow && sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (auxOpenNow && sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('data-ag-ws-splitter="outer-left"')) {
        return findOwnInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left');
      }
      if (sel.includes('ag-ws-narrow-banner')) {
        return findOwnInTree(auxInner, n => String(n.className || '').includes('ag-ws-narrow-banner'));
      }
      if (auxOpenNow && sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (auxOpenNow && sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('webview')) return [webview];
      return [];
    };

    // 1. 先纯浏览器模式 -> 点击插件入口自动进入三栏共存 (both) 且不隐藏浏览器
    h.api.setDockPositionForTest('aux', { persist: false });
    h.api.setAuxViewTabForTest('browser', { persist: false });
    assert.equal(h.api.getAuxDockStateForTest().auxViewTab, 'browser');
    h.elements.get('badge').click();
    let st = h.api.getAuxDockStateForTest();
    assert.equal(st.auxViewTab, 'both', '先开浏览器再开插件在宽屏下必须自动并排进入 both');
    assert.equal(browserPane.style.display, '', '进入并排后原生浏览器必须保持可见');

    // 2. 切 browser-first：挂载宿主同级外左分隔条 (order:0) 并隐藏 Shadow 重复左缘 resizer
    h.api.setAuxOrderForTest('browser-first', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.hostOuterLeftSplitterPresent, true, 'browser-first 三栏必须挂载宿主同级外左分隔条');
    assert.equal(st.auxResizerHidden, true, 'browser-first 三栏必须隐藏 Shadow 内重复的 dock-aux-resizer');
    const outerLeft = h.sandbox.document.querySelector('[data-ag-ws-splitter="outer-left"]');
    assert.equal(outerLeft.style.order, '0', '宿主外左分隔条必须位于 order:0 贴紧会话组与浏览器之间');

    // 3. 切回 plugin-first：宿主外左分隔条必须被彻底卸载
    h.api.setAuxOrderForTest('plugin-first', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.hostOuterLeftSplitterPresent, false, '切回 plugin-first 必须移除宿主外左分隔条');
    assert.equal(st.auxResizerHidden, false, 'plugin-first 下 dock-aux-resizer 必须恢复可见');

    // 4. 窄窗临时降级与拉宽自动恢复（绝不污染 auxCollapsed）
    h.sandbox.window.innerWidth = 800;
    h.api.setAuxViewTabForTest('both', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.auxAutoDegradedTriPane, true, '窗口窄于三栏底线时必须触发临时降级');
    assert.equal(st.auxCollapsed, false, '窄窗临时降级严禁覆盖用户手动 auxCollapsed 标记');
    assert.equal(browserPane.style.display, '', '临时降级时必须保留原生浏览器可见');

    h.sandbox.window.innerWidth = 1600;
    h.api.setAuxViewTabForTest('both', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.auxAutoDegradedTriPane, false, '拉宽回 1600px 后必须自动退出降级并恢复三栏');
    assert.equal(st.auxTripaneAttr, 'true', '拉宽恢复后必须重回真三栏态');

    // 5. 比例预设与双击复位
    const presetRes = h.api.applyAuxRatioPresetForTest('wide', { persist: true, silent: true });
    assert.ok(presetRes.auxWidthPx >= 660 && presetRes.auxPluginSharePx >= 300);
    const resetRes = h.api.resetOuterWorkspaceRatiosForTest({ persist: true, silent: true });
    assert.ok(resetRes.auxWidthPx >= 660);

    // 6. 辅助栏关闭重开自动解除上次折叠态，杜绝 01-47-11.mp4 空白
    h.api.setAuxCollapsedForTest(true, { persist: false });
    assert.equal(h.api.getAuxDockStateForTest().auxCollapsed, true);
    auxOpenNow = false;
    h.api.setAuxViewTabForTest('plugin', { persist: false });
    auxOpenNow = true;
    h.api.setAuxViewTabForTest('plugin', { persist: false });
    assert.equal(h.api.getAuxDockStateForTest().auxCollapsed, false, '宿主辅助栏关闭重开后必须自动解除上次折叠防止空白');
  } finally {
    h.dispose();
  }
});

test('Batch03 03.html 接入 13: 3/4 会话不被误判辅助栏、移除手动收起按钮、窄窗自动降级与立即恢复、焦点同步与查看器锁定', () => {
  const sess1 = '11111111-1111-4111-8111-111111111111';
  const sess2 = '22222222-2222-4222-8222-222222222222';
  const sess3 = '33333333-3333-4333-8333-333333333333';
  const h = createBatch03Harness({
    innerWidth: 1600,
    pathname: `/c/${sess1}+${sess2}+${sess3}`,
    search: `?focused=${sess1}`
  });
  try {
    // 预写入历史旧版手动折叠缓存键，验证运行期完全忽略且不留竖条
    h.sandbox.localStorage.setItem('ag_aux_manual_collapsed_panes', JSON.stringify(['pane-id-p2']));

    const group = h.makeEl('div');
    group.clientWidth = 900;
    group.getBoundingClientRect = () => ({ left: 200, top: 40, right: 1100, bottom: 920, width: 900, height: 880 });

    const makePane = (pid, sid, left, focused) => {
      const p = h.makeEl('div');
      p.setAttribute('data-testid', 'conversation-view');
      p.setAttribute('data-pane-id', pid);
      p.setAttribute('data-cascade-id', sid);
      if (focused) p.setAttribute('data-focused', 'true');
      p.getBoundingClientRect = () => ({ left, top: 40, right: left + 300, bottom: 920, width: 300, height: 880 });
      const msgArea = h.makeEl('div');
      msgArea.className = 'message-stream-blank';
      p.appendChild(msgArea);
      const f = h.makeEl('form');
      f.className = 'surface-composer';
      f.getBoundingClientRect = () => ({ left: left + 10, top: 820, right: left + 290, bottom: 890, width: 280, height: 70 });
      const ed = h.makeEl('div');
      ed.setAttribute('contenteditable', 'true');
      ed.setAttribute('data-lexical-editor', 'true');
      f.appendChild(ed);
      p.appendChild(f);
      group.appendChild(p);
      return { p, f, ed, msgArea };
    };
    const p1 = makePane('p1', sess1, 200, true);
    const p2 = makePane('p2', sess2, 500, false);
    const p3 = makePane('p3', sess3, 800, false);
    h.body.appendChild(group);

    // 1. 第 2/3 会话窗格必须被 isChatWorkspacePaneNotAux 识别为会话而非辅助栏
    assert.equal(h.api.isChatWorkspacePaneNotAuxForTest(p2.p), true);
    assert.equal(h.api.isChatWorkspacePaneNotAuxForTest(p3.p), true);

    const prevQsa = h.sandbox.document.querySelectorAll;
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('surface-composer') || sel.includes('form')) return [p1.f, p2.f, p3.f];
      if (sel.includes('ag-ws-sub-splitter')) {
        return group.children.filter(c => String(c.className || '').includes('ag-ws-sub-splitter'));
      }
      if (sel.includes('ag-ws-fold-btn')) {
        const out = [];
        for (const ch of [p1.p, p2.p, p3.p]) {
          for (const sub of ch.children) if (String(sub.className || '').includes('ag-ws-fold-btn')) out.push(sub);
        }
        return out;
      }
      return prevQsa ? prevQsa(sel) : [];
    };

    // 2. 3 会话宽屏全部展开、挂载 2 条子分隔条，且零手动收起按钮
    h.api.syncMultiSessionWorkspacePanesForTest();
    let st = h.api.getAuxDockStateForTest();
    assert.equal(st.sessionSubSplitterCount, 2, '3 个展开会话之间必须挂载 2 条独立子分隔条');
    assert.equal(st.foldButtonCount, 0, '严禁注入任何手动「收起会话／收纳此会话」按钮');
    assert.deepEqual(Array.from(st.auxManualCollapsedPanes || []), [], '运行期手动折叠集合必须恒为空');
    assert.equal(p2.p.getAttribute('data-ag-ws-pane-folded'), null, '旧配置残留手动折叠不得让 p2 在宽屏变竖条');

    // 3. 极窄空间触发自动降级（保留焦点 p1，自动收纳最远非焦点会话），拉宽后必须立即全部恢复展开不留竖条
    group.clientWidth = 420;
    group.getBoundingClientRect = () => ({ left: 200, top: 40, right: 620, bottom: 920, width: 420, height: 880 });
    h.api.syncMultiSessionWorkspacePanesForTest();
    st = h.api.getAuxDockStateForTest();
    assert.ok(st.auxAutoCollapsedPanes.includes('pane-id-p3'), '极窄空间时必须自动收纳最远非焦点会话 p3');
    assert.equal(p1.p.getAttribute('data-ag-ws-pane-folded'), null, '焦点会话 p1 绝不可被自动收纳');

    // 拉宽回足够空间 -> 全部窗格立即恢复展开，绝不残留任何竖条
    group.clientWidth = 960;
    group.getBoundingClientRect = () => ({ left: 200, top: 40, right: 1160, bottom: 920, width: 960, height: 880 });
    h.api.syncMultiSessionWorkspacePanesForTest();
    st = h.api.getAuxDockStateForTest();
    assert.deepEqual(Array.from(st.auxAutoCollapsedPanes || []), [], '拉宽到足够空间后必须立即全部恢复，不留任何竖条');
    assert.equal(p2.p.getAttribute('data-ag-ws-pane-folded'), null);
    assert.equal(p3.p.getAttribute('data-ag-ws-pane-folded'), null);

    // 4. 输入框 / 消息区空白焦点同步（跟随 vs 锁定）
    h.api.syncFocusedWorkspacePaneFromTargetForTest(p2.msgArea);
    assert.equal(h.api.getConversationScopeStateForTest().activeRoute, sess2, '点击第二窗格消息区空白必须跟随切到 sess2');
    h.api.syncFocusedWorkspacePaneFromTargetForTest(p3.ed);
    assert.equal(h.api.getConversationScopeStateForTest().activeRoute, sess3, '聚焦第三窗格输入框必须跟随切到 sess3');

    // 查看器独立锁定：锁定 sess2 后，聚焦 p3 输入框与路由切换均不可抢跳查看器，解锁后立即恢复跟随
    h.api.setSessionViewerLockedForTest(sess2, { silent: true });
    assert.equal(h.api.getAuxDockStateForTest().lockedSessionId, sess2);
    h.api.syncFocusedWorkspacePaneFromTargetForTest(p1.ed);
    assert.equal(h.api.getConversationScopeStateForTest().activeRoute, sess2, '锁定时点击其他窗格输入框绝不可抢跳查看器');
    h.sandbox.location.search = `?focused=${sess3}`;
    h.api.tickForTest();
    assert.equal(h.api.getConversationScopeStateForTest().activeRoute, sess2, '锁定时左侧切焦点绝不可抢跳查看器');
    h.api.unlockSessionViewerForTest({ silent: true });
    assert.equal(h.api.getAuxDockStateForTest().lockedSessionId, null);
    assert.equal(h.api.getConversationScopeStateForTest().activeRoute, sess3, '解锁后查看器必须立刻恢复跟随焦点 sess3');
  } finally {
    h.dispose();
  }
});

test('Batch03 03.html 接入 14: host-settings 严格拒绝归档通知弹窗栈误判为宿主设置页', () => {
  const hsSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/host-settings.js'), 'utf8');
  assert.match(hsSrc, /conversation\\s\+archived|view\\s\+archived|对话已归档/i, 'host-settings 必须显式排除归档通知文本');
  assert.match(hsSrc, /aria-live/, 'host-settings 必须排除 aria-live 通知容器');
  assert.match(hsSrc, /matchedNavNames\.size\s*>=\s*2/, '无显式设置锚点时必须要求命中至少 2 个不同标准设置导航标签');
});

test('Batch03 生产修复 15: P0-1 关闭宿主右栏彻底释放历史占位与双分屏退回单会话零残留 50% 宽度', () => {
  const sess1 = '11111111-1111-4111-8111-111111111111';
  const sess2 = '22222222-2222-4222-8222-222222222222';
  const h = createBatch03Harness({ innerWidth: 1600, pathname: `/c/${sess1}+${sess2}`, search: `?focused=${sess1}` });
  try {
    // 1. 打开宿主右栏并设置宽度 780px
    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    auxOuter.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });
    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.clientWidth = 780;
    auxInner.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    const webview = h.makeEl('webview');
    browserPane.appendChild(webview);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);
    h.body.appendChild(auxOuter);

    let auxOpen = true;
    h.sandbox.document.querySelector = (sel) => {
      if (auxOpen && sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (auxOpen && sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (auxOpen && sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (auxOpen && sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('webview')) return [webview];
      return [];
    };

    h.api.setDockPositionForTest('aux', { persist: false });
    h.api.setAuxViewTabForTest('both', { persist: false });
    h.api.resizeAuxPanelForTest(780, { persist: false });
    assert.ok(auxOuter.style.width.endsWith('px'), '打开右栏并排后外层容器应写入受管宽度');

    // 2. 宿主关闭右栏（data-side-panel-open="false"，findAuxSidebarContainer() 返回 null）
    auxOpen = false;
    auxOuter.setAttribute('data-side-panel-open', 'false');
    h.api.tickForTest?.();
    h.api.setDockPositionForTest('aux', { persist: false });
    assert.equal(h.elements.get('panel').hidden, true, '关闭宿主右栏退回单会话时，原右栏停靠面板必须自动收起而非变成居中浮层挡住会话正文');
    h.api.setDockPositionForTest('topbar', { persist: false });
    assert.equal(auxOuter.style.width, '', '宿主关闭右栏后历史 width 必须彻底清零，杜绝右侧幽灵黑洞');
    assert.equal(auxOuter.style.minWidth, '', '宿主关闭右栏后历史 minWidth 必须彻底清零');
    assert.equal(auxOuter.style.flexBasis, '', '宿主关闭右栏后历史 flexBasis 必须彻底清零');
    assert.equal(auxOuter.getAttribute('data-ag-aux-sized'), null, '关闭右栏后受管标记必须移除');

    // 3. 双会话退回单会话：原双会话 slot 曾记录 width="50%"，切回单会话后绝不可把 50% 写回导致单会话被锁左半屏
    const group = h.makeEl('div');
    group.clientWidth = 1200;
    group.getBoundingClientRect = () => ({ left: 200, top: 40, right: 1400, bottom: 920, width: 1200, height: 880 });
    const mkPane = (pid, sid) => {
      const p = h.makeEl('div');
      p.setAttribute('data-testid', 'conversation-view');
      p.setAttribute('data-pane-id', pid);
      p.setAttribute('data-cascade-id', sid);
      p.style.width = '50%';
      const f = h.makeEl('form');
      f.className = 'surface-composer';
      const ed = h.makeEl('div');
      ed.setAttribute('contenteditable', 'true');
      f.appendChild(ed);
      p.appendChild(f);
      group.appendChild(p);
      return { p, f };
    };
    const s1 = mkPane('s1', sess1);
    const s2 = mkPane('s2', sess2);
    h.body.appendChild(group);
    let forms = [s1.f, s2.f];
    h.sandbox.document.querySelectorAll = (sel) => (sel.includes('surface-composer') || sel.includes('form') ? forms : []);

    h.api.syncMultiSessionWorkspacePanesForTest();
    assert.equal(s1.p.getAttribute('data-ag-ws-pane-styled'), 'true');
    // 关闭第二个会话回到单会话
    s2.p.remove();
    forms = [s1.f];
    h.api.syncMultiSessionWorkspacePanesForTest();
    assert.equal(s1.p.style.width, '', '双会话关闭回到单会话后必须清空旧 50% 宽度，让单会话占满全部空间');
    assert.equal(s1.p.style.flex, '', '单会话恢复时必须清空受管 flex 样式');
  } finally {
    h.dispose();
  }
});

test('Batch03 生产修复 16: P0-2 多宿主子节点启用 CSS Grid 零黑墙与 1600px 窄窗恢复严守 Browser >= 320px', () => {
  const h = createBatch03Harness({ innerWidth: 1600 });
  try {
    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    auxOuter.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });
    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.clientWidth = 780;
    auxInner.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 960, width: 780, height: 922 });

    // 真实 Antigravity 2.35.2 多纵向宿主直系子节点：顶部 strip + Browser 主体
    const hostStrip = h.makeEl('div');
    hostStrip.setAttribute('data-side-panel-strip', 'true');
    hostStrip.textContent = 'Browser · Review · Terminal';
    hostStrip.getBoundingClientRect = () => ({ left: 820, top: 38, right: 1600, bottom: 74, width: 780, height: 36 });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    browserPane.getBoundingClientRect = () => ({ left: 820, top: 74, right: 1600, bottom: 960, width: 780, height: 886 });
    const webview = h.makeEl('webview');
    browserPane.appendChild(webview);

    auxInner.appendChild(hostStrip);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);
    h.body.appendChild(auxOuter);

    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('webview')) return [webview];
      return [];
    };

    h.api.setDockPositionForTest('aux', { persist: false });
    h.api.setAuxViewTabForTest('both', { persist: false });

    // 1. 多宿主子节点必须走 CSS Grid 归拢同列（gridColumn='2'），绝不横向劈成 380px 黑空墙
    const stGrid = h.api.getAuxDockStateForTest();
    assert.equal(stGrid.auxGridModeActive, true, '多宿主直系子节点三栏共存必须启用 CSS Grid 归拢');
    assert.equal(auxInner.style.display, 'grid');
    assert.equal(hostStrip.style.gridColumn, '2', '宿主顶部 strip 必须归拢在 Browser 同列');
    assert.equal(browserPane.style.gridColumn, '2', '宿主 Browser 主体必须归拢在同列');
    assert.equal(hostStrip.style.gridRow, '1');
    assert.equal(browserPane.style.gridRow, '2');
    assert.equal(h.host.style.gridColumn, '1', 'plugin-first 下插件占第 1 列并跨全高');
    assert.equal(h.host.style.gridRow, '1 / -1');

    // 互换至 browser-first 仍不移动/重建任何宿主 DOM
    h.api.setAuxOrderForTest('browser-first', { persist: false });
    assert.equal(h.host.style.gridColumn, '3', 'browser-first 下插件占第 3 列');
    assert.equal(browserPane.style.gridColumn, '2', 'browser-first 下宿主 Browser 仍在第 2 列');
    assert.equal(auxInner.children.includes(browserPane), true, '互换严禁移除或重建宿主节点');
    h.api.setAuxOrderForTest('plugin-first', { persist: false });

    // 2. 复现上轮夹具缺口：压测态 auxWidthPx=680、auxPluginSharePx=406 -> 缩窄(800px)降级再恢复 1600px，必须夹紧确保 Browser >= 320px
    h.api.resizeAuxPanelForTest(680, { persist: false });
    h.api.setAuxPluginShareForTest(406, { persist: false });
    h.sandbox.window.innerWidth = 800;
    h.api.setAuxViewTabForTest('both', { persist: false });
    assert.equal(h.api.getAuxDockStateForTest().auxAutoDegradedTriPane, true);

    h.sandbox.window.innerWidth = 1600;
    h.api.setAuxViewTabForTest('both', { persist: false });
    const restored = h.api.getAuxDockStateForTest();
    assert.equal(restored.auxAutoDegradedTriPane, false);
    const sepReserve = restored.auxOrder === 'browser-first' ? 1 : 0;
    const restoredBrowserW = restored.auxWidthPx - restored.auxPluginSharePx - sepReserve;
    assert.ok(restored.auxPluginSharePx >= 300, `1600px 恢复后插件宽必须 >= 300px，实际 ${restored.auxPluginSharePx}`);
    assert.ok(restoredBrowserW >= 320, `1600px 恢复后 Browser 宽必须 >= 320px，实际 ${restoredBrowserW}（total=${restored.auxWidthPx}, plug=${restored.auxPluginSharePx}）`);
  } finally {
    h.dispose();
  }
});

test('Batch03 生产修复 17: P0-3 悬浮球零交集避让、440px/680px 断点重排与 PR #121 矮窗无 form 挂载', () => {
  const h = createBatch03Harness({ innerWidth: 1280, innerHeight: 420 });
  try {
    // 1. 验证 440px / 680px 两档 auxTier 在窄、中、宽三态准确切换
    const panel = h.elements.get('panel');
    panel.hidden = false;
    panel.getBoundingClientRect = () => ({ left: 880, top: 40, right: 1260, bottom: 420, width: 380, height: 380 });
    h.host.getBoundingClientRect = () => ({ left: 880, top: 40, right: 1260, bottom: 420, width: 380, height: 380 });
    h.api.setPanelWidthForTest(380);
    assert.equal(h.host.getAttribute('data-aux-tier'), 'narrow', '380px 必须命中 narrow');
    assert.equal(panel.getAttribute('data-aux-tier'), 'narrow');

    h.api.setPanelWidthForTest(480);
    assert.equal(h.host.getAttribute('data-aux-tier'), 'medium', '480px (>=440) 必须命中 medium');
    assert.equal(panel.getAttribute('data-aux-tier'), 'medium');

    h.api.setPanelWidthForTest(720);
    assert.equal(h.host.getAttribute('data-aux-tier'), 'wide', '720px (>=680) 必须命中 wide');
    assert.equal(panel.getAttribute('data-aux-tier'), 'wide');

    // 2. 悬浮球避让：右下角存在无 <form> 输入框 + 发送按钮 + 右栏 -> 计算出的悬浮球坐标不得与任何禁区相交
    const orb = h.elements.get('ctx-radial-orb');
    const compBox = h.makeEl('div');
    compBox.className = 'surface-composer';
    compBox.getBoundingClientRect = () => ({ left: 480, top: 310, right: 920, bottom: 410, width: 440, height: 100 });
    const sendBtn = h.makeEl('button');
    sendBtn.setAttribute('data-testid', 'send-button');
    sendBtn.getBoundingClientRect = () => ({ left: 870, top: 360, right: 912, bottom: 400, width: 42, height: 40 });
    compBox.appendChild(sendBtn);
    const fakeAux = h.makeEl('div');
    fakeAux.setAttribute('data-side-panel-open', 'true');
    fakeAux.getBoundingClientRect = () => ({ left: 940, top: 38, right: 1280, bottom: 420, width: 340, height: 382 });
    h.body.appendChild(compBox);
    h.body.appendChild(fakeAux);

    h.sandbox.document.querySelector = (sel) => (sel.includes('data-side-panel-open') ? fakeAux : null);
    h.sandbox.document.querySelectorAll = (sel) => {
      const out = [];
      if (sel.includes('surface-composer')) out.push(compBox);
      if (sel.includes('send-button')) out.push(sendBtn);
      if (sel.includes('data-side-panel-open')) out.push(fakeAux);
      return out;
    };
    h.api.applyOrbPositionToDomForTest();
    const ox = Number.parseFloat(orb.style.left || '0');
    const oy = Number.parseFloat(orb.style.top || '0');
    const orbRect = { left: ox, top: oy, right: ox + 44, bottom: oy + 44 };
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    assert.equal(overlaps(orbRect, compBox.getBoundingClientRect()), false, `悬浮球 (${ox},${oy}) 严禁与输入框相交`);
    assert.equal(overlaps(orbRect, sendBtn.getBoundingClientRect()), false, `悬浮球 (${ox},${oy}) 严禁与发送按钮相交`);
    assert.equal(overlaps(orbRect, fakeAux.getBoundingClientRect()), false, `悬浮球 (${ox},${oy}) 严禁与右侧栏相交`);

    // 3. PR #121：矮窗（innerHeight=420）+ 无 <form> 纯 contenteditable + 开关关得掉且重开只有一个且不抢焦点
    const csb = h.elements.get('composer-status-bar');
    const colWrap = h.makeEl('div');
    const noFormComp = h.makeEl('div');
    noFormComp.className = 'surface-composer';
    noFormComp.getBoundingClientRect = () => ({ left: 40, top: 220, right: 440, bottom: 380, width: 400, height: 160 });
    const ed = h.makeEl('div');
    ed.setAttribute('data-lexical-editor', 'true');
    ed.setAttribute('contenteditable', 'true');
    ed.textContent = '长草稿测试'.repeat(60);
    noFormComp.appendChild(ed);
    colWrap.appendChild(noFormComp);
    h.body.appendChild(colWrap);
    h.sandbox.document.activeElement = ed;
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('surface-composer') || sel.includes('data-lexical-editor')) return [noFormComp];
      return [];
    };
    h.sandbox.document.querySelector = () => null;
    h.api.setRadialBottombarEnabledForTest(true);
    h.api.renderComposerStatusBarForTest();
    assert.equal(csb.hidden, false, 'PR #121: 矮窗无 form 长草稿的合法纵向 composer 必须正常挂载底栏');
    assert.equal(noFormComp.nextElementSibling, csb, 'PR #121: 底栏必须挂载在无 form composer 之后');
    assert.equal(h.sandbox.document.activeElement, ed, 'PR #121: 挂载底栏严禁抢走输入框焦点');

    // 关掉底栏开关 -> 立即隐藏；重开 -> 仍只有 1 条且焦点仍在编辑器
    h.api.setRadialBottombarEnabledForTest(false);
    h.api.renderComposerStatusBarForTest();
    assert.equal(csb.hidden, true, 'PR #121: 关闭开关必须立刻隐藏底栏');
    h.api.setRadialBottombarEnabledForTest(true);
    h.api.renderComposerStatusBarForTest();
    assert.equal(csb.hidden, false, 'PR #121: 重开底栏必须恢复显示');
    assert.equal(colWrap.children.filter(c => c === csb).length, 1, 'PR #121: 重开后只能存在唯一 1 条底栏');
    assert.equal(h.sandbox.document.activeElement, ed, 'PR #121: 重开底栏严禁抢走输入框焦点');

    // 4. 分隔条命中层级防退化：外/内分隔条必须全部落在容器安全热区内且 z-index 严格高于停靠态 .ag-panel
    assert.match(STYLES_SOURCE, /\.dock-aux-resizer,[\s\S]*z-index:\s*2147483560\s*!important/, '外/内分隔条 z-index 必须严格高于停靠态面板');
    assert.match(STYLES_SOURCE, /:host\(\[data-dock="aux"\]\)\s+\.ag-panel\[data-panel-docked="true"\][\s\S]*z-index:\s*1\s*!important/, '停靠态面板不得以高 z-index 压死外/内分隔条');
  } finally {
    h.dispose();
  }
});

test('Batch03 闭环修复 18: 顶栏锁定精简控件、原生中性灰分隔线、纯原生三窗零侵入与双侧竖线零和宽度守恒', () => {
  // 1. 静态契约：移除蓝色均衡与冗余按钮、三语零括号、分隔线零亮绿/蓝紫/粗胶囊
  for (const removedId of [
    'btn-dock-aux-ratio-compact',
    'btn-dock-aux-ratio-balanced',
    'btn-dock-aux-ratio-wide',
    'btn-dock-aux-layout-mode',
    'btn-dock-aux-collapse',
    'btn-dock-aux-copy-url',
    'btn-dock-aux-external',
    'btn-dock-aux-back',
    'btn-dock-aux-view-plugin',
    'btn-dock-aux-view-both',
    'btn-dock-aux-view-browser',
    'btn-dock-aux-swap-order'
  ]) {
    assert.doesNotMatch(TEMPLATE_SOURCE, new RegExp(`id="${removedId}"`), `插件内部模板必须移除冗余或迁出的旧按钮 ${removedId}`);
  }
  assert.doesNotMatch(TEMPLATE_SOURCE, /ag-v2-splitter-pill/, '分隔线模板不得残留突兀粗胶囊 Pill 抓手');

  // 校验分隔线样式 100% 还原原客户端低饱和度中性灰（零 #22e09b 亮绿 / 蓝紫）
  const splitterBlockMatch = STYLES_SOURCE.match(/\.dock-aux-resizer,[\s\S]*?\.dock-aux-inner-resizer\[hidden\]\s*\{[\s\S]*?\}/);
  assert.ok(splitterBlockMatch, 'styles.css 必须包含 .dock-aux-resizer / .dock-aux-inner-resizer 样式块');
  assert.doesNotMatch(splitterBlockMatch[0], /#22e09b|34,\s*224,\s*155|#6366f1|#8b5cf6|ag-v2-splitter-pill/i, 'Shadow 分隔线严禁残留亮绿/蓝紫或粗胶囊样式');
  assert.match(splitterBlockMatch[0], /width:\s*7px;/, 'Shadow 分隔线必须保留 6px-8px 透明可抓热区');
  assert.match(splitterBlockMatch[0], /width:\s*1px;/, 'Shadow 分隔线视觉细线常态必须为 1px');

  const mainSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/main.js'), 'utf8');
  const hostWsBlock = mainSrc.match(/function ensureHostWorkspaceStyles\(\)[\s\S]*?document\.head\.appendChild\(st\);/);
  assert.ok(hostWsBlock, 'main.js 必须包含 ensureHostWorkspaceStyles');
  assert.doesNotMatch(hostWsBlock[0], /#22e09b|34,\s*224,\s*155|ag-ws-splitter-pill/i, '宿主级分隔线严禁残留亮绿或粗胶囊 Pill');
  assert.match(hostWsBlock[0], /#ag-topbar-ws-controls\{[^}]*flex-wrap:nowrap !important[^}]*white-space:nowrap !important/, '顶栏锁定控件必须强制单行不折行');

  // 校验本批新增及修改的简中/繁中/英文可见文案严格零中英文括号
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/i18n.js'), 'utf8');
  for (const key of [
    'settings.dock.auxTabPlugin',
    'settings.dock.auxViewBoth',
    'settings.dock.auxTabBrowser',
    'settings.dock.auxSwapOrder',
    'settings.dock.auxSwapOrderTitle',
    'settings.dock.auxTopbarControlsAria',
    'settings.dock.auxOuterSplitterTitle'
  ]) {
    const m = i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{([^\\n}]+)\\}`));
    assert.ok(m, `i18n.js 必须包含词条 ${key}`);
    assert.doesNotMatch(m[1], /[()（）]/, `三语词条 ${key} 严禁包含任何中英文括号，实际: ${m[1]}`);
  }

  // 2. 运行时 DOM 完整双会话 + 原生浏览器 + 插件 1440px 工作区闭环测试
  const sess1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const sess2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const h = createBatch03Harness({
    innerWidth: 1440,
    innerHeight: 900,
    pathname: `/c/${sess1}+${sess2}`,
    search: `?focused=${sess1}`
  });
  try {
    const winListeners = new Map();
    h.sandbox.window.addEventListener = (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    };
    h.sandbox.window.removeEventListener = (type, fn) => {
      winListeners.get(type)?.delete(fn);
    };
    const triggerWin = (type, ev = {}) => {
      for (const fn of Array.from(winListeners.get(type) || [])) fn(ev);
    };

    // 最上方稳定顶栏 [data-testid="title-menu-bar"]（全窗 1440px）
    const titleMenuBar = h.makeEl('div');
    titleMenuBar.setAttribute('data-testid', 'title-menu-bar');
    titleMenuBar.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 32, width: 1440, height: 32 });
    h.body.appendChild(titleMenuBar);

    // 共同横向工作区容器 workspaceRow（严格宽 W_total = 1440px）
    const workspaceRow = h.makeEl('div');
    workspaceRow.clientWidth = 1440;
    workspaceRow.getBoundingClientRect = () => ({ left: 0, top: 32, right: 1440, bottom: 900, width: 1440, height: 868 });

    // 左侧双会话槽位 leftGroup（包 S1 + S2，模拟真实浏览器 Flex 弹性主列：未写死 width 时自动填满 1440 - auxW）
    const leftGroup = h.makeEl('div');
    const parsePx = (v, fallback) => {
      const m = String(v || '').match(/^(-?\d+(?:\.\d+)?)px$/);
      return m ? Number(m[1]) : fallback;
    };
    leftGroup.getBoundingClientRect = () => {
      const explicitW = parsePx(leftGroup.style.width, null);
      const auxWNow = auxOuter.getAttribute('data-side-panel-open') === 'true' ? parsePx(auxOuter.style.width, 420) : 0;
      const w = explicitW != null ? explicitW : Math.max(0, 1440 - auxWNow);
      return { left: 0, top: 32, right: w, bottom: 900, width: w, height: 868 };
    };
    Object.defineProperty(leftGroup, 'clientWidth', { get: () => leftGroup.getBoundingClientRect().width, configurable: true });

    const makeSess = (pid, sid, focused) => {
      const p = h.makeEl('div');
      p.setAttribute('data-testid', 'conversation-view');
      p.setAttribute('data-pane-id', pid);
      p.setAttribute('data-cascade-id', sid);
      if (focused) p.setAttribute('data-focused', 'true');
      p.getBoundingClientRect = () => {
        const half = Math.round(leftGroup.getBoundingClientRect().width / 2);
        return { left: pid === 's1' ? 0 : half, top: 32, right: pid === 's1' ? half : leftGroup.getBoundingClientRect().width, bottom: 900, width: half, height: 868 };
      };
      const f = h.makeEl('form');
      f.className = 'surface-composer';
      f.getBoundingClientRect = () => ({ left: 10, top: 810, right: 260, bottom: 880, width: 250, height: 70 });
      const ed = h.makeEl('div');
      ed.setAttribute('contenteditable', 'true');
      ed.setAttribute('data-lexical-editor', 'true');
      f.appendChild(ed);
      p.appendChild(f);
      leftGroup.appendChild(p);
      return { p, f };
    };
    const s1 = makeSess('s1', sess1, true);
    const s2 = makeSess('s2', sess2, false);

    // 右侧辅助区 auxOuter > auxInner > browserPane(webview)
    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    auxOuter.getBoundingClientRect = () => {
      const w = parsePx(auxOuter.style.width, 800);
      return { left: 1440 - w, top: 32, right: 1440, bottom: 900, width: w, height: 868 };
    };
    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.getBoundingClientRect = () => auxOuter.getBoundingClientRect();
    Object.defineProperty(auxInner, 'clientWidth', { get: () => auxOuter.getBoundingClientRect().width, configurable: true });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    const webview = h.makeEl('webview');
    webview.style.pointerEvents = 'auto';
    browserPane.appendChild(webview);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);

    workspaceRow.appendChild(leftGroup);
    workspaceRow.appendChild(auxOuter);
    h.body.appendChild(workspaceRow);

    const findInTree = (root, pred, out = []) => {
      if (!root) return out;
      if (pred(root)) out.push(root);
      for (const ch of (root.children || [])) findInTree(ch, pred, out);
      return out;
    };
    h.sandbox.document.getElementById = (id) => findInTree(h.body, n => n.id === id)[0] || findInTree(h.sandbox.document.head, n => n.id === id)[0] || null;
    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('title-menu-bar')) return titleMenuBar;
      if (sel.includes('data-ag-ws-splitter="outer-left"')) return findInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left')[0] || null;
      if (sel.includes('ag-topbar-ws-controls')) return findInTree(h.body, n => n.id === 'ag-topbar-ws-controls')[0] || null;
      if (sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('surface-composer') || sel.includes('form')) return [s1.f, s2.f];
      if (sel.includes('conversation-view')) return [s1.p, s2.p];
      if (sel.includes('webview')) return [webview];
      if (sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('ag-ws-sub-splitter')) return findInTree(leftGroup, n => String(n.className || '').includes('ag-ws-sub-splitter'));
      if (sel.includes('data-ag-ws-splitter="outer-left"')) return findInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left');
      if (sel.includes('data-ag-ws-topbar-controls')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-topbar-controls') === 'true');
      return [];
    };

    // === 场景 1: 纯原生三窗（双会话 + 浏览器、未开启上下文插件 flow 模式）100% 零侵入 ===
    h.api.setDockPositionForTest('flow', { persist: false });
    h.api.syncMultiSessionWorkspacePanesForTest({ force: false });
    let st = h.api.getAuxDockStateForTest();
    assert.equal(st.pluginWorkspaceLayoutActive, false);
    assert.equal(st.topbarWsControls.present, false, '未开启上下文插件时不得挂载顶栏布局控制组');
    assert.equal(st.sessionSubSplitterCount, 0, '纯原生三窗严禁注入插件会话子分隔线');
    assert.equal(st.hostOuterLeftSplitterPresent, false, '纯原生三窗严禁注入外左分隔线');
    assert.equal(leftGroup.style.width || '', '', '纯原生三窗严禁改写左侧会话槽位宽');
    assert.equal(auxOuter.style.width || '', '', '纯原生三窗严禁改写右侧浏览器槽位宽');
    assert.equal(s1.p.style.flex || '', '', '纯原生三窗严禁改写 S1 样式');
    assert.equal(s2.p.style.flex || '', '', '纯原生三窗严禁改写 S2 样式');
    assert.equal(browserPane.style.display || '', '', '纯原生浏览器必须保持原生可见');

    // === 场景 2: 开启插件并排（双会话 | 左竖线#1 | 插件 | 右竖线#2 | 浏览器）===
    h.api.setDockPositionForTest('aux', { persist: false });
    h.api.setAuxViewTabForTest('both', { persist: false });
    // 设定确定初始宽度：W_total = 1440 -> 双会话 640px、插件 400px、浏览器 400px（auxW = 800px）
    h.api.resizeAuxPanelForTest(800, { persist: false });
    h.api.setAuxPluginShareForTest(400, { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.topbarWsControls.present, false, '阶段二收敛后标题栏严禁再挂载冗余 4 枚按钮控件组');
    let g = st.workspaceConservedGeometry;
    assert.equal(g.totalW, 1440);
    assert.equal(g.sessionsW, 640);
    assert.equal(g.pluginW, 400);
    assert.equal(g.browserW, 400);
    assert.equal(g.sessionsW + g.pluginW + g.browserW + g.nativeSepW + g.auxSepW, 1440, '初始三栏宽度总和必须严格等于 W_total=1440');
    assert.equal(g.overflowPx, 0);
    assert.equal(leftGroup.style.width, '', '弹性主列严禁写死固定像素 width 死锁');
    assert.equal(leftGroup.style.flex, '1 1 0px', '左侧会话槽位必须以弹性 flex 填满剩余空间');
    assert.equal(auxOuter.style.width, '800px');

    // === 场景 3: 拖动左竖线 #1（dock-aux-resizer）向左 -120px 与向右 +90px + 越界硬边界钳位 ===
    const leftSep = h.elements.get('dock-aux-resizer');
    leftSep.dispatchEvent({ type: 'pointerdown', pointerId: 11, button: 0, isPrimary: true, clientX: 640, preventDefault() { } });
    assert.equal(webview.style.pointerEvents, 'none', '拖动左竖线期间必须对 webview 施加 pointer-events: none');
    // 向左拖 120px -> 插件 +120 (=520)，左侧双会话 -120 (=520)，右侧浏览器保持 400 不变
    triggerWin('pointermove', { clientX: 520 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, 520, '左竖线左拖 120px 后左侧双会话区必须严格缩小 120px');
    assert.equal(g.pluginW, 520, '左竖线左拖 120px 后插件必须严格增大 120px');
    assert.equal(g.browserW, 400, '左竖线拖动期间右侧浏览器必须保持 400px 不变');
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    assert.equal(leftGroup.style.width, '', '拖动期间左侧双会话外容器保持弹性补位');
    assert.equal(leftGroup.style.flex, '1 1 0px');
    assert.equal(auxOuter.style.width, '920px');

    // 暴力向左拖 -2000px 撞左边界：必须原地钳位在双会话安全下限停住，绝不溢出 W_total
    triggerWin('pointermove', { clientX: -1360 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, g.minSess, '左拖触达左会话最小安全宽必须原地钳位');
    assert.equal(g.browserW, 400, '越界左拖右侧浏览器仍保持不变');
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);

    // 往右拖至插件最小宽度 300px（从 640 右移 +500）
    triggerWin('pointermove', { clientX: 1140 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.pluginW, 300, '左竖线右拖触达插件最小宽 300px 必须钳位');
    assert.equal(g.sessionsW, 740, '插件缩至 300px 后左侧会话等量增至 740px');
    assert.equal(g.browserW, 400);
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    // 阶段二收敛后标题栏不再挂载旧顶栏控件组
    const stMin = h.api.getAuxDockStateForTest();
    assert.equal(stMin.topbarWsControls.present, false);
    triggerWin('pointerup', { clientX: 1140 });
    assert.equal(webview.style.pointerEvents, 'auto', '松手后必须 100% 恢复 webview pointer-events');

    // === 场景 4: 拖动右竖线 #2（dock-aux-inner-resizer）向右 +60px 与越界钳位（左侧会话不变）===
    // 先恢复到 640 / 400 / 400
    h.api.resizeAuxPanelForTest(800, { persist: false });
    h.api.setAuxPluginShareForTest(400, { persist: false });
    h.host.getBoundingClientRect = () => ({ left: 640, top: 32, right: 1040, bottom: 900, width: 400, height: 868 });
    const rightSep = h.elements.get('dock-aux-inner-resizer');
    rightSep.dispatchEvent({ type: 'pointerdown', pointerId: 12, button: 0, isPrimary: true, clientX: 1040, preventDefault() { } });
    assert.equal(webview.style.pointerEvents, 'none');
    // 向右拖 +60px -> 插件 +60 (=460)，浏览器 -60 (=340)，左侧双会话 640 纹丝不动
    triggerWin('pointermove', { clientX: 1100 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, 640, '右竖线拖动期间左侧双会话必须保持 640px 不变');
    assert.equal(g.pluginW, 460);
    assert.equal(g.browserW, 340);
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    // 暴力向右拖 +2000px 撞右边界：浏览器稳停 320px，插件 480px，会话 640px，绝不顶出屏幕右边界
    triggerWin('pointermove', { clientX: 3040 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, 640);
    assert.equal(g.browserW, 320, '右竖线暴力右拖必须在浏览器 320px 最小宽原地停住，严禁顶出右边界');
    assert.equal(g.pluginW, 480);
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    // Escape 取消恢复拖动前尺寸并 100% 还原 webview pointer-events
    triggerWin('keydown', { key: 'Escape', preventDefault() { } });
    assert.equal(webview.style.pointerEvents, 'auto', '按 Escape 取消拖动也必须 100% 恢复 webview pointer-events');
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.pluginW, 400);
    assert.equal(g.browserW, 400);

    // === 场景 5: 切到 browser-first（双会话 | 浏览器 | 插件），不销毁浏览器 DOM 且双竖线对称守恒 ===
    const browserRefBefore = browserPane;
    const webviewRefBefore = webview;
    h.api.setAuxOrderForTest('browser-first', { persist: false });
    assert.equal(h.api.getAuxDockStateForTest().auxOrder, 'browser-first');
    assert.equal(browserPane, browserRefBefore, '互换位置严禁销毁重建宿主浏览器 DOM');
    assert.equal(webview, webviewRefBefore, '互换位置严禁销毁重建 webview');
    assert.equal(auxInner.children.includes(browserPane), true);
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);

    // browser-first 左竖线（outer-left，会话 | 浏览器）：向左拖 -80px -> 浏览器 +80，会话 -80，插件不变
    const outerLeftSep = findInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left')[0];
    assert.ok(outerLeftSep, 'browser-first 必须存在外左分隔条');
    const beforeBf = { ...h.api.getAuxDockStateForTest().workspaceConservedGeometry };
    outerLeftSep.dispatchEvent({ type: 'pointerdown', pointerId: 13, button: 0, isPrimary: true, clientX: beforeBf.sessionsW, preventDefault() { } });
    triggerWin('pointermove', { clientX: beforeBf.sessionsW - 80 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, beforeBf.sessionsW - 80, 'browser-first 左竖线左拖 80px 会话区严格减 80px');
    assert.equal(g.browserW, beforeBf.browserW + 80, 'browser-first 左竖线左拖 80px 浏览器严格增 80px');
    assert.equal(g.pluginW, beforeBf.pluginW, 'browser-first 左竖线拖动期间最右插件保持不变');
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    triggerWin('pointerup', { clientX: beforeBf.sessionsW - 80 });

    // browser-first 右竖线（dock-aux-inner-resizer，浏览器 | 插件）：向左拖 -70px -> 插件 +70，浏览器 -70，会话不变
    const beforeBfInner = { ...h.api.getAuxDockStateForTest().workspaceConservedGeometry };
    h.host.getBoundingClientRect = () => ({ left: 1440 - beforeBfInner.pluginW, top: 32, right: 1440, bottom: 900, width: beforeBfInner.pluginW, height: 868 });
    rightSep.dispatchEvent({ type: 'pointerdown', pointerId: 14, button: 0, isPrimary: true, clientX: 1440 - beforeBfInner.pluginW, preventDefault() { } });
    triggerWin('pointermove', { clientX: 1440 - beforeBfInner.pluginW - 70 });
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, beforeBfInner.sessionsW, 'browser-first 右竖线拖动期间左侧会话保持不变');
    assert.equal(g.pluginW, beforeBfInner.pluginW + 70, 'browser-first 右竖线左拖 70px 插件严格增 70px');
    assert.equal(g.browserW, beforeBfInner.browserW - 70, 'browser-first 右竖线左拖 70px 浏览器严格减 70px');
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    triggerWin('pointerup', { clientX: 1440 - beforeBfInner.pluginW - 70 });

    // === 场景 6: 切到单浏览器彻底退出工作区布局流（纯原生零占位） ===
    h.api.setAuxViewTabForTest('browser', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(st.auxViewTab, 'browser');
    assert.equal(st.pluginWorkspaceLayoutActive, false);
    assert.equal(st.sessionSubSplitterCount, 0, '单浏览器态必须清除全部插件会话子分隔线');
    assert.equal(st.hostOuterLeftSplitterPresent, false, '单浏览器态必须清除外左分隔线');
    assert.equal(leftGroup.style.width, '', '单浏览器态必须 100% 释放左会话槽位宽度覆盖');
    assert.equal(auxOuter.style.width, '', '单浏览器态必须 100% 释放右浏览器槽位宽度覆盖');
    assert.equal(browserPane.style.display, '', '单浏览器态原生浏览器立即可见');
    assert.equal(st.topbarWsControls.present, false, '阶段二收敛后标题栏不再挂载旧控件组');

    // === 场景 7: 扁平同级双会话（workspaceRow 直接含 [S1, S2, auxOuter]）左竖线左拖同步挤压两会话 ===
    h.api.setAuxViewTabForTest('both', { persist: false });
    h.api.setAuxOrderForTest('plugin-first', { persist: false });
    // 切换为扁平结构
    leftGroup.remove();
    s1.p.getBoundingClientRect = () => ({ left: 0, top: 32, right: 320, bottom: 900, width: 320, height: 868 });
    s2.p.getBoundingClientRect = () => ({ left: 320, top: 32, right: 640, bottom: 900, width: 320, height: 868 });
    workspaceRow.insertBefore(s1.p, auxOuter);
    workspaceRow.insertBefore(s2.p, auxOuter);
    h.api.resizeAuxPanelForTest(800, { persist: false });
    h.api.setAuxPluginShareForTest(400, { persist: false });
    assert.equal(s1.p.style.width, '');
    assert.equal(s2.p.style.width, '');
    assert.equal(s1.p.style.flex, '1 1 0px');
    assert.equal(s2.p.style.flex, '1 1 0px');
    leftSep.dispatchEvent({ type: 'pointerdown', pointerId: 15, button: 0, isPrimary: true, clientX: 640, preventDefault() { } });
    triggerWin('pointermove', { clientX: 540 }); // 左拖 100px -> S1/S2 合计缩 100px（各自弹性均分 270px）
    assert.equal(s1.p.style.width, '', '扁平双会话左拖 100px 时 S1 保持弹性权重自动收缩');
    assert.equal(s2.p.style.width, '', '扁平双会话左拖 100px 时 S2 保持弹性权重自动收缩');
    assert.equal(auxOuter.style.width, '900px');
    g = h.api.getAuxDockStateForTest().workspaceConservedGeometry;
    assert.equal(g.sessionsW, 540);
    assert.equal(g.sumW, 1440);
    assert.equal(g.overflowPx, 0);
    triggerWin('pointerup', { clientX: 540 });
  } finally {
    h.dispose();
  }
});

test('Batch03 终极闭环 19: 消灭双竖线、单浏览器/关侧栏零黑洞全量还原、切态防废条与当前会话拖拽零回流降载', async () => {
  const sess1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const h = createBatch03Harness({
    pathname: `/c/${sess1}`,
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: {
      ag_dock_position: 'flow',
      ag_aux_view_tab: 'both',
      ag_aux_order: 'plugin-first'
    }
  });
  try {
    const winListeners = new Map();
    h.sandbox.window.addEventListener = (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    };
    h.sandbox.window.removeEventListener = (type, fn) => {
      winListeners.get(type)?.delete(fn);
    };
    const triggerWin = (type, ev = {}) => {
      for (const fn of Array.from(winListeners.get(type) || [])) fn(ev);
    };

    const titleMenuBar = h.makeEl('div');
    titleMenuBar.setAttribute('data-testid', 'title-menu-bar');
    titleMenuBar.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 32, width: 1440, height: 32 });
    let titleBarClicks = 0;
    titleMenuBar.addEventListener('click', () => { titleBarClicks += 1; });
    h.body.appendChild(titleMenuBar);

    const workspaceRow = h.makeEl('div');
    workspaceRow.clientWidth = 1440;
    workspaceRow.getBoundingClientRect = () => ({ left: 0, top: 32, right: 1440, bottom: 900, width: 1440, height: 868 });

    const parsePx = (v, fallback) => {
      const m = String(v || '').match(/^(-?\d+(?:\.\d+)?)px$/);
      return m ? Number(m[1]) : fallback;
    };

    // 模拟真实宿主：原生会话槽 + 宿主原生左分隔线 + 带初始原生宽度 480px 的右侧辅助栏
    let auxOpen = true;
    const leftPane = h.makeEl('div');
    leftPane.setAttribute('data-testid', 'conversation-view');
    leftPane.setAttribute('data-pane-id', 's1');
    leftPane.setAttribute('data-cascade-id', sess1);
    leftPane.setAttribute('data-focused', 'true');
    const nativeLeftSep = h.makeEl('div');
    nativeLeftSep.setAttribute('role', 'separator');
    nativeLeftSep.className = 'host-native-sash cursor-col-resize';
    nativeLeftSep.getBoundingClientRect = () => {
      if (nativeLeftSep.style.display === 'none' || !auxOpen) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      const auxW = parsePx(auxOuter.style.width, 480);
      return { left: 1440 - auxW - 4, top: 32, right: 1440 - auxW, bottom: 900, width: 4, height: 868 };
    };

    const auxOuter = h.makeEl('div');
    auxOuter.setAttribute('data-side-panel-open', 'true');
    auxOuter.style.width = '480px';
    auxOuter.getBoundingClientRect = () => {
      if (!auxOpen) return { left: 1440, top: 32, right: 1440, bottom: 900, width: 0, height: 868 };
      const w = parsePx(auxOuter.style.width, 480);
      return { left: 1440 - w, top: 32, right: 1440, bottom: 900, width: w, height: 868 };
    };
    leftPane.getBoundingClientRect = () => {
      const explicitW = parsePx(leftPane.style.width, null);
      const auxW = auxOpen ? parsePx(auxOuter.style.width, 480) : 0;
      const sepW = (auxOpen && nativeLeftSep.style.display !== 'none') ? 4 : 0;
      const w = explicitW != null ? explicitW : Math.max(0, 1440 - auxW - sepW);
      return { left: 0, top: 32, right: w, bottom: 900, width: w, height: 868 };
    };

    const auxInner = h.makeEl('div');
    auxInner.setAttribute('data-side-panel-focus-scope', 'true');
    auxInner.getBoundingClientRect = () => auxOuter.getBoundingClientRect();
    Object.defineProperty(auxInner, 'clientWidth', { get: () => auxOuter.getBoundingClientRect().width, configurable: true });
    const browserPane = h.makeEl('div');
    browserPane.setAttribute('data-testid', 'host-browser-pane');
    const webview = h.makeEl('webview');
    browserPane.appendChild(webview);
    auxInner.appendChild(browserPane);
    auxOuter.appendChild(auxInner);

    workspaceRow.appendChild(leftPane);
    workspaceRow.appendChild(nativeLeftSep);
    workspaceRow.appendChild(auxOuter);
    h.body.appendChild(workspaceRow);

    const findInTree = (root, pred, out = []) => {
      if (!root) return out;
      if (pred(root)) out.push(root);
      for (const ch of (root.children || [])) findInTree(ch, pred, out);
      return out;
    };
    h.sandbox.document.getElementById = (id) => findInTree(h.body, n => n.id === id)[0] || findInTree(h.sandbox.document.head, n => n.id === id)[0] || null;
    h.sandbox.document.querySelector = (sel) => {
      if (sel.includes('title-menu-bar')) return titleMenuBar;
      if (sel.includes('data-ag-ws-splitter="outer-left"')) return findInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left')[0] || null;
      if (sel.includes('ag-topbar-ws-controls')) return findInTree(h.body, n => n.id === 'ag-topbar-ws-controls')[0] || null;
      if (auxOpen && sel.includes('data-side-panel-focus-scope')) return auxInner;
      if (auxOpen && sel.includes('data-side-panel-open')) return auxOuter;
      return null;
    };
    h.sandbox.document.querySelectorAll = (sel) => {
      if (sel.includes('conversation-view')) return [leftPane];
      if (sel.includes('webview')) return [webview];
      if (auxOpen && sel.includes('data-side-panel-focus-scope')) return [auxInner];
      if (auxOpen && sel.includes('data-side-panel-open')) return [auxOuter];
      if (sel.includes('data-ag-ws-native-sep-hidden')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-native-sep-hidden') === 'true');
      if (sel.includes('data-ag-ws-left-styled')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-left-styled') === 'true');
      if (sel.includes('data-ag-ws-row-styled')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-row-styled') === 'true');
      if (sel.includes('data-ag-ws-auxchain-styled')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-auxchain-styled') === 'true');
      if (sel.includes('data-ag-aux-styled')) return findInTree(h.body, n => n.getAttribute?.('data-ag-aux-styled') === 'true');
      if (sel.includes('data-ag-aux-sized')) return findInTree(h.body, n => n.getAttribute?.('data-ag-aux-sized') === 'true');
      if (sel.includes('data-ag-aux-tripane')) return findInTree(h.body, n => n.getAttribute?.('data-ag-aux-tripane') === 'true');
      if (sel.includes('data-ag-aux-host-hidden')) return findInTree(h.body, n => n.getAttribute?.('data-ag-aux-host-hidden') === 'true');
      if (sel.includes('data-ag-ws-splitter="outer-left"')) return findInTree(auxInner, n => n.getAttribute?.('data-ag-ws-splitter') === 'outer-left');
      if (sel.includes('data-ag-ws-topbar-controls')) return findInTree(h.body, n => n.getAttribute?.('data-ag-ws-topbar-controls') === 'true');
      return [];
    };

    const countVisibleSplitters = () => {
      let n = 0;
      if (auxOpen && nativeLeftSep.style.display !== 'none') n += 1;
      if (!h.elements.get('dock-aux-resizer')?.hidden) n += 1;
      if (!h.elements.get('dock-aux-inner-resizer')?.hidden) n += 1;
      if (findInTree(auxInner, x => x.getAttribute?.('data-ag-ws-splitter') === 'outer-left').length > 0) n += 1;
      return n;
    };

    // 1. 并排开启：宿主原生左分隔线被屏蔽，全屏严格仅 2 根有效分隔线（零双竖线打架）
    h.api.setDockPositionForTest('aux', { persist: false });
    h.api.setAuxViewTabForTest('both', { persist: false });
    let st = h.api.getAuxDockStateForTest();
    assert.equal(nativeLeftSep.style.display, 'none', '并排接管期间必须隐藏宿主原生左分隔线以消灭双竖线');
    assert.equal(st.hiddenNativeOuterSplitterCount, 1);
    assert.equal(countVisibleSplitters(), 2, '并排模式下全屏可见分隔线总数必须严格等于 2');
    assert.equal(browserPane.style.width, '', '并排模式下浏览器兄弟必须弹性伸缩严禁写死固定像素宽');

    // 2. 切「单插件」并拖窄到 320px，再切回「并排」：单插件仅 1 根分隔线、切回并排插件不得被压成废条
    assert.equal(findInTree(titleMenuBar, n => n.id === 'ag-topbar-ws-controls').length, 0, '阶段二收敛后标题栏严禁残留旧控件组');
    h.api.setAuxViewTabForTest('plugin', { persist: false });
    assert.equal(titleBarClicks, 0, '切态严禁冒泡穿透到宿主 title-menu-bar');
    assert.equal(countVisibleSplitters(), 1, '单插件模式下全屏可见分隔线总数必须严格等于 1');
    h.api.resizeAuxPanelForTest(320, { persist: false });
    assert.equal(leftPane.getBoundingClientRect().width, 1120, '单插件拖窄至 320px 时左侧会话必须立即补位至 1120px 零黑洞');
    h.api.setAuxViewTabForTest('both', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(countVisibleSplitters(), 2, '切回并排后全屏可见分隔线必须恢复为严格 2 根');
    assert.ok(st.workspaceConservedGeometry.pluginW >= 300, '从窄单插件切回并排后插件宽必须 >= 300px 严禁压成废条');
    assert.ok(st.workspaceConservedGeometry.browserW >= 320, '切回并排后浏览器宽必须 >= 320px');

    // 3. 切「单浏览器」：原生分隔线 100% 恢复，全屏仅 1 根原生分隔线，auxOuter 恢复宿主原本 480px，浏览器与左会话零残留样式
    h.api.setAuxViewTabForTest('browser', { persist: false });
    st = h.api.getAuxDockStateForTest();
    assert.equal(nativeLeftSep.style.display, '', '单浏览器模式下必须 100% 恢复宿主原生左分隔线');
    assert.equal(countVisibleSplitters(), 1, '单浏览器模式下全屏可见分隔线总数必须严格等于 1（仅原生线）');
    assert.equal(auxOuter.style.width, '480px', '单浏览器模式下必须精准恢复宿主原生侧栏宽度快照 480px 避免半屏黑洞');
    assert.equal(browserPane.style.width, '', '单浏览器模式下浏览器节点严禁残留插件行内宽度');
    assert.equal(leftPane.style.width, '', '单浏览器模式下左侧会话节点严禁残留插件行内宽度');

    // 4. 在并排模式下模拟用户点击宿主 Toggle Side Panel 彻底关闭侧栏：必须清空一切残留宽度，会话秒复 100% 全宽 1440px
    h.api.setAuxViewTabForTest('both', { persist: false });
    assert.equal(nativeLeftSep.style.display, 'none');
    auxOpen = false;
    auxOuter.setAttribute('data-side-panel-open', 'false');
    h.api.restoreAllHostInlineLayoutStylesForTest(null);
    assert.equal(nativeLeftSep.style.display, '', '关闭侧栏后原生分隔线样式必须彻底恢复');
    assert.equal(leftPane.style.width, '', '关闭侧栏后左侧会话严禁残留宽度覆盖');
    assert.equal(leftPane.style.flex, '', '关闭侧栏后左侧会话 flex 覆盖必须彻底清空');
    assert.equal(leftPane.getBoundingClientRect().width, 1440, '关闭侧栏后左侧会话必须瞬间恢复 100% 全宽 1440px 零黑洞');
    assert.equal(auxOuter.style.width, '', '关闭侧栏后已关闭辅助栏外层严禁残留宽度占位');

    // 5. 拖拽分隔线期间全局降载标记 data-pane-resizing="true" 开关核验
    auxOpen = true;
    auxOuter.setAttribute('data-side-panel-open', 'true');
    h.api.setAuxViewTabForTest('both', { persist: false });
    const leftSep = h.elements.get('dock-aux-resizer');
    leftSep.dispatchEvent({ type: 'pointerdown', pointerId: 21, button: 0, isPrimary: true, clientX: 640, preventDefault() { } });
    assert.equal(h.host.getAttribute('data-pane-resizing'), 'true', '拖拽开始必须打上 data-pane-resizing="true" 降载标记');
    assert.equal(h.api.getAuxDockStateForTest().paneResizing, true);
    triggerWin('pointerup', { clientX: 600 });
    assert.equal(h.host.getAttribute('data-pane-resizing'), null, '松手必须立即清除 data-pane-resizing 标记');
    assert.equal(h.api.getAuxDockStateForTest().paneResizing, false);
  } finally {
    h.dispose();
  }
});

test('nav-settings-ux 回归 #3/#4 + PR #126 (#124) + GitHub #127 + PR #138 (#117) 完整契约与 DOM 交互验收', () => {
  const navAlign = require('./src/renderer/host-settings-nav-align');
  const insightsMod = require('./src/renderer/insights-and-views');
  const hsSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/host-settings.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(__dirname, 'src/renderer/context-settings-ui.js'), 'utf8');

  // 1. 回归 #4：设置左栏无前缀图标、无 font-weight: 600 加粗覆盖、保留 !important 优先级且严格对齐未选中官方项
  assert.equal(navAlign.hasForbiddenNavBoldOverride(navAlign.buildAlignedHostSettingsNavCss()), false, '对齐样式绝不可包含 font-weight >= 600 加粗覆盖');
  assert.equal(navAlign.hasForbiddenNavBoldOverride(hsSrc), false, 'host-settings.js 绝不可残留 font-weight >= 600 覆盖');
  assert.doesNotMatch(hsSrc, /ag-hs-nav-icon|<svg[^>]*ag-hs/i, '设置左栏三项必须为纯文本零前缀图标');

  const mkMockStyle = () => {
    const priorities = new Map();
    return new Proxy({ _priorities: priorities }, {
      set(target, prop, val) {
        target[prop] = val;
        if (typeof prop === 'string' && !prop.startsWith('_')) {
          priorities.set(prop, '');
        }
        return true;
      },
      get(target, prop) {
        if (prop === 'setProperty') {
          return (kebab, val, priority = '') => {
            const camel = kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            target[camel] = String(val);
            target[kebab] = String(val);
            priorities.set(kebab, priority);
          };
        }
        return target[prop];
      }
    });
  };
  const nativeGeneral = {
    id: 'settings-nav-item-General',
    className: 'bg-sidebar-secondary text-foreground',
    getAttribute: (k) => (k === 'aria-selected' ? 'true' : null),
    querySelector: () => null,
    style: mkMockStyle()
  };
  const nativeBrowser = {
    id: 'settings-nav-item-Browser',
    className: 'text-secondary-foreground',
    getAttribute: (k) => (k === 'aria-selected' ? 'false' : (k === 'data-testid' ? 'settings-nav-item-Browser' : null)),
    textContent: 'Browser',
    querySelector: () => null,
    style: mkMockStyle()
  };
  const picked = navAlign.pickUnselectedNativeNavRef([nativeGeneral, nativeBrowser], nativeGeneral);
  assert.equal(picked.unselectedRef, nativeBrowser, '必须优先选取未选中官方 Browser 项作为排版基准');
  assert.equal(picked.activeRef, nativeGeneral, '必须同时提取已选中官方项用于采集高亮背景色');

  const pluginBtn = { style: mkMockStyle(), querySelector: () => ({ style: mkMockStyle() }) };
  const mockWin = {
    getComputedStyle(el) {
      if (el === nativeBrowser) {
        return {
          fontFamily: 'Inter, sans-serif',
          fontSize: '13px',
          fontWeight: '400',
          lineHeight: '20px',
          letterSpacing: '0px',
          color: 'rgb(157, 157, 157)',
          opacity: '1',
          paddingLeft: '12px',
          paddingRight: '12px',
          paddingTop: '6px',
          paddingBottom: '6px',
          borderRadius: '6px'
        };
      }
      if (el === nativeGeneral) {
        return { backgroundColor: 'rgb(42, 42, 46)', color: 'rgb(204, 204, 204)' };
      }
      return {};
    }
  };
  const aligned = navAlign.alignHostSettingsNavTypography(nativeBrowser, [pluginBtn], mockWin, { activeNativeRefBtn: nativeGeneral });
  assert.equal(aligned.applied, true);
  assert.equal(pluginBtn.style.fontWeight, '400');
  assert.equal(pluginBtn.style._priorities.get('font-weight'), 'important', 'setProperty important 必须在最后执行以防真实 CSSOM 丢失 !important');
  assert.equal(pluginBtn.style['--ag-hs-inactive-color'], 'rgb(157, 157, 157)');
  assert.equal(pluginBtn.style['--ag-hs-active-bg'], 'rgb(42, 42, 46)');

  // 2. 回归 #3：主左栏「上下文洞察」16px 图标、样式同步与全页展开/单帧切回
  assert.equal(typeof insightsMod.createSidebarInsightsHostController, 'function');
  assert.equal(typeof insightsMod.syncSidebarInsightsButtonStyle, 'function');
  const sbBtn = { style: mkMockStyle(), querySelector: () => ({ setAttribute() {} }) };
  const officialPluginsBtn = {
    style: mkMockStyle(),
    querySelector: (sel) => (sel.includes('svg') ? { getAttribute: () => '16' } : null)
  };
  const sbWin = {
    getComputedStyle: () => ({
      fontFamily: 'Inter', fontSize: '13px', fontWeight: '400', lineHeight: '18px',
      letterSpacing: '0px', color: 'rgb(157, 157, 157)', opacity: '1',
      paddingTop: '6px', paddingRight: '10px', paddingBottom: '6px', paddingLeft: '10px',
      height: '32px', borderRadius: '8px', gap: '8px'
    })
  };
  const sbMetrics = insightsMod.syncSidebarInsightsButtonStyle(sbBtn, officialPluginsBtn, sbWin, null);
  assert.equal(sbMetrics.fontWeight, '400');
  assert.equal(sbMetrics.iconSize, 16);
  assert.equal(sbBtn.style._priorities.get('font-weight'), 'important', '左栏上下文洞察按钮样式同步必须保留 !important');
  assert.equal(sbBtn.style['--ag-si-inactive-color'], 'rgb(157, 157, 157)');

  // 3. PR #126 (#124)：普通 dialog 与归档 Toast 零误注入，且严禁回退盲选 navBtns[0]
  assert.match(hsSrc, /hasExplicitSettingsModalSignal/, '必须具备显式设置弹窗信号判定');
  assert.match(hsSrc, /(?:uniqueLabels|matchedNavNames)\.size\s*>=\s*2/, '降级弹窗匹配必须命中 >=2 个标准设置分类名');
  assert.match(hsSrc, /matchedCategoryBtns\.length\s*<\s*2/, '无显式设置信号时必须要求命中 >=2 个分类按钮');
  assert.match(hsSrc, /conversation\\s\+archived|view\\s\+archived|对话已归档/i, '必须显式拦截 macOS 归档 Toast');
  assert.doesNotMatch(hsSrc, /const sampleBtn\s*=\s*navBtns\[0\]/, '严禁回退盲选 navBtns[0]');

  // 4. GitHub #127：5 大重组分组、统一 40x22 开关/18px 滑块/>=40x24 热区、禁用原因、整行点击保选字、aria-labelledby/describedby
  assert.match(uiSrc, /data-group-area="topbar"/, '必须有独立顶栏分组');
  assert.match(uiSrc, /data-group-area="bottombar"/, '必须有独立底栏分组');
  assert.match(uiSrc, /data-group-area="floating"/, '必须有独立悬浮圆环分组');
  assert.match(uiSrc, /data-group-area="stats"/, '必须有独立统计显示分组');
  assert.match(uiSrc, /data-group-area="experimental"/, '必须有独立实验功能分组');
  assert.match(uiSrc, /\.ag-ns-switch\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*22px;/, '统一开关轨道必须为 40x22');
  assert.match(uiSrc, /\.ag-ns-switch::after\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/, '统一开关滑块必须为 18px');
  assert.match(uiSrc, /transform:\s*translateX\(18px\)/, '开启态滑块位移必须严丝合缝无右侧暗边缺口');
  assert.match(uiSrc, /min-width:\s*40px;[\s\S]*?min-height:\s*24px;/, '开关交互热区至少 40x24');
  assert.match(uiSrc, /hasNonEmptyTextSelection/, '整行点击必须检测文本选区以防干扰选字');
  assert.match(uiSrc, /derivedDisabled\s*=\s*\(swKey === 'radialTopbar' && topbarHidden\) \|\| \(swKey === 'radialBottombar' && composerOff\)/, '入口隐藏时对应径向开关必须派生禁用');

  // 5. PR #138 (#117)：三档字号 (barFontScale) 与尾标高对比度 (footerContrast) 控件与语义
  assert.match(uiSrc, /data-ag-ns-seg="barFontScale"/, '必须包含 barFontScale 三档字号控件');
  assert.match(uiSrc, /data-val="compact"[\s\S]*?data-val="standard"[\s\S]*?data-val="large"/, 'barFontScale 必须支持 compact/standard/large 三档');
  assert.match(uiSrc, /data-ag-ns-seg="footerContrast"/, '必须包含 footerContrast 对比度控件');
  assert.match(uiSrc, /data-val="standard"[\s\S]*?data-val="high"/, 'footerContrast 必须支持 standard/high 两档');

  // 6. 回归 #1 账号页复核：单眼睛图标 + svg[hidden] 隐藏规则 + 960px 宽列布局
  assert.match(uiSrc, /svg\[hidden\]\s*\{\s*display:\s*none\s*!important;/, 'svg[hidden] 必须强隐藏以防双图标重叠');
  assert.match(uiSrc, /id="ag-ac-eye-icon"/, '隐藏邮箱按钮必须为单 SVG 图标');
  assert.match(uiSrc, /\.ag-ns-page\.is-accounts-wide\s*\{\s*max-width:\s*960px;/, '账号页容器必须加宽防邮箱与配额名过度截断');
});

test('nav-settings-ux 运行时行为闭环：左栏上下文洞察全页与互斥高亮、PR #126 弹窗拒挂、#127 整行点击保选字与禁用原因读屏', () => {
  const insightsMod = require('./src/renderer/insights-and-views');
  const navAlign = require('./src/renderer/host-settings-nav-align');
  const contextSettingsUi = require('./src/renderer/context-settings-ui');
  const hsCode = fs.readFileSync(path.join(__dirname, 'src/renderer/host-settings.js'), 'utf8');

  // 轻量 DOM 工厂（支持 closest/querySelectorAll/addEventListener/capture/remove/setProperty）
  function createRuntimeDom() {
    const docListeners = new Map();
    function mkEl(tag) {
      const attrs = new Map();
      const listeners = new Map();
      const capListeners = new Map();
      const styleMap = new Map();
      let _text = '';
      let _html = '';
      const el = {
        tagName: String(tag || 'div').toUpperCase(),
        nodeType: 1,
        children: [],
        parentElement: null,
        hidden: false,
        disabled: false,
        isConnected: true,
        dataset: {},
        style: new Proxy({}, {
          set(t, k, v) { t[k] = String(v); styleMap.set(k, String(v)); return true; },
          get(t, k) {
            if (k === 'setProperty') return (p, v) => { t[p] = String(v); const c = p.replace(/-([a-z])/g, (_, x) => x.toUpperCase()); t[c] = String(v); styleMap.set(p, String(v)); };
            if (k === 'removeProperty') return (p) => { delete t[p]; styleMap.delete(p); };
            if (k === 'getPropertyValue') return (p) => styleMap.get(p) || t[p] || '';
            return t[k] || '';
          }
        }),
        get id() { return attrs.get('id') || ''; },
        set id(v) { attrs.set('id', String(v || '')); },
        get className() { return attrs.get('class') || ''; },
        set className(v) { attrs.set('class', String(v || '')); },
        get textContent() {
          if (el.children.length > 0) return el.children.map(c => c.textContent).join('');
          return _text;
        },
        set textContent(v) { el.children = []; _text = String(v ?? ''); },
        get innerHTML() { return _html; },
        set innerHTML(v) { _html = String(v ?? ''); },
        get firstChild() { return el.children[0] || null; },
        get firstElementChild() { return el.children[0] || null; },
        get nextSibling() {
          if (!el.parentElement) return null;
          const idx = el.parentElement.children.indexOf(el);
          return idx >= 0 ? (el.parentElement.children[idx + 1] || null) : null;
        },
        get nextElementSibling() { return el.nextSibling; },
        classList: {
          add(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => c && s.add(c)); el.className = [...s].join(' '); },
          remove(...cs) { const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
          toggle(c, f) { const on = f === undefined ? !this.contains(c) : Boolean(f); if (on) this.add(c); else this.remove(c); return on; },
          contains(c) { return el.className.split(/\s+/).includes(c); }
        },
        setAttribute(k, v) { attrs.set(String(k), String(v)); },
        getAttribute(k) { return attrs.has(String(k)) ? attrs.get(String(k)) : null; },
        hasAttribute(k) { return attrs.has(String(k)); },
        removeAttribute(k) { attrs.delete(String(k)); },
        appendChild(ch) {
          if (!ch) return ch;
          if (ch.parentElement) ch.remove();
          ch.parentElement = el;
          el.children.push(ch);
          return ch;
        },
        insertBefore(ch, ref) {
          if (!ch) return ch;
          if (ch.parentElement) ch.remove();
          ch.parentElement = el;
          const idx = ref ? el.children.indexOf(ref) : -1;
          if (idx >= 0) el.children.splice(idx, 0, ch);
          else el.children.push(ch);
          return ch;
        },
        after(node) {
          if (!node || !el.parentElement) return;
          if (node.parentElement) node.remove();
          node.parentElement = el.parentElement;
          const idx = el.parentElement.children.indexOf(el);
          el.parentElement.children.splice(idx + 1, 0, node);
        },
        removeChild(ch) {
          const idx = el.children.indexOf(ch);
          if (idx >= 0) { el.children.splice(idx, 1); ch.parentElement = null; }
          return ch;
        },
        remove() { if (el.parentElement) el.parentElement.removeChild(el); },
        contains(node) { return node === el || el.children.some(c => c.contains(node)); },
        matches(sel) {
          return String(sel).split(',').map(s => s.trim()).filter(Boolean).some(part => {
            if (part === '*') return true;
            let r = part;
            const attrRe = /\[([^\]=*^]+)(?:(\^?=|\*=)"([^"]+)")?\]/g;
            let m;
            while ((m = attrRe.exec(part)) !== null) {
              const [, k, op, val] = m;
              const actual = el.getAttribute(k);
              if (actual === null) return false;
              if (op === '=' && actual !== val) return false;
              if (op === '^=' && !actual.startsWith(val)) return false;
              if (op === '*=' && !actual.includes(val)) return false;
              r = r.replace(m[0], '');
            }
            const idM = r.match(/#([\w-]+)/);
            if (idM) { if (el.id !== idM[1]) return false; r = r.replace(idM[0], ''); }
            for (const cm of [...r.matchAll(/\.([\w-]+)/g)]) {
              if (!el.classList.contains(cm[1])) return false;
              r = r.replace(cm[0], '');
            }
            const tagPart = r.trim();
            if (tagPart && el.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
            return true;
          });
        },
        closest(sel) {
          let cur = el;
          while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
          return null;
        },
        querySelectorAll(sel) {
          const out = [];
          const walk = (n) => {
            for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); }
          };
          walk(el);
          return out;
        },
        querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
        addEventListener(type, fn, capture) {
          const map = capture ? capListeners : listeners;
          if (!map.has(type)) map.set(type, new Set());
          map.get(type).add(fn);
        },
        removeEventListener(type, fn, capture) {
          (capture ? capListeners : listeners).get(type)?.delete(fn);
        },
        click() {
          if (el.disabled) return;
          const chain = [];
          let cur = el;
          while (cur) { chain.unshift(cur); cur = cur.parentElement; }
          const ev = { type: 'click', target: el, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
          for (const fn of (docListeners.get('click:capture') || [])) fn(ev);
          for (const node of chain) {
            for (const fn of (node._capListeners?.get('click') || [])) fn(ev);
            if (ev.stopped) return;
          }
          for (let i = chain.length - 1; i >= 0; i--) {
            for (const fn of (chain[i]._listeners?.get('click') || [])) fn(ev);
            if (ev.stopped) return;
          }
        },
        _listeners: listeners,
        _capListeners: capListeners
      };
      return el;
    }
    const head = mkEl('head');
    const body = mkEl('body');
    const doc = {
      head, body,
      activeElement: body,
      createElement: mkEl,
      createElementNS: (_ns, t) => mkEl(t),
      getElementById: (id) => body.querySelector(`#${id}`) || head.querySelector(`#${id}`),
      querySelector: (s) => body.querySelector(s) || head.querySelector(s),
      querySelectorAll: (s) => [...head.querySelectorAll(s), ...body.querySelectorAll(s)],
      addEventListener(t, fn, cap) {
        const k = cap ? `${t}:capture` : t;
        if (!docListeners.has(k)) docListeners.set(k, new Set());
        docListeners.get(k).add(fn);
      },
      removeEventListener(t, fn, cap) {
        docListeners.get(cap ? `${t}:capture` : t)?.delete(fn);
      }
    };
    return { doc, body, head, mkEl };
  }

  // A. 回归 #3 运行时闭环：左栏「上下文洞察」挂载、16px SVG、点击全页展开+互斥清除高亮、点原生项单帧无残留切回
  {
    const { doc, body, mkEl } = createRuntimeDom();
    const shell = mkEl('div');
    const sidebar = mkEl('aside');
    sidebar.setAttribute('data-testid', 'main-sidebar');
    const btnNew = mkEl('button');
    btnNew.setAttribute('data-testid', 'new-conversation-button');
    btnNew.textContent = '新建会话';
    const btnAuto = mkEl('button');
    btnAuto.setAttribute('data-testid', 'automations-button');
    btnAuto.className = 'bg-sidebar-secondary';
    btnAuto.setAttribute('aria-current', 'page');
    btnAuto.textContent = '自动化';
    const btnPlug = mkEl('button');
    btnPlug.setAttribute('data-testid', 'plugins-button');
    btnPlug.textContent = '自定义扩展';
    const convItem = mkEl('button');
    convItem.textContent = '示例历史会话';
    sidebar.appendChild(btnNew);
    sidebar.appendChild(btnAuto);
    sidebar.appendChild(btnPlug);
    sidebar.appendChild(convItem);

    const mainPane = mkEl('main');
    mainPane.setAttribute('data-testid', 'main-content');
    shell.appendChild(sidebar);
    shell.appendChild(mainPane);
    body.appendChild(shell);

    const mockWin = {
      getComputedStyle: () => ({
        fontFamily: 'Inter', fontSize: '13px', fontWeight: '400', lineHeight: '18px',
        letterSpacing: '0px', color: 'rgb(157, 157, 157)', opacity: '1',
        paddingTop: '6px', paddingRight: '10px', paddingBottom: '6px', paddingLeft: '10px',
        borderRadius: '8px', gap: '8px', height: '32px', backgroundColor: 'rgb(20, 20, 22)', position: 'static'
      })
    };
    const ctrl = insightsMod.createSidebarInsightsHostController({
      document: doc,
      window: mockWin,
      lang: 'zh-CN',
      getInsightsData: () => ({
        summary: { sessionCount: 2, totalTokens: 125000, apiCostLabel: '$1.42', cacheHitLabel: '76%', toolCalls: 14, activeTimeLabel: '18m' },
        sessions: [{ sessionId: 's1', title: '会话一', totalTokens: 80000 }]
      })
    });
    assert.equal(ctrl.syncMount('zh-CN'), true);
    const insightsBtn = ctrl.getButtonEl();
    assert.ok(insightsBtn && insightsBtn.querySelector('.ag-sidebar-insights-icon'), '左栏详细上下文必须带 16px SVG 线条图标');
    assert.equal(insightsBtn.querySelector('.ag-sidebar-insights-label').textContent, '详细上下文');

    // 点击「上下文洞察」：全页展开且互斥清除「自动化」高亮
    insightsBtn.click();
    assert.equal(ctrl.getState().active, true);
    assert.equal(ctrl.getState().pageVisible, true);
    assert.equal(insightsBtn.getAttribute('data-active'), 'true');
    assert.equal(btnAuto.getAttribute('aria-current'), 'false', '进入洞察页后必须互斥清除原高亮官方项');
    assert.equal(btnAuto.classList.contains('bg-sidebar-secondary'), false);

    // 点击任意会话：单帧无缝切回原生界面、零残留、无双高亮
    convItem.click();
    assert.equal(ctrl.getState().active, false, '点击任意会话必须单帧关闭洞察全页');
    assert.equal(ctrl.getState().pageVisible, false);
    assert.equal(insightsBtn.getAttribute('data-active'), 'false');
    assert.equal(mainPane.style.position, '', '关闭后必须还原主内容区原始行内 position');
    ctrl.destroy();
  }

  // B. PR #126 (#124) + 回归 #4 运行时闭环：普通 [role="dialog"] 归档 Toast & 确认框零误注入，真 Settings 零前缀图标挂载
  {
    const { doc, body, mkEl } = createRuntimeDom();
    const toastDlg = mkEl('div');
    toastDlg.setAttribute('role', 'dialog');
    const toastHdr = mkEl('div');
    const closeB = mkEl('button'); closeB.textContent = '×';
    toastHdr.appendChild(closeB);
    const toastBody = mkEl('div'); toastBody.textContent = 'Conversation Archived. View archived in the sidebar.';
    const undoB = mkEl('button'); undoB.textContent = '撤销';
    toastBody.appendChild(undoB);
    toastDlg.appendChild(toastHdr);
    toastDlg.appendChild(toastBody);
    body.appendChild(toastDlg);

    const confirmDlg = mkEl('div');
    confirmDlg.setAttribute('role', 'dialog');
    const confirmBody = mkEl('div'); confirmBody.textContent = 'Confirm action?';
    const confirmAct = mkEl('div');
    const okB = mkEl('button'); okB.textContent = '继续';
    const cancelB = mkEl('button'); cancelB.textContent = '取消';
    confirmAct.appendChild(okB); confirmAct.appendChild(cancelB);
    confirmDlg.appendChild(confirmBody); confirmDlg.appendChild(confirmAct);
    body.appendChild(confirmDlg);

    const hsSandbox = {
      document: doc,
      window: {
        AGHostSettingsNavAlign: navAlign,
        getComputedStyle: () => ({
          fontFamily: 'Inter', fontSize: '13px', fontWeight: '400', lineHeight: '20px',
          letterSpacing: '0px', color: 'rgb(157, 157, 157)', opacity: '1', paddingLeft: '8px'
        })
      },
      setTimeout: () => 1,
      clearTimeout: () => {}
    };
    vm.createContext(hsSandbox);
    vm.runInContext(`${hsCode}\nthis.__createHostSettingsController = createHostSettingsController;`, hsSandbox);
    const ctrl = hsSandbox.__createHostSettingsController({ t: (k) => k });

    assert.equal(ctrl.syncModalMount(), false, '普通 [role="dialog"] 归档提示与确认框绝不可误挂设置页');
    assert.equal(toastHdr.children.length, 1, '归档 Toast 标题行严禁被注入按钮');
    assert.equal(confirmAct.children.length, 2, '确认弹窗按钮栏严禁被注入按钮');

    // 挂载真正 Settings 弹窗：零前缀 SVG 图标，一次同步成功
    const realModal = mkEl('div');
    realModal.className = 'settings-modal-container';
    realModal.setAttribute('role', 'dialog');
    const split = mkEl('div'); split.className = 'relative flex w-full h-full';
    const sb = mkEl('aside'); sb.setAttribute('data-testid', 'settings-sidebar');
    const grp = mkEl('div');
    const bGen = mkEl('button'); bGen.id = 'settings-nav-item-General'; bGen.setAttribute('aria-selected', 'true'); bGen.textContent = 'General';
    const bBrw = mkEl('button'); bBrw.id = 'settings-nav-item-Browser'; bBrw.setAttribute('aria-selected', 'false'); bBrw.textContent = 'Browser';
    grp.appendChild(bGen); grp.appendChild(bBrw);
    sb.appendChild(grp);
    const rp = mkEl('section'); rp.setAttribute('data-settings-content-pane', 'true');
    const nativePane = mkEl('div'); nativePane.textContent = 'General body';
    rp.appendChild(nativePane);
    split.appendChild(sb); split.appendChild(rp);
    realModal.appendChild(split);
    body.appendChild(realModal);

    assert.equal(ctrl.syncModalMount(), true, '真实 Settings 弹窗必须单次同步成功挂载');
    for (const navId of ['ag-cm-host-settings-nav', 'ag-cm-host-settings-compact-nav', 'ag-cm-host-settings-accounts-nav']) {
      const nBtn = doc.getElementById(navId);
      assert.ok(nBtn, `必须挂载 ${navId}`);
      assert.equal(String(nBtn.innerHTML || '').includes('<svg'), false, `${navId} 严禁包含亮白前缀 SVG 图标`);
      assert.equal(nBtn.style.fontWeight, '400', `${navId} 字重必须与未选中官方 Browser 一致`);
      assert.equal(nBtn.style.paddingLeft, '8px', `${navId} 左内边距必须与官方项一致`);
    }
    ctrl.dispose();
  }

  // C. GitHub #127 运行时闭环：整行点击 + 文本选择防误触发 + 禁用径向原因 + 恢复入口保留偏好 + 稳态零重复文本
  {
    const { doc, mkEl } = createRuntimeDom();
    let mockSelectedText = '';
    const container = mkEl('section');
    container.id = 'ag-ns-root';
    container.ownerDocument = { defaultView: { getSelection: () => ({ toString: () => mockSelectedText }) } };

    const row = mkEl('div');
    row.className = 'ag-ns-row is-switch-row';
    const textWrap = mkEl('div'); textWrap.className = 'ag-ns-row-text';
    const titleEl = mkEl('div'); titleEl.id = 'ag-ns-title-radialTopbar'; titleEl.className = 'ag-ns-row-title'; titleEl.textContent = '顶栏径向展开';
    const descEl = mkEl('div'); descEl.id = 'ag-ns-radialTopbar-desc'; descEl.className = 'ag-ns-row-desc'; descEl.textContent = '点击顶栏展开';
    textWrap.appendChild(titleEl); textWrap.appendChild(descEl);
    const ctl = mkEl('div'); ctl.className = 'ag-ns-control';
    const wrap = mkEl('div'); wrap.className = 'ag-ns-switch-wrap';
    const stEl = mkEl('span'); stEl.id = 'ag-ns-status-radialTopbar'; stEl.className = 'ag-ns-switch-state'; stEl.setAttribute('data-ag-ns-sw-status', 'radialTopbar');
    const sw = mkEl('button'); sw.id = 'ag-ns-sw-radialTopbar'; sw.className = 'ag-ns-switch'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', 'false'); sw.setAttribute('data-ag-ns-switch', 'radialTopbar');
    wrap.appendChild(stEl); wrap.appendChild(sw); ctl.appendChild(wrap);
    row.appendChild(textWrap); row.appendChild(ctl);
    container.appendChild(row);
    const root = { getElementById: (id) => (id === 'ag-ns-root' ? container : container.querySelector(`#${id}`)) };

    const changes = [];
    contextSettingsUi.initContextSettingsUI(root, { onChange: (k, v) => changes.push([k, v]) });
    assert.equal(sw.getAttribute('aria-labelledby'), 'ag-ns-title-radialTopbar');
    assert.equal(sw.getAttribute('aria-describedby'), 'ag-ns-radialTopbar-desc');

    // 稳态开启且顶栏可见：无重复已开启文字；整行点击可触发；选中文字时不误触发
    contextSettingsUi.renderContextSettingsUI(root, {
      settings: { topbarMode: 'full', radialTopbar: true },
      status: { switchFeedback: { radialTopbar: { busy: false, tone: 'idle', text: '已开启' } } }
    });
    assert.equal(stEl.textContent, '', '稳态绝不显示冗余「已开启/已关闭」文字');
    mockSelectedText = '选中说明文本';
    descEl.click();
    assert.equal(changes.length, 0, '文本选择状态下点击说明行严禁误触发开关');
    mockSelectedText = '';
    descEl.click();
    assert.deepEqual(changes, [['radialTopbar', false]], '无文本选区时整行点击必须触发开关切换');

    // 隐藏顶栏：径向开关进入禁用态并显示原因 + aria-describedby 关联状态提示 + 保留原 radialTopbar=true 偏好
    contextSettingsUi.renderContextSettingsUI(root, {
      settings: { topbarMode: 'hidden', radialTopbar: true },
      status: { radialTopbarDisabledHint: '顶栏入口已隐藏', switchFeedback: {} }
    });
    assert.equal(sw.disabled, true);
    assert.equal(sw.getAttribute('aria-checked'), 'true', '隐藏入口不得擦除用户已保存的径向展开偏好');
    assert.equal(stEl.textContent, '顶栏入口已隐藏');
    assert.match(sw.getAttribute('aria-describedby') || '', /ag-ns-status-radialTopbar/);

    // 恢复顶栏：自动解禁并尊重原偏好 true
    contextSettingsUi.renderContextSettingsUI(root, {
      settings: { topbarMode: 'full', radialTopbar: true },
      status: { radialTopbarDisabledHint: '顶栏入口已隐藏', switchFeedback: {} }
    });
    assert.equal(sw.disabled, false);
    assert.equal(sw.getAttribute('aria-checked'), 'true');
    assert.equal(stEl.textContent, '');
  }
});
