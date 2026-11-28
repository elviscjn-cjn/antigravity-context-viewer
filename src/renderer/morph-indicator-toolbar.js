'use strict';
/**
 * 右上角 5 槽位原位折叠指标工具栏 + 输入框底栏五项常驻规范化 + 第二层单任务额度尾标格式化模块
 *
 * 直接复用 工具栏原型 中的视觉结构、SVG 图形、
 * CSS 变形编排与 initMorphToolbarUI / renderMorphToolbarUI 交互，并适配经典 renderer 构建、
 * Shadow DOM 与真实生产数据契约：
 * 1. 默认 5 槽位原位折叠（layoutMode: 'submenu'，正式替代旧固定 'flat' 平铺）：
 *    - 左→右：槽位 1 额度圆环、槽位 2 上下文圆环、槽位 3 状态工具组、槽位 4 统计工具组、槽位 5 CLI。
 *    - 两个工具组折叠态仅露出当前激活代表项与右下角展开角标，点击代表项在原位横向展开并带滑动蓝底高亮胶囊；
 *      状态组展开「首字沙漏、生成速度、账号入口」，统计组展开「用量、趋势、构成图入口」。
 *    - 选中子项触发真实回调后自动收回并保持该图标/读数；同一时刻最多展开一组，快速切换另一组时立即清除旧收起定时器防抖动吞点击；
 *      组内关闭按钮、Esc、点击外部（Shadow DOM composedPath 安全）均收起；左侧两环与右侧 CLI 始终可点。
 *    - 额度圆环对齐 Issue #107：左键轮切 5H/7D、Alt+左键与右键直达额度大面板并抑制宿主复制菜单；其余图标右键绝不误切主题。
 *    - 全量接真实生产数据，零演示随机数与假自增；严格按 scopeKey 隔离，拒绝快切迟到回包覆写；
 *      仅在 ContextMeter 可见时显示，切单 Browser/Swarm 时退场并收起所有展开组。
 * 2. 完整保留底栏五项常驻（buildComposerPermanentFiveMetrics / stripComposerQuotaMoreBadge）
 *    与第二层单任务额度尾标（formatTaskQuotaWindowCompact / formatTurnFooterCompactLine）。
 * 3. 三语可见文案严格零中英文括号；无顶层 ESM export/import；零动态 innerHTML。
 */
