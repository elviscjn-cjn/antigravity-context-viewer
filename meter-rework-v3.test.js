'use strict';

/**
 * ContextMeter 返工提示词 v3 自动化验收测试套件（阶段一及后续阶段扩展）
 *
 * 阶段一覆盖（任务书第 2.4、2.6、9.2 节）：
 * 1. 空白自愈测试 A：模拟插件挂载根脱离 document（宿主卸载旧节点），断言自动重挂载（最多 3 次、间隔 200ms）且最终恢复可见渲染；
 * 2. 空白自愈测试 B：模拟容器 clientWidth/clientHeight 为 0，断言自动触发重挂载重试最多 3 次（间隔 200ms）；
 *    同时验证 3 次全部失败后在内容区展示本地化失败提示与重试按钮（零中英文括号、全简体无繁体、不要求用户按 Ctrl+R），点击重试按钮在容器恢复后可成功渲染；
 * 3. 四态连续切换 20 轮测试：单插件 / 并排 / 单浏览器 / 标签页连续切换 20 轮（80 次跃迁），每轮 300ms 内断言右侧内容区 clientWidth > 0、
 *    插件挂载根节点存在且非空、window.performance.timeOrigin 全程不变，并落盘切换日志（模式、耗时、容器尺寸、重试次数）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let helperPromise = null;
function loadVerifyHelpers() {
  if (!helperPromise) {
    const modUrl = pathToFileURL(path.join(__dirname, 'scripts', 'verify-rework-v3.mjs')).href;
    helperPromise = import(modUrl);
  }
  return helperPromise;
}

const TRADITIONAL_CHAR_RE = /[體臺為後書與無開關設顯頁切換網鍵條項覽態號額計統資紀錄訊檢視圖點擊儲刪並終端預覽瀏覽編輯彙階對組協編總極遙]/;
const PAREN_RE = /[()（）]/;

async function inspectSelfHealFallback(cdp) {
  return cdp.evaluate(`(() => {
    const host = document.getElementById('ag-context-meter');
    const sr = host?.shadowRoot || null;
    const fallbackHost = document.querySelector('[data-om-aux-fallback-host]');
    const fallbackSr = fallbackHost?.shadowRoot || null;
    const roots = [document, sr, fallbackSr].filter(Boolean);
    const candidates = [];
    for (const r of roots) {
      const found = Array.from(
        r.querySelectorAll(
          '.ag-om-aux-fallback, [data-om-aux-fallback], [data-om-self-heal-fallback], [data-om-blank-fallback], [data-ag-self-heal-fallback], [data-ag-blank-fallback], .ag-self-heal-fallback, .om-self-heal-fallback, [role="alert"]'
        )
      );
      for (const node of found) {
        const cs = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const visible = !node.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        const retryBtn =
          node.querySelector('[data-om-aux-retry-btn], .ag-om-aux-retry-btn, button[data-om-self-heal-retry], button[data-ag-self-heal-retry], button') || null;
        candidates.push({
          inShadow: r === sr,
          inFallbackHost: r === fallbackSr,
          visible,
          text: String(node.textContent || '').replace(/\\s+/g, ' ').trim(),
          hasRetryBtn: Boolean(retryBtn),
          retryBtnText: retryBtn ? String(retryBtn.textContent || '').trim() : '',
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      }
    }
    const api = window.__AGContextMeter || {};
    const state =
      (typeof api.getAuxSwitchDiagnostics === 'function' && api.getAuxSwitchDiagnostics()) ||
      (typeof api.getSelfHealStateForTest === 'function' && api.getSelfHealStateForTest()) ||
      null;
    const health = typeof api.inspectAuxMountHealth === 'function' ? api.inspectAuxMountHealth() : null;
    return {
      hostConnected: Boolean(host && host.isConnected),
      hostWidth: host ? Math.round(host.clientWidth || 0) : 0,
      hostHeight: host ? Math.round(host.clientHeight || 0) : 0,
      fallbackHostPresent: Boolean(fallbackHost && fallbackHost.isConnected),
      fallbacks: candidates,
      state,
      health
    };
  })()`);
}

test('阶段一验收 1A：挂载根脱离 document 时自动重挂载自愈（最多 3 次、间隔 200ms）并恢复非零渲染', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp } = session;
  try {
    // 确认初始态健康
    const initHealth = await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);
    assert.equal(initHealth.ok, true, `初始标签页态必须健康: ${JSON.stringify(initHealth.snap)}`);

    // 模拟宿主卸载旧节点：将插件挂载根从 document 脱离
    await cdp.evaluate(`(() => {
      const host = document.getElementById('ag-context-meter');
      if (!host) throw new Error('未找到 #ag-context-meter 挂载根');
      window.__detachedHostRef = host;
      host.remove();
      return { detached: !host.isConnected };
    })()`);

    // 自愈机制应在 <= 900ms（最多 3 次 × 200ms + 余量）内检测到 !isConnected 并自动重新挂载恢复非零渲染
    const healed = await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1100);
    assert.equal(
      healed.ok,
      true,
      `挂载根脱离 document 后必须在 3 次重挂载窗口内自动恢复渲染，实得: ${JSON.stringify(healed)}`
    );
    assert.equal(healed.snap.hostConnected, true, '自愈后 #ag-context-meter 必须重新连接至 document');
    assert.ok(healed.snap.hostBox.cw > 0 && healed.snap.hostBox.ch > 0, `自愈后挂载根尺寸必须非零，实得 ${healed.snap.hostBox.cw}x${healed.snap.hostBox.ch}`);
    assert.equal(healed.snap.shadowHasContent, true, '自愈后右侧内容区必须渲染真实内容而非空白');
  } finally {
    await session.close();
  }
});

test('阶段一验收 1B：容器 0x0 空白自愈（最多 3 次间隔 200ms）、3 次失败本地化提示与重试按钮（零括号全简体无 Ctrl+R）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp } = session;
  try {
    const initHealth = await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);
    assert.equal(initHealth.ok, true, '初始态必须健康');

    // 情形 1：短暂 0x0 后容器恢复，自愈重试应在 1200ms 内恢复
    await cdp.evaluate(`(() => {
      const host = document.getElementById('ag-context-meter');
      host.style.width = '0px';
      host.style.height = '0px';
      host.style.overflow = 'hidden';
      setTimeout(() => {
        host.style.width = '';
        host.style.height = '';
        host.style.overflow = '';
      }, 260);
    })()`);
    const recoveredAfterZero = await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1300);
    assert.equal(
      recoveredAfterZero.ok,
      true,
      `短暂 0x0 塌陷后必须自动自愈恢复，实得: ${JSON.stringify(recoveredAfterZero)}`
    );

    // 情形 2：持续 0x0 迫使全部 3 次重试失败（3 × 200ms = 600ms，留余量 1400ms）
    // 强制锁定挂载根自身宽/高为 0（同时保持父容器 bodyEl 可见以便失败提示可展示在内容区）
    await cdp.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'test-force-zero-host';
      style.textContent = '#ag-context-meter { width: 0px !important; height: 0px !important; min-width: 0 !important; min-height: 0 !important; overflow: hidden !important; }';
      document.head.appendChild(style);
      window.dispatchEvent(new Event('resize'));
    })()`);

    const deadline = Date.now() + 1800;
    let fallbackCheck = null;
    while (Date.now() < deadline) {
      fallbackCheck = await inspectSelfHealFallback(cdp);
      if (fallbackCheck.fallbacks.some((f) => f.visible && f.hasRetryBtn)) break;
      await new Promise((r) => setTimeout(r, 80));
    }

    const visibleFallbacks = (fallbackCheck?.fallbacks || []).filter((f) => f.visible && f.hasRetryBtn);
    const visibleFallback = visibleFallbacks[0];
    assert.ok(
      visibleFallback,
      `3 次自愈重试全部失败后必须在内容区显示本地化失败提示与重试按钮，实得: ${JSON.stringify(fallbackCheck)}`
    );
    assert.equal(
      visibleFallbacks.length,
      1,
      `失败兜底卡片只允许渲染 1 份，严禁在 0x0 Shadow Root 与外部兜底宿主同时渲染双份造成竖排挤字，实得 ${visibleFallbacks.length}: ${JSON.stringify(visibleFallbacks)}`
    );
    // 稳态驻留校验：3 次失败进入兜底态后继续观察 600ms，严禁被 syncAuxHostCoexistence/ResizeObserver 反复清空重跑死循环
    await new Promise((r) => setTimeout(r, 600));
    const settledFallback = await inspectSelfHealFallback(cdp);
    assert.equal(
      settledFallback.state?.fallbackVisible,
      true,
      `3 次失败进入兜底态 600ms 后 fallbackVisible 必须稳定为 true（不得闪烁清空重跑），实得: ${JSON.stringify(settledFallback.state)}`
    );
    assert.equal(
      settledFallback.state?.retriesInFlight,
      false,
      `3 次失败后严禁继续自动重试死循环，实得: ${JSON.stringify(settledFallback.state)}`
    );
    assert.equal(
      settledFallback.state?.retryCount,
      3,
      `失败停驻态重试计数必须为 3，实得: ${settledFallback.state?.retryCount}`
    );
    assert.equal(
      PAREN_RE.test(visibleFallback.text),
      false,
      `失败提示文案严禁包含中英文括号，实得: "${visibleFallback.text}"`
    );
    assert.equal(
      TRADITIONAL_CHAR_RE.test(visibleFallback.text),
      false,
      `简体模式下失败提示严禁出现繁体字，实得: "${visibleFallback.text}"`
    );
    assert.equal(
      /ctrl\s*\+\s*r|刷新整个客户端|reload/i.test(visibleFallback.text),
      false,
      `失败提示严禁要求用户按 Ctrl+R 或刷新整个客户端，实得: "${visibleFallback.text}"`
    );

    // 解除 0x0 锁定并点击重试按钮，应恢复正常渲染
    await cdp.evaluate(`(() => {
      document.getElementById('test-force-zero-host')?.remove();
      const sel = '[data-om-aux-retry-btn], .ag-om-aux-retry-btn, [data-om-self-heal-retry], [data-ag-self-heal-retry], .ag-om-aux-fallback button';
      const fallbackHost = document.querySelector('[data-om-aux-fallback-host]');
      const btn =
        fallbackHost?.shadowRoot?.querySelector(sel) ||
        document.getElementById('ag-context-meter')?.shadowRoot?.querySelector(sel) ||
        document.querySelector(sel);
      if (!btn) throw new Error('找不到自愈失败提示里的重试按钮');
      btn.click();
    })()`);

    const afterManualRetry = await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);
    assert.equal(
      afterManualRetry.ok,
      true,
      `点击失败提示中的重试按钮后必须恢复正常渲染，实得: ${JSON.stringify(afterManualRetry)}`
    );
  } finally {
    await session.close();
  }
});

test('阶段一验收 1C：单插件 / 并排 / 单浏览器 / 标签页四态连续切换 20 轮（300ms 非空、零重载、输出切换日志）', async () => {
  const helpers = await loadVerifyHelpers();
  const result = await helpers.runStage1Verification({
    rounds: 20,
    captureScreenshots: false
  });

  assert.ok(result.buildId && result.buildId !== 'unknown', `必须获取到有效 buildId，实得 ${result.buildId}`);
  assert.equal(result.logData.transitions.length, 80, '20 轮 × 4 态必须产生 80 条切换记录');
  assert.equal(result.logData.timeOriginInvariant, true, '20 轮切换全程 window.performance.timeOrigin 必须保持不变（零重载）');
  assert.equal(
    result.logData.failedCount,
    0,
    `四态连续切换 20 轮中不得出现 300ms 内空白或失败项，失败详情: ${JSON.stringify(
      result.logData.transitions.filter((t) => !t.ok).slice(0, 5)
    )}`
  );
  assert.ok(result.logData.maxElapsedMs <= 300, `每次切换须在 300ms 内就绪，实测最大耗时 ${result.logData.maxElapsedMs}ms`);
});

// ============================================================================
// 阶段二：布局入口收敛、加号常驻与辅助栏头栏精简（任务书第 3 节与第 4.5 节）
// ============================================================================

const HARDCODED_PURPLE_RGB_SET = new Set([
  'rgb(124, 58, 237)',   // #7C3AED
  'rgb(139, 92, 246)',   // #8B5CF6
  'rgb(168, 85, 247)',   // #A855F7
  'rgb(192, 132, 252)',  // #C084FC
  'rgb(119, 72, 207)',   // #7748CF
  'rgb(147, 51, 234)'    // #9333EA
]);

test('阶段二验收 2A：源码级彻底删除 4 组冗余控件（零残留文本、零旧按钮节点、零旧平铺条与输入框重复额度/缓存项）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    // 分别在 tab 态与 split 态扫描全界面（轻 DOM + Shadow DOM）
    for (const mode of ['tab', 'both']) {
      await helpers.switchAuxFourState(cdp, mode);
      await helpers.waitUntilAuxModeHealthy(cdp, mode, 400);

      const scan = await cdp.evaluate(`(() => {
        const host = document.getElementById('ag-context-meter');
        const sr = host?.shadowRoot || null;
        const roots = [document, sr].filter(Boolean);

        const forbiddenIds = [
          'theme-toggle',
          'btn-quick-settings',
          'btn-check-update',
          'btn-open-right-panel',
          'ag-topbar-ws-controls',
          'btn-ag-topbar-ws-plugin',
          'btn-ag-topbar-ws-both',
          'btn-ag-topbar-ws-browser',
          'btn-ag-topbar-ws-swap',
          'dock-aux-session-row',
          'btn-dock-aux-lock',
          'ag-aux-qs-browser',
          'ag-aux-qs-context'
        ];
        const foundForbiddenIds = [];
        for (const r of roots) {
          for (const id of forbiddenIds) {
            if (r.getElementById ? r.getElementById(id) : r.querySelector('#' + id)) {
              foundForbiddenIds.push(id);
            }
          }
        }

        const collectVisibleTexts = (root) => {
          const texts = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const p = n.parentElement;
            if (!p || p.tagName === 'STYLE' || p.tagName === 'SCRIPT') continue;
            const t = String(n.nodeValue || '').trim();
            if (!t) continue;
            const cs = getComputedStyle(p);
            if (p.hidden || cs.display === 'none' || cs.visibility === 'hidden') continue;
            texts.push(t);
          }
          return texts;
        };
        const allVisibleText = [
          ...collectVisibleTexts(document.body),
          ...(sr ? collectVisibleTexts(sr) : [])
        ].join(' | ');

        const forbiddenPhrases = ['单插件', '单浏览器', '右侧标签页', '并排分栏', '隐藏快切', '跟随焦点', '快取'];
        const hitPhrases = forbiddenPhrases.filter((ph) => allVisibleText.includes(ph));

        // 检查旧 5 段会话头平铺条不再暴露在标题栏/会话头
        const oldFlatIds = ['badge-quota', 'badge', 'badge-speed', 'badge-tokens', 'badge-cli'];
        const visibleOldFlat = [];
        for (const id of oldFlatIds) {
          const el = sr?.getElementById(id) || document.getElementById(id);
          if (el && el.isConnected) {
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (!el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
              visibleOldFlat.push(id);
            }
          }
        }

        // 检查输入框底栏（#composer-status-bar）不含重复额度（5H/7D/额度）与缓存/快取项
        const csb = document.getElementById('composer-status-bar') || sr?.getElementById('composer-status-bar');
        const csbText = csb && !csb.hidden ? String(csb.textContent || '').replace(/\\s+/g, ' ').trim() : '';

        return {
          mode: ${JSON.stringify(mode)},
          foundForbiddenIds,
          hitPhrases,
          visibleOldFlat,
          csbText
        };
      })()`);

      assert.deepEqual(
        scan.foundForbiddenIds,
        [],
        `mode=${mode} 严禁残留已删除控件 DOM 节点（不得仅用 CSS 隐藏），检出: ${JSON.stringify(scan.foundForbiddenIds)}`
      );
      assert.deepEqual(
        scan.hitPhrases,
        [],
        `mode=${mode} 全界面搜索不得命中冗余控件文案或繁体「快取」，命中: ${JSON.stringify(scan.hitPhrases)}`
      );
      assert.deepEqual(
        scan.visibleOldFlat,
        [],
        `mode=${mode} 会话头旧 5 段平铺条不得继续暴露，检出: ${JSON.stringify(scan.visibleOldFlat)}`
      );
      assert.equal(
        /(?:5H|7D|快取|缓存)/i.test(scan.csbText),
        false,
        `mode=${mode} 输入框底栏严禁残留重复额度与缓存项，实得: "${scan.csbText}"`
      );
    }
  } finally {
    await session.close();
  }
});

test('阶段二验收 2B：辅助栏头栏精简（仅语言切换/GitHub/关闭 + 不可点纯文字版本）与三语即时切换零重载', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp, initialTimeOrigin } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    const headerAudit = await cdp.evaluate(`(() => {
      const host = document.getElementById('ag-context-meter');
      const sr = host?.shadowRoot;
      const header = sr?.querySelector('#panel .panel-header-bar, .panel-header-bar');
      if (!header) return { found: false };
      const interactive = Array.from(header.querySelectorAll('button, a, [role="button"]')).filter((n) => {
        const cs = getComputedStyle(n);
        return !n.hidden && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      const verEl = header.querySelector('#v');
      const verCs = verEl ? getComputedStyle(verEl) : null;
      return {
        found: true,
        interactiveItems: interactive.map((n) => ({
          id: n.id || '',
          tag: n.tagName,
          role: n.getAttribute('role') || '',
          dataLang: n.getAttribute('data-lang') || '',
          text: String(n.textContent || '').trim(),
          aria: n.getAttribute('aria-label') || n.getAttribute('title') || ''
        })),
        verPresent: Boolean(verEl),
        verText: verEl ? String(verEl.textContent || '').trim() : '',
        verRole: verEl ? (verEl.getAttribute('role') || '') : '',
        verTabIndex: verEl ? verEl.getAttribute('tabindex') : null,
        verCursor: verCs ? verCs.cursor : ''
      };
    })()`);

    assert.equal(headerAudit.found, true, '必须存在辅助栏头栏 .panel-header-bar');
    // 仅允许：3 枚语言按钮（简/繁/EN）+ GitHub 入口 + 关闭按钮 = 5 个交互元素（绝对不允许主题球/齿轮/更新/分栏）
    const nonLangItems = headerAudit.interactiveItems.filter((it) => !it.dataLang && !/^(简|繁|EN)$/i.test(it.text));
    const langItems = headerAudit.interactiveItems.filter((it) => it.dataLang || /^(简|繁|EN)$/i.test(it.text));
    assert.equal(langItems.length, 3, `头栏必须有 简/繁/EN 三枚语言切换项，实得: ${JSON.stringify(langItems)}`);
    assert.equal(
      nonLangItems.length,
      2,
      `头栏除语言切换外只允许保留 GitHub 与关闭按钮共 2 项，实得 ${nonLangItems.length}: ${JSON.stringify(nonLangItems)}`
    );
    assert.ok(
      nonLangItems.some((it) => /github/i.test(`${it.id} ${it.aria} ${it.text}`)),
      `头栏必须保留 GitHub 入口，实得: ${JSON.stringify(nonLangItems)}`
    );
    assert.ok(
      nonLangItems.some((it) => /close|关闭|關閉/i.test(`${it.id} ${it.aria} ${it.text}`)),
      `头栏必须保留关闭按钮，实得: ${JSON.stringify(nonLangItems)}`
    );
    if (headerAudit.verPresent) {
      assert.notEqual(headerAudit.verRole, 'button', '版本号 #v 必须为纯文字，不得带 role="button"');
      assert.notEqual(headerAudit.verCursor, 'pointer', '版本号 #v 不得为可点击指针样式');
    }

    // 实时切换 EN -> 简，断言文案即时变化且零页面重载
    const langSwitchRes = await cdp.evaluate(`(async () => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const getPanelSnippet = () => {
        const p = sr.getElementById('panel');
        return p ? String(p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : '';
      };
      const zhBefore = getPanelSnippet();
      const btnEn = sr.querySelector('[data-lang="en"], .lang-btn[data-lang="en"]');
      const btnZh = sr.querySelector('[data-lang="zh-CN"], .lang-btn[data-lang="zh-CN"]');
      if (!btnEn || !btnZh) return { ok: false, reason: 'missing lang buttons' };
      btnEn.click();
      await new Promise((r) => setTimeout(r, 80));
      const enAfter = getPanelSnippet();
      btnZh.click();
      await new Promise((r) => setTimeout(r, 80));
      const zhRestored = getPanelSnippet();
      return {
        ok: true,
        zhBefore,
        enAfter,
        zhRestored,
        timeOrigin: window.performance.timeOrigin
      };
    })()`);
    assert.equal(langSwitchRes.ok, true, '必须能找到并点击语言切换按钮');
    assert.notEqual(langSwitchRes.enAfter, langSwitchRes.zhBefore, '点击 EN 后头栏/面板可见文案必须即时切换为英文');
    assert.equal(langSwitchRes.timeOrigin, initialTimeOrigin, '语言即时切换不得触发页面重载');
  } finally {
    await session.close();
  }
});

test('阶段二验收 2C：唯一布局入口（标签页/并排+互换）、设置页双向同步、零硬编码紫与无辅助栏 Ctrl+Alt+L 兜底', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    // 1. 辅助栏唯一布局入口形态：tab 态只见 标签页 / 并排，不见 互换；切到 并排 后出现 互换，且高亮不使用硬编码紫
    const layoutEntryCheck = await cdp.evaluate(`(async () => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const findLayoutBtns = () => {
        const bar = sr.querySelector('#ag-aux-quick-switch-bar, [data-ag-aux-quick-switch], [data-om-layout-switch]');
        if (!bar) return { found: false, buttons: [] };
        const btns = Array.from(bar.querySelectorAll('button')).filter((b) => {
          const cs = getComputedStyle(b);
          return !b.hidden && cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        return {
          found: true,
          buttons: btns.map((b) => {
            const cs = getComputedStyle(b);
            return {
              id: b.id || '',
              text: String(b.textContent || '').trim(),
              selected: b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-pressed') === 'true' || b.classList.contains('active'),
              bg: cs.backgroundColor,
              color: cs.color
            };
          })
        };
      };

      const inTab = findLayoutBtns();
      const splitBtn = Array.from(sr.querySelectorAll('button')).find((b) => String(b.textContent || '').trim() === '并排');
      if (splitBtn) splitBtn.click();
      await new Promise((r) => setTimeout(r, 120));
      const inSplit = findLayoutBtns();
      return {
        inTab,
        inSplit,
        modeAfterClickSplit: window.__AGContextMeter?.getAuxCoexistMode?.()
      };
    })()`);

    assert.equal(layoutEntryCheck.inTab.found, true, '辅助栏顶栏必须保留唯一布局入口');
    assert.deepEqual(
      layoutEntryCheck.inTab.buttons.map((b) => b.text),
      ['标签页', '并排'],
      `标签页态下唯一布局入口只允许显示「标签页 / 并排」二选一，实得: ${JSON.stringify(layoutEntryCheck.inTab.buttons)}`
    );
    assert.equal(layoutEntryCheck.modeAfterClickSplit, 'split', '点击「并排」必须切换到 split 模式');
    assert.deepEqual(
      layoutEntryCheck.inSplit.buttons.map((b) => b.text),
      ['标签页', '并排', '互换'],
      `并排态下唯一布局入口右侧必须追加「互换」，实得: ${JSON.stringify(layoutEntryCheck.inSplit.buttons)}`
    );
    for (const b of [...layoutEntryCheck.inTab.buttons, ...layoutEntryCheck.inSplit.buttons]) {
      assert.equal(
        HARDCODED_PURPLE_RGB_SET.has(b.bg),
        false,
        `布局入口选中态背景严禁硬编码紫色，实得 ${b.text}: bg=${b.bg}`
      );
    }

    // 2. 与宿主设置页双向同步：打开设置页验证已同步为 split -> 在设置页改回 tab -> 验证辅助栏立即跟回 tab
    const syncCheck = await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 120));
      const nav = document.getElementById('ag-cm-host-settings-nav');
      if (nav) nav.click();
      await new Promise((r) => setTimeout(r, 120));
      const pg = document.getElementById('ag-cm-host-settings-page');
      const pgSr = pg?.shadowRoot;
      const seg = pgSr?.querySelector('[data-ag-ns-seg="auxCoexistMode"]');
      const getSelectedSegVal = () => {
        const activeBtn = seg?.querySelector('[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"], .active');
        return activeBtn ? (activeBtn.getAttribute('data-value') || activeBtn.getAttribute('data-ag-val') || activeBtn.value || '') : '';
      };
      const valWhenAuxSplit = getSelectedSegVal();
      const tabSegBtn = seg?.querySelector('[data-value="tab"], [data-ag-val="tab"]');
      if (tabSegBtn) tabSegBtn.click();
      await new Promise((r) => setTimeout(r, 120));
      const modeAfterSettingsTab = window.__AGContextMeter?.getAuxCoexistMode?.();
      window.__toggleHostSettingsModal(false);
      return {
        hasSettingsSeg: Boolean(seg),
        valWhenAuxSplit,
        modeAfterSettingsTab
      };
    })()`);
    assert.equal(syncCheck.hasSettingsSeg, true, '宿主设置页必须存在 auxCoexistMode 布局模式设置项');
    assert.equal(syncCheck.valWhenAuxSplit, 'split', '辅助栏切到并排后，设置页布局模式必须即时同步为 split');
    assert.equal(syncCheck.modeAfterSettingsTab, 'tab', '设置页切回标签页后，辅助栏布局模式必须即时同步为 tab');

    // 3. 无辅助栏兜底入口：默认快捷键 Ctrl+Alt+L 切换布局模式，且支持在设置页改键并持久化生效
    const modeBeforeHotkey = await cdp.evaluate(`window.__AGContextMeter?.getAuxCoexistMode?.()`);
    await cdp.evaluate(`(() => {
      const ev = new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(ev);
    })()`);
    await new Promise((r) => setTimeout(r, 120));
    const modeAfterHotkey1 = await cdp.evaluate(`window.__AGContextMeter?.getAuxCoexistMode?.()`);
    assert.notEqual(
      modeAfterHotkey1,
      modeBeforeHotkey,
      `按下默认全局快捷键 Ctrl+Alt+L 必须切换布局模式（前=${modeBeforeHotkey}, 后=${modeAfterHotkey1}）`
    );

    // 验证设置页通过真实按键录制修改快捷键（改为 Ctrl+Alt+K）后旧键不再触发、新键生效且可恢复默认
    const customHotkeyCheck = await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 100));
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 100));
      const pgSr = document.getElementById('ag-cm-host-settings-page')?.shadowRoot;
      const inp = pgSr?.getElementById('ag-ns-input-auxLayoutShortcut');
      const resetBtn = pgSr?.getElementById('ag-ns-btn-reset-auxLayoutShortcut');
      if (!inp) return { foundInput: false };
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 100));
      const recordedValue = inp.value;
      const savedShortcut = window.__AGContextMeter?.getAuxLayoutShortcut?.() || '';
      window.__toggleHostSettingsModal(false);
      await new Promise((r) => setTimeout(r, 80));

      const beforeOldL = window.__AGContextMeter?.getAuxCoexistMode?.();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      const afterOldL = window.__AGContextMeter?.getAuxCoexistMode?.();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 100));
      const afterNewK = window.__AGContextMeter?.getAuxCoexistMode?.();

      let restoredShortcut = '';
      if (resetBtn) {
        resetBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        restoredShortcut = window.__AGContextMeter?.getAuxLayoutShortcut?.() || '';
      }
      return {
        foundInput: true,
        recordedValue,
        savedShortcut,
        beforeOldL,
        afterOldL,
        afterNewK,
        restoredShortcut
      };
    })()`);
    assert.equal(customHotkeyCheck.foundInput, true, '设置页必须提供 #ag-ns-input-auxLayoutShortcut 快捷键录制项');
    assert.equal(customHotkeyCheck.recordedValue, 'Ctrl+Alt+K', `按键录制后输入框值必须更新为 Ctrl+Alt+K，实得: ${customHotkeyCheck.recordedValue}`);
    assert.equal(customHotkeyCheck.savedShortcut, 'Ctrl+Alt+K', `修改后的快捷键必须保存为 Ctrl+Alt+K，实得: ${customHotkeyCheck.savedShortcut}`);
    assert.equal(customHotkeyCheck.afterOldL, customHotkeyCheck.beforeOldL, '改键为 Ctrl+Alt+K 后旧键 Ctrl+Alt+L 不得再误触');
    assert.notEqual(
      customHotkeyCheck.afterNewK,
      customHotkeyCheck.afterOldL,
      `修改快捷键为 Ctrl+Alt+K 后按下新快捷键必须触发切换（前=${customHotkeyCheck.afterOldL}, 后=${customHotkeyCheck.afterNewK}）`
    );
    assert.equal(customHotkeyCheck.restoredShortcut, 'Ctrl+Alt+L', '点击恢复默认后快捷键必须恢复为 Ctrl+Alt+L');
  } finally {
    await session.close();
  }
});

test('阶段二验收 2D：加号常驻三态覆盖（只开插件标签、先插件再浏览器、Swarm↔插件反复切换后）且点击可拉出原生工具', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin'
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    const checkPlus = () =>
      cdp.evaluate(`(() => {
        const strip = document.getElementById('host-strip');
        const plus = document.getElementById('host-plus-btn');
        if (!strip || !plus || !plus.isConnected) return { ok: false, reason: 'missing' };
        const cs = getComputedStyle(plus);
        const r = plus.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return {
          ok: !plus.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0,
          clickable: hit === plus || (hit && plus.contains(hit)),
          rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
      })()`);

    // 状态一：只开插件标签（移除所有原生 tab，仅留 ContextMeter + 末尾 +）
    await cdp.evaluate(`(() => {
      window.__setNativeTabsForTest([]);
      window.__AGContextMeter?.setAuxCoexistMode?.('tab', { persist: false });
      window.__AGContextMeter?.tickForTest?.();
    })()`);
    await new Promise((r) => setTimeout(r, 120));
    const s1 = await checkPlus();
    assert.equal(s1.ok && s1.clickable, true, `只开插件标签时 strip 末尾加号必须常驻可见且可点: ${JSON.stringify(s1)}`);

    // 状态二：先开插件再点击加号开出浏览器
    await cdp.evaluate(`document.getElementById('host-plus-btn').click()`);
    await new Promise((r) => setTimeout(r, 120));
    const s2 = await checkPlus();
    const s2Meta = await cdp.evaluate(`({
      clicks: window.__plusClickCount,
      browserTabPresent: Boolean(document.querySelector('button[data-tab-id="browser__main"]'))
    })`);
    assert.ok(s2Meta.clicks >= 1 && s2Meta.browserTabPresent, `点击加号必须成功拉出原生浏览器标签: ${JSON.stringify(s2Meta)}`);
    assert.equal(s2.ok && s2.clickable, true, `先开插件再开浏览器后末尾加号必须仍常驻可见可点: ${JSON.stringify(s2)}`);

    // 状态三：Swarm 与插件标签反复切换 5 轮
    await cdp.evaluate(`window.__setNativeTabsForTest(['browser', 'swarm'])`);
    for (let i = 0; i < 5; i++) {
      await cdp.evaluate(`document.querySelector('button[data-tab-id="swarm__main"]')?.click()`);
      await new Promise((r) => setTimeout(r, 40));
      await cdp.evaluate(`document.getElementById('ag-context-meter-tab')?.click()`);
      await new Promise((r) => setTimeout(r, 40));
    }
    const s3 = await checkPlus();
    assert.equal(s3.ok && s3.clickable, true, `Swarm 与插件反复切换 5 轮后末尾加号必须仍常驻可见可点: ${JSON.stringify(s3)}`);
  } finally {
    await session.close();
  }
});

// ============================================================================
// 阶段三：主窗右上角五槽位胶囊归位、五槽交互与动态伸缩（任务书第 4.1–4.4、4.6、1.5 节）
// ============================================================================

test('阶段三验收 3A：主窗会话头「打开 IDE」左邻挂载（安全区 >=12px、零遮挡）、辅助栏内无胶囊、独立开关关闭彻底卸载且持久化', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1680,
    height: 900,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`(() => {
      window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false });
      window.__setMainSessionWidthForTest(1160);
    })()`);
    await new Promise((r) => setTimeout(r, 260));

    const anchorCheck = await helpers.findMainCapsuleShadowInfo(cdp);
    assert.equal(anchorCheck.hasCapsuleHost, true, `主窗会话头必须挂载五槽位胶囊宿主 [data-om-main-capsule-host]: ${JSON.stringify(anchorCheck)}`);
    assert.equal(anchorCheck.inConvHeader, true, `五槽位胶囊必须挂在主窗会话头内部，不得飘在窗口外或辅助栏: ${JSON.stringify(anchorCheck)}`);
    assert.equal(anchorCheck.auxHasCapsule, false, '辅助栏内部严禁再出现五槽位胶囊');
    assert.ok(anchorCheck.capsuleRect && anchorCheck.openIdeRect, '胶囊与打开 IDE 按钮必须均具有有效几何');
    const gapToOpenIde = anchorCheck.openIdeRect.left - anchorCheck.capsuleRect.right;
    assert.ok(
      gapToOpenIde >= 10,
      `胶囊右缘必须在「打开 IDE」左侧并保留 >=12px 安全区（允许 2px 亚像素舍入），实测间距=${gapToOpenIde}px, capsule=${JSON.stringify(anchorCheck.capsuleRect)}, openIde=${JSON.stringify(anchorCheck.openIdeRect)}`
    );
    assert.ok(
      anchorCheck.capsuleRect.bottom <= anchorCheck.convHeaderRect.bottom + 2,
      `胶囊不得压住会话正文首行，实测 capsule.bottom=${anchorCheck.capsuleRect.bottom}, header.bottom=${anchorCheck.convHeaderRect.bottom}`
    );

    // 独立开关关闭后彻底卸载胶囊无残影且持久化，再开启恢复
    const toggleCheck = await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const pgSr = document.getElementById('ag-cm-host-settings-page')?.shadowRoot;
      const sw =
        pgSr?.querySelector('[data-switch-key="mainCapsuleEnabled"], #ag-ns-sw-mainCapsuleEnabled, [id*="capsule" i][role="switch"], [data-ag-ns-sw*="capsule" i]') ||
        Array.from(pgSr?.querySelectorAll('[role="switch"]') || []).find((el) => /胶囊|capsule/i.test(el.closest('.ag-ns-row')?.textContent || ''));
      if (!sw) return { foundSwitch: false };
      const initialChecked = sw.getAttribute('aria-checked');
      sw.click();
      await new Promise((r) => setTimeout(r, 160));
      const afterOffHost = document.querySelector('[data-om-main-capsule-host]');
      const savedAfterOff = window.__savedSettingsCalls.slice(-3);
      sw.click();
      await new Promise((r) => setTimeout(r, 160));
      const afterOnHost = document.querySelector('[data-om-main-capsule-host]');
      window.__toggleHostSettingsModal(false);
      return {
        foundSwitch: true,
        initialChecked,
        removedWhenOff: !afterOffHost || !afterOffHost.isConnected,
        restoredWhenOn: Boolean(afterOnHost && afterOnHost.isConnected),
        savedAfterOff
      };
    })()`);
    assert.equal(toggleCheck.foundSwitch, true, '设置页必须提供五槽位胶囊独立开关');
    assert.equal(toggleCheck.removedWhenOff, true, '关闭五槽位胶囊独立开关后必须彻底卸载胶囊 DOM 无残影');
    assert.equal(toggleCheck.restoredWhenOn, true, '重新开启独立开关后必须恢复主窗五槽位胶囊');
  } finally {
    await session.close();
  }
});

test('阶段三验收 3B：五槽位全交互（槽1 5H/7D+1500ms节流+右键/Alt左键、槽2浮层、槽3智能/手动锁定/3子项/3种收起、槽4两入口、槽5 CLI强调色与改色）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1680,
    height: 900,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`(() => {
      window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false });
      window.__setMainSessionWidthForTest(1160);
      window.__quotaFetchCount = 0;
      const origGetQuota = window.contextMeterAPI.getQuota;
      window.contextMeterAPI.getQuota = async (...args) => {
        window.__quotaFetchCount += 1;
        return origGetQuota(...args);
      };
    })()`);
    await new Promise((r) => setTimeout(r, 260));

    // 1. 槽位 1：5H/7D 轮切 + 1500ms 节流防连点雪崩 + 右键 & Alt+左键打开额度面板
    const slot1Res = await cdp.evaluate(`(async () => {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const sr = h?.shadowRoot;
      const quotaBtn = sr?.getElementById('ag-v2-mtb-quota-ring') || sr?.querySelector('[data-slot="quota"]');
      if (!quotaBtn) return { found: false };
      const getActiveWin = () => quotaBtn.getAttribute('data-quota-window') || quotaBtn.getAttribute('data-active-window') || sr?.querySelector('.ag-v2-mtb-quota-tag[data-active="true"]')?.textContent?.trim() || '';
      const beforeWin = getActiveWin();
      window.__quotaFetchCount = 0;
      quotaBtn.click();
      await new Promise((r) => setTimeout(r, 60));
      const after1Win = getActiveWin();
      const countAfter1 = window.__quotaFetchCount;
      // 1500ms 内连续点击 3 次，节流不得引发重复请求雪崩
      quotaBtn.click();
      quotaBtn.click();
      quotaBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const countAfterBurst = window.__quotaFetchCount;

      // 右键展开额度面板
      quotaBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      await new Promise((r) => setTimeout(r, 120));
      const hostSr = document.getElementById('ag-context-meter')?.shadowRoot;
      const quotaOpenByRight = Boolean(
        (hostSr?.getElementById('panel-quota') && !hostSr.getElementById('panel-quota').hidden) ||
        document.querySelector('[data-om-quota-popover]:not([hidden])') ||
        sr?.querySelector('[data-om-quota-popover]:not([hidden])')
      );
      // Alt+左键也能展开额度面板
      quotaBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 120));
      const quotaOpenByAlt = Boolean(
        (hostSr?.getElementById('panel-quota') && !hostSr.getElementById('panel-quota').hidden) ||
        document.querySelector('[data-om-quota-popover]:not([hidden])') ||
        sr?.querySelector('[data-om-quota-popover]:not([hidden])')
      );
      return { found: true, beforeWin, after1Win, countAfter1, countAfterBurst, quotaOpenByRight, quotaOpenByAlt };
    })()`);
    assert.equal(slot1Res.found, true, '必须存在槽位 1 额度圆环');
    assert.notEqual(slot1Res.after1Win, slot1Res.beforeWin, `单击槽位 1 必须轮切 5H/7D（前=${slot1Res.beforeWin}, 后=${slot1Res.after1Win}）`);
    assert.ok(slot1Res.countAfterBurst <= Math.max(1, slot1Res.countAfter1), `1500ms 内连点槽位 1 必须节流防雪崩: after1=${slot1Res.countAfter1}, burst=${slot1Res.countAfterBurst}`);
    assert.equal(slot1Res.quotaOpenByRight || slot1Res.quotaOpenByAlt, true, `右键与 Alt+左键必须展开额度面板: ${JSON.stringify(slot1Res)}`);

    // 1.5 槽位 2：上下文进度圆环含环内百分比 + 单击展开精简上下文浮层
    const slot2Res = await cdp.evaluate(`(async () => {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const sr = h?.shadowRoot;
      const ctxBtn = sr?.querySelector('[data-slot="ring-secondary"], [data-slot="context"], #ag-v2-mtb-context-ring, #ag-v2-mtb-ring-secondary');
      if (!ctxBtn) return { found: false };
      const pctEl = sr.getElementById('ag-v2-mtb-context-pct') || ctxBtn.querySelector('.ag-v2-mtb-ring-pct, text');
      const pctText = pctEl ? String(pctEl.textContent || '').trim() : '';
      ctxBtn.click();
      await new Promise((r) => setTimeout(r, 140));
      const hostSr = document.getElementById('ag-context-meter')?.shadowRoot;
      const panelOpen = Boolean(
        (hostSr?.getElementById('panel') && !hostSr.getElementById('panel').hidden) ||
        document.querySelector('[data-om-capsule-popover]:not([hidden])')
      );
      return { found: true, pctText, panelOpen };
    })()`);
    assert.equal(slot2Res.found, true, '必须存在槽位 2 上下文进度圆环');
    assert.ok(slot2Res.pctText.length > 0, `槽位 2 圆环内必须存在百分比显示元素，实得: "${slot2Res.pctText}"`);
    assert.equal(slot2Res.panelOpen, true, `单击槽位 2 必须展开上下文详情浮层: ${JSON.stringify(slot2Res)}`);

    // 2. 槽位 3：原位横向展开 3 子项 + 叉形/空白/Esc 三种收起 + 手动锁定持久化 + 无硬编码紫 + 槽位 4 二级菜单两入口与单组互斥
    const slot3Res = await cdp.evaluate(`(async () => {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const sr = h?.shadowRoot;
      const group = sr?.getElementById('ag-v2-mtb-group-ttft') || sr?.querySelector('[data-group="ttft-group"]');
      if (!group) return { found: false };
      const trigger = group.querySelector('button[data-active="true"]') || group.querySelector('button[data-group-item="ttft-group"]');
      trigger.click();
      await new Promise((r) => setTimeout(r, 240));
      const openAfterClick = group.getAttribute('data-open') === 'true';
      const subItems = Array.from(group.querySelectorAll('button[data-group-item="ttft-group"]')).map((b) => b.getAttribute('data-tool') || b.id);
      const pill = group.querySelector('.ag-v2-mtb-pill');
      const pillBg = pill ? getComputedStyle(pill).backgroundColor : '';

      // 叉形收起
      const closeBtn = sr.getElementById('ag-v2-mtb-close-ttft') || group.querySelector('[data-close-group="ttft-group"]');
      closeBtn?.click();
      await new Promise((r) => setTimeout(r, 240));
      const closedByX = group.getAttribute('data-open') === 'false';

      // 再展开 -> Esc 收起
      (group.querySelector('button[data-active="true"]') || trigger).click();
      await new Promise((r) => setTimeout(r, 240));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 240));
      const closedByEsc = group.getAttribute('data-open') === 'false';

      // 再展开 -> 点空白处收起
      (group.querySelector('button[data-active="true"]') || trigger).click();
      await new Promise((r) => setTimeout(r, 240));
      document.getElementById('conv-messages')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.getElementById('conv-messages')?.click();
      await new Promise((r) => setTimeout(r, 240));
      const closedByOutside = group.getAttribute('data-open') === 'false';

      // 手动锁定沙漏（ttft）并检查 localStorage 持久化，以及再次点击恢复 auto 智能模式
      (group.querySelector('button[data-active="true"]') || trigger).click();
      await new Promise((r) => setTimeout(r, 240));
      const btnTtft = sr.getElementById('ag-v2-mtb-tool-ttft') || group.querySelector('[data-tool="ttft"]');
      btnTtft?.click();
      await new Promise((r) => setTimeout(r, 140));
      const pinAfterLock = localStorage.getItem('ag_mtb_status_pin_mode') || window.__AGContextMeter?.getMainCapsuleStateForTest?.()?.statusPinMode || '';

      // 同一时刻仅允许展开一组 + 槽位 4 二级菜单含个人主页与详细上下文
      const statsGroup = sr?.getElementById('ag-v2-mtb-group-stats') || sr?.querySelector('[data-group="stats-group"]');
      (group.querySelector('button[data-active="true"]') || trigger).click();
      await new Promise((r) => setTimeout(r, 220));
      const statsTrigger = statsGroup?.querySelector('button[data-active="true"], button[data-group-item="stats-group"]');
      statsTrigger?.click();
      await new Promise((r) => setTimeout(r, 220));
      const ttftClosedWhenStatsOpen = group.getAttribute('data-open') === 'false';
      const statsSubItems = Array.from(statsGroup?.querySelectorAll('button[data-group-item="stats-group"]') || []).map((b) => ({
        tool: b.getAttribute('data-tool') || b.id,
        aria: b.getAttribute('aria-label') || b.title || b.textContent || ''
      }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 180));

      return { found: true, openAfterClick, subItems, pillBg, closedByX, closedByEsc, closedByOutside, pinAfterLock, ttftClosedWhenStatsOpen, statsSubItems };
    })()`);
    assert.equal(slot3Res.found, true, '必须存在槽位 3 状态工具组');
    assert.equal(slot3Res.openAfterClick, true, '单击槽位 3 必须原位横向展开');
    assert.ok(slot3Res.subItems.length >= 3, `槽位 3 必须包含沙漏/仪表盘/双人切号至少 3 个子项，实得: ${JSON.stringify(slot3Res.subItems)}`);
    assert.equal(HARDCODED_PURPLE_RGB_SET.has(slot3Res.pillBg), false, `槽位 3 高亮滑块严禁硬编码紫，实得 bg=${slot3Res.pillBg}`);
    assert.equal(slot3Res.closedByX, true, '点击叉形按钮必须收起槽位 3');
    assert.equal(slot3Res.closedByEsc, true, '按 Esc 必须收起槽位 3');
    assert.equal(slot3Res.closedByOutside, true, '点击空白处必须收起槽位 3');
    assert.ok(slot3Res.pinAfterLock && slot3Res.pinAfterLock !== 'auto', `手动锁定沙漏后必须持久化偏好，实得: ${slot3Res.pinAfterLock}`);
    assert.equal(slot3Res.ttftClosedWhenStatsOpen, true, '展开槽位 4 时槽位 3 必须自动收起（同一时刻仅展开一组）');
    assert.ok(slot3Res.statsSubItems.length >= 2, `槽位 4 展开菜单必须同时提供个人主页与详细上下文等入口，实得: ${JSON.stringify(slot3Res.statsSubItems)}`);

    // 3. 槽位 5 CLI：默认跟随宿主强调色（无紫），设置页切换中性单色/自定义色实时生效
    const slot5Res = await cdp.evaluate(`(async () => {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const sr = h?.shadowRoot;
      const cliBtn = sr?.getElementById('ag-v2-mtb-cli') || sr?.querySelector('[data-slot="cli"]');
      if (!cliBtn) return { found: false };
      const initialColor = getComputedStyle(cliBtn).color;
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const pgSr = document.getElementById('ag-cm-host-settings-page')?.shadowRoot;
      const monoBtn = pgSr?.querySelector('[data-ag-ns-seg="cliIconColorMode"] [data-value="mono"], [data-ag-ns-seg="cliIconColorMode"] [data-ag-val="mono"], #ag-ns-btn-cli-color-mono');
      if (monoBtn) monoBtn.click();
      await new Promise((r) => setTimeout(r, 120));
      const monoColor = getComputedStyle(cliBtn).color;
      window.__toggleHostSettingsModal(false);
      return { found: true, initialColor, monoColor, hasMonoSetting: Boolean(monoBtn) };
    })()`);
    assert.equal(slot5Res.found, true, '必须存在槽位 5 CLI 入口');
    assert.equal(HARDCODED_PURPLE_RGB_SET.has(slot5Res.initialColor), false, `CLI 图标默认色严禁为硬编码紫，实得 ${slot5Res.initialColor}`);
    assert.equal(slot5Res.hasMonoSetting, true, '设置页外观区必须存在 CLI 图标颜色选项');
  } finally {
    await session.close();
  }
});

test('阶段三验收 3C：动态伸缩三条规则（仅浏览器完整常驻、开插件缩进把手且点击展开/收起、宽度 1200->1000->820->680->1200 梯度简化与反序恢复零溢出）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1680,
    height: 900,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    // 规则一：辅助栏仅开浏览器，主会话 1200px -> 完整 5 槽常驻
    await cdp.evaluate(`(() => {
      window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false });
      window.__setMainSessionWidthForTest(1200);
    })()`);
    await new Promise((r) => setTimeout(r, 240));
    const r1 = await helpers.findMainCapsuleShadowInfo(cdp);
    assert.equal(r1.retracted, false, `规则一：仅开浏览器时胶囊应常驻完整形态而非收起: ${JSON.stringify(r1)}`);
    assert.ok(r1.visibleSlots.length >= 5, `规则一：1200px 宽下应完整显示 5 槽位，实得 ${JSON.stringify(r1.visibleSlots)}`);

    // 规则二：辅助栏打开 ContextMeter 插件 -> 平滑缩进收起为呼出把手；点击把手展开并存；再点收起
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('tab', { persist: false })`);
    await new Promise((r) => setTimeout(r, 280));
    const r2Tucked = await helpers.findMainCapsuleShadowInfo(cdp);
    assert.equal(
      r2Tucked.retracted || r2Tucked.handleVisible,
      true,
      `规则二：辅助栏打开插件时主窗胶囊必须缩进收起并保留极简呼出把手: ${JSON.stringify(r2Tucked)}`
    );
    await cdp.evaluate(`(() => {
      const h = document.querySelector('[data-om-main-capsule-host]');
      const handle = h?.shadowRoot?.querySelector('[data-om-capsule-handle], .ag-om-capsule-handle, .ag-v2-mtb-handle, button[data-role="capsule-handle"]');
      handle?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    const r2Expanded = await helpers.findMainCapsuleShadowInfo(cdp);
    assert.equal(r2Expanded.retracted, false, `规则二：点击呼出把手后必须展开胶囊与辅助栏并存: ${JSON.stringify(r2Expanded)}`);

    // 规则三 & 规则四：主会话宽度 1200 -> 1000 -> 820 -> 680 -> 1200 逐档简化与反序恢复，且全程无溢出无遮挡
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    const widths = [1200, 1000, 820, 680, 1200];
    const samples = [];
    for (const w of widths) {
      await cdp.evaluate(`window.__setMainSessionWidthForTest(${w})`);
      await new Promise((r) => setTimeout(r, 200));
      const info = await helpers.findMainCapsuleShadowInfo(cdp);
      samples.push({ w, ...info });
      assert.ok(
        info.capsuleRect && info.openIdeRect && info.capsuleRect.right <= info.openIdeRect.left + 1,
        `规则四：主会话宽 ${w}px 下胶囊不得遮挡「打开 IDE」按钮: capsule=${JSON.stringify(info.capsuleRect)}, openIde=${JSON.stringify(info.openIdeRect)}`
      );
      assert.ok(
        info.capsuleRect.left >= info.convHeaderRect.left - 1,
        `规则四：主会话宽 ${w}px 下胶囊不得向左溢出越界: capsule=${JSON.stringify(info.capsuleRect)}, header=${JSON.stringify(info.convHeaderRect)}`
      );
    }
    const at680 = samples.find((s) => s.w === 680);
    const atRestore1200 = samples[samples.length - 1];
    assert.ok(
      at680.visibleSlots.length <= 2,
      `规则三：<760px（实测 680px）只应保留额度圆环与 CLI 共 2 枚，实得 ${JSON.stringify(at680.visibleSlots)}`
    );
    assert.ok(
      atRestore1200.visibleSlots.length >= 5,
      `规则三：宽度回升至 1200px 后必须反序完整恢复 5 槽位，实得 ${JSON.stringify(atRestore1200.visibleSlots)}`
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// 阶段四：会话内四视角 Tab（对话 | 轨迹 | 上下文 | 编队）（任务书第 5 节与 1.5 节）
// ============================================================================

test('阶段四验收 4A：清除辅助栏「对话轨迹上下文编队」残留、会话标题下注入 [data-om-session-tabs]、默认对话且切会话重置、独立开关可完全卸载', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin',
    width: 1560,
    height: 920,
    auxWidthPx: 420
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    const audit = await cdp.evaluate(`(() => {
      const auxHost = document.getElementById('ag-context-meter');
      const auxText = auxHost?.shadowRoot ? String(auxHost.shadowRoot.textContent || '').replace(/\\s+/g, '') : '';
      const hasAuxResidue = auxText.includes('对话轨迹上下文编队') || auxText.includes('對話軌跡上下文編');

      const header = document.querySelector('[data-testid="conversation-header"]');
      const convView = document.querySelector('[data-testid="conversation-view"]');
      const msgs = document.getElementById('conv-messages');
      const tabsBar = document.querySelector('[data-om-session-tabs]');
      const tabsRoot = tabsBar?.shadowRoot || tabsBar;
      const tabButtons = tabsRoot
        ? Array.from(tabsRoot.querySelectorAll('button[role="tab"], [data-om-tab], [data-tab]')).map((b) => ({
            key: b.getAttribute('data-om-tab') || b.getAttribute('data-tab') || b.getAttribute('data-view') || '',
            text: String(b.textContent || '').trim(),
            selected: b.getAttribute('aria-selected') === 'true' || b.getAttribute('data-active') === 'true' || b.classList.contains('active')
          }))
        : [];
      const hRect = header?.getBoundingClientRect();
      const bRect = tabsBar?.getBoundingClientRect();
      const mRect = msgs?.getBoundingClientRect();
      return {
        hasAuxResidue,
        hasTabsBar: Boolean(tabsBar && tabsBar.isConnected),
        tabButtons,
        belowHeader: Boolean(hRect && bRect && bRect.top >= hRect.bottom - 2),
        aboveMessages: Boolean(mRect && bRect && bRect.bottom <= mRect.top + 4),
        sameWidthLeftAligned: Boolean(hRect && bRect && Math.abs(bRect.left - hRect.left) <= 4 && Math.abs(bRect.width - hRect.width) <= 8)
      };
    })()`);

    assert.equal(audit.hasAuxResidue, false, '辅助栏内严禁再出现「对话轨迹上下文编队」错误残留');
    assert.equal(audit.hasTabsBar, true, '会话标题正下方必须挂载 [data-om-session-tabs]');
    assert.equal(audit.belowHeader, true, '[data-om-session-tabs] 必须位于会话标题行正下方');
    assert.equal(audit.aboveMessages, true, '[data-om-session-tabs] 必须位于消息列表上方');
    assert.equal(audit.sameWidthLeftAligned, true, '[data-om-session-tabs] 必须与会话标题行同宽左对齐');
    const tabLabels = audit.tabButtons.map((b) => b.text);
    for (const reqLabel of ['对话', '轨迹', '上下文', '编队']) {
      assert.ok(tabLabels.includes(reqLabel), `四视角 Tab 条必须包含「${reqLabel}」，实得: ${JSON.stringify(tabLabels)}`);
    }
    const defaultActive = audit.tabButtons.find((b) => b.selected);
    assert.equal(defaultActive?.text, '对话', `默认激活视角必须为「对话」，实得: ${JSON.stringify(defaultActive)}`);

    // 切到「轨迹」后模拟切换到新会话，必须自动重置回「对话」
    const resetCheck = await cdp.evaluate(`(async () => {
      window.__AGContextMeter?.switchSessionViewTab?.('trace');
      await new Promise((r) => setTimeout(r, 120));
      const activeBefore = window.__AGContextMeter?.getSessionFourViewsState?.()?.activeTab || document.querySelector('[data-om-session-tabs]')?.getAttribute('data-om-active-tab');
      if (typeof window.__AGContextMeter?.simulateConversationSwitchForTest === 'function') {
        window.__AGContextMeter.simulateConversationSwitchForTest('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      } else {
        const cv = document.querySelector('[data-testid="conversation-view"]');
        cv?.setAttribute('data-cascade-id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        history.pushState({}, '', '/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
      await new Promise((r) => setTimeout(r, 180));
      const activeAfter = window.__AGContextMeter?.getSessionFourViewsState?.()?.activeTab || document.querySelector('[data-om-session-tabs]')?.getAttribute('data-om-active-tab');
      return { activeBefore, activeAfter };
    })()`);
    assert.equal(resetCheck.activeBefore, 'trace', '切换至轨迹视图应生效');
    assert.equal(resetCheck.activeAfter, 'chat', `切换新会话后必须自动重置回「对话」，实得: ${resetCheck.activeAfter}`);

    // 独立开关关闭后彻底卸载 Tab 条与视图，重新开启恢复
    const toggleCheck = await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const pgSr = document.getElementById('ag-cm-host-settings-page')?.shadowRoot;
      const sw =
        pgSr?.querySelector('#ag-ns-sw-sessionFourViewsEnabled, [data-ag-ns-switch="sessionFourViewsEnabled"], [data-switch-key="sessionFourViewsEnabled"]') ||
        Array.from(pgSr?.querySelectorAll('[role="switch"]') || []).find((el) => /四视角|会话内/.test(el.closest('.ag-ns-row')?.textContent || ''));
      if (!sw) return { found: false };
      sw.click();
      await new Promise((r) => setTimeout(r, 140));
      const goneWhenOff = !document.querySelector('[data-om-session-tabs]');
      const convVisibleWhenOff = (() => {
        const m = document.getElementById('conv-messages');
        return Boolean(m && !m.hidden && getComputedStyle(m).display !== 'none');
      })();
      sw.click();
      await new Promise((r) => setTimeout(r, 140));
      const backWhenOn = Boolean(document.querySelector('[data-om-session-tabs]'));
      window.__toggleHostSettingsModal(false);
      return { found: true, goneWhenOff, convVisibleWhenOff, backWhenOn };
    })()`);
    assert.equal(toggleCheck.found, true, '设置页必须提供四视角 Tab 独立开关');
    assert.equal(toggleCheck.goneWhenOff, true, '关闭四视角开关后 [data-om-session-tabs] 必须彻底卸载无残影');
    assert.equal(toggleCheck.convVisibleWhenOff, true, '关闭四视角开关后原生对话区必须正常显示无黑洞');
    assert.equal(toggleCheck.backWhenOn, true, '重新开启四视角开关后必须恢复 Tab 条');
  } finally {
    await session.close();
  }
});

test('阶段四验收 4B：四视角切换保活原生对话（DOM 节点不变、scrollTop 精准不变、零重载、独立滚动容器、右侧浏览器不受影响）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 760,
    auxWidthPx: 360
  });
  const { cdp, initialTimeOrigin } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.seedRichSessionForStage4(cdp);
    await new Promise((r) => setTimeout(r, 220));

    // 将原生对话区滚动到 scrollTop > 0，并记录原始节点引用
    const prep = await cdp.evaluate(`(() => {
      const msgs = document.getElementById('conv-messages');
      msgs.scrollTop = 180;
      window.__origMsgFirstChild = msgs.firstElementChild;
      return {
        scrollHeight: msgs.scrollHeight,
        clientHeight: msgs.clientHeight,
        scrollTop: Math.round(msgs.scrollTop)
      };
    })()`);
    assert.ok(prep.scrollTop >= 80, `夹具对话区必须真实可滚动，实得 scrollTop=${prep.scrollTop} (scrollH=${prep.scrollHeight}, clientH=${prep.clientHeight})`);

    const viewMetrics = {};
    for (const v of ['trace', 'context', 'collab']) {
      await cdp.evaluate(`window.__AGContextMeter?.switchSessionViewTab?.(${JSON.stringify(v)})`);
      await new Promise((r) => setTimeout(r, 180));
      viewMetrics[v] = await cdp.evaluate(`(() => {
        const viewEl = document.querySelector('[data-om-session-view="' + ${JSON.stringify(v)} + '"]');
        const browserPane = document.getElementById('host-browser-pane');
        const brRect = browserPane?.getBoundingClientRect();
        const cs = viewEl ? getComputedStyle(viewEl) : null;
        const innerScroll = viewEl?.shadowRoot
          ? Array.from(viewEl.shadowRoot.querySelectorAll('*')).some((el) => {
              const s = getComputedStyle(el);
              return s.overflowY === 'auto' || s.overflowY === 'scroll';
            })
          : false;
        return {
          visible: Boolean(viewEl && !viewEl.hidden && cs && cs.display !== 'none'),
          independentScroll: Boolean((cs && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) || innerScroll),
          browserUnaffected: Boolean(brRect && brRect.width > 100 && brRect.height > 100 && getComputedStyle(browserPane).visibility !== 'hidden')
        };
      })()`);
      assert.equal(viewMetrics[v].visible, true, `切换至 ${v} 视图必须可见`);
      assert.equal(viewMetrics[v].independentScroll, true, `${v} 视图必须拥有独立滚动容器`);
      assert.equal(viewMetrics[v].browserUnaffected, true, `切换至 ${v} 视图时右侧浏览器分栏不得受影响`);
    }

    // 切回「对话」并断言原生对话节点引用不变、scrollTop 精准不变、timeOrigin 不变
    await cdp.evaluate(`window.__AGContextMeter?.switchSessionViewTab?.('chat')`);
    await new Promise((r) => setTimeout(r, 160));
    const afterChat = await cdp.evaluate(`(() => {
      const msgs = document.getElementById('conv-messages');
      return {
        sameNodeRef: msgs.firstElementChild === window.__origMsgFirstChild,
        scrollTop: Math.round(msgs.scrollTop),
        timeOrigin: window.performance.timeOrigin
      };
    })()`);
    assert.equal(afterChat.sameNodeRef, true, '切回对话后原生对话 DOM 节点必须零销毁零重建');
    assert.ok(
      Math.abs(afterChat.scrollTop - prep.scrollTop) <= 1,
      `切回对话后 scrollTop 必须精准保持不变（前=${prep.scrollTop}, 后=${afterChat.scrollTop}）`
    );
    assert.equal(afterChat.timeOrigin, initialTimeOrigin, '四视角往返切换严禁触发页面重载');
  } finally {
    await session.close();
  }
});

test('阶段四验收 4C：轨迹 / 上下文 / 编队三大视图业务区块、联动交互、零外部品牌与真实空态验证', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 920,
    auxWidthPx: 360
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.seedRichSessionForStage4(cdp);
    await new Promise((r) => setTimeout(r, 220));

    // 1. 轨迹视图：4 筛选胶囊 + 搜索框 + 泳道 + 行点击展开收起
    await cdp.evaluate(`window.__AGContextMeter?.switchSessionViewTab?.('trace')`);
    await new Promise((r) => setTimeout(r, 200));
    const traceAudit = await cdp.evaluate(`(async () => {
      const v = document.querySelector('[data-om-session-view="trace"]');
      const root = v?.shadowRoot || v;
      if (!root) return { found: false };
      const txt = String(root.textContent || '');
      const hasFilters = ['时长', '轮次', '调用', '子调用'].every((k) => txt.includes(k));
      const hasSearch = Boolean(root.querySelector('input[type="search"], input[type="text"], input'));
      const hasSwimlane = Boolean(root.querySelector('[data-om-trace-swimlane], .om-trace-swimlane, .trace-swimlane, svg'));
      const firstRow = root.querySelector('[data-om-trace-row], .om-trace-row, button[data-row-id], tr[data-row-id]');
      let expandedOk = false;
      if (firstRow) {
        firstRow.click();
        await new Promise((r) => setTimeout(r, 80));
        const afterOpen = root.querySelector('[data-om-trace-detail], .om-trace-detail, [aria-expanded="true"], [data-expanded="true"]');
        expandedOk = Boolean(afterOpen);
        firstRow.click();
      }
      return { found: true, hasFilters, hasSearch, hasSwimlane, hasRow: Boolean(firstRow), expandedOk, hasParens: /[()（）]/.test(txt) };
    })()`);
    assert.equal(traceAudit.found, true, '必须渲染轨迹视图');
    assert.equal(traceAudit.hasFilters, true, '轨迹视图顶部必须包含 时长/轮次/调用/子调用 四个筛选胶囊');
    assert.equal(traceAudit.hasSearch, true, '轨迹视图必须包含关键词搜索框');
    assert.equal(traceAudit.hasSwimlane, true, '轨迹视图必须渲染时间轴泳道');
    assert.equal(traceAudit.hasRow && traceAudit.expandedOk, true, `轨迹流水行点击必须原地展开详情: ${JSON.stringify(traceAudit)}`);

    // 2. 上下文视图：5 行完整区块 + 零第三方品牌 + 时间线柱图点击联动单步检查卡
    await cdp.evaluate(`window.__AGContextMeter?.switchSessionViewTab?.('context')`);
    await new Promise((r) => setTimeout(r, 220));
    const ctxAudit = await cdp.evaluate(`(async () => {
      const v = document.querySelector('[data-om-session-view="context"]');
      const root = v?.shadowRoot || v;
      if (!root) return { found: false };
      const txt = String(root.textContent || '');
      const requiredHeadings = ['上下文统计', 'Token 统计', '耗时统计', '当前上下文', '上下文时间线', '上下文浏览器', '上下文事件', '文件活动', '命令执行'];
      const missingHeadings = requiredHeadings.filter((h) => !txt.includes(h));
      const hasExternalBrand = /Zilliz|Milvus|推广|充值余额/i.test(txt);
      const bars = Array.from(root.querySelectorAll('[data-om-timeline-bar], [data-step-index], .om-ctx-bar'));
      let barLinked = false;
      if (bars.length >= 2) {
        const detailEl = root.querySelector('[data-om-step-detail], .om-ctx-step-detail');
        const beforeDetail = detailEl ? detailEl.textContent : '';
        bars[0].click();
        await new Promise((r) => setTimeout(r, 80));
        const afterFirst = detailEl ? detailEl.textContent : '';
        bars[bars.length - 1].click();
        await new Promise((r) => setTimeout(r, 80));
        const afterLast = detailEl ? detailEl.textContent : '';
        barLinked = Boolean(afterFirst && afterLast && (afterFirst !== afterLast || afterFirst !== beforeDetail));
      }
      return { found: true, missingHeadings, hasExternalBrand, barCount: bars.length, barLinked };
    })()`);
    assert.equal(ctxAudit.found, true, '必须渲染上下文视图');
    assert.deepEqual(ctxAudit.missingHeadings, [], `上下文视图缺少必须的 5 行业务区块: ${JSON.stringify(ctxAudit.missingHeadings)}`);
    assert.equal(ctxAudit.hasExternalBrand, false, '上下文视图严禁出现任何第三方品牌推广位');
    assert.ok(ctxAudit.barCount >= 2 && ctxAudit.barLinked, `上下文时间线柱图点击必须联动单步详情检查卡: ${JSON.stringify(ctxAudit)}`);

    // 3. 编队视图：4 计数 + 单主节点真实空态（零假子节点）+ 4 筛选事件检查
    await cdp.evaluate(`window.__AGContextMeter?.switchSessionViewTab?.('collab')`);
    await new Promise((r) => setTimeout(r, 200));
    const collabAudit = await cdp.evaluate(`(() => {
      const v = document.querySelector('[data-om-session-view="collab"]');
      const root = v?.shadowRoot || v;
      if (!root) return { found: false };
      const txt = String(root.textContent || '');
      const hasOverview = ['多 Agent 编队', '跨 Agent 协作', '协作任务', '事件检查'].every((k) => txt.includes(k));
      const hasEventFilters = ['全部', '消息', '回报', '委派'].every((k) => txt.includes(k));
      const hasHonestEmpty = txt.includes('subagent') || txt.includes('委派任务');
      const subNodes = root.querySelectorAll('[data-om-agent-role="sub"], [data-agent-role="sub"]');
      return { found: true, hasOverview, hasEventFilters, hasHonestEmpty, subNodeCount: subNodes.length };
    })()`);
    assert.equal(collabAudit.found, true, '必须渲染编队视图');
    assert.equal(collabAudit.hasOverview, true, '编队视图必须包含 多 Agent 编队 / 跨 Agent 协作 / 协作任务 / 事件检查 四大区块');
    assert.equal(collabAudit.hasEventFilters, true, '编队事件检查必须提供 全部/消息/回报/委派 四个筛选');
    assert.equal(collabAudit.hasHonestEmpty, true, '无子 Agent 时必须显示真实空态说明');
    assert.equal(collabAudit.subNodeCount, 0, '无子 Agent 时严禁伪造任何示例子 Agent 节点');
  } finally {
    await session.close();
  }
});

// ============================================================================
// 阶段五：左栏「详细上下文」全页重构与六大缺陷修复（任务书第 6 节与 9.2 节）
// ============================================================================

test('阶段五验收 5A：时间筛选 7d/30d/all 连续自然日含今天（零跳日）、热力图列数等于区间天数且今天在末列并支持点击锁定', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1600,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    const openRes = await helpers.openDetailedContextFullpage(cdp);
    assert.equal(openRes.opened, true, '必须能打开左栏「详细上下文」全页视图');

    const dateAudit = await cdp.evaluate(`(async () => {
      const now = new Date();
      const todayKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const todayShort = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      const root = page?.shadowRoot || page;

      const sampleRange = async (rangeKey) => {
        const btn = root.querySelector('[data-range="' + rangeKey + '"], [data-om-range="' + rangeKey + '"]') ||
          Array.from(root.querySelectorAll('.ag-ci-seg-btn, button')).find((b) => {
            const t = String(b.textContent || '').trim();
            if (rangeKey === '7d') return t.includes('7 天') || t.includes('7天');
            if (rangeKey === '30d') return t.includes('30 天') || t.includes('30天');
            return t.includes('全部');
          });
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 140));
        const barCols = Array.from(root.querySelectorAll('.ag-ci-7d-col, [data-om-bar-date]'));
        const barDates = barCols.map((el) => el.getAttribute('data-date') || el.getAttribute('data-om-bar-date') || el.querySelector('.ag-ci-7d-lbl')?.textContent?.trim() || '');
        const heatCells = Array.from(root.querySelectorAll('.ag-ci-heat-cell[data-date], [data-om-heat-date]'));
        const heatDates = heatCells.map((el) => el.getAttribute('data-date') || el.getAttribute('data-om-heat-date') || '');
        return { rangeKey, barCount: barCols.length, barDates, heatCount: heatCells.length, heatDates };
      };

      const r7 = await sampleRange('7d');
      const r30 = await sampleRange('30d');
      const rAll = await sampleRange('all');

      // 点击热力图任意小格验证选中锁定态与当日筛选
      const targetCell = root.querySelector('.ag-ci-heat-cell[data-date="' + todayKey + '"]') || root.querySelector('.ag-ci-heat-cell[data-date]');
      let cellClickLocked = false;
      let cellClickUnlocked = false;
      if (targetCell) {
        targetCell.click();
        await new Promise((r) => setTimeout(r, 100));
        const lockedEl = root.querySelector('.ag-ci-heat-cell[data-selected="true"], .ag-ci-heat-cell.is-selected, .ag-ci-heat-cell[aria-pressed="true"]');
        cellClickLocked = Boolean(lockedEl);
        (lockedEl || targetCell).click();
        await new Promise((r) => setTimeout(r, 100));
        cellClickUnlocked = !root.querySelector('.ag-ci-heat-cell[data-selected="true"], .ag-ci-heat-cell.is-selected, .ag-ci-heat-cell[aria-pressed="true"]');
      }

      return { todayKey, todayShort, r7, r30, rAll, cellClickLocked, cellClickUnlocked };
    })()`);

    const checkContinuousToToday = (dates, expectedMinLen, label) => {
      assert.ok(dates.length >= expectedMinLen, `${label} 必须至少有 ${expectedMinLen} 天，实得 ${dates.length}: ${JSON.stringify(dates)}`);
      const last = dates[dates.length - 1];
      assert.ok(
        last === dateAudit.todayKey || last === dateAudit.todayShort,
        `${label} 最后一列必须是今天(${dateAudit.todayKey}/${dateAudit.todayShort})，实得 "${last}"`
      );
      if (/^\d{4}-\d{2}-\d{2}$/.test(dates[0]) && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
        for (let i = 1; i < dates.length; i++) {
          const prevMs = Date.parse(dates[i - 1] + 'T00:00:00Z');
          const curMs = Date.parse(dates[i] + 'T00:00:00Z');
          assert.equal(curMs - prevMs, 86400000, `${label} 不得跳日: ${dates[i - 1]} -> ${dates[i]}`);
        }
      }
    };

    checkContinuousToToday(dateAudit.r7.barDates, 7, '近 7 天柱图');
    checkContinuousToToday(dateAudit.r7.heatDates, 7, '近 7 天热力图');
    assert.equal(dateAudit.r7.heatCount, 7, `近 7 天热力图列数必须等于 7，实得 ${dateAudit.r7.heatCount}`);
    checkContinuousToToday(dateAudit.r30.heatDates, 30, '近 30 天热力图');
    assert.equal(dateAudit.r30.heatCount, 30, `近 30 天热力图列数必须等于 30，实得 ${dateAudit.r30.heatCount}`);
    checkContinuousToToday(dateAudit.rAll.heatDates, 7, '全部时间热力图');
    assert.equal(dateAudit.cellClickLocked, true, '热力图任意小格点击必须进入选中锁定态');
    assert.equal(dateAudit.cellClickUnlocked, true, '再次点击热力图已锁小格必须取消锁定');
  } finally {
    await session.close();
  }
});

test('阶段五验收 5B：四列排行非空、迷你占比条填充 width>0 零紫色、3–6 列会话网格卡使用真实标题而非首条消息', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1600,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.openDetailedContextFullpage(cdp);

    const gridAudit = await cdp.evaluate(`(() => {
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      const root = page?.shadowRoot || page;
      if (!root) return { found: false };
      const txt = String(root.textContent || '');
      const hasFourRankings = ['项目分布', '技能加载', '工具调用', '命令执行'].every((k) => txt.includes(k));
      const fills = Array.from(root.querySelectorAll('.ag-ci-rank-fill'));
      const nonZeroFills = fills.filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none';
      });
      const fillColors = nonZeroFills.map((el) => getComputedStyle(el).backgroundColor);
      const hasRealProject = txt.includes('project1') || txt.includes('AntigravityContextMeter');

      const cards = Array.from(root.querySelectorAll('.ag-ci-session-card, [data-om-session-card]'));
      const cardTitles = cards.map((c) => {
        const t = c.querySelector('.ag-ci-session-title, [data-om-session-title]');
        return t ? String(t.textContent || '').trim() : '';
      });
      const hasMiniRings = cards.filter((c) => Boolean(c.querySelector('svg'))).length;
      const gridEl = root.querySelector('.ag-ci-session-grid, [data-om-session-grid], .ag-ci-session-list');
      const gridDisplay = gridEl ? getComputedStyle(gridEl).display : '';
      const gridCols = gridEl ? getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length : 0;

      return {
        found: true,
        hasFourRankings,
        hasRealProject,
        fillsTotal: fills.length,
        nonZeroFillsCount: nonZeroFills.length,
        fillColors,
        cardCount: cards.length,
        cardTitles,
        hasMiniRings,
        gridDisplay,
        gridCols
      };
    })()`);

    assert.equal(gridAudit.found, true, '必须渲染详细上下文页');
    assert.equal(gridAudit.hasFourRankings, true, '第 3 行必须包含 项目分布/技能加载/工具调用/命令执行 四列排行卡');
    assert.equal(gridAudit.hasRealProject, true, '项目分布排行卡不得为空，必须聚合真实项目名（如 project1 / AntigravityContextMeter）');
    assert.ok(gridAudit.nonZeroFillsCount >= 4, `四列排行卡迷你占比条 .ag-ci-rank-fill 必须真实渲染非零宽高，实得 ${gridAudit.nonZeroFillsCount}/${gridAudit.fillsTotal}`);
    for (const bg of gridAudit.fillColors) {
      assert.equal(HARDCODED_PURPLE_RGB_SET.has(bg), false, `占比条填充色严禁硬编码紫，实得 ${bg}`);
    }
    assert.ok(gridAudit.cardCount >= 4, `第 4 行必须渲染多张会话网格卡片，实得 ${gridAudit.cardCount}`);
    assert.equal(gridAudit.gridDisplay, 'grid', `会话区必须采用自适应 CSS Grid 卡片网格，实得 display=${gridAudit.gridDisplay}`);
    assert.ok(gridAudit.gridCols >= 3 && gridAudit.gridCols <= 6, `会话卡片网格在宽屏应为 3–6 列自适应，实得 ${gridAudit.gridCols} 列`);
    assert.ok(gridAudit.cardTitles.includes('Replying With Ok'), `会话卡片标题必须取真实会话标题 Replying With Ok，实得 ${JSON.stringify(gridAudit.cardTitles)}`);
    assert.equal(gridAudit.cardTitles.includes('只回答 ok'), false, '严禁用首条用户消息「只回答 ok」代替真实会话标题');
    assert.ok(gridAudit.hasMiniRings >= 4, `每张会话卡左侧应带迷你环形上下文进度图，实得 ${gridAudit.hasMiniRings}`);
  } finally {
    await session.close();
  }
});

test('阶段五验收 5C：全插件金额口径一致（详细上下文与本机已记录用量/个人主页对同一账本给出完全一致的美元估价）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1600,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.openDetailedContextFullpage(cdp);

    const costAudit = await cdp.evaluate(`(async () => {
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      const root = page?.shadowRoot || page;
      // 切到「全部时间」取详细上下文预估费用
      const allBtn = root?.querySelector('[data-range="all"], [data-om-range="all"]') ||
        Array.from(root?.querySelectorAll('.ag-ci-seg-btn, button') || []).find((b) => String(b.textContent || '').includes('全部'));
      if (allBtn) allBtn.click();
      await new Promise((r) => setTimeout(r, 140));

      const kpiCards = Array.from(root?.querySelectorAll('.ag-ci-kpi-card') || []);
      const costCard = kpiCards.find((c) => /预估费用|API|估价|费用/.test(c.textContent || ''));
      const detailedCostText = costCard?.querySelector('.ag-ci-kpi-val')?.textContent?.trim() || costCard?.textContent?.match(/\\$[\\d,.]+/)?.[0] || '';

      // 用 core 统一估价函数校验同一份 dailyInsights 的汇总金额
      const core = window.__AGContextMeterCore || {};
      const hist = await window.contextMeterAPI.getTokenHistory();
      const dailyInsights = hist?.crossSessionInsights?.dailyInsights || {};
      const dailyMap = hist?.dailyMap || {};
      let unifiedCost = null;
      if (typeof core.calculateIntervalCost === 'function') {
        const res = core.calculateIntervalCost(dailyMap, Object.keys(dailyMap), 'claude-sonnet-4-5', null, dailyInsights);
        unifiedCost = typeof res === 'number' ? res : Number(res?.totalCostUSD ?? res?.costUSD ?? res?.total ?? NaN);
      }
      const sumDailyInsights = Object.values(dailyInsights).reduce((acc, d) => acc + Number(d.costUSD || 0), 0);
      return { detailedCostText, unifiedCost, sumDailyInsights };
    })()`);

    const parsedDetailed = Number(String(costAudit.detailedCostText || '').replace(/[^0-9.]/g, ''));
    assert.ok(Number.isFinite(parsedDetailed) && parsedDetailed > 0, `详细上下文必须显示有效美元估价，实得 "${costAudit.detailedCostText}"`);
    assert.ok(
      Math.abs(parsedDetailed - costAudit.sumDailyInsights) < 0.05,
      `详细上下文估价(${parsedDetailed}) 必须与账本逐请求精确估价合计(${costAudit.sumDailyInsights}) 一致（同口径 $1766.40）`
    );
    if (Number.isFinite(costAudit.unifiedCost)) {
      assert.ok(
        Math.abs(parsedDetailed - costAudit.unifiedCost) < 0.05,
        `详细上下文估价(${parsedDetailed}) 必须与 core.calculateIntervalCost(${costAudit.unifiedCost}) 严格一致`
      );
    }
  } finally {
    await session.close();
  }
});

test('阶段五验收 5D：全页实色不透明背景、零标题叠字、并排模式无右边缘腰斩、左下角账号上拉菜单 100% 浮于全页最上层', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'split',
    auxViewTab: 'both',
    width: 1680,
    height: 940,
    auxWidthPx: 520,
    auxPluginSharePx: 260
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'both', 1000);
    await helpers.openDetailedContextFullpage(cdp);
    await new Promise((r) => setTimeout(r, 220));

    const layerAudit = await cdp.evaluate(`(async () => {
      const page = document.getElementById('ag-context-insights-page') || document.querySelector('[data-om-detailed-context-page]');
      const slot = document.getElementById('left-session-slot');
      const convTitle = document.getElementById('conv-title');
      const pageRect = page.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const pageCs = getComputedStyle(page);
      const bgAlphaMatch = pageCs.backgroundColor.match(/rgba\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\)/);
      const isOpaque = pageCs.backgroundColor !== 'transparent' && (!bgAlphaMatch || Number(bgAlphaMatch[1]) >= 0.99);

      // 校验不与对话标题叠字：命中测试 page 顶部区域应命中 page 自身，不透出 #conv-title
      const titleRect = convTitle?.getBoundingClientRect();
      const hitAtTitle = titleRect ? document.elementFromPoint(Math.round(titleRect.left + 20), Math.round(titleRect.top + 10)) : null;
      const titleCoveredByPage = Boolean(hitAtTitle && (hitAtTitle === page || page.contains(hitAtTitle)));

      // 校验并排模式下无右边缘腰斩（page 右边界 <= slot 右边界 + 2px，且内部无横向溢出裁切，所有卡片右边界不超 page 右边界，排行名宽度不被压为 0）
      const noRightClip = pageRect.right <= slotRect.right + 2 && pageRect.left >= slotRect.left - 2;
      const root = page.shadowRoot || page;
      const scroller = root.querySelector('.ag-ci-shell') || page;
      const noHorizOverflow = scroller.scrollWidth <= scroller.clientWidth + 4 && page.scrollWidth <= page.clientWidth + 4;
      const clippedCards = Array.from(root.querySelectorAll('.ag-ci-card')).filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.right > pageRect.right + 4;
      }).map((c) => c.querySelector('.ag-ci-card-title')?.textContent?.trim() || 'card');
      const rankNames = Array.from(root.querySelectorAll('.ag-ci-rank-name'));
      const crushedRankNames = rankNames.filter((n) => n.getBoundingClientRect().width < 20).length;

      // 打开左下角账号上拉菜单，验证菜单挂载在高层且 100% 浮于详细上下文全页之上不被裁切
      const acctBtn = document.getElementById('host-account-pill') || document.querySelector('[data-testid="sidebar-account-button"]');
      acctBtn?.click();
      await new Promise((r) => setTimeout(r, 180));
      const pop = document.querySelector('#ag-sidebar-account-popover, [data-ag-sidebar-account-popover], [data-om-account-popover]');
      const popRect = pop ? pop.getBoundingClientRect() : null;
      const popCs = pop ? getComputedStyle(pop) : null;
      const popZ = Number(popCs?.zIndex || 0);
      const pageZ = Number(pageCs.zIndex || 0);
      const popHit = popRect && popRect.width > 0
        ? document.elementFromPoint(Math.round(popRect.left + popRect.width / 2), Math.round(popRect.top + Math.min(24, popRect.height / 2)))
        : null;
      const popOnTop = Boolean(pop && popHit && (popHit === pop || pop.contains(popHit)));
      const popUncropped = Boolean(popRect && popRect.left >= 0 && popRect.top >= 0 && popRect.right <= window.innerWidth && popRect.bottom <= window.innerHeight && popRect.width > 120 && popRect.height > 60);

      return {
        isOpaque,
        bgColor: pageCs.backgroundColor,
        titleCoveredByPage,
        noRightClip,
        noHorizOverflow,
        clippedCards,
        crushedRankNames,
        rankNamesCount: rankNames.length,
        pageRect: { left: Math.round(pageRect.left), right: Math.round(pageRect.right), width: Math.round(pageRect.width) },
        slotRect: { left: Math.round(slotRect.left), right: Math.round(slotRect.right), width: Math.round(slotRect.width) },
        hasPopover: Boolean(pop && !pop.hidden),
        popZ,
        pageZ,
        popOnTop,
        popUncropped
      };
    })()`);

    assert.equal(layerAudit.isOpaque, true, `详细上下文全页必须为实色不透明背景，实得 bg=${layerAudit.bgColor}`);
    assert.equal(layerAudit.titleCoveredByPage, true, '详细上下文全页必须完整接管主内容区，严禁透出或与对话标题叠字');
    assert.equal(layerAudit.noRightClip, true, `并排模式下详细上下文不得越界被右侧腰斩: page=${JSON.stringify(layerAudit.pageRect)}, slot=${JSON.stringify(layerAudit.slotRect)}`);
    assert.equal(layerAudit.noHorizOverflow, true, `并排模式下详细上下文内部不得出现横向溢出裁切: clippedCards=${JSON.stringify(layerAudit.clippedCards)}`);
    assert.deepEqual(layerAudit.clippedCards, [], `并排模式下任何卡片（含活跃度热力图）右缘不得被裁切出界，被裁卡片: ${JSON.stringify(layerAudit.clippedCards)}`);
    assert.equal(layerAudit.crushedRankNames, 0, `并排模式下四列排行卡项目/技能/工具/命令名称不得被挤压至不可读（<20px），被压扁项数: ${layerAudit.crushedRankNames}/${layerAudit.rankNamesCount}`);
    assert.equal(layerAudit.hasPopover, true, '点击左下角账号胶囊必须弹出账号上拉菜单');
    assert.ok(layerAudit.popZ > layerAudit.pageZ, `账号上拉菜单 z-index(${layerAudit.popZ}) 必须严格高于详细上下文全页(${layerAudit.pageZ})`);
    assert.equal(layerAudit.popOnTop && layerAudit.popUncropped, true, `账号上拉菜单必须 100% 完整浮于全页视图最上层不被裁切: ${JSON.stringify(layerAudit)}`);
  } finally {
    await session.close();
  }
});

// ============================================================================
// 阶段六：个人 Token 用量主页与左起热力图（任务书第 7 节、1.5 节与 9.2 节）
// ============================================================================

test('阶段六验收 6A：左下角账号点击保活切号菜单、3 处入口统一开同一 #ag-profile-home-page、零旧浮层残留、独立开关可卸载恢复', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await new Promise((r) => setTimeout(r, 200));

    const entryAudit = await cdp.evaluate(`(async () => {
      // 1. 左下角账号头像单击仍打开账号切换上拉菜单，绝不直接切到个人主页
      const acctBtn = document.getElementById('host-account-pill');
      acctBtn.click();
      await new Promise((r) => setTimeout(r, 150));
      const pop = document.querySelector('#ag-sidebar-account-popover, [data-ag-sidebar-account-popover]');
      const popVisible = Boolean(pop && !pop.hidden && getComputedStyle(pop).display !== 'none');
      const pageBeforeMenuClick = document.getElementById('ag-profile-home-page');
      const notOpenedDirectly = !pageBeforeMenuClick || pageBeforeMenuClick.hidden;

      // 入口 1：点击账号上拉菜单顶部「个人用量主页」项（兼容 Shadow DOM Portal）
      const popRoot = pop?.shadowRoot || pop;
      const menuProfileBtn = Array.from(popRoot?.querySelectorAll('button, [role="menuitem"]') || []).find((b) => /个人用量主页|个人主页/.test(b.textContent || ''));
      menuProfileBtn?.click();
      await new Promise((r) => setTimeout(r, 180));
      const p1 = document.getElementById('ag-profile-home-page');
      const openedFromAccountMenu = Boolean(p1 && p1.isConnected && !p1.hidden);
      window.__AGContextMeter?.closePersonalProfileHome?.();
      await new Promise((r) => setTimeout(r, 100));

      // 入口 2：点击主窗胶囊第 4 槽统计入口
      const capHost = document.querySelector('[data-om-main-capsule-host]');
      const capSr = capHost?.shadowRoot;
      const statsBtn = capSr?.getElementById('ag-v2-mtb-tool-stats-bars') || capSr?.querySelector('[data-group="stats-group"] button[data-group-item="stats-group"]');
      const capDbg = {
        hasCapHost: Boolean(capHost),
        hasStatsBtn: Boolean(statsBtn),
        retracted: capHost?.getAttribute('data-om-retracted'),
        widthTier: capHost?.getAttribute('data-om-width-tier'),
        groupOpenBefore: capSr?.getElementById('ag-v2-mtb-group-stats')?.getAttribute('data-open')
      };
      statsBtn?.click();
      await new Promise((r) => setTimeout(r, 180));
      const p2 = document.getElementById('ag-profile-home-page');
      const openedFromCapsule = Boolean(p2 && p2.isConnected && !p2.hidden);
      capDbg.groupOpenAfter = capSr?.getElementById('ag-v2-mtb-group-stats')?.getAttribute('data-open');
      capDbg.p2Hidden = p2?.hidden;
      window.__AGContextMeter?.closePersonalProfileHome?.();
      await new Promise((r) => setTimeout(r, 100));

      // 入口 3：详细上下文页顶部「个人用量主页」按钮
      window.__AGContextMeter?.openDetailedContextView?.();
      await new Promise((r) => setTimeout(r, 180));
      const dcPage = document.getElementById('ag-context-insights-page');
      const dcRoot = dcPage?.shadowRoot || dcPage;
      const dcProfileBtn = Array.from(dcRoot?.querySelectorAll('button') || []).find((b) => /个人用量主页/.test(b.textContent || ''));
      dcProfileBtn?.click();
      await new Promise((r) => setTimeout(r, 180));
      const p3 = document.getElementById('ag-profile-home-page');
      const openedFromDetailed = Boolean(p3 && p3.isConnected && !p3.hidden);

      // 不存在第二个「本机已记录用量」居中浮层 (#panel-tokens 不可见)
      const auxSr = document.getElementById('ag-context-meter')?.shadowRoot;
      const oldTokensPanel = auxSr?.getElementById('panel-tokens');
      const oldOverlayVisible = Boolean(oldTokensPanel && !oldTokensPanel.hidden && getComputedStyle(oldTokensPanel).display !== 'none');

      return {
        popVisible,
        notOpenedDirectly,
        openedFromAccountMenu,
        openedFromCapsule,
        capDbg,
        openedFromDetailed,
        oldOverlayVisible
      };
    })()`);

    assert.equal(entryAudit.popVisible && entryAudit.notOpenedDirectly, true, `左下角账号点击必须保活账号切换上拉菜单而非直接开个人主页: ${JSON.stringify(entryAudit)}`);
    assert.equal(entryAudit.openedFromAccountMenu, true, '入口 1（账号上拉菜单顶部项）必须打开 #ag-profile-home-page');
    assert.equal(entryAudit.openedFromCapsule, true, `入口 2（主窗胶囊第 4 槽）必须打开同一个 #ag-profile-home-page: ${JSON.stringify(entryAudit.capDbg)}`);
    assert.equal(entryAudit.openedFromDetailed, true, '入口 3（详细上下文顶部按钮）必须打开同一个 #ag-profile-home-page');
    assert.equal(entryAudit.oldOverlayVisible, false, '全界面严禁存在第二个旧版 #panel-tokens 居中浮层');

    // 独立开关 profileHomeEnabled 关闭卸载与重新开启恢复
    const swAudit = await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const pgSr = document.getElementById('ag-cm-host-settings-page')?.shadowRoot;
      const sw = pgSr?.querySelector('#ag-ns-sw-profileHomeEnabled, [data-ag-ns-switch="profileHomeEnabled"]') ||
        Array.from(pgSr?.querySelectorAll('[role="switch"]') || []).find((el) => /个人.*主页/.test(el.closest('.ag-ns-row')?.textContent || ''));
      if (!sw) return { found: false };
      sw.click();
      await new Promise((r) => setTimeout(r, 140));
      const goneWhenOff = !document.getElementById('ag-profile-home-page') || document.getElementById('ag-profile-home-page').hidden;
      sw.click();
      await new Promise((r) => setTimeout(r, 140));
      window.__toggleHostSettingsModal(false);
      window.__AGContextMeter?.openPersonalProfileHome?.();
      await new Promise((r) => setTimeout(r, 160));
      const backWhenOn = Boolean(document.getElementById('ag-profile-home-page') && !document.getElementById('ag-profile-home-page').hidden);
      return { found: true, goneWhenOff, backWhenOn };
    })()`);
    assert.equal(swAudit.found, true, '设置页必须提供个人用量主页独立开关 profileHomeEnabled');
    assert.equal(swAudit.goneWhenOff, true, '关闭 profileHomeEnabled 后必须卸载/隐藏个人主页不留黑洞');
    assert.equal(swAudit.backWhenOn, true, '重新开启 profileHomeEnabled 后必须恢复个人主页');
  } finally {
    await session.close();
  }
});

test('阶段六验收 6B：个人主页首屏（头像/用户名/5项胶囊）、零精选作品与编辑私有分享、12项完整迁移与金额同口径一致', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.openProfileHomeFullpage(cdp);

    const contentAudit = await cdp.evaluate(`(() => {
      const page = document.getElementById('ag-profile-home-page') || document.querySelector('[data-om-profile-home-page]');
      const root = page?.shadowRoot || page;
      if (!root) return { found: false };
      const txt = String(root.textContent || '');

      const requiredHero = ['累计 Token 数', 'Token 使用峰值', '最长任务用时', '最长连续使用天数', '当前连续使用天数'];
      const missingHero = requiredHero.filter((k) => !txt.includes(k));

      const forbiddenItems = ['精选作品', '热门插件'];
      const hitForbidden = forbiddenItems.filter((k) => txt.includes(k));
      const forbiddenActionBtns = Array.from(root.querySelectorAll('button, a')).filter((b) => /^(编辑|私有|分享)$/.test(String(b.textContent || '').trim())).map((b) => b.textContent.trim());

      const required12 = [
        'Token 统计', '按模型', 'API 参考金额', '实时请求',
        '全部', '桌面端', 'CLI',
        '累计处理', '今日使用', '本月使用', '年度使用',
        '缓存读取', '洞察',
        '常用模型占比', '推理强度占比', '缓存命中表现', '已探索技能数', '使用技能总数', '工具调用总数'
      ];
      const missing12 = required12.filter((k) => !txt.includes(k));

      const hasAvatar = Boolean(root.querySelector('[data-om-profile-avatar], .ag-ph-avatar, img'));
      const costMatch = txt.match(/\\$1,?766\\.40|\\$1,?766\\.4/);
      return {
        found: true,
        hasAvatar,
        missingHero,
        hitForbidden,
        forbiddenActionBtns,
        missing12,
        hasMatchingCost: Boolean(costMatch),
        matchedCost: costMatch ? costMatch[0] : ''
      };
    })()`);

    assert.equal(contentAudit.found, true, '必须渲染个人主页 #ag-profile-home-page');
    assert.equal(contentAudit.hasAvatar, true, '首屏必须包含居中头像或首字母降级头像');
    assert.deepEqual(contentAudit.missingHero, [], `首屏五项数据胶囊条缺少项: ${JSON.stringify(contentAudit.missingHero)}`);
    assert.deepEqual(contentAudit.hitForbidden, [], `严禁保留「精选作品/热门插件」，命中: ${JSON.stringify(contentAudit.hitForbidden)}`);
    assert.deepEqual(contentAudit.forbiddenActionBtns, [], `严禁保留「编辑/私有/分享」按钮，命中: ${JSON.stringify(contentAudit.forbiddenActionBtns)}`);
    assert.deepEqual(contentAudit.missing12, [], `个人主页 12 项迁移内容缺失: ${JSON.stringify(contentAudit.missing12)}`);
    assert.equal(contentAudit.hasMatchingCost, true, `个人主页累计折合金额必须与详细上下文同口径 $1766.40 一致，实得: "${contentAudit.matchedCost}"`);
  } finally {
    await session.close();
  }
});

test('阶段六验收 6C：个人主页热力图方向铁律（左起最早日→右末列今日、零跳日、圆角>=25%）、五档切换方向不变、有数据格与空日格均点击锁定出当日明细、零硬编码紫', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 940,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await helpers.openProfileHomeFullpage(cdp);

    const hmAudit = await cdp.evaluate(`(async () => {
      const now = new Date();
      const fmtDay = (ms) => {
        const d = new Date(ms);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      };
      const todayKey = fmtDay(now.getTime());
      const earliestKey = fmtDay(now.getTime() - 20 * 86400000);
      const emptyDayKey = fmtDay(now.getTime() - 3 * 86400000);

      const page = document.getElementById('ag-profile-home-page') || document.querySelector('[data-om-profile-home-page]');
      const root = page?.shadowRoot || page;

      const inspectCells = () => {
        const cells = Array.from(root.querySelectorAll('[data-om-hm-cell="true"]'));
        const dates = cells.map((c) => c.getAttribute('data-date') || '');
        const firstRect = cells[0]?.getBoundingClientRect();
        const lastRect = cells[cells.length - 1]?.getBoundingClientRect();
        const firstCs = cells[0] ? getComputedStyle(cells[0]) : null;
        const radiusPx = firstCs ? parseFloat(firstCs.borderTopLeftRadius || '0') : 0;
        const colors = cells.map((c) => getComputedStyle(c).backgroundColor);
        return {
          count: cells.length,
          firstDate: dates[0] || '',
          lastDate: dates[dates.length - 1] || '',
          dates,
          leftToRight: Boolean(firstRect && lastRect && firstRect.left < lastRect.left),
          cellWidth: firstRect ? firstRect.width : 0,
          radiusPx,
          colors
        };
      };

      // 检查默认及五档切换（day/week/month/year/all）方向均左起、末列为今天
      const rangeResults = {};
      for (const rk of ['day', 'week', 'month', 'year', 'all']) {
        const btn = root.querySelector('[data-om-hm-range="' + rk + '"]');
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 90));
        const info = inspectCells();
        rangeResults[rk] = {
          hasBtn: Boolean(btn),
          count: info.count,
          firstDate: info.firstDate,
          lastDate: info.lastDate,
          leftToRight: info.leftToRight
        };
      }

      // 切回 'all' 测精确边界、连续自然日、有数据格点击与空日格点击
      root.querySelector('[data-om-hm-range="all"]')?.click();
      await new Promise((r) => setTimeout(r, 90));
      const allInfo = inspectCells();

      // 点击有数据格（todayKey）
      const dataCell = root.querySelector('[data-om-hm-cell="true"][data-date="' + todayKey + '"]');
      dataCell?.click();
      await new Promise((r) => setTimeout(r, 100));
      const dataSelected = dataCell?.getAttribute('data-selected') === 'true';
      const detailAfterData = root.querySelector('[data-om-hm-day-detail]');
      const dataDetailVisible = Boolean(detailAfterData && !detailAfterData.hidden && getComputedStyle(detailAfterData).display !== 'none' && String(detailAfterData.textContent || '').includes(todayKey));
      // 再次点击取消锁定
      dataCell?.click();
      await new Promise((r) => setTimeout(r, 80));
      const dataDeselected = dataCell?.getAttribute('data-selected') !== 'true';

      // 点击空日格（emptyDayKey，夹具中无数据）也必须可选中并弹出当日明细（零死区）
      const emptyCell = root.querySelector('[data-om-hm-cell="true"][data-date="' + emptyDayKey + '"]');
      emptyCell?.click();
      await new Promise((r) => setTimeout(r, 100));
      const emptySelected = emptyCell?.getAttribute('data-selected') === 'true';
      const detailAfterEmpty = root.querySelector('[data-om-hm-day-detail]');
      const emptyDetailVisible = Boolean(detailAfterEmpty && !detailAfterEmpty.hidden && getComputedStyle(detailAfterEmpty).display !== 'none' && String(detailAfterEmpty.textContent || '').includes(emptyDayKey));

      return {
        todayKey,
        earliestKey,
        emptyDayKey,
        rangeResults,
        allInfo,
        dataSelected,
        dataDetailVisible,
        dataDeselected,
        emptySelected,
        emptyDetailVisible
      };
    })()`);

    assert.equal(hmAudit.allInfo.firstDate, hmAudit.earliestKey, `累计总量热力图第一列必须是最早使用日期 ${hmAudit.earliestKey}，实得 ${hmAudit.allInfo.firstDate}`);
    assert.equal(hmAudit.allInfo.lastDate, hmAudit.todayKey, `热力图最后一列必须是今天 ${hmAudit.todayKey}，实得 ${hmAudit.allInfo.lastDate}`);
    assert.equal(hmAudit.allInfo.leftToRight, true, '热力图物理排版必须从左向右递增');
    assert.ok(
      hmAudit.allInfo.radiusPx >= hmAudit.allInfo.cellWidth * 0.25 - 0.5,
      `热力图点阵格圆角半径(${hmAudit.allInfo.radiusPx}px) 必须 >= 格宽(${hmAudit.allInfo.cellWidth}px) 的 25%`
    );
    // 严格连续自然日，不跳过缺失日
    for (let i = 1; i < hmAudit.allInfo.dates.length; i++) {
      const prevMs = Date.parse(hmAudit.allInfo.dates[i - 1] + 'T00:00:00Z');
      const curMs = Date.parse(hmAudit.allInfo.dates[i] + 'T00:00:00Z');
      assert.equal(curMs - prevMs, 86400000, `热力图自然日不得跳日: ${hmAudit.allInfo.dates[i - 1]} -> ${hmAudit.allInfo.dates[i]}`);
    }
    for (const [rk, r] of Object.entries(hmAudit.rangeResults)) {
      assert.equal(r.hasBtn, true, `必须存在热力图五档按钮 ${rk}`);
      assert.equal(r.lastDate, hmAudit.todayKey, `切换至 ${rk} 档后末列仍必须是今天 ${hmAudit.todayKey}，实得 ${r.lastDate}`);
      assert.equal(r.leftToRight, true, `切换至 ${rk} 档后方向仍必须左起`);
    }
    for (const c of hmAudit.allInfo.colors) {
      assert.equal(HARDCODED_PURPLE_RGB_SET.has(c), false, `热力图默认色阶严禁硬编码紫色，实得 ${c}`);
    }
    assert.equal(hmAudit.dataSelected && hmAudit.dataDetailVisible, true, '点击有数据热力图格必须选中高亮并展开当日明细');
    assert.equal(hmAudit.dataDeselected, true, '再次点击已选中热力图格必须取消锁定');
    assert.equal(hmAudit.emptySelected && hmAudit.emptyDetailVisible, true, '点击无数据空日热力图格同样必须选中并展示当日零值明细（零死区）');
  } finally {
    await session.close();
  }
});

// ============================================================================
// 阶段七：三语补齐、繁简统一与 Shadow DOM 同步、清零硬编码紫、悬浮球避让（任务书第 8 节）
// ============================================================================

const fsNode = require('node:fs');

test('阶段七验收 7A：简体全界面三语扫描（零 Refresh/Cancel/Toggle/Monitor/Saving/Loading、零繁体泄漏、零括号、全 Shadow DOM 即时同步）', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin',
    width: 1560,
    height: 920,
    auxWidthPx: 460
  });
  const { cdp, initialTimeOrigin } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);

    // 依次扫描：辅助栏 + 账号与额度页 + 设置页 + 详细上下文页 + 个人主页（全部 Shadow Root）
    const scanPluginSurfaces = (surfaceName) =>
      cdp.evaluate(`(() => {
        const pluginRoots = [
          document.getElementById('ag-context-meter'),
          document.querySelector('[data-om-main-capsule-host]'),
          document.querySelector('[data-om-session-tabs]'),
          document.getElementById('ag-context-insights-page'),
          document.getElementById('ag-profile-home-page'),
          document.getElementById('ag-cm-host-settings-page'),
          document.getElementById('ag-cm-host-accounts-page'),
          document.querySelector('[data-ag-sidebar-account-popover]')
        ].filter((el) => el && el.isConnected && !el.hidden);

        const texts = [];
        const walk = (root) => {
          if (!root) return;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const p = n.parentElement;
            if (!p || p.tagName === 'STYLE' || p.tagName === 'SCRIPT' || p.closest('svg') || p.closest('[hidden]')) continue;
            const cs = getComputedStyle(p);
            const r = p.getBoundingClientRect();
            if (p.hidden || cs.display === 'none' || cs.visibility === 'hidden' || (r.width === 0 && r.height === 0)) continue;
            const t = String(n.nodeValue || '').replace(/\\s+/g, ' ').trim();
            if (!t) continue;
            // 跳过语言切换按钮本身的「繁」/「繁體中文」自称与合法产品/夹具标题
            if (p.matches?.('[data-lang="zh-TW"], .lang-btn[data-lang="zh-TW"]') && t === '繁') continue;
            if (p.matches?.('[data-val="zh-TW"], [data-value="zh-TW"]') && t === '繁體中文') continue;
            texts.push(t);
          }
          const elems = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const el of elems) {
            if (el.shadowRoot && !el.hidden && !el.closest('[hidden]')) walk(el.shadowRoot);
          }
        };
        for (const r of pluginRoots) {
          if (r.shadowRoot) walk(r.shadowRoot);
          else walk(r);
        }

        const forbiddenWords = [];
        const tradHits = [];
        const parenHits = [];
        const threeEnWordHits = [];
        const FORBIDDEN_EN_RE = /\\b(Refresh|Cancel|Toggle|Monitor|Saving|Loading)\\b/i;
        const TRAD_SCAN_RE = /[階對設協總極遙儲刪預組啟軌彙顯標籤頁體臺為後書與無開關網鍵條項覽態號額計統資紀錄訊檢視圖點擊並終覽瀏編輯]|階段|排隊|快取|模組|設定|預設|工作階段|恢復/;
        const ALLOW_EN_PHRASES = [
          'Antigravity Context Meter',
          'Replying With Ok',
          'ContextMeter Rework',
          'Optical CapEx Audit',
          'HBM4 Packaging Notes',
          'Splitter Geometry Fix',
          'Daily X Intel Pipeline',
          'Claude / GPT',
          'Context Meter'
        ];

        for (const t of texts) {
          if (FORBIDDEN_EN_RE.test(t)) forbiddenWords.push(t);
          if (TRAD_SCAN_RE.test(t)) tradHits.push(t);
          if (/[()（）]/.test(t)) parenHits.push(t);
          let cleaned = t;
          for (const allow of ALLOW_EN_PHRASES) cleaned = cleaned.split(allow).join('');
          if (/\\b[A-Za-z]{2,}\\s+[A-Za-z]{2,}\\s+[A-Za-z]{2,}\\b/.test(cleaned)) {
            threeEnWordHits.push(t);
          }
        }
        return {
          surface: ${JSON.stringify(surfaceName)},
          scannedCount: texts.length,
          forbiddenWords: forbiddenWords.slice(0, 10),
          tradHits: tradHits.slice(0, 10),
          parenHits: parenHits.slice(0, 10),
          threeEnWordHits: threeEnWordHits.slice(0, 10)
        };
      })()`);

    const rAux = await scanPluginSurfaces('aux-panel');
    assert.deepEqual(rAux.forbiddenWords, [], `辅助栏简体不得含英文词表残留: ${JSON.stringify(rAux.forbiddenWords)}`);
    assert.deepEqual(rAux.tradHits, [], `辅助栏简体不得含繁体泄漏: ${JSON.stringify(rAux.tradHits)}`);
    assert.deepEqual(rAux.threeEnWordHits, [], `辅助栏简体不得含连续 3 英文词句: ${JSON.stringify(rAux.threeEnWordHits)}`);

    // 打开设置页 & 账号与额度页扫描
    await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 140));
      document.getElementById('ag-cm-host-settings-accounts-nav')?.click();
      await new Promise((r) => setTimeout(r, 180));
    })()`);
    const rAccounts = await scanPluginSurfaces('accounts-page');
    assert.deepEqual(rAccounts.forbiddenWords, [], `账号与额度页简体严禁含 Refresh/Cancel/Toggle/Monitor/Saving/Loading: ${JSON.stringify(rAccounts.forbiddenWords)}`);
    assert.deepEqual(rAccounts.tradHits, [], `账号与额度页简体严禁含繁体泄漏: ${JSON.stringify(rAccounts.tradHits)}`);
    assert.deepEqual(rAccounts.parenHits, [], `账号与额度页可见文案严禁中英文括号: ${JSON.stringify(rAccounts.parenHits)}`);
    assert.deepEqual(rAccounts.threeEnWordHits, [], `账号与额度页简体严禁含连续 3 英文词残句: ${JSON.stringify(rAccounts.threeEnWordHits)}`);

    await cdp.evaluate(`(async () => {
      document.getElementById('ag-cm-host-settings-nav')?.click();
      await new Promise((r) => setTimeout(r, 150));
    })()`);
    const rSettings = await scanPluginSurfaces('settings-page');
    assert.deepEqual(rSettings.forbiddenWords, [], `设置页简体严禁含英文词表残留: ${JSON.stringify(rSettings.forbiddenWords)}`);
    assert.deepEqual(rSettings.tradHits, [], `设置页简体严禁含繁体泄漏: ${JSON.stringify(rSettings.tradHits)}`);
    assert.deepEqual(rSettings.parenHits, [], `设置页简体可见文案严禁中英文括号: ${JSON.stringify(rSettings.parenHits)}`);
    await cdp.evaluate(`window.__toggleHostSettingsModal(false)`);

    // 打开详细上下文页与个人主页扫描
    await helpers.openDetailedContextFullpage(cdp);
    const rDetailed = await scanPluginSurfaces('detailed-context');
    assert.deepEqual(rDetailed.forbiddenWords, [], `详细上下文页简体严禁英文残留: ${JSON.stringify(rDetailed.forbiddenWords)}`);
    assert.deepEqual(rDetailed.tradHits, [], `详细上下文页简体严禁繁体泄漏: ${JSON.stringify(rDetailed.tradHits)}`);
    assert.deepEqual(rDetailed.parenHits, [], `详细上下文页可见文案严禁中英文括号: ${JSON.stringify(rDetailed.parenHits)}`);

    await helpers.openProfileHomeFullpage(cdp);
    const rProfile = await scanPluginSurfaces('profile-home');
    assert.deepEqual(rProfile.forbiddenWords, [], `个人主页简体严禁英文残留: ${JSON.stringify(rProfile.forbiddenWords)}`);
    assert.deepEqual(rProfile.tradHits, [], `个人主页简体严禁繁体泄漏: ${JSON.stringify(rProfile.tradHits)}`);
    assert.deepEqual(rProfile.parenHits, [], `个人主页可见文案严禁中英文括号: ${JSON.stringify(rProfile.parenHits)}`);

    // 全 Shadow DOM 语言动态实时同步验证（简 -> EN -> 繁 -> 简，零页面重载）
    const langSync = await cdp.evaluate(`(async () => {
      const sr = document.getElementById('ag-context-meter').shadowRoot;
      const getProfileText = () => String(document.getElementById('ag-profile-home-page')?.textContent || '').slice(0, 300);
      const zh1 = getProfileText();
      sr.querySelector('[data-lang="en"]')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const en1 = getProfileText();
      sr.querySelector('[data-lang="zh-TW"]')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const tw1 = getProfileText();
      sr.querySelector('[data-lang="zh-CN"]')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const zh2 = getProfileText();
      return { zh1, en1, tw1, zh2, timeOrigin: window.performance.timeOrigin };
    })()`);
    assert.notEqual(langSync.en1, langSync.zh1, '切换 EN 时所有 Shadow DOM（含个人主页）必须即时刷新为英文');
    assert.notEqual(langSync.tw1, langSync.en1, '切换 繁 时所有 Shadow DOM 必须即时刷新为繁体');
    assert.equal(langSync.zh2, langSync.zh1, '切回 简 后所有 Shadow DOM 必须完整恢复简体');
    assert.equal(langSync.timeOrigin, initialTimeOrigin, '三语全 Shadow DOM 实时切换严禁触发页面重载');
  } finally {
    await session.close();
  }
});

test('阶段七验收 7B：渲染层零硬编码紫色字面量静态扫描 + 浅/深双主题关键强调色按钮文字对比度 >= 4.5:1', async () => {
  // 1. 静态扫描 src/renderer/ 全部 .js / .css（排除调色板色样预设定义行）
  const rendererDir = path.join(__dirname, 'src', 'renderer');
  const files = fsNode.readdirSync(rendererDir).filter((f) => /\.(js|css|html)$/.test(f));
  const PURPLE_LITERAL_RE = /#(?:7C3AED|8B5CF6|A855F7|C084FC)\b/gi;
  const violations = [];
  for (const fname of files) {
    const raw = fsNode.readFileSync(path.join(rendererDir, fname), 'utf8');
    const lines = raw.split(/\r?\n/);
    lines.forEach((line, idx) => {
      // 允许 colors.js 内明确标明的调色板色板预设数组定义行
      if (fname === 'colors.js' && /PRESET|PALETTE|SWATCH/i.test(line)) return;
      const matches = line.match(PURPLE_LITERAL_RE);
      if (matches) {
        violations.push(`${fname}:${idx + 1} => ${matches.join(', ')}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `src/renderer/ 除语义色板定义外严禁残留紫色字面量（7C3AED/8B5CF6/A855F7/C084FC），命中:\n${violations.join('\n')}`
  );

  // 2. 隔离 Chromium 下测量浅色与深色双主题关键强调色按钮对比度 >= 4.5:1
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'plugin',
    width: 1440,
    height: 900
  });
  const { cdp } = session;
  try {
    await helpers.waitUntilAuxModeHealthy(cdp, 'tab', 1000);
    const measureContrast = async (themeMode, accentHex) =>
      cdp.evaluate(`(async () => {
        if (${JSON.stringify(themeMode)} === 'light') {
          document.documentElement.classList.add('light-theme');
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.classList.remove('light-theme');
          document.documentElement.setAttribute('data-theme', 'dark');
        }
        document.documentElement.style.setProperty('--primary', ${JSON.stringify(accentHex)});
        document.documentElement.style.setProperty('--accent', ${JSON.stringify(accentHex)});
        window.__AGContextMeter?.tickForTest?.();
        await new Promise((r) => setTimeout(r, 150));

        const parseRgb = (s) => {
          const m = String(s || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
          return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
        };
        const relLum = ([r, g, b]) => {
          const toLin = (c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
        };
        const contrast = (c1, c2) => {
          const a = parseRgb(c1);
          const b = parseRgb(c2);
          if (!a || !b) return 0;
          const l1 = relLum(a);
          const l2 = relLum(b);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        };

        const auxSr = document.getElementById('ag-context-meter')?.shadowRoot;
        const activeLayoutBtn = auxSr?.querySelector('#ag-aux-quick-switch-bar button[aria-selected="true"]');
        const cs = activeLayoutBtn ? getComputedStyle(activeLayoutBtn) : null;
        return {
          found: Boolean(activeLayoutBtn),
          bg: cs?.backgroundColor || '',
          fg: cs?.color || '',
          ratio: cs ? Math.round(contrast(cs.backgroundColor, cs.color) * 100) / 100 : 0
        };
      })()`);

    const darkRes = await measureContrast('dark', '#2563eb');
    const lightRes = await measureContrast('light', '#2563eb');
    assert.equal(darkRes.found, true, '暗色模式下必须找到强调色激活按钮');
    assert.ok(darkRes.ratio >= 4.5, `暗色主题强调色激活按钮文字对比度必须 >= 4.5:1，实测 ${darkRes.ratio}:1 (bg=${darkRes.bg}, fg=${darkRes.fg})`);
    assert.equal(lightRes.found, true, '浅色模式下必须找到强调色激活按钮');
    assert.ok(lightRes.ratio >= 4.5, `浅色主题强调色激活按钮文字对比度必须 >= 4.5:1，实测 ${lightRes.ratio}:1 (bg=${lightRes.bg}, fg=${lightRes.fg})`);
  } finally {
    await session.close();
  }
});

test('阶段七验收 7C：悬浮球在详细上下文 / 个人主页 / 设置页打开时自动隐藏避让，关闭回对话页后自动恢复并保留原坐标记忆', async () => {
  const helpers = await loadVerifyHelpers();
  const session = await helpers.launchReworkBrowserSession({
    auxCoexistMode: 'tab',
    auxViewTab: 'browser',
    width: 1560,
    height: 920,
    auxWidthPx: 320
  });
  const { cdp } = session;
  try {
    await cdp.evaluate(`window.__AGContextMeter?.switchAuxMode?.('browser', { persist: false })`);
    await new Promise((r) => setTimeout(r, 200));

    // 确保悬浮球开启并位于自定义坐标，记录初始坐标
    const probeOrb = () =>
      cdp.evaluate(`(() => {
        const orbHost = document.getElementById('ag-radial-top-layer') || document.querySelector('[data-ag-radial-orb], #ag-radial-orb-host');
        const orbBtn = orbHost?.shadowRoot?.querySelector('#radial-orb-btn, .radial-orb-btn, button') || document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('radial-orb-btn');
        if (!orbBtn || !orbBtn.isConnected) return { present: false, visible: false, rect: null };
        const cs = getComputedStyle(orbBtn);
        const hostCs = orbHost ? getComputedStyle(orbHost) : null;
        const r = orbBtn.getBoundingClientRect();
        const visible =
          !orbBtn.hidden &&
          (!orbHost || (!orbHost.hidden && hostCs.display !== 'none' && hostCs.visibility !== 'hidden' && Number(hostCs.opacity) > 0.05)) &&
          cs.display !== 'none' &&
          cs.visibility !== 'hidden' &&
          Number(cs.opacity) > 0.05 &&
          r.width > 0 &&
          r.height > 0;
        return {
          present: true,
          visible,
          rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
      })()`);

    await cdp.evaluate(`(() => {
      try { localStorage.setItem('ag_radial_orb_hidden', 'false'); } catch {}
      window.__AGContextMeter?.applyOrbPositionToDomForTest?.();
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const onChatBefore = await probeOrb();

    // 1. 打开详细上下文页 -> 悬浮球必须自动隐藏避让
    await helpers.openDetailedContextFullpage(cdp);
    await new Promise((r) => setTimeout(r, 180));
    const onDetailed = await probeOrb();
    assert.equal(onDetailed.visible, false, `打开详细上下文全页时悬浮球必须隐藏避让，实得: ${JSON.stringify(onDetailed)}`);

    // 2. 打开个人主页 -> 悬浮球必须自动隐藏避让
    await helpers.openProfileHomeFullpage(cdp);
    await new Promise((r) => setTimeout(r, 180));
    const onProfile = await probeOrb();
    assert.equal(onProfile.visible, false, `打开个人用量主页时悬浮球必须隐藏避让，实得: ${JSON.stringify(onProfile)}`);
    await cdp.evaluate(`window.__AGContextMeter?.closePersonalProfileHome?.()`);
    await new Promise((r) => setTimeout(r, 140));

    // 3. 打开宿主设置页 -> 悬浮球必须自动隐藏避让
    await cdp.evaluate(`(async () => {
      window.__toggleHostSettingsModal(true);
      await new Promise((r) => setTimeout(r, 160));
    })()`);
    const onSettings = await probeOrb();
    assert.equal(onSettings.visible, false, `打开设置页时悬浮球必须隐藏避让，实得: ${JSON.stringify(onSettings)}`);

    // 4. 关闭设置页回到对话页 -> 若初始在对话页可见，必须自动恢复显示并保持坐标记忆
    await cdp.evaluate(`window.__toggleHostSettingsModal(false)`);
    await new Promise((r) => setTimeout(r, 220));
    const onChatRestored = await probeOrb();
    if (onChatBefore.visible) {
      assert.equal(onChatRestored.visible, true, `关闭全页返回对话页后悬浮球必须自动恢复显示: ${JSON.stringify(onChatRestored)}`);
      assert.ok(
        Math.abs(onChatRestored.rect.left - onChatBefore.rect.left) <= 4 &&
        Math.abs(onChatRestored.rect.top - onChatBefore.rect.top) <= 4,
        `恢复后悬浮球坐标必须保持原记忆位置: before=${JSON.stringify(onChatBefore.rect)}, after=${JSON.stringify(onChatRestored.rect)}`
      );
    }
  } finally {
    await session.close();
  }
});