(function (rootScope) {
  const RING_CIRCUMFERENCE = 53.4071; // 2 * Math.PI * 8.5
  const NEEDLE_MIN_DEG = -58;
  const NEEDLE_IDLE_DEG = 46;
  const NEEDLE_MAX_DEG = 64;
  const MTB_STYLE_ID = 'ag-v2-mtb-prod-style';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const QUOTA_REFRESH_THROTTLE_MS = 1500;
  const STATUS_PIN_STORAGE_KEY = 'ag_mtb_status_pin_mode';
  const VALID_STATUS_PIN_MODES = ['auto', 'ttft', 'tok-speed'];
  const VALID_CLI_COLOR_MODES = ['accent', 'mono', 'custom'];

  const INSTANCE_MAP = new WeakMap();

  const MTB_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      toolbarAria: '当前会话指标工具栏',
      quotaRingAria: '当前账号模型池额度',
      quotaRingHint: '左键切换 5H 与 7D · 右键或 Alt 左键打开额度面板',
      contextRingAria: '当前会话上下文占用',
      cacheAria: '缓存命中率',
      ttftAria: '首字等待耗时',
      speedAria: '实时生成速度',
      accountAria: '账号切换与管理',
      closeSubmenuAria: '收起工具组',
      closeStatsSubmenuAria: '收起统计工具组',
      statsAria: '用量统计入口',
      statsBarsAria: '个人 Token 用量主页',
      statsTrendAria: '速度对比与趋势',
      statsDonutAria: '详细上下文',
      mergedToolsAria: '状态与统计工具',
      retractHandleExpandAria: '展开指标胶囊',
      retractHandleCollapseAria: '收起指标胶囊',
      cliAria: '启动终端 CLI',
      sessionBtnAria: '会话绑定与锁定',
      sessionLocked: '已锁定',
      sessionFollow: '跟随',
      queuedShort: '排队',
      unknownShort: '未知',
      staleShort: '待刷新',
      noPermShort: '无权限',
      remoteShort: '远程',
      observedTag: '观测',
      pendingSyncTag: '待同步',
      concurrentTag: '并发',
      resetTag: '已重置',
      unavailableTag: '不可用',
      cacheLabel: '缓存'
    }),
    'zh-TW': Object.freeze({
      toolbarAria: '目前工作階段指標工具列',
      quotaRingAria: '目前帳號模型池額度',
      quotaRingHint: '左鍵切換 5H 與 7D · 右鍵或 Alt 左鍵開啟額度面板',
      contextRingAria: '目前工作階段上下文佔用',
      cacheAria: '快取命中率',
      ttftAria: '首字等待耗時',
      speedAria: '即時生成速度',
      accountAria: '帳號切換與管理',
      closeSubmenuAria: '收合工具組',
      closeStatsSubmenuAria: '收合統計工具組',
      statsAria: '用量統計入口',
      statsBarsAria: '個人 Token 用量主頁',
      statsTrendAria: '速度對比與趨勢',
      statsDonutAria: '詳細上下文',
      mergedToolsAria: '狀態與統計工具',
      retractHandleExpandAria: '展開指標膠囊',
      retractHandleCollapseAria: '收合指標膠囊',
      cliAria: '啟動終端 CLI',
      sessionBtnAria: '工作階段綁定與鎖定',
      sessionLocked: '已鎖定',
      sessionFollow: '跟隨',
      queuedShort: '排隊',
      unknownShort: '未知',
      staleShort: '待重新整理',
      noPermShort: '無權限',
      remoteShort: '遠端',
      observedTag: '觀測',
      pendingSyncTag: '待同步',
      concurrentTag: '併發',
      resetTag: '已重設',
      unavailableTag: '不可用',
      cacheLabel: '快取'
    }),
    en: Object.freeze({
      toolbarAria: 'Active session metrics toolbar',
      quotaRingAria: 'Account pool quota',
      quotaRingHint: 'Left click switches 5H and 7D · Right click or Alt left click opens quota panel',
      contextRingAria: 'Session context usage',
      cacheAria: 'Cache hit rate',
      ttftAria: 'Time to first token',
      speedAria: 'Generation speed',
      accountAria: 'Switch account',
      closeSubmenuAria: 'Close tool group',
      closeStatsSubmenuAria: 'Close statistics group',
      statsAria: 'Usage statistics',
      statsBarsAria: 'Personal Token Usage Home',
      statsTrendAria: 'Speed comparison',
      statsDonutAria: 'Detailed Context',
      mergedToolsAria: 'Status and statistics',
      retractHandleExpandAria: 'Expand metrics capsule',
      retractHandleCollapseAria: 'Retract metrics capsule',
      cliAria: 'Launch CLI',
      sessionBtnAria: 'Session binding and lock',
      sessionLocked: 'Locked',
      sessionFollow: 'Follow',
      queuedShort: 'Queue',
      unknownShort: 'Unknown',
      staleShort: 'Stale',
      noPermShort: 'No access',
      remoteShort: 'Remote',
      observedTag: 'Obs',
      pendingSyncTag: 'Syncing',
      concurrentTag: 'Shared',
      resetTag: 'Reset',
      unavailableTag: 'N/A',
      cacheLabel: 'Cache'
    })
  });

  function resolveLang(lang) {
    const raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return 'zh-TW';
    if (/^en/i.test(raw)) return 'en';
    return 'zh-CN';
  }

  function getMtbCopy(lang) {
    return MTB_I18N[resolveLang(lang)] || MTB_I18N['zh-CN'];
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function resolveCapsuleWidthTier(mainSessionWidthPx) {
    const w = Number(mainSessionWidthPx);
    if (!Number.isFinite(w) || w <= 0 || w >= 1100) return 'full';
    if (w >= 900) return 'compact-labels';
    if (w >= 760) return 'merged';
    return 'minimal';
  }

  function byId(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    if (typeof root.getElementById === 'function') {
      const hit = root.getElementById(id);
      if (hit) return hit;
    }
    return typeof root.querySelector === 'function' ? root.querySelector('#' + id) : null;
  }

  /**
   * 规范化周期缩写为全插件统一大写 5H / 7D（不动内部 windowKey）
   */
  function formatQuotaWindowBadge(windowKeyOrShort) {
    const raw = String(windowKeyOrShort || '').trim().toLowerCase();
    if (raw === '5h' || raw === 'five_hour' || raw === '5hour') return '5H';
    if (raw === '7d' || raw === 'weekly' || raw === 'week' || raw === '7day') return '7D';
    return String(windowKeyOrShort || '').trim().toUpperCase();
  }

  /**
   * 沙漏正计时格式化：
   * 0..59 -> "0", "1", ..., "59"（纯整数无 s 后缀）
   * >= 60 -> "01:00", "01:05", "02:10"（MM:SS）
   */
  function formatTtftElapsedSeconds(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(Number(totalSeconds)) || Number(totalSeconds) < 0) {
      return '--';
    }
    const sec = Math.max(0, Math.floor(Number(totalSeconds)));
    if (sec < 60) return String(sec);
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function tokRateToNeedleAngle(tokPerSec, maxTokPerSec = 145) {
    if (tokPerSec == null || !Number.isFinite(Number(tokPerSec)) || Number(tokPerSec) < 0) {
      return NEEDLE_MIN_DEG;
    }
    const cap = Math.max(20, Number(maxTokPerSec) || 145);
    const rate = clamp(Number(tokPerSec), 0, cap);
    if (rate <= 100 && cap >= 100) {
      return Number((NEEDLE_MIN_DEG + (rate / 100) * (NEEDLE_IDLE_DEG - NEEDLE_MIN_DEG)).toFixed(2));
    }
    return Number((NEEDLE_IDLE_DEG + ((rate - 100) / Math.max(1, cap - 100)) * (NEEDLE_MAX_DEG - NEEDLE_IDLE_DEG)).toFixed(2));
  }

  function formatCompactTok(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return '--';
    if (num >= 1e9) return `${(num / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(num >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(Math.round(num));
  }

  function formatQuotaPct(frac) {
    if (frac == null || !Number.isFinite(Number(frac))) return '--';
    const pct = clamp(Number(frac) * 100, 0, 100);
    if (pct === 0) return '0%';
    if (pct === 100) return '100%';
    // 保护 10.1% 与 10% 边界精度，不错误截断到 10%
    if (pct > 10 && pct < 10.5) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
  }

  /**
   * 第一层：辅助面板关闭时，生成输入框底栏五项常驻核心读数
   * 固定 5 项：速度或等待首字、上下文已用/上限、缓存命中率、5H、7D；零 +N、零第二行
   */
  function buildComposerPermanentFiveMetrics(snapshot = {}, lang = 'zh-CN') {
    const copy = getMtbCopy(lang);
    const phase = String(snapshot.phase || 'idle');
    let speedText = '--';
    let speedKind = 'idle';
    if (phase === 'queued') {
      speedText = copy.queuedShort;
      speedKind = 'queued';
    } else if (phase === 'waiting') {
      const waitSec = snapshot.waitElapsedSec;
      speedText = waitSec != null && Number.isFinite(Number(waitSec))
        ? `${Number(waitSec) < 60 ? `${Math.floor(Number(waitSec))}s` : formatTtftElapsedSeconds(waitSec)}`
        : '--';
      speedKind = 'waiting';
    } else if (snapshot.speedUnavailableReason === 'remote') {
      speedText = copy.remoteShort;
      speedKind = 'remote';
    } else if (snapshot.tps != null && Number.isFinite(Number(snapshot.tps)) && Number(snapshot.tps) >= 0) {
      const n = Number(snapshot.tps);
      speedText = `${n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '')} tok/s`;
      speedKind = phase === 'streaming' ? 'streaming' : 'settled';
    }

    const used = snapshot.contextUsed;
    const budget = snapshot.contextBudget;
    const hasCtx = used != null && Number.isFinite(Number(used)) && Number(used) >= 0
      && budget != null && Number.isFinite(Number(budget)) && Number(budget) > 0;
    const contextPct = hasCtx ? clamp((Number(used) / Number(budget)) * 100, 0, 100) : null;
    const contextText = hasCtx
      ? `${formatCompactTok(used)} / ${formatCompactTok(budget)}`
      : '-- / --';

    const hasCache = snapshot.cacheHitPct != null && Number.isFinite(Number(snapshot.cacheHitPct)) && Number(snapshot.cacheHitPct) >= 0;
    const cacheText = hasCache
      ? `${copy.cacheLabel} ${Number(snapshot.cacheHitPct) === 0 ? '0%' : `${Number(snapshot.cacheHitPct).toFixed(1).replace(/\.0$/, '')}%`}`
      : `${copy.cacheLabel} --`;

    const fmtBucket = (label, b) => {
      if (!b || b.status === 'no_permission') return `${label} ${copy.noPermShort}`;
      if (b.status === 'stale') return `${label} ${copy.staleShort}`;
      if (b.remainingFraction != null && Number.isFinite(Number(b.remainingFraction))) {
        return `${label} ${formatQuotaPct(b.remainingFraction)}`;
      }
      if (b.remainingPct != null && Number.isFinite(Number(b.remainingPct))) {
        return `${label} ${formatQuotaPct(Number(b.remainingPct) / 100)}`;
      }
      return `${label} ${copy.unknownShort}`;
    };

    const quota5hText = fmtBucket('5H', snapshot.quota5h);
    const quota7dText = fmtBucket('7D', snapshot.quota7d);

    return {
      items: [
        { key: 'speed', kind: speedKind, text: speedText },
        { key: 'context', pct: contextPct, text: contextText },
        { key: 'cache', pct: hasCache ? Number(snapshot.cacheHitPct) : null, text: cacheText },
        { key: 'quota5h', label: '5H', text: quota5hText },
        { key: 'quota7d', label: '7D', text: quota7dText }
      ],
      hasQuotaMoreBadge: false,
      hasSecondStatusLine: false
    };
  }

  /**
   * 清理底栏中遗留的 +N 其他额度池徽标（csb-quota-more）并统一 5H/7D 大写
   */
  function stripComposerQuotaMoreBadge(root) {
    if (!root) return { removedCount: 0, uppercasedCount: 0 };
    let removedCount = 0;
    let uppercasedCount = 0;
    const moreNodes = [];
    if (typeof root.getElementById === 'function') {
      const byIdNode = root.getElementById('csb-quota-more');
      if (byIdNode) moreNodes.push(byIdNode);
    }
    if (typeof root.querySelectorAll === 'function') {
      for (const n of Array.from(root.querySelectorAll('#csb-quota-more, .csb-quota-more') || [])) {
        if (!moreNodes.includes(n)) moreNodes.push(n);
      }
    }
    for (const node of moreNodes) {
      node.hidden = true;
      node.textContent = '';
      if (node.style) node.style.display = 'none';
      removedCount += 1;
    }
    if (typeof root.querySelectorAll === 'function') {
      const qTexts = Array.from(root.querySelectorAll('#csb-quota-text-5h, #csb-quota-text-7d, .csb-quota-text') || []);
      for (const el of qTexts) {
        const cur = String(el.textContent || '');
        const next = cur.replace(/\b5h\b/g, '5H').replace(/\b7d\b/g, '7D');
        if (next !== cur) {
          el.textContent = next;
          uppercasedCount += 1;
        }
      }
    }
    return { removedCount, uppercasedCount };
  }

  /**
   * 第二层：格式化单任务 5H/7D 额度观测紧凑尾标（对接 TaskQuotaObservation 契约）
   * 严格零括号，区分 observed / observed_zero / pending_sync / concurrent_ambiguous / reset_crossed / unavailable
   */
  function formatTaskQuotaWindowCompact(windowKey, winObs, lang = 'zh-CN') {
    const copy = getMtbCopy(lang);
    const tag = formatQuotaWindowBadge(windowKey);
    if (!winObs || typeof winObs !== 'object') return `${tag} ${copy.unavailableTag}`;
    const status = String(winObs.status || 'unavailable');
    if (status === 'observed' && winObs.deltaPp != null && Number.isFinite(Number(winObs.deltaPp))) {
      const val = Number(winObs.deltaPp);
      const formatted = val >= 10 ? val.toFixed(0) : val.toFixed(1).replace(/\.0$/, '');
      return `${tag} −${formatted}% ${copy.observedTag}`;
    }
    if (status === 'observed_zero') {
      return `${tag} 0% ${copy.observedTag}`;
    }
    if (status === 'pending_sync') return `${tag} ${copy.pendingSyncTag}`;
    if (status === 'concurrent_ambiguous') return `${tag} ${copy.concurrentTag}`;
    if (status === 'reset_crossed' || status === 'rebounded') return `${tag} ${copy.resetTag}`;
    return `${tag} ${copy.unavailableTag}`;
  }

  function formatTurnFooterCompactLine(turnData = {}, lang = 'zh-CN') {
    const copy = getMtbCopy(lang);
    const parts = [];
    if (turnData.inputTokens != null && Number.isFinite(Number(turnData.inputTokens))) {
      parts.push(`↑ ${formatCompactTok(turnData.inputTokens)}`);
    }
    if (turnData.outputTokens != null && Number.isFinite(Number(turnData.outputTokens))) {
      parts.push(`↓ ${formatCompactTok(turnData.outputTokens)}`);
    }
    if (turnData.cacheHitPct != null && Number.isFinite(Number(turnData.cacheHitPct))) {
      const c = Number(turnData.cacheHitPct);
      parts.push(`${copy.cacheLabel} ${c === 0 ? '0%' : `${c.toFixed(1).replace(/\.0$/, '')}%`}`);
    }
    const obs = turnData.taskQuotaObservation;
    if (obs && obs.isTaskTerminalReply !== false && obs.windows) {
      if (obs.windows['5h']) parts.push(formatTaskQuotaWindowCompact('5h', obs.windows['5h'], lang));
      if (obs.windows.weekly) parts.push(formatTaskQuotaWindowCompact('weekly', obs.windows.weekly, lang));
    }
    return parts.join(' · ');
  }

  /**
   * 复用自 工具栏原型的 styles.css，
   * 适配 Shadow DOM、浅色/深色主题、宿主 Accent、窄栏自适应与 reduced-motion。
   */
  const MTB_PROD_CSS = `
    .ag-v2-mtb-root {
      --ag-mtb-height: 40px;
      --ag-mtb-pad-x: 5px;
      --ag-mtb-slot: 38px;
      --ag-mtb-gap: 3px;
      --ag-mtb-sub-gap: 3px;
      --ag-mtb-step: calc(var(--ag-mtb-slot) + var(--ag-mtb-sub-gap));
      --ag-mtb-close-w: 28px;
      --ag-mtb-close-offset: calc(var(--ag-mtb-close-w) + var(--ag-mtb-sub-gap));
      --ag-mtb-radius: 13px;

      --ag-mtb-speed-mult: 1;
      --ag-mtb-ease-morph: cubic-bezier(0.2, 0.8, 0.2, 1);
      --ag-mtb-ease-flip: cubic-bezier(0.2, 0.8, 0.2, 1);
      --ag-mtb-dur-open: calc(200ms * var(--ag-mtb-speed-mult));
      --ag-mtb-dur-close: calc(200ms * var(--ag-mtb-speed-mult));
      --ag-mtb-dur-pill: calc(190ms * var(--ag-mtb-speed-mult));
      --ag-mtb-dur-flip: calc(220ms * var(--ag-mtb-speed-mult));

      --ag-mtb-micro-scale: 0.727;

      --ag-mtb-surface: var(--ag-unified-bg, var(--ag-bg-card, #181818));
      --ag-mtb-border: var(--ag-border-card, rgba(255, 255, 255, 0.09));
      --ag-mtb-border-subtle: var(--ag-border-subtle, rgba(255, 255, 255, 0.08));
      --ag-mtb-text-primary: var(--ag-text-primary, #ececef);
      --ag-mtb-text-secondary: var(--ag-text-secondary, #c8c8d0);
      --ag-mtb-text-muted: var(--ag-text-muted, #8a8a94);
      --ag-mtb-btn-bg: var(--ag-btn-bg, transparent);
      --ag-mtb-btn-hover: var(--ag-btn-hover, rgba(255, 255, 255, 0.08));
      --ag-mtb-btn-active: var(--ag-btn-active, rgba(255, 255, 255, 0.14));
      --ag-mtb-tray-bg: rgba(255, 255, 255, 0.05);
      --ag-mtb-tray-border: rgba(255, 255, 255, 0.07);
      --ag-mtb-accent: var(--ag-host-accent, var(--primary, #3274f6));
      --ag-mtb-warn: var(--ag-ring-warn, #f59e0b);
      --ag-mtb-danger: var(--ag-ring-danger, #ef4444);
      --ag-mtb-ring-track: var(--ag-border-subtle, rgba(255, 255, 255, 0.16));
      --ag-mtb-pill-blue: var(--ag-host-accent, var(--primary, #3274f6));
      --ag-mtb-pill-shadow: 0 3px 12px color-mix(in srgb, var(--ag-mtb-pill-blue) 38%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.22);
      --ag-mtb-cli-mono: #ffffff;
      --ag-mtb-cli-custom-color: var(--ag-custom-cli-icon, var(--ag-mtb-accent));

      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    .ag-v2-mtb-root[hidden] {
      display: none !important;
    }
    .ag-v2-mtb-root *,
    .ag-v2-mtb-root *::before,
    .ag-v2-mtb-root *::after {
      box-sizing: border-box;
    }
    .ag-v2-mtb-root[data-label-size="xs"] {
      --ag-mtb-micro-scale: 0.636;
    }
    .ag-v2-mtb-root[data-label-size="sm"] {
      --ag-mtb-micro-scale: 0.727;
    }
    .ag-v2-mtb-root[data-label-size="md"] {
      --ag-mtb-micro-scale: 0.818;
    }
    .ag-v2-mtb-root[data-compact="true"] {
      --ag-mtb-height: 36px;
      --ag-mtb-pad-x: 4px;
      --ag-mtb-slot: 34px;
      --ag-mtb-gap: 2px;
      --ag-mtb-sub-gap: 2px;
      --ag-mtb-close-w: 24px;
      --ag-mtb-radius: 11px;
    }

    .ag-v2-mtb-root { gap: 4px; }
    .ag-v2-mtb-root[data-width-tier="full"] {
      --ag-mtb-height: 36px; --ag-mtb-pad-x: 5px; --ag-mtb-slot: 42px;
      --ag-mtb-gap: 4px; --ag-mtb-sub-gap: 3px; --ag-mtb-close-w: 26px; --ag-mtb-radius: 12px;
    }
    .ag-v2-mtb-root[data-width-tier="compact-labels"],
    .ag-v2-mtb-root[data-width-tier="merged"],
    .ag-v2-mtb-root[data-width-tier="minimal"] {
      --ag-mtb-height: 34px; --ag-mtb-pad-x: 4px; --ag-mtb-slot: 34px;
      --ag-mtb-gap: 2px; --ag-mtb-sub-gap: 2px; --ag-mtb-close-w: 24px; --ag-mtb-radius: 11px;
    }
    .ag-v2-mtb-root[data-width-tier="compact-labels"] .ag-v2-mtb-unit-label { display: none !important; }
    .ag-v2-mtb-root[data-width-tier="merged"]:not([data-merged-expanded="true"]) #ag-v2-mtb-group-ttft,
    .ag-v2-mtb-root[data-width-tier="merged"]:not([data-merged-expanded="true"]) #ag-v2-mtb-group-stats { display: none !important; }
    .ag-v2-mtb-root:not([data-width-tier="merged"]) #ag-v2-mtb-slot-merged { display: none !important; }
    .ag-v2-mtb-root[data-width-tier="minimal"] #ag-v2-mtb-slot-ring-secondary,
    .ag-v2-mtb-root[data-width-tier="minimal"] #ag-v2-mtb-group-ttft,
    .ag-v2-mtb-root[data-width-tier="minimal"] #ag-v2-mtb-group-stats,
    .ag-v2-mtb-root[data-width-tier="minimal"] #ag-v2-mtb-slot-merged { display: none !important; }

    .ag-v2-mtb-shell {
      display: inline-flex; align-items: center; justify-content: center; gap: var(--ag-mtb-gap);
      height: var(--ag-mtb-height); max-width: 480px; padding: 0 var(--ag-mtb-pad-x);
      border-radius: var(--ag-mtb-radius); background: var(--ag-mtb-surface);
      border: 1px solid var(--ag-mtb-border);
      box-shadow: 0 6px 20px rgba(0,0,0,0.28), 0 1px 4px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.05);
      contain: layout style; overflow: hidden; opacity: 1;
      transition: max-width var(--ag-mtb-dur-open) var(--ag-mtb-ease-morph), opacity var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph), padding var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph), border-width var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph);
    }
    .ag-v2-mtb-root[data-retracted="true"] .ag-v2-mtb-shell {
      max-width: 0 !important; opacity: 0 !important; padding-left: 0 !important; padding-right: 0 !important;
      border-width: 0 !important; box-shadow: none !important; pointer-events: none !important; overflow: hidden !important;
    }
    .ag-v2-mtb-retract-handle {
      appearance: none; display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 28px; padding: 0; margin: 0; border-radius: 999px;
      border: 1px solid var(--ag-mtb-border); background: var(--ag-mtb-surface); color: var(--ag-mtb-text-secondary);
      cursor: pointer; outline: none; flex: 0 0 auto;
      transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .ag-v2-mtb-retract-handle:hover { background: var(--ag-mtb-btn-hover); color: var(--ag-mtb-text-primary); border-color: var(--ag-mtb-accent); }
    .ag-v2-mtb-retract-handle:focus-visible { box-shadow: 0 0 0 2px var(--ag-mtb-accent); }
    .ag-v2-mtb-retract-handle[hidden] { display: none !important; }
    .ag-v2-mtb-retract-handle svg { width: 13px; height: 13px; display: block; transition: transform var(--ag-mtb-dur-open) var(--ag-mtb-ease-morph); }
    .ag-v2-mtb-root[data-retracted="false"] .ag-v2-mtb-retract-handle svg { transform: rotate(180deg); }
    .ag-v2-mtb-track { display: contents; }
    #ag-v2-mtb-slot-ring-primary { order: 1; }
    #ag-v2-mtb-slot-ring-secondary { order: 2; }
    #ag-v2-mtb-group-ttft { order: 3; }
    #ag-v2-mtb-slot-merged { order: 3; }
    #ag-v2-mtb-group-stats { order: 4; }
    #ag-v2-mtb-slot-cli { order: 5; }
    .ag-v2-mtb-ring-pct {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 8.5px; font-weight: 700; line-height: 1; letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums; color: var(--ag-mtb-text-primary); pointer-events: none;
    }
    #ag-v2-mtb-slot-ring-secondary .ag-v2-mtb-svg--ring { width: 24px; height: 24px; }

    .ag-v2-mtb-slot {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--ag-mtb-slot);
      height: calc(var(--ag-mtb-height) - 6px);
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--ag-mtb-text-primary);
      cursor: pointer;
      outline: none;
      flex: 0 0 auto;
      transition: background-color 140ms ease, color 150ms ease;
    }
    .ag-v2-mtb-slot:hover {
      background: var(--ag-mtb-btn-hover);
    }
    .ag-v2-mtb-slot:active {
      background: var(--ag-mtb-btn-active);
    }
    .ag-v2-mtb-slot:focus-visible,
    .ag-v2-mtb-sub-btn:focus-visible,
    .ag-v2-mtb-close-btn:focus-visible {
      box-shadow: 0 0 0 2px rgba(50, 116, 246, 0.78);
    }
    .ag-v2-mtb-slot--accent {
      color: var(--ag-mtb-accent);
    }
    .ag-v2-mtb-slot[data-slot="cli"] {
      transition: background-color 140ms ease, color 150ms ease, transform 120ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .ag-v2-mtb-slot[data-slot="cli"]:active {
      transform: scale(0.92);
    }
    .ag-v2-mtb-slot[data-slot="cli"][data-cli-color-mode="accent"] {
      color: var(--ag-mtb-accent);
    }
    .ag-v2-mtb-slot[data-slot="cli"][data-cli-color-mode="mono"] {
      color: var(--ag-mtb-cli-mono);
    }
    .ag-v2-mtb-slot[data-slot="cli"][data-cli-color-mode="custom"] {
      color: var(--ag-mtb-cli-custom-color);
    }
    .ag-v2-mtb-slot[data-selected="true"] {
      background: var(--ag-mtb-btn-hover);
    }

    /* Slot 1 Quota Ring 5H / 7D Corner Micro Badges & Refresh Pulse */
    .ag-v2-mtb-corner-tag {
      position: absolute;
      bottom: 1px;
      font-size: 7px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: -0.02em;
      pointer-events: none;
      color: var(--ag-mtb-text-muted);
      opacity: 0.48;
      transition: opacity 150ms ease, color 150ms ease, transform 150ms ease;
    }
    .ag-v2-mtb-corner-tag--bl {
      left: 2px;
    }
    .ag-v2-mtb-corner-tag--br {
      right: 2px;
    }
    .ag-v2-mtb-corner-tag[data-active="true"] {
      color: var(--ag-mtb-text-primary);
      opacity: 0.96;
    }
    @keyframes ag-v2-mtb-ring-spin-pulse {
      0% { transform: rotate(0deg) scale(1); }
      45% { transform: rotate(180deg) scale(1.08); }
      100% { transform: rotate(360deg) scale(1); }
    }
    .ag-v2-mtb-slot[data-refreshing="true"] .ag-v2-mtb-svg--ring {
      animation: ag-v2-mtb-ring-spin-pulse 620ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .ag-v2-mtb-sub-btn[data-pinned="true"]::after {
      content: "";
      position: absolute;
      top: 3px;
      right: 3px;
      width: 4px;
      height: 4px;
      border-radius: 999px;
      background: var(--ag-mtb-accent);
      pointer-events: none;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"][data-pinned="true"]::after {
      background: #ffffff;
    }

    /* Progress Ring Strokes */
    .ag-v2-mtb-ring-track {
      stroke: var(--ag-mtb-ring-track);
    }
    .ag-v2-mtb-ring-arc {
      transition: stroke-dashoffset 260ms var(--ag-mtb-ease-morph), stroke 180ms ease;
    }
    .ag-v2-mtb-ring-arc--primary {
      stroke: var(--ag-mtb-warn);
    }
    .ag-v2-mtb-slot[data-status="danger"] .ag-v2-mtb-ring-arc--primary {
      stroke: var(--ag-mtb-danger);
    }
    .ag-v2-mtb-slot[data-status="accent"] .ag-v2-mtb-ring-arc--primary {
      stroke: var(--ag-mtb-accent);
    }
    .ag-v2-mtb-slot[data-status="normal"] .ag-v2-mtb-ring-arc--primary {
      stroke: #22c55e;
    }
    .ag-v2-mtb-ring-arc--secondary {
      stroke: var(--ag-mtb-text-primary);
    }
    .ag-v2-mtb-slot[data-status="warn"] .ag-v2-mtb-ring-arc--secondary {
      stroke: var(--ag-mtb-warn);
    }
    .ag-v2-mtb-slot[data-status="danger"] .ag-v2-mtb-ring-arc--secondary {
      stroke: var(--ag-mtb-danger);
    }

    /* Expandable Inline Morphing Groups (Slot 3: Status, Slot 4: Stats) */
    .ag-v2-mtb-group {
      position: relative;
      display: inline-flex;
      align-items: center;
      height: calc(var(--ag-mtb-height) - 6px);
      width: var(--ag-mtb-slot);
      flex: 0 0 auto;
      border-radius: 10px;
      background: transparent;
      box-shadow: inset 0 0 0 1px transparent;
      transition:
        width var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph),
        background-color 180ms ease,
        box-shadow 180ms ease;
    }
    .ag-v2-mtb-group[data-open="true"] {
      width: calc(
        var(--ag-mtb-close-offset) +
        var(--ag-mtb-count, 3) * var(--ag-mtb-slot) +
        (var(--ag-mtb-count, 3) - 1) * var(--ag-mtb-sub-gap)
      );
      background: var(--ag-mtb-tray-bg);
      box-shadow: inset 0 0 0 1px var(--ag-mtb-tray-border);
      transition:
        width var(--ag-mtb-dur-open) var(--ag-mtb-ease-morph),
        background-color 180ms ease,
        box-shadow 180ms ease;
    }
    .ag-v2-mtb-group-stage {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    /* Close Button (X) */
    .ag-v2-mtb-close-btn {
      position: absolute;
      left: 0;
      top: 50%;
      width: var(--ag-mtb-close-w);
      height: 100%;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--ag-mtb-text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      outline: none;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-50%) scale(0.76);
      transition:
        opacity calc(180ms * var(--ag-mtb-speed-mult)) ease,
        transform var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph),
        background-color 140ms ease,
        color 140ms ease;
    }
    .ag-v2-mtb-close-btn::after {
      content: "";
      position: absolute;
      right: -2px;
      top: 22%;
      bottom: 22%;
      width: 1px;
      background: var(--ag-mtb-border-subtle);
      opacity: 0;
      transition: opacity 160ms ease;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-close-btn {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(-50%) scale(1);
      transition:
        opacity calc(200ms * var(--ag-mtb-speed-mult)) ease calc(45ms * var(--ag-mtb-speed-mult)),
        transform var(--ag-mtb-dur-open) var(--ag-mtb-ease-morph),
        background-color 140ms ease,
        color 140ms ease;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-close-btn::after {
      opacity: 1;
    }
    .ag-v2-mtb-close-btn:hover {
      background: var(--ag-mtb-btn-hover);
      color: var(--ag-mtb-text-primary);
    }
    .ag-v2-mtb-close-btn:active {
      background: var(--ag-mtb-btn-active);
    }
    .ag-v2-mtb-close-svg {
      width: 13px;
      height: 13px;
      display: block;
    }

    /* Electric-Blue Sliding Highlight Pill */
    .ag-v2-mtb-pill {
      position: absolute;
      top: 0;
      left: 0;
      width: var(--ag-mtb-slot);
      height: 100%;
      border-radius: 9px;
      background: var(--ag-mtb-pill-blue);
      box-shadow: var(--ag-mtb-pill-shadow);
      opacity: 0;
      pointer-events: none;
      z-index: 1;
      transform: translateX(0px) scale(0.86);
      transition:
        transform var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph),
        opacity calc(180ms * var(--ag-mtb-speed-mult)) ease;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-pill {
      opacity: 1;
      transform: translateX(
        calc(var(--ag-mtb-close-offset) + var(--ag-mtb-active-idx, 0) * var(--ag-mtb-step))
      ) scale(1);
      transition:
        transform var(--ag-mtb-dur-pill) var(--ag-mtb-ease-morph),
        opacity calc(190ms * var(--ag-mtb-speed-mult)) ease;
    }

    /* Sub-Item Buttons */
    .ag-v2-mtb-sub-btn {
      position: absolute;
      top: 0;
      left: 0;
      width: var(--ag-mtb-slot);
      height: 100%;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--ag-mtb-text-primary);
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      outline: none;
      z-index: 2;
      opacity: 0;
      pointer-events: none;
      transform: translateX(calc((var(--ag-mtb-idx, 0) - var(--ag-mtb-active-idx, 0)) * 8px)) scale(0.76);
      transition:
        transform var(--ag-mtb-dur-close) var(--ag-mtb-ease-morph),
        opacity calc(170ms * var(--ag-mtb-speed-mult)) ease,
        background-color 140ms ease,
        color 160ms ease;
    }
    .ag-v2-mtb-sub-btn[data-active="true"] {
      opacity: 1;
      pointer-events: auto;
      z-index: 3;
      transform: translateX(0px) scale(1);
    }
    .ag-v2-mtb-group[data-open="false"] .ag-v2-mtb-sub-btn[data-active="true"]:hover {
      background: var(--ag-mtb-btn-hover);
    }
    .ag-v2-mtb-group[data-open="false"] .ag-v2-mtb-sub-btn[data-active="true"]:active {
      background: var(--ag-mtb-btn-active);
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(
        calc(var(--ag-mtb-close-offset) + var(--ag-mtb-idx, 0) * var(--ag-mtb-step))
      ) scale(1);
      transition:
        transform var(--ag-mtb-dur-open) var(--ag-mtb-ease-morph),
        opacity calc(210ms * var(--ag-mtb-speed-mult)) ease calc(25ms * var(--ag-mtb-speed-mult)),
        background-color 140ms ease,
        color 160ms ease;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="false"]:hover {
      background: var(--ag-mtb-btn-hover);
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="false"]:active {
      background: var(--ag-mtb-btn-active);
    }
    .ag-v2-mtb-sub-btn--accent {
      color: var(--ag-mtb-accent);
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn--accent[data-active="true"],
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] {
      color: #ffffff;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-needle-core {
      fill: #ffffff;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-micro-text {
      color: #ffffff;
    }

    /* Bottom-Right Disclosure Triangle */
    .ag-v2-mtb-disclosure {
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 0;
      height: 0;
      border-style: solid;
      border-width: 0 0 4.5px 4.5px;
      border-color: transparent transparent var(--ag-mtb-text-muted) transparent;
      opacity: 0.66;
      pointer-events: none;
      z-index: 4;
      transition: opacity 150ms ease, transform 150ms ease;
    }
    .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-disclosure {
      opacity: 0;
      transform: scale(0.5);
    }

    /* Optional Flat Layout Override (Only if explicitly requested via data-layout="flat") */
    .ag-v2-mtb-root[data-layout="flat"] .ag-v2-mtb-group--flat-able {
      width: calc(3 * var(--ag-mtb-slot) + 2 * var(--ag-mtb-gap));
    }
    .ag-v2-mtb-root[data-layout="flat"] .ag-v2-mtb-group--flat-able .ag-v2-mtb-close-btn,
    .ag-v2-mtb-root[data-layout="flat"] .ag-v2-mtb-group--flat-able .ag-v2-mtb-pill,
    .ag-v2-mtb-root[data-layout="flat"] .ag-v2-mtb-group--flat-able .ag-v2-mtb-disclosure {
      opacity: 0;
      pointer-events: none;
      visibility: hidden;
    }
    .ag-v2-mtb-root[data-layout="flat"] .ag-v2-mtb-group--flat-able .ag-v2-mtb-sub-btn {
      opacity: 1;
      pointer-events: auto;
      z-index: 2;
      transform: translateX(
        calc(var(--ag-mtb-idx, 0) * (var(--ag-mtb-slot) + var(--ag-mtb-gap)))
      ) scale(1);
    }

    /* SVG Sizing & Metric Baseline */
    .ag-v2-mtb-svg {
      width: 19px;
      height: 19px;
      display: block;
      flex-shrink: 0;
    }
    .ag-v2-mtb-svg--account {
      width: 20px;
      height: 20px;
    }
    .ag-v2-mtb-sub-btn--metric {
      justify-content: flex-start;
      padding-top: 2px;
    }
    .ag-v2-mtb-icon-box {
      width: 19px;
      height: 19px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .ag-v2-mtb-svg--hg {
      width: 18px;
      height: 18px;
      transform-origin: center center;
      transform: rotate(calc(var(--ag-mtb-hg-turns, 0) * 180deg));
      transition: transform var(--ag-mtb-dur-flip) var(--ag-mtb-ease-flip);
      will-change: transform;
    }
    .ag-v2-mtb-svg--gauge {
      width: 19px;
      height: 19px;
      overflow: visible;
    }
    .ag-v2-mtb-needle-core {
      transition: fill 160ms ease;
    }
    .ag-v2-mtb-micro-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 10px;
      margin-top: -1px;
      overflow: visible;
      pointer-events: none;
    }
    .ag-v2-mtb-micro-text {
      display: inline-block;
      font-size: 11px;
      line-height: 1;
      font-weight: 600;
      letter-spacing: -0.01em;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      color: var(--ag-mtb-text-secondary);
      transform: scale(var(--ag-mtb-micro-scale));
      transform-origin: center center;
      transition: color 160ms ease;
    }
    .ag-v2-mtb-root[data-ttft-running="true"] #ag-v2-mtb-ttft-label {
      color: var(--ag-mtb-text-primary);
    }

    /* Light Theme Tokens */
    [data-theme="light"] .ag-v2-mtb-root,
    :host([data-theme="light"]) .ag-v2-mtb-root,
    :host([data-panel-tone="light"]) .ag-v2-mtb-root {
      --ag-mtb-surface: var(--ag-bg-card, #ffffff);
      --ag-mtb-border: rgba(24, 24, 27, 0.12);
      --ag-mtb-border-subtle: rgba(24, 24, 27, 0.1);
      --ag-mtb-text-primary: #18181b;
      --ag-mtb-text-secondary: #52525b;
      --ag-mtb-text-muted: #71717a;
      --ag-mtb-btn-hover: rgba(24, 24, 27, 0.06);
      --ag-mtb-btn-active: rgba(24, 24, 27, 0.12);
      --ag-mtb-tray-bg: rgba(24, 24, 27, 0.045);
      --ag-mtb-tray-border: rgba(24, 24, 27, 0.09);
      --ag-mtb-ring-track: rgba(24, 24, 27, 0.14);
      --ag-mtb-cli-mono: #18181b;
    }
    [data-theme="light"] .ag-v2-mtb-shell,
    :host([data-theme="light"]) .ag-v2-mtb-shell,
    :host([data-panel-tone="light"]) .ag-v2-mtb-shell {
      box-shadow:
        0 6px 18px rgba(15, 23, 42, 0.1),
        0 1px 4px rgba(15, 23, 42, 0.08);
    }
    [data-theme="light"] .ag-v2-mtb-needle-blade,
    [data-theme="light"] .ag-v2-mtb-needle-hub,
    :host([data-theme="light"]) .ag-v2-mtb-needle-blade,
    :host([data-theme="light"]) .ag-v2-mtb-needle-hub {
      fill: #18181b;
    }
    [data-theme="light"] .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-needle-blade,
    [data-theme="light"] .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-needle-hub,
    :host([data-theme="light"]) .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-needle-blade,
    :host([data-theme="light"]) .ag-v2-mtb-group[data-open="true"] .ag-v2-mtb-sub-btn[data-active="true"] .ag-v2-mtb-needle-hub {
      fill: #ffffff;
    }

    @media (max-width: 480px) {
      .ag-v2-mtb-root {
        --ag-mtb-height: 36px;
        --ag-mtb-pad-x: 4px;
        --ag-mtb-slot: 34px;
        --ag-mtb-gap: 2px;
        --ag-mtb-sub-gap: 2px;
        --ag-mtb-close-w: 24px;
        --ag-mtb-radius: 11px;
      }
      .ag-v2-mtb-svg,
      .ag-v2-mtb-icon-box {
        width: 17px;
        height: 17px;
      }
      .ag-v2-mtb-svg--hg,
      .ag-v2-mtb-svg--gauge {
        width: 17px;
        height: 17px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .ag-v2-mtb-root { --ag-mtb-dur-open: 0ms; --ag-mtb-dur-close: 0ms; --ag-mtb-dur-pill: 0ms; --ag-mtb-dur-flip: 0ms; }
      .ag-v2-mtb-root *, .ag-v2-mtb-shell, .ag-v2-mtb-group, .ag-v2-mtb-pill, .ag-v2-mtb-sub-btn, .ag-v2-mtb-close-btn { transition-duration: 0ms !important; animation-duration: 0ms !important; }
    }
    .ag-v2-mtb-root[data-reduced-motion="true"] { --ag-mtb-dur-open: 0ms; --ag-mtb-dur-close: 0ms; --ag-mtb-dur-pill: 0ms; --ag-mtb-dur-flip: 0ms; }
    .ag-v2-mtb-root[data-reduced-motion="true"] *, .ag-v2-mtb-root[data-reduced-motion="true"] .ag-v2-mtb-shell, .ag-v2-mtb-root[data-reduced-motion="true"] .ag-v2-mtb-group, .ag-v2-mtb-root[data-reduced-motion="true"] .ag-v2-mtb-pill, .ag-v2-mtb-root[data-reduced-motion="true"] .ag-v2-mtb-sub-btn, .ag-v2-mtb-root[data-reduced-motion="true"] .ag-v2-mtb-close-btn { transition-duration: 0ms !important; animation-duration: 0ms !important; }
  `;

  function svgEl(doc, tag, attrs = {}, children = []) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    for (const ch of children) {
      if (ch) node.appendChild(ch);
    }
    return node;
  }

  /**
   * 纯 DOM API 构建 5 槽位原位折叠工具栏节点树（复用原参考 template.html 全套 SVG 与语义 ID，零 innerHTML）。
   */
  function buildMorphToolbarDom(doc, copy) {
    const rootEl = doc.createElement('div');
    rootEl.id = 'ag-v2-mtb-root';
    rootEl.className = 'ag-v2-mtb-root';
    rootEl.setAttribute('data-ag-mtb-toolbar', 'true');
    rootEl.setAttribute('data-layout', 'submenu');
    rootEl.setAttribute('data-label-size', 'sm');
    rootEl.setAttribute('data-speed-multiplier', '1');
    rootEl.setAttribute('data-reduced-motion', 'false');

    const nav = doc.createElement('nav');
    nav.id = 'ag-v2-mtb-shell';
    nav.className = 'ag-v2-mtb-shell';
    nav.setAttribute('role', 'toolbar');
    nav.setAttribute('aria-label', copy.toolbarAria);

    const track = doc.createElement('div');
    track.className = 'ag-v2-mtb-track';

    const makeRingButton = (id, slotKey, arcId, arcModClass, status, ariaLabel) => {
      const btn = doc.createElement('button');
      btn.id = id;
      btn.className = 'ag-v2-mtb-slot ag-v2-mtb-slot--icon-only';
      btn.type = 'button';
      btn.setAttribute('data-slot', slotKey);
      btn.setAttribute('data-status', status);
      btn.setAttribute('aria-label', ariaLabel);
      const svg = svgEl(doc, 'svg', {
        class: 'ag-v2-mtb-svg ag-v2-mtb-svg--ring',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true'
      }, [
        svgEl(doc, 'circle', {
          class: 'ag-v2-mtb-ring-track',
          cx: 12, cy: 12, r: 8.5, fill: 'none', 'stroke-width': 2.7
        }),
        svgEl(doc, 'circle', {
          id: arcId,
          class: `ag-v2-mtb-ring-arc ${arcModClass}`,
          cx: 12, cy: 12, r: 8.5, fill: 'none', 'stroke-width': 2.7,
          'stroke-linecap': 'round',
          'stroke-dasharray': String(RING_CIRCUMFERENCE),
          'stroke-dashoffset': String(RING_CIRCUMFERENCE),
          transform: 'rotate(-90 12 12)'
        })
      ]);
      btn.appendChild(svg);
      return btn;
    };

    const makeCloseBtn = (id, groupId, ariaLabel) => {
      const btn = doc.createElement('button');
      btn.id = id;
      btn.className = 'ag-v2-mtb-close-btn';
      btn.type = 'button';
      btn.setAttribute('data-group-close', groupId);
      btn.setAttribute('tabindex', '-1');
      btn.setAttribute('aria-label', ariaLabel);
      btn.appendChild(svgEl(doc, 'svg', {
        class: 'ag-v2-mtb-close-svg',
        viewBox: '0 0 16 16',
        'aria-hidden': 'true'
      }, [
        svgEl(doc, 'path', {
          d: 'M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round'
        })
      ]));
      return btn;
    };

    // Slot 1: 额度主圆环（Amber / Danger / Normal + 左下角 5H / 右下角 7D 微型标识）
    const primaryRingBtn = makeRingButton(
      'ag-v2-mtb-slot-ring-primary',
      'quota',
      'ag-v2-mtb-ring-primary-arc',
      'ag-v2-mtb-ring-arc--primary',
      'warn',
      copy.quotaRingAria
    );
    primaryRingBtn.setAttribute('data-quota-window', '5h');
    const badge5h = doc.createElement('span');
    badge5h.id = 'ag-v2-mtb-quota-badge-5h';
    badge5h.className = 'ag-v2-mtb-corner-tag ag-v2-mtb-corner-tag--bl';
    badge5h.setAttribute('data-window', '5h');
    badge5h.setAttribute('data-active', 'true');
    badge5h.setAttribute('aria-hidden', 'true');
    badge5h.textContent = '5H';
    const badge7d = doc.createElement('span');
    badge7d.id = 'ag-v2-mtb-quota-badge-7d';
    badge7d.className = 'ag-v2-mtb-corner-tag ag-v2-mtb-corner-tag--br';
    badge7d.setAttribute('data-window', '7d');
    badge7d.setAttribute('data-active', 'false');
    badge7d.setAttribute('aria-hidden', 'true');
    badge7d.textContent = '7D';
    primaryRingBtn.appendChild(badge5h);
    primaryRingBtn.appendChild(badge7d);

    // Slot 2: 上下文次圆环（环内居中显示百分比）
    const secondaryRingBtn = makeRingButton(
      'ag-v2-mtb-slot-ring-secondary',
      'ring-secondary',
      'ag-v2-mtb-ring-secondary-arc',
      'ag-v2-mtb-ring-arc--secondary',
      'normal',
      copy.contextRingAria
    );
    const secondaryRingPct = doc.createElement('span');
    secondaryRingPct.id = 'ag-v2-mtb-context-pct';
    secondaryRingPct.className = 'ag-v2-mtb-ring-pct';
    secondaryRingPct.setAttribute('aria-hidden', 'true');
    secondaryRingPct.textContent = '--%';
    secondaryRingBtn.appendChild(secondaryRingPct);

    // Slot 3: 状态工具组（首字沙漏 / 生成速度 / 账号入口）
    const ttftGroup = doc.createElement('div');
    ttftGroup.id = 'ag-v2-mtb-group-ttft';
    ttftGroup.className = 'ag-v2-mtb-group ag-v2-mtb-group--flat-able';
    ttftGroup.setAttribute('data-group', 'ttft-group');
    ttftGroup.setAttribute('data-open', 'false');
    ttftGroup.setAttribute('data-active-tool', 'ttft');
    ttftGroup.setAttribute('aria-expanded', 'false');
    ttftGroup.style.setProperty('--ag-mtb-active-idx', '0');
    ttftGroup.style.setProperty('--ag-mtb-count', '3');

    const ttftStage = doc.createElement('div');
    ttftStage.className = 'ag-v2-mtb-group-stage';
    const ttftClose = makeCloseBtn('ag-v2-mtb-close-ttft', 'ttft-group', copy.closeSubmenuAria);
    const ttftPill = doc.createElement('span');
    ttftPill.className = 'ag-v2-mtb-pill';
    ttftPill.setAttribute('aria-hidden', 'true');

    // Sub-item 0: TTFT 沙漏
    const btnTtft = doc.createElement('button');
    btnTtft.id = 'ag-v2-mtb-tool-ttft';
    btnTtft.className = 'ag-v2-mtb-sub-btn ag-v2-mtb-sub-btn--metric';
    btnTtft.type = 'button';
    btnTtft.setAttribute('data-group-item', 'ttft-group');
    btnTtft.setAttribute('data-tool', 'ttft');
    btnTtft.setAttribute('data-idx', '0');
    btnTtft.setAttribute('data-active', 'true');
    btnTtft.setAttribute('aria-pressed', 'true');
    btnTtft.setAttribute('aria-label', copy.ttftAria);
    btnTtft.style.setProperty('--ag-mtb-idx', '0');

    const hgIconBox = doc.createElement('span');
    hgIconBox.className = 'ag-v2-mtb-icon-box';
    hgIconBox.appendChild(svgEl(doc, 'svg', {
      id: 'ag-v2-mtb-hg-svg',
      class: 'ag-v2-mtb-svg ag-v2-mtb-svg--hg',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true'
    }, [
      svgEl(doc, 'defs', {}, [
        svgEl(doc, 'linearGradient', { id: 'ag-v2-mtb-hg-cap', x1: '0%', y1: '0%', x2: '100%', y2: '0%' }, [
          svgEl(doc, 'stop', { offset: '0%', 'stop-color': '#9ca3af' }),
          svgEl(doc, 'stop', { offset: '48%', 'stop-color': '#e5e7eb' }),
          svgEl(doc, 'stop', { offset: '100%', 'stop-color': '#7c8596' })
        ]),
        svgEl(doc, 'linearGradient', { id: 'ag-v2-mtb-hg-sand', x1: '0%', y1: '0%', x2: '0%', y2: '100%' }, [
          svgEl(doc, 'stop', { offset: '0%', 'stop-color': '#fde68a' }),
          svgEl(doc, 'stop', { offset: '55%', 'stop-color': '#f59e0b' }),
          svgEl(doc, 'stop', { offset: '100%', 'stop-color': '#d97706' })
        ])
      ]),
      svgEl(doc, 'path', {
        d: 'M7.2 4.6H16.8V6.2C16.8 8.7 14.9 10.6 12.8 11.75V12.25C14.9 13.4 16.8 15.3 16.8 17.8V19.4H7.2V17.8C7.2 15.3 9.1 13.4 11.2 12.25V11.75C9.1 10.6 7.2 8.7 7.2 6.2Z',
        fill: 'rgba(219, 234, 254, 0.18)', stroke: 'rgba(226, 232, 240, 0.62)', 'stroke-width': 1.2, 'stroke-linejoin': 'round'
      }),
      svgEl(doc, 'path', {
        d: 'M8.65 6.85H15.35C15.1 8.55 13.85 9.95 12 10.85C10.15 9.95 8.9 8.55 8.65 6.85Z',
        fill: 'url(#ag-v2-mtb-hg-sand)'
      }),
      svgEl(doc, 'path', {
        d: 'M8.55 18.25C9.15 16.55 10.5 15.55 12 14.85C13.5 15.55 14.85 16.55 15.45 18.25Z',
        fill: 'url(#ag-v2-mtb-hg-sand)'
      }),
      svgEl(doc, 'line', {
        x1: 12, y1: 10.9, x2: 12, y2: 14.9, stroke: '#fbbf24', 'stroke-width': 1.05, 'stroke-linecap': 'round'
      }),
      svgEl(doc, 'path', {
        d: 'M8.8 6.4C8.9 7.8 9.6 8.9 10.6 9.6',
        fill: 'none', stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 0.85, 'stroke-linecap': 'round'
      }),
      svgEl(doc, 'rect', { x: 6, y: 3.1, width: 12, height: 2, rx: 1, fill: 'url(#ag-v2-mtb-hg-cap)' }),
      svgEl(doc, 'rect', { x: 6, y: 18.9, width: 12, height: 2, rx: 1, fill: 'url(#ag-v2-mtb-hg-cap)' })
    ]));
    const ttftMicroWrap = doc.createElement('span');
    ttftMicroWrap.className = 'ag-v2-mtb-micro-wrap';
    const ttftLabel = doc.createElement('span');
    ttftLabel.id = 'ag-v2-mtb-ttft-label';
    ttftLabel.className = 'ag-v2-mtb-micro-text';
    ttftLabel.textContent = '--';
    ttftMicroWrap.appendChild(ttftLabel);
    btnTtft.appendChild(hgIconBox);
    btnTtft.appendChild(ttftMicroWrap);

    // Sub-item 1: 生成速度仪表盘
    const btnSpeed = doc.createElement('button');
    btnSpeed.id = 'ag-v2-mtb-tool-tok-speed';
    btnSpeed.className = 'ag-v2-mtb-sub-btn ag-v2-mtb-sub-btn--metric';
    btnSpeed.type = 'button';
    btnSpeed.setAttribute('data-group-item', 'ttft-group');
    btnSpeed.setAttribute('data-tool', 'tok-speed');
    btnSpeed.setAttribute('data-idx', '1');
    btnSpeed.setAttribute('data-active', 'false');
    btnSpeed.setAttribute('aria-pressed', 'false');
    btnSpeed.setAttribute('aria-label', copy.speedAria);
    btnSpeed.style.setProperty('--ag-mtb-idx', '1');

    const gaugeIconBox = doc.createElement('span');
    gaugeIconBox.className = 'ag-v2-mtb-icon-box';
    gaugeIconBox.appendChild(svgEl(doc, 'svg', {
      id: 'ag-v2-mtb-gauge-svg',
      class: 'ag-v2-mtb-svg ag-v2-mtb-svg--gauge',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true'
    }, [
      svgEl(doc, 'path', {
        class: 'ag-v2-mtb-gauge-outer-l',
        d: 'M 4.21 18.35 A 8.4 8.4 0 0 1 16.70 8.24',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round'
      }),
      svgEl(doc, 'path', {
        class: 'ag-v2-mtb-gauge-outer-r',
        d: 'M 19.27 11.00 A 8.4 8.4 0 0 1 19.79 18.35',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', opacity: 0.34
      }),
      svgEl(doc, 'path', {
        class: 'ag-v2-mtb-gauge-inner-l',
        d: 'M 6.93 17.05 A 5.4 5.4 0 0 1 14.70 10.52',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.28
      }),
      svgEl(doc, 'path', {
        class: 'ag-v2-mtb-gauge-inner-r',
        d: 'M 16.85 12.83 A 5.4 5.4 0 0 1 17.07 17.05',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.22
      }),
      svgEl(doc, 'g', {
        id: 'ag-v2-mtb-needle',
        class: 'ag-v2-mtb-needle-group',
        transform: `rotate(${NEEDLE_MIN_DEG} 12 15.2)`
      }, [
        svgEl(doc, 'path', {
          class: 'ag-v2-mtb-needle-blade',
          d: 'M 10.25 15.15 L 11.58 5.25 C 11.68 4.72 12.32 4.72 12.42 5.25 L 13.75 15.15 A 1.85 1.85 0 0 1 10.25 15.15 Z',
          fill: '#ffffff'
        }),
        svgEl(doc, 'circle', { class: 'ag-v2-mtb-needle-hub', cx: 12, cy: 15.2, r: 2.2, fill: '#ffffff' }),
        svgEl(doc, 'circle', { class: 'ag-v2-mtb-needle-core', cx: 12, cy: 15.2, r: 0.95, fill: '#38bdf8' })
      ])
    ]));
    const tokMicroWrap = doc.createElement('span');
    tokMicroWrap.className = 'ag-v2-mtb-micro-wrap';
    const tokLabel = doc.createElement('span');
    tokLabel.id = 'ag-v2-mtb-tok-label';
    tokLabel.className = 'ag-v2-mtb-micro-text';
    const tokNumSpan = doc.createElement('span');
    tokNumSpan.id = 'ag-v2-mtb-tok-num';
    tokNumSpan.textContent = '--';
    const tokUnitSpan = doc.createElement('span');
    tokUnitSpan.id = 'ag-v2-mtb-tok-unit';
    tokUnitSpan.className = 'ag-v2-mtb-unit-label';
    tokUnitSpan.textContent = ' tok/s';
    tokLabel.appendChild(tokNumSpan);
    tokLabel.appendChild(tokUnitSpan);
    tokMicroWrap.appendChild(tokLabel);
    btnSpeed.appendChild(gaugeIconBox);
    btnSpeed.appendChild(tokMicroWrap);

    // Sub-item 2: 账号切换入口（双头像+双向箭头）
    const btnAccount = doc.createElement('button');
    btnAccount.id = 'ag-v2-mtb-tool-account-switch';
    btnAccount.className = 'ag-v2-mtb-sub-btn ag-v2-mtb-sub-btn--icon-only';
    btnAccount.type = 'button';
    btnAccount.setAttribute('data-group-item', 'ttft-group');
    btnAccount.setAttribute('data-tool', 'account-switch');
    btnAccount.setAttribute('data-idx', '2');
    btnAccount.setAttribute('data-active', 'false');
    btnAccount.setAttribute('aria-pressed', 'false');
    btnAccount.setAttribute('aria-label', copy.accountAria);
    btnAccount.style.setProperty('--ag-mtb-idx', '2');
    btnAccount.appendChild(svgEl(doc, 'svg', {
      class: 'ag-v2-mtb-svg ag-v2-mtb-svg--account',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true'
    }, [
      svgEl(doc, 'defs', {}, [
        svgEl(doc, 'mask', { id: 'ag-v2-mtb-acct-mask' }, [
          svgEl(doc, 'rect', { x: 0, y: 0, width: 24, height: 24, fill: '#ffffff' }),
          svgEl(doc, 'circle', { cx: 8.6, cy: 8.7, r: 6.55, fill: '#000000' })
        ])
      ]),
      svgEl(doc, 'g', { mask: 'url(#ag-v2-mtb-acct-mask)', opacity: 0.46 }, [
        svgEl(doc, 'circle', { cx: 15.4, cy: 8.7, r: 5.35, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.35 }),
        svgEl(doc, 'circle', { cx: 15.4, cy: 7.35, r: 1.75, fill: 'currentColor' }),
        svgEl(doc, 'path', {
          d: 'M12.1 12.75C12.75 11.15 13.95 10.35 15.4 10.35C16.85 10.35 18.05 11.15 18.7 12.75A5.3 5.3 0 0 1 12.1 12.75Z',
          fill: 'currentColor'
        })
      ]),
      svgEl(doc, 'g', {}, [
        svgEl(doc, 'circle', { cx: 8.6, cy: 8.7, r: 5.35, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.45 }),
        svgEl(doc, 'circle', { cx: 8.6, cy: 7.35, r: 1.8, fill: 'currentColor' }),
        svgEl(doc, 'path', {
          d: 'M5.25 12.8C5.9 11.15 7.15 10.35 8.6 10.35C10.05 10.35 11.3 11.15 11.95 12.8A5.3 5.3 0 0 1 5.25 12.8Z',
          fill: 'currentColor'
        })
      ]),
      svgEl(doc, 'path', {
        d: 'M7.6 19.05H16.4M9.4 17.25L7.1 19.05L9.4 20.85M14.6 17.25L16.9 19.05L14.6 20.85',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.78
      })
    ]));

    ttftStage.appendChild(ttftClose);
    ttftStage.appendChild(ttftPill);
    ttftStage.appendChild(btnTtft);
    ttftStage.appendChild(btnSpeed);
    ttftStage.appendChild(btnAccount);

    const ttftDisc = doc.createElement('span');
    ttftDisc.className = 'ag-v2-mtb-disclosure';
    ttftDisc.setAttribute('aria-hidden', 'true');
    ttftGroup.appendChild(ttftStage);
    ttftGroup.appendChild(ttftDisc);

    // Slot 4: 统计工具组（用量 / 趋势 / 构成图）
    const statsGroup = doc.createElement('div');
    statsGroup.id = 'ag-v2-mtb-group-stats';
    statsGroup.className = 'ag-v2-mtb-group ag-v2-mtb-group--accent';
    statsGroup.setAttribute('data-group', 'stats-group');
    statsGroup.setAttribute('data-open', 'false');
    statsGroup.setAttribute('data-active-tool', 'stats-bars');
    statsGroup.setAttribute('aria-expanded', 'false');
    statsGroup.style.setProperty('--ag-mtb-active-idx', '0');
    statsGroup.style.setProperty('--ag-mtb-count', '3');

    const statsStage = doc.createElement('div');
    statsStage.className = 'ag-v2-mtb-group-stage';
    const statsClose = makeCloseBtn('ag-v2-mtb-close-stats', 'stats-group', copy.closeStatsSubmenuAria);
    const statsPill = doc.createElement('span');
    statsPill.className = 'ag-v2-mtb-pill';
    statsPill.setAttribute('aria-hidden', 'true');

    const makeStatsBtn = (id, toolId, idx, active, ariaLabel, svgNode) => {
      const btn = doc.createElement('button');
      btn.id = id;
      btn.className = 'ag-v2-mtb-sub-btn ag-v2-mtb-sub-btn--accent';
      btn.type = 'button';
      btn.setAttribute('data-group-item', 'stats-group');
      btn.setAttribute('data-tool', toolId);
      btn.setAttribute('data-idx', String(idx));
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.setAttribute('aria-label', ariaLabel);
      btn.style.setProperty('--ag-mtb-idx', String(idx));
      btn.appendChild(svgNode);
      return btn;
    };

    const btnBars = makeStatsBtn('ag-v2-mtb-tool-stats-bars', 'stats-bars', 0, true, copy.statsBarsAria,
      svgEl(doc, 'svg', { class: 'ag-v2-mtb-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl(doc, 'rect', { x: 5.2, y: 13.2, width: 2.8, height: 6.3, rx: 1.4, fill: 'currentColor' }),
        svgEl(doc, 'rect', { x: 10.6, y: 5.5, width: 2.8, height: 14, rx: 1.4, fill: 'currentColor' }),
        svgEl(doc, 'rect', { x: 16, y: 9.8, width: 2.8, height: 9.7, rx: 1.4, fill: 'currentColor' })
      ])
    );

    const btnTrend = makeStatsBtn('ag-v2-mtb-tool-stats-trend', 'stats-trend', 1, false, copy.statsTrendAria,
      svgEl(doc, 'svg', { class: 'ag-v2-mtb-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl(doc, 'path', {
          d: 'M4.5 16.5L9.2 11.4L13.1 14.3L19.2 7.4',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }),
        svgEl(doc, 'path', {
          d: 'M15.6 7.2H19.4V11',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        })
      ])
    );

    const btnDonut = makeStatsBtn('ag-v2-mtb-tool-stats-donut', 'stats-donut', 2, false, copy.statsDonutAria,
      svgEl(doc, 'svg', { class: 'ag-v2-mtb-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl(doc, 'circle', {
          cx: 12, cy: 12, r: 6.8, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2,
          'stroke-dasharray': '26 17', 'stroke-linecap': 'round', transform: 'rotate(-90 12 12)'
        }),
        svgEl(doc, 'circle', {
          cx: 12, cy: 12, r: 6.8, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2,
          'stroke-dasharray': '10 33', 'stroke-dashoffset': '-31', 'stroke-linecap': 'round', opacity: 0.45,
          transform: 'rotate(-90 12 12)'
        })
      ])
    );

    statsStage.appendChild(statsClose);
    statsStage.appendChild(statsPill);
    statsStage.appendChild(btnBars);
    statsStage.appendChild(btnTrend);
    statsStage.appendChild(btnDonut);

    const statsDisc = doc.createElement('span');
    statsDisc.className = 'ag-v2-mtb-disclosure';
    statsDisc.setAttribute('aria-hidden', 'true');
    statsGroup.appendChild(statsStage);
    statsGroup.appendChild(statsDisc);

    // Slot 5: CLI 终端入口 (>_)
    const cliBtn = doc.createElement('button');
    cliBtn.id = 'ag-v2-mtb-slot-cli';
    cliBtn.className = 'ag-v2-mtb-slot ag-v2-mtb-slot--icon-only ag-v2-mtb-slot--accent';
    cliBtn.type = 'button';
    cliBtn.setAttribute('data-slot', 'cli');
    cliBtn.setAttribute('data-cli-color-mode', 'accent');
    cliBtn.setAttribute('aria-label', copy.cliAria);
    cliBtn.appendChild(svgEl(doc, 'svg', { class: 'ag-v2-mtb-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl(doc, 'path', {
        d: 'M5.5 8.1L10.3 12.1L5.5 16.1',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }),
      svgEl(doc, 'line', {
        x1: 12.4, y1: 16.4, x2: 18.6, y2: 16.4,
        stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round'
      })
    ]));

    track.appendChild(primaryRingBtn);
    track.appendChild(secondaryRingBtn);
    track.appendChild(ttftGroup);
    track.appendChild(statsGroup);
    track.appendChild(cliBtn);
    nav.appendChild(track);

    const mergedSlotBtn = doc.createElement('button');
    mergedSlotBtn.id = 'ag-v2-mtb-slot-merged';
    mergedSlotBtn.className = 'ag-v2-mtb-slot ag-v2-mtb-slot--icon-only';
    mergedSlotBtn.type = 'button';
    mergedSlotBtn.setAttribute('data-slot', 'merged-tools');
    mergedSlotBtn.setAttribute('aria-expanded', 'false');
    mergedSlotBtn.setAttribute('aria-label', copy.mergedToolsAria);
    mergedSlotBtn.title = copy.mergedToolsAria;
    mergedSlotBtn.appendChild(svgEl(doc, 'svg', { class: 'ag-v2-mtb-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl(doc, 'rect', { x: 4.5, y: 12.5, width: 3, height: 6.5, rx: 1.2, fill: 'currentColor', opacity: 0.72 }),
      svgEl(doc, 'rect', { x: 10.5, y: 6.5, width: 3, height: 12.5, rx: 1.2, fill: 'currentColor' }),
      svgEl(doc, 'rect', { x: 16.5, y: 9.5, width: 3, height: 9.5, rx: 1.2, fill: 'currentColor', opacity: 0.86 })
    ]));
    nav.appendChild(mergedSlotBtn);

    const retractHandle = doc.createElement('button');
    retractHandle.id = 'ag-v2-mtb-retract-handle';
    retractHandle.className = 'ag-v2-mtb-retract-handle';
    retractHandle.type = 'button';
    retractHandle.hidden = true;
    retractHandle.setAttribute('data-om-capsule-handle', 'true');
    retractHandle.setAttribute('aria-expanded', 'false');
    retractHandle.setAttribute('aria-label', copy.retractHandleExpandAria);
    retractHandle.title = copy.retractHandleExpandAria;
    retractHandle.appendChild(svgEl(doc, 'svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, [
      svgEl(doc, 'path', { d: 'M10.5 3.5L6 8l4.5 4.5' })
    ]));

    rootEl.setAttribute('data-width-tier', 'full');
    rootEl.setAttribute('data-retracted', 'false');
    rootEl.appendChild(nav);
    rootEl.appendChild(retractHandle);
    return rootEl;
  }

  function getOrCreateMorphState(root) {
    let st = INSTANCE_MAP.get(root);
    if (!st) {
      st = {
        root,
        callbacks: {},
        initialized: false,
        layoutMode: 'submenu',
        labelSize: 'sm',
        speedMult: 1,
        reducedMotion: false,
        openGroupId: null,
        collapseTimer: null,
        activeTools: {
          'ttft-group': 'ttft',
          'stats-group': 'stats-bars'
        },
        cleanupFns: [],
        ttftRunning: false,
        ttftElapsed: null,
        ttftTurns: 0,
        lastTtftSec: -1,
        needleAngle: NEEDLE_MIN_DEG,
        tokUnit: 'tok/s',
        tokMax: 145
      };
      INSTANCE_MAP.set(root, st);
    }
    return st;
  }

  function clearPendingCollapseTimer(st) {
    if (st && st.collapseTimer !== null) {
      try { clearTimeout(st.collapseTimer); } catch { }
      st.collapseTimer = null;
    }
  }

  function setGroupOpenState(st, groupId, isOpen, emitCallback) {
    const groups = Array.from(st.root.querySelectorAll('.ag-v2-mtb-group') || []);
    let changed = false;

    for (const groupEl of groups) {
      const id = groupEl.getAttribute('data-group');
      if (st.layoutMode === 'flat' && groupEl.classList?.contains?.('ag-v2-mtb-group--flat-able')) {
        groupEl.setAttribute('data-open', 'false');
        groupEl.setAttribute('aria-expanded', 'false');
        continue;
      }
      const shouldOpen = Boolean(isOpen && id === groupId);
      const wasOpen = groupEl.getAttribute('data-open') === 'true';
      if (wasOpen !== shouldOpen) {
        groupEl.setAttribute('data-open', shouldOpen ? 'true' : 'false');
        groupEl.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        const closeBtn = groupEl.querySelector('.ag-v2-mtb-close-btn');
        if (closeBtn) {
          closeBtn.setAttribute('tabindex', shouldOpen ? '0' : '-1');
        }
        changed = true;
        if (emitCallback && typeof st.callbacks.onGroupToggle === 'function') {
          st.callbacks.onGroupToggle(id, shouldOpen);
        }
      }
    }

    st.openGroupId = isOpen ? groupId : null;
    return changed;
  }

  function setGroupActiveTool(st, groupEl, toolId) {
    if (!groupEl) return -1;
    const groupId = groupEl.getAttribute('data-group');
    const items = Array.from(groupEl.querySelectorAll('.ag-v2-mtb-sub-btn') || []);
    let matchedIdx = -1;
    items.forEach((btn, idx) => {
      if (btn.getAttribute('data-tool') === toolId) matchedIdx = idx;
    });
    if (matchedIdx < 0) return -1;

    items.forEach((btn, idx) => {
      const active = idx === matchedIdx;
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    groupEl.setAttribute('data-active-tool', toolId);
    groupEl.style?.setProperty?.('--ag-mtb-active-idx', String(matchedIdx));
    if (groupId) st.activeTools[groupId] = toolId;
    return matchedIdx;
  }

  /**
   * 1) initMorphToolbarUI(root, callbacks) — 复用原参考签名与 Shadow DOM 安全事件委托，
   *    额外加固快速切换另一组时取消未完成收起定时器防抖动吞点击、以及额度圆环 Issue #107 右键/Alt 左键交互。
   */
  function initMorphToolbarUI(root, callbacks = {}) {
    const st = getOrCreateMorphState(root);
    st.callbacks = callbacks || {};

    if (st.initialized) {
      return buildMorphControllerHandle(st);
    }
    st.initialized = true;

    const shell = byId(root, 'ag-v2-mtb-shell');
    if (!shell) {
      return buildMorphControllerHandle(st);
    }

    const handleShellClick = (evt) => {
      const target = evt?.target && typeof evt.target.closest === 'function' ? evt.target : null;
      if (!target) return;

      // 1) 展开组内关闭按钮 (X)
      const closeBtn = target.closest('[data-group-close]');
      if (closeBtn) {
        evt.stopPropagation?.();
        clearPendingCollapseTimer(st);
        const groupId = closeBtn.getAttribute('data-group-close');
        setGroupOpenState(st, groupId, false, true);
        return;
      }

      // 2) 独立槽位（左侧两环、合并入口与右侧 CLI）
      const slotBtn = target.closest('[data-slot]');
      if (slotBtn) {
        evt.stopPropagation?.();
        clearPendingCollapseTimer(st);
        const slotId = slotBtn.getAttribute('data-slot');
        if (slotId === 'merged-tools') {
          const nextExpanded = st.root.getAttribute('data-merged-expanded') !== 'true';
          st.root.setAttribute('data-merged-expanded', nextExpanded ? 'true' : 'false');
          slotBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
          if (!nextExpanded && st.openGroupId) setGroupOpenState(st, st.openGroupId, false, true);
          if (typeof st.callbacks.onSlotClick === 'function') st.callbacks.onSlotClick(slotId, { layoutMode: st.layoutMode, expanded: nextExpanded, event: evt });
          return;
        }
        if (st.openGroupId) {
          setGroupOpenState(st, st.openGroupId, false, true);
        }
        if (typeof st.callbacks.onSlotClick === 'function') {
          st.callbacks.onSlotClick(slotId, {
            layoutMode: st.layoutMode,
            altKey: Boolean(evt.altKey),
            detail: evt.detail,
            event: evt
          });
        }
        return;
      }

      // 3) 变形工具组内子项
      const subBtn = target.closest('[data-group-item]');
      if (subBtn) {
        evt.stopPropagation?.();
        const groupId = subBtn.getAttribute('data-group-item');
        const toolId = subBtn.getAttribute('data-tool');
        const groupEl = subBtn.closest('.ag-v2-mtb-group');
        if (!groupEl) return;

        if (st.layoutMode === 'flat' && groupEl.classList?.contains?.('ag-v2-mtb-group--flat-able')) {
          clearPendingCollapseTimer(st);
          if (st.openGroupId) setGroupOpenState(st, st.openGroupId, false, true);
          if (typeof st.callbacks.onSlotClick === 'function') {
            st.callbacks.onSlotClick(toolId, { groupId, layoutMode: 'flat', event: evt });
          }
          return;
        }

        const isOpen = groupEl.getAttribute('data-open') === 'true';

        // 折叠态点击代表项 -> 互斥展开本组；槽位 4 单击同时支持直达个人主页
        if (!isOpen) {
          clearPendingCollapseTimer(st);
          setGroupOpenState(st, groupId, true, true);
          if (groupId === 'stats-group' && typeof st.callbacks.onStatsPrimaryClick === 'function') {
            st.callbacks.onStatsPrimaryClick({ groupId, toolId, event: evt });
          }
          return;
        }

        // 展开态点选子项 -> 滑动蓝底高亮至新项、触发真实回调、自动收起并保留该代表项
        const prevTool = groupEl.getAttribute('data-active-tool');
        setGroupActiveTool(st, groupEl, toolId);

        if (typeof st.callbacks.onSubToolSelect === 'function') {
          st.callbacks.onSubToolSelect(groupId, toolId, {
            previousTool: prevTool,
            layoutMode: st.layoutMode,
            event: evt
          });
        }

        clearPendingCollapseTimer(st);
        const rawDelay = st.reducedMotion ? 0 : Math.round((prevTool === toolId ? 85 : 165) * st.speedMult);
        if (rawDelay <= 0) {
          setGroupOpenState(st, groupId, false, true);
        } else {
          st.collapseTimer = setTimeout(() => {
            st.collapseTimer = null;
            if (st.openGroupId === groupId) {
              setGroupOpenState(st, groupId, false, true);
            }
          }, rawDelay);
        }
      }
    };

    // Issue #107: 仅额度圆环支持右键打开大面板并抑制宿主复制菜单；其余图标右键绝不切换主题
    const handleShellContextMenu = (evt) => {
      const target = evt?.target && typeof evt.target.closest === 'function' ? evt.target : null;
      if (!target) return;
      const quotaSlot = target.closest('#ag-v2-mtb-slot-ring-primary, [data-slot="ring-primary"], [data-slot="quota"]');
      if (!quotaSlot) return;
      evt.preventDefault?.();
      evt.stopPropagation?.();
      evt.stopImmediatePropagation?.();
      clearPendingCollapseTimer(st);
      if (st.openGroupId) {
        setGroupOpenState(st, st.openGroupId, false, true);
      }
      if (typeof st.callbacks.onQuotaContextMenu === 'function') {
        st.callbacks.onQuotaContextMenu(evt);
      } else if (typeof st.callbacks.onSlotClick === 'function') {
        st.callbacks.onSlotClick('ring-primary-contextmenu', { layoutMode: st.layoutMode, rightClick: true, event: evt });
      }
    };

    const handlePointerOver = (evt) => {
      if (typeof st.callbacks.onSlotHover !== 'function') return;
      const btn = evt?.target && typeof evt.target.closest === 'function'
        ? evt.target.closest('[data-slot], [data-tool]')
        : null;
      if (!btn) return;
      const id = btn.getAttribute('data-slot') || btn.getAttribute('data-tool');
      st.callbacks.onSlotHover(id, { groupId: btn.getAttribute('data-group-item') || null });
    };

    const handlePointerLeave = () => {
      if (typeof st.callbacks.onSlotHover === 'function') {
        st.callbacks.onSlotHover(null, { groupId: null });
      }
    };

    const ownerDoc = root.host ? root.host.ownerDocument : (root.ownerDocument || (root.nodeType === 9 ? root : null));

    const retractHandle = byId(root, 'ag-v2-mtb-retract-handle');
    const handleRetractClick = (evt) => {
      evt?.stopPropagation?.();
      if (typeof st.callbacks.onRetractHandleClick === 'function') st.callbacks.onRetractHandleClick(evt);
    };
    if (retractHandle) {
      retractHandle.addEventListener('click', handleRetractClick);
      st.cleanupFns.push(() => retractHandle.removeEventListener('click', handleRetractClick));
    }
    const handleOutsidePointerDown = (evt) => {
      const mergedExpanded = st.root.getAttribute('data-merged-expanded') === 'true';
      if (!st.openGroupId && !mergedExpanded) return;
      const path = typeof evt?.composedPath === 'function' ? evt.composedPath() : [];
      const inside = path.length > 0 ? path.includes(shell) : Boolean(evt?.target && shell.contains?.(evt.target));
      if (!inside) {
        clearPendingCollapseTimer(st);
        if (st.openGroupId) setGroupOpenState(st, st.openGroupId, false, true);
        if (mergedExpanded) {
          st.root.setAttribute('data-merged-expanded', 'false');
          byId(st.root, 'ag-v2-mtb-slot-merged')?.setAttribute('aria-expanded', 'false');
        }
      }
    };
    const handleKeyDown = (evt) => {
      if (evt?.key === 'Escape') {
        if (st.openGroupId) { clearPendingCollapseTimer(st); setGroupOpenState(st, st.openGroupId, false, true); }
        if (st.root.getAttribute('data-merged-expanded') === 'true') {
          st.root.setAttribute('data-merged-expanded', 'false');
          byId(st.root, 'ag-v2-mtb-slot-merged')?.setAttribute('aria-expanded', 'false');
        }
      }
    };
    shell.addEventListener('click', handleShellClick);
    shell.addEventListener('contextmenu', handleShellContextMenu);
    shell.addEventListener('pointerover', handlePointerOver);
    shell.addEventListener('pointerleave', handlePointerLeave);
    st.cleanupFns.push(() => {
      shell.removeEventListener('click', handleShellClick);
      shell.removeEventListener('contextmenu', handleShellContextMenu);
      shell.removeEventListener('pointerover', handlePointerOver);
      shell.removeEventListener('pointerleave', handlePointerLeave);
    });
    if (ownerDoc && typeof ownerDoc.addEventListener === 'function') {
      ownerDoc.addEventListener('pointerdown', handleOutsidePointerDown, true);
      ownerDoc.addEventListener('mousedown', handleOutsidePointerDown, true);
      ownerDoc.addEventListener('click', handleOutsidePointerDown, true);
      ownerDoc.addEventListener('keydown', handleKeyDown);
      st.cleanupFns.push(() => {
        ownerDoc.removeEventListener('pointerdown', handleOutsidePointerDown, true);
        ownerDoc.removeEventListener('mousedown', handleOutsidePointerDown, true);
        ownerDoc.removeEventListener('click', handleOutsidePointerDown, true);
        ownerDoc.removeEventListener('keydown', handleKeyDown);
      });
    }
    const ownerWin = ownerDoc?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (ownerWin && typeof ownerWin.addEventListener === 'function') {
      ownerWin.addEventListener('keydown', handleKeyDown);
      st.cleanupFns.push(() => ownerWin.removeEventListener('keydown', handleKeyDown));
    }

    return buildMorphControllerHandle(st);
  }

  function buildMorphControllerHandle(st) {
    return {
      openGroup(groupId) {
        clearPendingCollapseTimer(st);
        setGroupOpenState(st, groupId, true, true);
      },
      closeAll() {
        clearPendingCollapseTimer(st);
        if (st.openGroupId) {
          setGroupOpenState(st, st.openGroupId, false, true);
        }
      },
      setSpeedMultiplier(mult) {
        const safe = clamp(Number(mult) || 1, 0.25, 5);
        st.speedMult = safe;
        const rootEl = byId(st.root, 'ag-v2-mtb-root');
        if (rootEl) {
          rootEl.style?.setProperty?.('--ag-mtb-speed-mult', String(safe));
          rootEl.setAttribute('data-speed-multiplier', String(safe));
        }
      },
      getState() {
        return {
          layoutMode: st.layoutMode,
          labelSize: st.labelSize,
          speedMultiplier: st.speedMult,
          reducedMotion: st.reducedMotion,
          openGroupId: st.openGroupId,
          hasPendingCollapse: st.collapseTimer !== null,
          activeTools: {
            ttftGroup: st.activeTools['ttft-group'],
            statsGroup: st.activeTools['stats-group']
          },
          ttftElapsed: st.ttftElapsed,
          ttftRunning: st.ttftRunning,
          ttftTurns: st.ttftTurns,
          needleAngle: st.needleAngle
        };
      },
      destroy() {
        clearPendingCollapseTimer(st);
        st.cleanupFns.forEach(fn => { try { fn(); } catch { } });
        st.cleanupFns = [];
        st.initialized = false;
        INSTANCE_MAP.delete(st.root);
      }
    };
  }

  /**
   * 2) renderMorphToolbarUI(root, data) — 声明式原地 DOM 更新（纯真实数据，零演示随机/自增）。
   */
  function renderMorphToolbarUI(root, data) {
    if (!root || !data || typeof data !== 'object') return;
    const st = getOrCreateMorphState(root);
    const rootEl = byId(root, 'ag-v2-mtb-root');
    if (!rootEl) return;

    if (data.layoutMode === 'submenu' || data.layoutMode === 'flat') {
      if (st.layoutMode !== data.layoutMode) {
        st.layoutMode = data.layoutMode;
        rootEl.setAttribute('data-layout', data.layoutMode);
        if (data.layoutMode === 'flat' && st.openGroupId === 'ttft-group') {
          clearPendingCollapseTimer(st);
          setGroupOpenState(st, 'ttft-group', false, false);
        }
      }
    }

    if (data.labelSize === 'xs' || data.labelSize === 'sm' || data.labelSize === 'md') {
      st.labelSize = data.labelSize;
      rootEl.setAttribute('data-label-size', data.labelSize);
    }

    if (typeof data.speedMultiplier === 'number' && Number.isFinite(data.speedMultiplier)) {
      const nextMult = clamp(data.speedMultiplier, 0.25, 5);
      st.speedMult = nextMult;
      rootEl.style?.setProperty?.('--ag-mtb-speed-mult', String(nextMult));
      rootEl.setAttribute('data-speed-multiplier', String(nextMult));
    }

    if (typeof data.reducedMotion === 'boolean') {
      st.reducedMotion = data.reducedMotion;
      rootEl.setAttribute('data-reduced-motion', data.reducedMotion ? 'true' : 'false');
    }

    if (typeof data.compact === 'boolean') {
      rootEl.setAttribute('data-compact', data.compact ? 'true' : 'false');
    }
    if (typeof data.widthTier === 'string' && ['full', 'compact-labels', 'merged', 'minimal'].includes(data.widthTier)) {
      const prevTier = rootEl.getAttribute('data-width-tier');
      rootEl.setAttribute('data-width-tier', data.widthTier);
      if (prevTier !== data.widthTier) {
        rootEl.setAttribute('data-merged-expanded', 'false');
        byId(root, 'ag-v2-mtb-slot-merged')?.setAttribute('aria-expanded', 'false');
        if ((data.widthTier === 'merged' || data.widthTier === 'minimal') && st.openGroupId) {
          setGroupOpenState(st, st.openGroupId, false, false);
        }
      }
    }
    if (typeof data.retracted === 'boolean') {
      rootEl.setAttribute('data-retracted', data.retracted ? 'true' : 'false');
      if (data.retracted && st.openGroupId) { clearPendingCollapseTimer(st); setGroupOpenState(st, st.openGroupId, false, false); }
    }
    const retractHandleEl = byId(root, 'ag-v2-mtb-retract-handle');
    if (retractHandleEl) {
      if (typeof data.showRetractHandle === 'boolean') retractHandleEl.hidden = !data.showRetractHandle;
      const isRet = rootEl.getAttribute('data-retracted') === 'true';
      retractHandleEl.setAttribute('aria-expanded', isRet ? 'false' : 'true');
      if (typeof data.retractHandleLabel === 'string' && data.retractHandleLabel) {
        retractHandleEl.setAttribute('aria-label', data.retractHandleLabel);
        retractHandleEl.title = data.retractHandleLabel;
      }
    }

    // Slot 1: 额度圆环
    if (data.primaryRing && typeof data.primaryRing === 'object') {
      const pct = clamp(Number(data.primaryRing.percent) || 0, 0, 100);
      const arc = byId(root, 'ag-v2-mtb-ring-primary-arc');
      const slot = byId(root, 'ag-v2-mtb-slot-ring-primary');
      const b5El = byId(root, 'ag-v2-mtb-quota-badge-5h');
      const b7El = byId(root, 'ag-v2-mtb-quota-badge-7d');
      if (arc) {
        arc.setAttribute('stroke-dashoffset', (RING_CIRCUMFERENCE * (1 - pct / 100)).toFixed(4));
      }
      if (slot) {
        if (data.primaryRing.status) slot.setAttribute('data-status', String(data.primaryRing.status));
        if (typeof data.primaryRing.activeWindow === 'string') {
          const aw = data.primaryRing.activeWindow;
          slot.setAttribute('data-quota-window', aw);
          if (b5El) b5El.setAttribute('data-active', aw === '5h' || aw === 'both' ? 'true' : 'false');
          if (b7El) b7El.setAttribute('data-active', aw === '7d' || aw === 'weekly' || aw === 'both' ? 'true' : 'false');
        }
        if (typeof data.primaryRing.refreshing === 'boolean') {
          slot.setAttribute('data-refreshing', data.primaryRing.refreshing ? 'true' : 'false');
        }
        if (typeof data.primaryRing.tooltip === 'string') {
          slot.setAttribute('title', data.primaryRing.tooltip);
          slot.setAttribute('aria-label', data.primaryRing.tooltip);
        }
      }
    }

    // Slot 2: 上下文圆环（环内居中显示百分比）
    if (data.secondaryRing && typeof data.secondaryRing === 'object') {
      const pct = clamp(Number(data.secondaryRing.percent) || 0, 0, 100);
      const arc = byId(root, 'ag-v2-mtb-ring-secondary-arc');
      const slot = byId(root, 'ag-v2-mtb-slot-ring-secondary');
      const pctEl = byId(root, 'ag-v2-mtb-context-pct');
      if (arc) {
        arc.setAttribute('stroke-dashoffset', (RING_CIRCUMFERENCE * (1 - pct / 100)).toFixed(4));
      }
      if (pctEl) {
        pctEl.textContent = typeof data.secondaryRing.pctText === 'string'
          ? data.secondaryRing.pctText
          : (data.secondaryRing.hasValue === false ? '--%' : `${Math.round(pct)}%`);
      }
      if (slot) {
        if (data.secondaryRing.status) slot.setAttribute('data-status', String(data.secondaryRing.status));
        if (typeof data.secondaryRing.tooltip === 'string') {
          slot.setAttribute('title', data.secondaryRing.tooltip);
          slot.setAttribute('aria-label', data.secondaryRing.tooltip);
        }
      }
    }

    // Slot 3 Sub-item 0: 首字等待沙漏（真实秒数，仅等待态秒递增时翻转 180°）
    if (data.ttft && typeof data.ttft === 'object') {
      const hgSvg = byId(root, 'ag-v2-mtb-hg-svg');
      const ttftLabel = byId(root, 'ag-v2-mtb-ttft-label');
      const running = Boolean(data.ttft.running);
      st.ttftRunning = running;
      rootEl.setAttribute('data-ttft-running', running ? 'true' : 'false');

      if (typeof data.ttft.displayText === 'string') {
        if (ttftLabel) ttftLabel.textContent = data.ttft.displayText;
      } else {
        const rawSec = data.ttft.elapsedSeconds;
        const hasSec = rawSec != null && Number.isFinite(Number(rawSec)) && Number(rawSec) >= 0;
        if (running && hasSec) {
          const floored = Math.floor(Number(rawSec));
          if (st.lastTtftSec >= 0 && floored > st.lastTtftSec) {
            st.ttftTurns += 1;
          }
          st.lastTtftSec = floored;
          st.ttftElapsed = floored;
          hgSvg?.style?.setProperty?.('--ag-mtb-hg-turns', String(st.ttftTurns));
        } else {
          if (!running) st.lastTtftSec = -1;
          st.ttftElapsed = hasSec ? Math.floor(Number(rawSec)) : null;
        }
        if (ttftLabel) {
          ttftLabel.textContent = hasSec ? formatTtftElapsedSeconds(rawSec) : '--';
        }
      }
    }

    // Slot 3 Sub-item 1: 生成速度仪表盘（真实 tok/s，无演示随机摆动）
    if (data.tokSpeed && typeof data.tokSpeed === 'object') {
      if (typeof data.tokSpeed.max === 'number' && data.tokSpeed.max > 0) {
        st.tokMax = data.tokSpeed.max;
      }
      if (typeof data.tokSpeed.unit === 'string' && data.tokSpeed.unit.trim()) {
        st.tokUnit = data.tokSpeed.unit.trim();
      }
      const needleEl = byId(root, 'ag-v2-mtb-needle');
      const tokLabel = byId(root, 'ag-v2-mtb-tok-label');
      const val = data.tokSpeed.value;
      const hasVal = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
      st.needleAngle = hasVal ? tokRateToNeedleAngle(val, st.tokMax) : NEEDLE_MIN_DEG;
      if (needleEl) {
        needleEl.setAttribute('transform', `rotate(${st.needleAngle} 12 15.2)`);
      }
      if (tokLabel) {
        const numSpan = byId(root, 'ag-v2-mtb-tok-num');
        const unitSpan = byId(root, 'ag-v2-mtb-tok-unit');
        if (numSpan && unitSpan) {
          if (typeof data.tokSpeed.displayText === 'string') {
            numSpan.textContent = data.tokSpeed.displayText;
            unitSpan.textContent = '';
          } else if (hasVal) {
            const n = Number(val);
            numSpan.textContent = n === 0 ? '0' : String(Math.round(n));
            unitSpan.textContent = ` ${st.tokUnit}`;
          } else {
            numSpan.textContent = '--';
            unitSpan.textContent = ` ${st.tokUnit}`;
          }
        } else if (typeof data.tokSpeed.displayText === 'string') {
          tokLabel.textContent = data.tokSpeed.displayText;
        } else if (hasVal) {
          const n = Number(val);
          tokLabel.textContent = `${n === 0 ? '0' : Math.round(n)} ${st.tokUnit}`;
        } else {
          tokLabel.textContent = `-- ${st.tokUnit}`;
        }
      }
    }

    // 显式同步激活子项（未传入时保持用户已选代表项，避免刷新/滚动冲掉选中态）
    if (data.activeTools && typeof data.activeTools === 'object') {
      if (typeof data.activeTools.ttftGroup === 'string') {
        setGroupActiveTool(st, byId(root, 'ag-v2-mtb-group-ttft'), data.activeTools.ttftGroup);
      }
      if (typeof data.activeTools.statsGroup === 'string') {
        setGroupActiveTool(st, byId(root, 'ag-v2-mtb-group-stats'), data.activeTools.statsGroup);
      }
    }

    // Slot 5: CLI 状态与颜色配置（accent / mono / custom）
    if (data.cli && typeof data.cli === 'object') {
      const cliBtn = byId(root, 'ag-v2-mtb-slot-cli');
      if (cliBtn) {
        cliBtn.setAttribute('data-selected', data.cli.active ? 'true' : 'false');
        if (typeof data.cli.colorMode === 'string' && VALID_CLI_COLOR_MODES.includes(data.cli.colorMode)) {
          cliBtn.setAttribute('data-cli-color-mode', data.cli.colorMode);
        }
        if (typeof data.cli.customColor === 'string' && data.cli.customColor.trim()) {
          cliBtn.style?.setProperty?.('--ag-mtb-cli-custom-color', data.cli.customColor.trim());
        } else if (data.cli.customColor === '') {
          cliBtn.style?.removeProperty?.('--ag-mtb-cli-custom-color');
        }
        if (typeof data.cli.tooltip === 'string') {
          cliBtn.setAttribute('title', data.cli.tooltip);
          cliBtn.setAttribute('aria-label', data.cli.tooltip);
        }
      }
    }
  }

  /**
   * 3) 生产级控制器（对接 main.js 挂载、作用域隔离、动作路由与 5 槽位原位折叠渲染）
   */
  function createMorphIndicatorToolbarController(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    let lang = resolveLang(deps.lang);
    let activeScopeKey = String(deps.initialScopeKey || '');
    let persistedActiveTools = {
      ttftGroup: deps.initialActiveTools?.ttftGroup || 'ttft',
      statsGroup: deps.initialActiveTools?.statsGroup || 'stats-bars'
    };
    let statusPinMode = (() => {
      if (VALID_STATUS_PIN_MODES.includes(deps.initialStatusPinMode)) return deps.initialStatusPinMode;
      try {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STATUS_PIN_STORAGE_KEY) : null;
        if (VALID_STATUS_PIN_MODES.includes(saved)) return saved;
      } catch { }
      return 'auto';
    })();
    let activeQuotaWindow = deps.initialQuotaWindow === '7d' || deps.initialQuotaWindow === 'weekly' ? '7d' : '5h';
    let lastQuotaRefreshAtMs = 0;
    let quotaPulseTimer = null;
    const quotaThrottleMs = Number.isFinite(Number(deps.quotaRefreshThrottleMs))
      ? Math.max(0, Number(deps.quotaRefreshThrottleMs))
      : QUOTA_REFRESH_THROTTLE_MS;
    let rootEl = null;
    let uiHandle = null;
    let currentWidthTier = 'full';
    let currentRetracted = false;
    let disposed = false;

    function syncStatusPinDom() {
      if (!rootEl) return;
      const grp = byId(rootEl, 'ag-v2-mtb-group-ttft');
      if (grp) grp.setAttribute('data-status-pin-mode', statusPinMode);
      const bTtft = byId(rootEl, 'ag-v2-mtb-tool-ttft');
      const bSpeed = byId(rootEl, 'ag-v2-mtb-tool-tok-speed');
      if (bTtft) bTtft.setAttribute('data-pinned', statusPinMode === 'ttft' ? 'true' : 'false');
      if (bSpeed) bSpeed.setAttribute('data-pinned', statusPinMode === 'tok-speed' ? 'true' : 'false');
    }

    function setStatusPinMode(nextMode, opts = {}) {
      const clean = VALID_STATUS_PIN_MODES.includes(nextMode) ? nextMode : 'auto';
      statusPinMode = clean;
      if (clean === 'ttft' || clean === 'tok-speed') {
        persistedActiveTools.ttftGroup = clean;
        if (rootEl) {
          const st = getOrCreateMorphState(rootEl);
          setGroupActiveTool(st, byId(rootEl, 'ag-v2-mtb-group-ttft'), clean);
        }
      }
      if (opts.persist !== false) {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(STATUS_PIN_STORAGE_KEY, clean);
        } catch { }
      }
      syncStatusPinDom();
      if (opts.emit !== false && typeof deps.onStatusPinChange === 'function') {
        deps.onStatusPinChange(clean);
      }
      return clean;
    }

    function triggerQuotaRefreshPulse() {
      if (!rootEl) return;
      const slot = byId(rootEl, 'ag-v2-mtb-slot-ring-primary');
      if (!slot) return;
      if (quotaPulseTimer) {
        try { clearTimeout(quotaPulseTimer); } catch { }
        quotaPulseTimer = null;
      }
      slot.setAttribute('data-refreshing', 'true');
      quotaPulseTimer = setTimeout(() => {
        quotaPulseTimer = null;
        if (!disposed && rootEl) {
          byId(rootEl, 'ag-v2-mtb-slot-ring-primary')?.setAttribute('data-refreshing', 'false');
        }
      }, 650);
    }

    function ensureStyle(styleRoot) {
      if (!doc) return;
      const target = styleRoot && styleRoot.nodeType === 11 ? styleRoot : doc.head;
      if (!target) return;
      if (target.querySelector?.(`#${MTB_STYLE_ID}`) || doc.getElementById?.(MTB_STYLE_ID)) return;
      const st = doc.createElement('style');
      st.id = MTB_STYLE_ID;
      st.textContent = MTB_PROD_CSS;
      target.appendChild(st);
    }

    function dispatchNormalizedAction(rawAction, meta = {}) {
      const normalized = rawAction === 'account-switch' ? 'account'
        : (rawAction === 'ring-primary' ? 'quota'
          : (rawAction === 'ring-secondary' ? 'context' : rawAction));
      const payload = { ...meta, scopeKey: activeScopeKey, rawAction, normalizedAction: normalized };
      if (typeof deps.onSlotAction === 'function') {
        deps.onSlotAction(rawAction, payload);
      }
      if (typeof deps.onAction === 'function') {
        deps.onAction(normalized, payload);
      }
    }

    function mount(container, styleRoot = null) {
      if (disposed || !doc || !container) return null;
      unmount();
      ensureStyle(styleRoot || (container.getRootNode ? container.getRootNode() : null));
      const copy = getMtbCopy(lang);
      rootEl = buildMorphToolbarDom(doc, copy);
      container.appendChild(rootEl);

      uiHandle = initMorphToolbarUI(rootEl, {
        onSlotClick: (slotId, meta) => {
          if (slotId === 'ring-primary' || slotId === 'quota') {
            if (meta?.altKey) {
              if (typeof deps.onQuotaPanelToggle === 'function') {
                deps.onQuotaPanelToggle({ source: 'alt-click', scopeKey: activeScopeKey, event: meta.event });
              } else {
                dispatchNormalizedAction('quota', { ...meta, openQuotaPanel: true });
              }
              return;
            }
            activeQuotaWindow = activeQuotaWindow === '5h' ? '7d' : '5h';
            const nowMs = Date.now();
            const shouldRefresh = (nowMs - lastQuotaRefreshAtMs) >= quotaThrottleMs;
            if (shouldRefresh) {
              lastQuotaRefreshAtMs = nowMs;
              triggerQuotaRefreshPulse();
            }
            const quotaSlotEl = byId(rootEl, 'ag-v2-mtb-slot-ring-primary');
            if (quotaSlotEl) quotaSlotEl.setAttribute('data-quota-window', activeQuotaWindow);
            const b5El = byId(rootEl, 'ag-v2-mtb-quota-badge-5h');
            const b7El = byId(rootEl, 'ag-v2-mtb-quota-badge-7d');
            if (b5El) b5El.setAttribute('data-active', activeQuotaWindow === '5h' ? 'true' : 'false');
            if (b7El) b7El.setAttribute('data-active', activeQuotaWindow === '7d' ? 'true' : 'false');
            if (typeof deps.onQuotaCycleWindow === 'function') {
              deps.onQuotaCycleWindow({
                source: 'left-click',
                nextWindow: activeQuotaWindow,
                shouldRefresh,
                throttled: !shouldRefresh,
                scopeKey: activeScopeKey,
                event: meta?.event
              });
              return;
            }
            dispatchNormalizedAction('quota', { ...meta, cycleQuotaWindow: true, nextWindow: activeQuotaWindow, shouldRefresh });
            return;
          }
          if (slotId === 'ring-secondary') {
            dispatchNormalizedAction('context', meta);
            return;
          }
          dispatchNormalizedAction(slotId, meta);
        },
        onQuotaContextMenu: (evt) => {
          if (typeof deps.onQuotaPanelToggle === 'function') {
            deps.onQuotaPanelToggle({ source: 'contextmenu', scopeKey: activeScopeKey, event: evt });
          } else {
            dispatchNormalizedAction('quota', { source: 'contextmenu', openQuotaPanel: true, event: evt });
          }
        },
        onSubToolSelect: (groupId, toolId, meta) => {
          if (groupId === 'ttft-group') {
            persistedActiveTools.ttftGroup = toolId;
            if (toolId === 'ttft' || toolId === 'tok-speed') {
              const nextPin = statusPinMode === toolId ? 'auto' : toolId;
              setStatusPinMode(nextPin, { persist: true, emit: true });
            }
          }
          if (groupId === 'stats-group') persistedActiveTools.statsGroup = toolId;
          if (typeof deps.onSubToolSelect === 'function') {
            deps.onSubToolSelect(groupId, toolId, { ...meta, statusPinMode, scopeKey: activeScopeKey });
          }
          dispatchNormalizedAction(toolId, { ...meta, groupId, statusPinMode });
        },
        onStatsPrimaryClick: (meta) => {
          if (typeof deps.onStatsPrimaryClick === 'function') deps.onStatsPrimaryClick({ ...meta, scopeKey: activeScopeKey });
        },
        onRetractHandleClick: (evt) => {
          if (typeof deps.onRetractHandleClick === 'function') deps.onRetractHandleClick({ retracted: currentRetracted, event: evt });
          else { currentRetracted = !currentRetracted; if (rootEl) renderMorphToolbarUI(rootEl, { retracted: currentRetracted }); }
        },
        onGroupToggle: (groupId, isOpen) => {
          if (groupId === 'stats-group' && typeof deps.onStatsGroupToggle === 'function') deps.onStatsGroupToggle(isOpen);
          if (typeof deps.onGroupToggle === 'function') deps.onGroupToggle(groupId, isOpen);
        }
      });

      // 恢复持久化的工具组代表项与锁定状态（切换辅助面板/重挂后保持选中态）
      if (statusPinMode === 'ttft' || statusPinMode === 'tok-speed') {
        persistedActiveTools.ttftGroup = statusPinMode;
      }
      renderMorphToolbarUI(rootEl, {
        layoutMode: 'submenu',
        labelSize: deps.labelSize || 'sm',
        speedMultiplier: 1,
        primaryRing: { activeWindow: activeQuotaWindow },
        activeTools: { ...persistedActiveTools }
      });
      syncStatusPinDom();

      return rootEl;
    }

    function setActiveScope(nextScopeKey) {
      const clean = String(nextScopeKey || '');
      if (clean !== activeScopeKey) {
        activeScopeKey = clean;
        if (rootEl) {
          const st = getOrCreateMorphState(rootEl);
          st.lastTtftSec = -1;
          st.ttftTurns = 0;
        }
      }
    }

    /**
     * 按真实生产快照原地更新工具栏；严格按 scopeKey 隔离防快切旧回包覆盖；
     * auxViewerVisible=false 时立即隐退并关闭展开组，绝不遮压宿主按钮。
     */
    function render(snapshot = {}) {
      if (disposed || !rootEl) return { applied: false, reason: 'unmounted' };
      const incomingScope = snapshot.scopeKey != null ? String(snapshot.scopeKey) : activeScopeKey;
      if (activeScopeKey && incomingScope && incomingScope !== activeScopeKey) {
        return { applied: false, reason: 'stale-scope', activeScopeKey, incomingScope };
      }
      if (snapshot.lang) lang = resolveLang(snapshot.lang);
      const copy = getMtbCopy(lang);
      const visible = snapshot.auxViewerVisible !== false;
      rootEl.hidden = !visible;
      if (!visible) {
        uiHandle?.closeAll?.();
        return { applied: true, visible: false };
      }

      // 1) 额度圆环（5H / 7D 真实百分比、当前激活窗口标识与状态色）
      if (snapshot.quotaWindowMode === '5h') activeQuotaWindow = '5h';
      else if (snapshot.quotaWindowMode === 'weekly' || snapshot.quotaWindowMode === '7d') activeQuotaWindow = '7d';
      const resolvedWindowAttr = snapshot.quotaWindowMode === 'both' ? 'both' : activeQuotaWindow;
      const q5 = snapshot.quota5h || null;
      const q7 = snapshot.quota7d || null;
      const q5Txt = q5?.status === 'no_permission' ? copy.noPermShort
        : (q5?.status === 'stale' ? copy.staleShort
          : (q5?.remainingFraction != null ? formatQuotaPct(q5.remainingFraction) : copy.unknownShort));
      const q7Txt = q7?.status === 'no_permission' ? copy.noPermShort
        : (q7?.status === 'stale' ? copy.staleShort
          : (q7?.remainingFraction != null ? formatQuotaPct(q7.remainingFraction) : copy.unknownShort));
      const primaryFrac = activeQuotaWindow === '7d'
        ? (q7?.remainingFraction != null ? Number(q7.remainingFraction) : (q5?.remainingFraction != null ? Number(q5.remainingFraction) : null))
        : (q5?.remainingFraction != null ? Number(q5.remainingFraction) : (q7?.remainingFraction != null ? Number(q7.remainingFraction) : null));
      const primaryPct = primaryFrac != null && Number.isFinite(primaryFrac) ? clamp(primaryFrac * 100, 0, 100) : 0;
      const primaryStatus = q5?.status === 'no_permission' || q7?.status === 'no_permission'
        ? 'accent'
        : (primaryFrac != null && primaryFrac <= 0.15 ? 'danger' : (primaryFrac != null && primaryFrac <= 0.65 ? 'warn' : 'normal'));
      const quotaSummaryText = `5H ${q5Txt} · 7D ${q7Txt}`;
      const quotaTooltip = `${snapshot.poolTitle || copy.quotaRingAria} · ${quotaSummaryText} · ${copy.quotaRingHint}`;

      // 2) 上下文圆环（当前绑定会话上下文占用）
      const used = snapshot.contextUsed;
      const budget = snapshot.contextBudget;
      const hasCtx = used != null && Number.isFinite(Number(used)) && Number(used) >= 0 && budget != null && Number(budget) > 0;
      const ctxPct = hasCtx ? clamp((Number(used) / Number(budget)) * 100, 0, 100) : null;
      const ctxStatus = ctxPct != null && ctxPct >= 85 ? 'danger' : (ctxPct != null && ctxPct >= 65 ? 'warn' : 'normal');
      const ctxSummaryText = ctxPct != null ? `${Math.round(ctxPct)}%` : '--%';
      const ctxTooltip = hasCtx ? `${copy.contextRingAria} · ${formatCompactTok(used)} / ${formatCompactTok(budget)} · ${ctxSummaryText}` : `${copy.contextRingAria} · ${copy.unknownShort}`;

      // 3) 缓存命中率摘要（保留返回字段兼容调用方）
      const hasCache = snapshot.cacheHitPct != null && Number.isFinite(Number(snapshot.cacheHitPct)) && Number(snapshot.cacheHitPct) >= 0;
      const cacheSummaryText = hasCache
        ? `${copy.cacheLabel} ${Number(snapshot.cacheHitPct) === 0 ? '0%' : `${Number(snapshot.cacheHitPct).toFixed(1).replace(/\.0$/, '')}%`}`
        : `${copy.cacheLabel} --`;

      // 4) 首字等待沙漏
      const phase = String(snapshot.phase || 'idle');
      const isWaiting = phase === 'waiting';
      const ttftData = phase === 'queued'
        ? { running: false, displayText: copy.queuedShort }
        : { running: isWaiting, elapsedSeconds: snapshot.ttftElapsedSec };

      // 5) 生成速度仪表盘
      const tokSpeedData = snapshot.speedUnavailableReason === 'remote'
        ? { value: null, max: snapshot.maxTps || 145, displayText: copy.remoteShort }
        : { value: snapshot.tps, max: snapshot.maxTps || 145, unit: 'tok/s' };

      const compact = Number.isFinite(Number(snapshot.containerWidth)) && Number(snapshot.containerWidth) > 0
        ? Number(snapshot.containerWidth) < 330
        : undefined;
      const widthTier = typeof snapshot.widthTier === 'string'
        ? snapshot.widthTier
        : (snapshot.mainSessionWidthPx != null ? resolveCapsuleWidthTier(snapshot.mainSessionWidthPx) : currentWidthTier);
      currentWidthTier = widthTier;
      if (typeof snapshot.retracted === 'boolean') currentRetracted = snapshot.retracted;
      const showRetractHandle = typeof snapshot.showRetractHandle === 'boolean' ? snapshot.showRetractHandle : currentRetracted;
      const retractHandleLabel = currentRetracted ? copy.retractHandleExpandAria : copy.retractHandleCollapseAria;
      byId(rootEl, 'ag-v2-mtb-tool-stats-bars')?.setAttribute('aria-label', copy.statsBarsAria);
      byId(rootEl, 'ag-v2-mtb-tool-stats-bars')?.setAttribute('title', copy.statsBarsAria);
      byId(rootEl, 'ag-v2-mtb-tool-stats-trend')?.setAttribute('aria-label', copy.statsTrendAria);
      byId(rootEl, 'ag-v2-mtb-tool-stats-trend')?.setAttribute('title', copy.statsTrendAria);
      byId(rootEl, 'ag-v2-mtb-tool-stats-donut')?.setAttribute('aria-label', copy.statsDonutAria);
      byId(rootEl, 'ag-v2-mtb-tool-stats-donut')?.setAttribute('title', copy.statsDonutAria);
      byId(rootEl, 'ag-v2-mtb-tool-account-switch')?.setAttribute('aria-label', copy.accountAria);
      byId(rootEl, 'ag-v2-mtb-tool-account-switch')?.setAttribute('title', copy.accountAria);
      byId(rootEl, 'ag-v2-mtb-slot-merged')?.setAttribute('aria-label', copy.mergedToolsAria);
      byId(rootEl, 'ag-v2-mtb-slot-merged')?.setAttribute('title', copy.mergedToolsAria);

      // 6) 槽位 3 智能自动切换（等待首字 -> 沙漏；流式输出 -> tok/s）与手动锁定协调
      let resolvedActiveTools = snapshot.activeTools ? { ...snapshot.activeTools } : undefined;
      if (!resolvedActiveTools?.ttftGroup) {
        if (statusPinMode === 'ttft' || statusPinMode === 'tok-speed') {
          resolvedActiveTools = { ...(resolvedActiveTools || {}), ttftGroup: statusPinMode };
        } else if (statusPinMode === 'auto') {
          if (phase === 'waiting' || phase === 'queued') {
            persistedActiveTools.ttftGroup = 'ttft';
            resolvedActiveTools = { ...(resolvedActiveTools || {}), ttftGroup: 'ttft' };
          } else if (phase === 'streaming' || (snapshot.tps != null && Number.isFinite(Number(snapshot.tps)) && Number(snapshot.tps) > 0 && phase !== 'waiting' && phase !== 'queued')) {
            persistedActiveTools.ttftGroup = 'tok-speed';
            resolvedActiveTools = { ...(resolvedActiveTools || {}), ttftGroup: 'tok-speed' };
          }
        }
      }

      renderMorphToolbarUI(rootEl, {
        layoutMode: snapshot.layoutMode === 'flat' ? 'flat' : 'submenu',
        labelSize: snapshot.labelSize || undefined,
        speedMultiplier: typeof snapshot.speedMultiplier === 'number' ? snapshot.speedMultiplier : 1,
        reducedMotion: typeof snapshot.reducedMotion === 'boolean' ? snapshot.reducedMotion : undefined,
        compact,
        widthTier,
        retracted: currentRetracted,
        showRetractHandle,
        retractHandleLabel,
        primaryRing: { percent: primaryPct, status: primaryStatus, activeWindow: resolvedWindowAttr, tooltip: quotaTooltip },
        secondaryRing: { percent: ctxPct || 0, hasValue: hasCtx, pctText: ctxSummaryText, status: ctxStatus, tooltip: ctxTooltip },
        ttft: ttftData,
        tokSpeed: tokSpeedData,
        activeTools: resolvedActiveTools,
        cli: {
          active: Boolean(snapshot.cliActive),
          colorMode: snapshot.cliColorMode,
          customColor: snapshot.cliCustomColor,
          tooltip: copy.cliAria
        }
      });
      syncStatusPinDom();

      const uiState = uiHandle?.getState?.() || {};
      const ttftLabel = byId(rootEl, 'ag-v2-mtb-ttft-label');
      const tokLabel = byId(rootEl, 'ag-v2-mtb-tok-label');

      return {
        applied: true,
        visible: true,
        scopeKey: activeScopeKey,
        layoutMode: uiState.layoutMode || 'submenu',
        openGroupId: uiState.openGroupId || null,
        activeTools: uiState.activeTools || { ...persistedActiveTools },
        needleAngle: uiState.needleAngle ?? NEEDLE_MIN_DEG,
        ttftText: ttftLabel?.textContent || '',
        quotaText: quotaSummaryText,
        contextText: ctxSummaryText,
        cacheText: cacheSummaryText,
        speedText: tokLabel?.textContent || ''
      };
    }

    function unmount() {
      if (quotaPulseTimer) {
        try { clearTimeout(quotaPulseTimer); } catch { }
        quotaPulseTimer = null;
      }
      if (uiHandle) {
        try { uiHandle.destroy(); } catch { }
        uiHandle = null;
      }
      if (rootEl) {
        try { rootEl.remove?.(); } catch { }
      }
      rootEl = null;
    }

    function destroy() {
      disposed = true;
      unmount();
    }

    return {
      mount,
      render,
      setActiveScope,
      setStatusPinMode,
      openGroup: (groupId) => uiHandle?.openGroup?.(groupId),
      closeAll: () => uiHandle?.closeAll?.(),
      getState: () => {
        const u = uiHandle?.getState?.() || {};
        return {
          layoutMode: u.layoutMode || 'submenu',
          speedMultiplier: u.speedMultiplier ?? 1,
          labelSize: u.labelSize || 'sm',
          activeScopeKey,
          activeQuotaWindow,
          statusPinMode,
          widthTier: currentWidthTier,
          retracted: currentRetracted,
          openGroupId: u.openGroupId || null,
          statsOpen: u.openGroupId === 'stats-group',
          statusOpen: u.openGroupId === 'ttft-group',
          activeTools: u.activeTools || { ...persistedActiveTools },
          ttftTurns: u.ttftTurns ?? 0,
          lastNeedleAngle: u.needleAngle ?? NEEDLE_MIN_DEG
        };
      },
      unmount,
      destroy
    };
  }

  const exported = {
    RING_CIRCUMFERENCE,
    NEEDLE_MIN_DEG,
    NEEDLE_IDLE_DEG,
    NEEDLE_MAX_DEG,
    MTB_STYLE_ID,
    QUOTA_REFRESH_THROTTLE_MS,
    STATUS_PIN_STORAGE_KEY,
    VALID_STATUS_PIN_MODES,
    VALID_CLI_COLOR_MODES,
    MTB_I18N,
    MTB_PROD_CSS,
    getMtbCopy,
    resolveCapsuleWidthTier,
    formatQuotaWindowBadge,
    formatTtftElapsedSeconds,
    tokRateToNeedleAngle,
    buildComposerPermanentFiveMetrics,
    stripComposerQuotaMoreBadge,
    formatTaskQuotaWindowCompact,
    formatTurnFooterCompactLine,
    buildMorphToolbarDom,
    initMorphToolbarUI,
    renderMorphToolbarUI,
    createMorphIndicatorToolbarController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (rootScope && typeof rootScope === 'object') {
    rootScope.AGMorphIndicatorToolbar = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
