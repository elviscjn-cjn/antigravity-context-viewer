(function () {
  const METER_VERSION = '0.8.3';

  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const {
    summarize,
    parseGeneratorCall,
    calculateRequestApiCost,
    normalizeModelId,
    resolveStableModelId,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    convertToCNY,
    resolveEffectivePlanStatus
  } = (globalThis.__AGContextMeterCore || {});
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据（纯净初始状态，启动时由宿主实时扫描本地实际账本注入）
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "",
    firstUseDate: null,
    summary: {
      grandTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      todayTokens: 0,
      monthTokens: 0,
      yearTokens: 0,
      totalSteps: 0,
      totalConversations: 0,
      firstUseDate: null,
      activeDaysCount: 0
    },
    dailyMap: {},
    speedRecords: []
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  shadow.innerHTML = `<style>
    :host{
      position:fixed;top:6px;right:138px;z-index:2147483000;
      font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      -webkit-app-region:no-drag;user-select:none;display:inline-flex;align-items:center;gap:2px;
      height:28px;flex-shrink:0;vertical-align:middle;

      /* 优先复用 Antigravity 0 级宿主主题变量，无变量时回退深色默认值 */
      --ag-toolbar-fg:var(--secondary-foreground,#b8b8c0);
      --ag-toolbar-fg-hover:var(--foreground,#ececef);
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:var(--secondary,rgba(255,255,255,0.08));
      --ag-toolbar-bg-active:var(--secondary,rgba(255,255,255,0.12));
      --ag-toolbar-border-focus:var(--primary,rgba(128,128,128,0.45));
      --ag-divider:var(--border,rgba(255,255,255,0.08));

      /* 圆环与各指标默认主题色 */
      --ag-ring-track-default:rgba(255,255,255,0.20);
      --ag-ring-used-default:#e6e6eb;
      --ag-ring-warn:#f59e0b;
      --ag-ring-danger:#ef4444;

      --ag-context-text-default:#ececef;
      --ag-speed-default:#b8b8c0;
      --ag-token-total-default:#b8b8c0;
      --ag-token-accent-default:#a78bfa;

      /* 0 级主题背景与一级/二级严格统一背景色 */
      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#181818));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(255,255,255,0.12);
      --ag-float-shadow:0 12px 32px rgba(0,0,0,0.52),0 2px 8px rgba(0,0,0,0.32);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(255,255,255,0.11);
      --ag-shadow-panel:0 16px 40px rgba(0,0,0,0.58),0 2px 10px rgba(0,0,0,0.32);
      --ag-text-primary:#ececef;
      --ag-text-secondary:#c8c8d0;
      --ag-text-muted:#8a8a94;
      --ag-border-subtle:rgba(255,255,255,0.08);

      /* 一级面板与二级内部菜单/卡片/抽屉背景严格一致 */
      --ag-bg-card:var(--ag-unified-bg);
      --ag-bg-card-hover:var(--ag-unified-bg);
      --ag-border-card:rgba(255,255,255,0.09);
      --ag-bg-subcard:var(--ag-unified-bg);
      --ag-border-subcard:rgba(255,255,255,0.08);
      --ag-bg-status:var(--ag-unified-bg);
      --ag-text-status:#c8c8d0;

      --ag-btn-bg:var(--ag-unified-bg);
      --ag-btn-hover:rgba(255,255,255,0.08);
      --ag-btn-border:rgba(255,255,255,0.12);
      --ag-btn-border-hover:rgba(255,255,255,0.22);
      --ag-btn-text:#d4d4d8;

      --ag-pill-muted-bg:var(--ag-unified-bg);
      --ag-pill-muted-border:rgba(255,255,255,0.12);
      --ag-pill-muted-text:#9a9aa2;

      --ag-track-bg:rgba(255,255,255,0.12);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-unified-bg);
      --ag-heat-lvl-0:#27272a;
      --ag-heat-lvl-1:#3f1e6b;
      --ag-heat-lvl-2:#652ab7;
      --ag-heat-lvl-3:#9053f8;
      --ag-heat-lvl-4:#c084fc;
      --ag-heat-outline:#ffffff;

      --ag-pop-bg:var(--ag-unified-bg);
      --ag-pop-border:var(--ag-float-border);
      --ag-pop-shadow:var(--ag-float-shadow);
      --ag-pop-text:var(--ag-text-primary);
      --ag-pop-muted:var(--ag-text-secondary);
      --ag-pop-sub:var(--ag-text-muted);

      --ag-scrollbar-thumb:rgba(255,255,255,0.16);
      --ag-scrollbar-hover:rgba(255,255,255,0.28);

      --ag-bg-input:rgba(255,255,255,0.06);
      --ag-select-option-bg:#222226;
      --ag-select-option-fg:#ececef;

      color-scheme:dark;
      color:var(--ag-text-primary);
    }

    /* 融入宿主原生布局容器时参与正常 Flexbox 空间分配 */
    :host([data-dock="flow"]){
      position:relative !important;top:auto !important;right:auto !important;left:auto !important;bottom:auto !important;z-index:20;
      margin-right:4px;
    }

    /* 窗口非活动状态适度降低顶栏对比度 */
    :host([data-window-active="false"]) .ag-unit{
      opacity:0.72;
    }
    :host([data-window-active="false"]) .ag-unit:hover,
    :host([data-window-active="false"]) .ag-unit:focus-visible{
      opacity:1;
    }

    /* 浅色模式规范（与 0 级浅色主题协调，且一级/二级背景严格统一） */
    :host([data-theme="light"]),
    :host([data-panel-tone="light"]){
      --ag-toolbar-fg:#52525b;
      --ag-toolbar-fg-hover:#18181b;
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:rgba(0,0,0,0.06);
      --ag-toolbar-bg-active:rgba(0,0,0,0.10);
      --ag-toolbar-border-focus:rgba(0,0,0,0.35);
      --ag-divider:rgba(0,0,0,0.08);

      --ag-ring-track-default:rgba(0,0,0,0.18);
      --ag-ring-used-default:#18181b;
      --ag-ring-warn:#d97706;
      --ag-ring-danger:#dc2626;

      --ag-context-text-default:#18181b;
      --ag-speed-default:#52525b;
      --ag-token-total-default:#52525b;
      --ag-token-accent-default:#7c3aed;

      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#ffffff));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(0,0,0,0.12);
      --ag-float-shadow:0 8px 24px rgba(0,0,0,0.12),0 2px 6px rgba(0,0,0,0.06);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(0,0,0,0.12);
      --ag-shadow-panel:0 14px 36px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.06);
      --ag-text-primary:#18181b;
      --ag-text-secondary:#3f3f46;
      --ag-text-muted:#71717a;
      --ag-border-subtle:rgba(0,0,0,0.08);

      --ag-bg-card:var(--ag-unified-bg);
      --ag-bg-card-hover:var(--ag-unified-bg);
      --ag-border-card:rgba(0,0,0,0.10);
      --ag-bg-subcard:var(--ag-unified-bg);
      --ag-border-subcard:rgba(0,0,0,0.09);
      --ag-bg-status:var(--ag-unified-bg);
      --ag-text-status:#27272a;

      --ag-btn-bg:var(--ag-unified-bg);
      --ag-btn-hover:rgba(0,0,0,0.05);
      --ag-btn-border:rgba(0,0,0,0.12);
      --ag-btn-border-hover:rgba(0,0,0,0.22);
      --ag-btn-text:#18181b;

      --ag-pill-muted-bg:var(--ag-unified-bg);
      --ag-pill-muted-border:rgba(0,0,0,0.12);
      --ag-pill-muted-text:#52525b;

      --ag-track-bg:rgba(0,0,0,0.08);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-unified-bg);
      --ag-heat-lvl-0:#e4e4e7;
      --ag-heat-lvl-1:#e9d5ff;
      --ag-heat-lvl-2:#c084fc;
      --ag-heat-lvl-3:#9333ea;
      --ag-heat-lvl-4:#6b21a8;
      --ag-heat-outline:#18181b;

      --ag-scrollbar-thumb:rgba(0,0,0,0.16);
      --ag-scrollbar-hover:rgba(0,0,0,0.28);

      --ag-bg-input:rgba(0,0,0,0.04);
      --ag-select-option-bg:#ffffff;
      --ag-select-option-fg:#18181b;

      color-scheme:light;
      color:var(--ag-text-primary);
    }

    *{box-sizing:border-box}
    .sr-only{
      position:absolute!important;width:1px!important;height:1px!important;
      padding:0!important;margin:-1px!important;overflow:hidden!important;
      clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
    }
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb);border-radius:3px}
    ::-webkit-scrollbar-thumb:hover{background:var(--ag-scrollbar-hover)}
    button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}
    button:focus-visible{outline:1.5px solid var(--ag-toolbar-border-focus);outline-offset:1px}

    /* Basic Unit: 原生工具栏级别精密小单元 */
    .ag-unit{
      display:inline-flex;align-items:center;justify-content:center;
      height:28px;padding:0 7px;border-radius:8px;border:1px solid transparent;
      background:var(--ag-toolbar-bg);color:var(--ag-toolbar-fg);
      white-space:nowrap;font-variant-numeric:tabular-nums;
      font-size:12px;font-weight:500;letter-spacing:-0.01em;gap:4px;
      transition:background-color .14s ease,color .14s ease,border-color .14s ease,opacity .14s ease,transform .1s cubic-bezier(0.16,1,0.3,1);
      flex-shrink:0;
    }
    .ag-unit:hover,.ag-unit:focus-visible,.ag-unit[aria-expanded="true"]{
      background:var(--ag-toolbar-bg-hover);
      color:var(--ag-toolbar-fg-hover);
    }
    .ag-unit:active{
      background:var(--ag-toolbar-bg-active);
      transform:scale(0.96);
    }

    /* 单元 1: 上下文小圆环按钮（按内容自适应，圆环+百分比共存） */
    #badge.ag-unit-ring{
      width:auto!important;
      min-width:28px;
      height:28px;
      padding:0 6px 0 4px;
      gap:3px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
    }
    :host([data-layout="ring-only"]) #badge.ag-unit-ring{
      width:28px!important;
      min-width:28px!important;
      padding:0!important;
      gap:0!important;
    }
    .ring-svg{
      width:18px;height:18px;display:block;flex-shrink:0;overflow:visible;
    }
    .ring-track{
      stroke:var(--ag-custom-ring-track,var(--ag-ring-track-default));
    }
    .ring-fill{
      stroke:var(--ag-custom-ring-used,var(--ag-ring-used-default));
      transition:stroke-dasharray .22s ease,opacity .15s ease;
    }
    :host([data-occupancy="warn"]) .ring-fill{
      stroke:var(--ag-ring-warn);
    }
    :host([data-occupancy="danger"]) .ring-fill{
      stroke:var(--ag-ring-danger);
    }

    /* 单元 2: 输出速度 */
    #badge-speed{
      color:var(--ag-custom-speed,var(--ag-speed-default));
      min-width:54px;
      justify-content:flex-start;
    }
    #badge-speed:hover,#badge-speed:focus-visible,#badge-speed[aria-expanded="true"]{
      color:var(--ag-custom-speed,var(--ag-toolbar-fg-hover));
    }
    .speed-icon{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.88;font-size:11.5px;line-height:1;
    }
    #speed-amount{
      font-variant-numeric:tabular-nums;
      display:inline-block;
      min-width:32px;
      text-align:left;
      color:inherit;
    }

    /* 单元 3: 累计 Token 用量 */
    #badge-tokens{
      color:var(--ag-custom-token-total,var(--ag-token-total-default));
      min-width:68px;
      justify-content:flex-start;
    }
    #badge-tokens:hover,#badge-tokens:focus-visible,#badge-tokens[aria-expanded="true"]{
      color:var(--ag-custom-token-total,var(--ag-toolbar-fg-hover));
    }
    .token-fire-dot{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      flex-shrink:0;opacity:0.95;
    }
    .badge-pct-val{
      font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;
      color:var(--ag-custom-context-text,var(--ag-context-text-default));
      padding-left:2px;
    }
    :host([data-layout="ring-only"]) .badge-pct-val{
      display:none!important;
    }
    #token-amount{
      font-variant-numeric:tabular-nums;
      display:inline-block;
      min-width:38px;
      text-align:left;
      color:inherit;
    }

    /* 下拉选择框与选项在深浅主题下的高对比度保底 */
    select {
      background-color: var(--ag-bg-input, rgba(255,255,255,0.08)) !important;
      color: var(--ag-text-primary, #ececef) !important;
      border: 1px solid var(--ag-border-subcard, rgba(255,255,255,0.15)) !important;
      border-radius: 4px;
      outline: none;
      color-scheme: dark;
    }
    :host([data-theme="light"]) select,
    :host([data-panel-tone="light"]) select {
      background-color: var(--ag-bg-input, #f4f4f5) !important;
      color: var(--ag-text-primary, #18181b) !important;
      border-color: var(--ag-border-subcard, rgba(0,0,0,0.15)) !important;
      color-scheme: light;
    }
    select option {
      background-color: var(--ag-select-option-bg, #27272a) !important;
      color: var(--ag-select-option-fg, #f4f4f5) !important;
    }
    :host([data-theme="light"]) select option,
    :host([data-panel-tone="light"]) select option {
      background-color: #ffffff !important;
      color: #18181b !important;
    }

    /* 单元 4: 一键启动 CLI 按钮 */
    #badge-cli{
      color:var(--ag-toolbar-fg);
      min-width:44px;
      padding:0 6px;
      gap:3px;
      justify-content:center;
      transition: transform 0.08s cubic-bezier(0.2, 0, 0, 1), background-color 0.12s ease, opacity 0.12s ease;
      user-select: none;
      -webkit-user-select: none;
    }
    #badge-cli:hover,#badge-cli:focus-visible{
      color:var(--ag-toolbar-fg-hover);
    }
    #badge-cli:active,
    #badge-cli[data-pressed="true"]{
      transform: scale(0.92);
      background: rgba(127, 127, 127, 0.16);
    }
    #badge-cli[data-busy="true"]{
      cursor: wait;
      pointer-events: none;
    }
    #badge-cli[data-busy="true"] .cli-icon{
      animation: ag-cli-pulse 0.8s ease-in-out infinite alternate;
    }
    @keyframes ag-cli-pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      100% { transform: scale(1.15); opacity: 1; }
    }
    .cli-icon{
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
      font-size:10.5px;font-weight:700;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      line-height:1;
      display: inline-block;
      transition: transform 0.15s ease;
    }

    /* CLI 启动状态提示浮层 */
    #cli-launch-toast{
      position:fixed;top:38px;right:140px;z-index:2147483650;
      max-width:360px;padding:7px 11px;border-radius:8px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);font-size:11.5px;line-height:1.4;
      pointer-events:auto;transition:opacity .15s ease,transform .15s ease;
    }
    #cli-launch-toast[hidden]{display:none!important}
    #cli-launch-toast[data-tone="error"]{
      border-color:rgba(239,68,68,0.45);
      color:#f87171;
    }
    :host([data-theme="light"]) #cli-launch-toast[data-tone="error"]{
      color:#dc2626;
    }

    /* 单元 5: 窄屏溢出菜单入口 */
    #badge-overflow{
      width:28px;height:28px;padding:0;display:none;
    }
    .overflow-icon{
      width:16px;height:16px;display:block;
    }

    /* 渐进式宽度收缩四阶段: wide -> compact -> minimal -> ring-only */
    :host([data-layout="compact"]){
      gap:1px;
    }
    :host([data-layout="compact"]) #badge-speed,
    :host([data-layout="compact"]) #badge-tokens,
    :host([data-layout="compact"]) #badge-cli{
      padding:0 5px;font-size:11.5px;gap:3px;
    }
    :host([data-layout="minimal"]) #badge-speed,
    :host([data-layout="minimal"]) #badge-tokens,
    :host([data-layout="minimal"]) #badge-cli{
      display:none!important;
    }
    :host([data-layout="minimal"]) #badge-overflow{
      display:inline-flex!important;
    }
    :host([data-layout="ring-only"]) #badge-speed,
    :host([data-layout="ring-only"]) #badge-tokens,
    :host([data-layout="ring-only"]) #badge-cli,
    :host([data-layout="ring-only"]) #badge-overflow{
      display:none!important;
    }

    /* 上下文悬停信息气泡（严格还原参考图三层结构） */
    #context-tooltip{
      position:fixed;top:0;left:0;z-index:2147483600;
      min-width:166px;max-width:268px;padding:9px 13px;
      border-radius:10px;border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      pointer-events:none;opacity:0;visibility:hidden;
      transform:translateY(2px);
      transition:opacity .12s ease,transform .12s ease,visibility .12s ease;
      font-variant-numeric:tabular-nums;
    }
    #context-tooltip[data-visible="true"]{
      opacity:1;visibility:visible;transform:translateY(0);
    }
    .ctx-tip-title{
      font-size:12px;line-height:1.35;font-weight:500;
      color:var(--ag-text-muted);margin-bottom:2px;
    }
    .ctx-tip-pct{
      font-size:13px;line-height:1.38;font-weight:600;
      color:var(--ag-custom-context-text,var(--ag-context-text-default));
    }
    :host([data-occupancy="warn"]) .ctx-tip-pct{
      color:var(--ag-ring-warn);
    }
    :host([data-occupancy="danger"]) .ctx-tip-pct{
      color:var(--ag-ring-danger);
    }
    .ctx-tip-detail{
      font-size:12.5px;line-height:1.38;font-weight:500;
      color:var(--ag-custom-context-text,var(--ag-text-secondary));
      margin-top:1px;
    }

    /* 窄屏溢出菜单浮层 */
    #overflow-menu{
      position:fixed;top:36px;right:12px;z-index:2147483500;
      width:220px;padding:6px;border-radius:10px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
    }
    #overflow-menu[hidden]{display:none!important}
    .overflow-item{
      width:100%;display:flex;align-items:center;justify-content:space-between;
      padding:7px 9px;border-radius:7px;font-size:12px;color:var(--ag-text-secondary);
      text-align:left;transition:background-color .12s ease,color .12s ease;
    }
    .overflow-item:hover,.overflow-item:focus-visible{
      background:var(--ag-toolbar-bg-hover);color:var(--ag-text-primary);
    }
    .overflow-item-label{display:flex;align-items:center;gap:6px;font-weight:500}
    .overflow-item-val{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ag-text-primary)}

    /* 详情二级抽屉折叠交互 */
    .tech-drawer{margin-top:10px;border-top:1px solid var(--ag-border-subtle);padding-top:9px}
    .drawer-trigger{
      width:100%;display:flex;justify-content:space-between;align-items:center;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      border-radius:7px;padding:7px 11px;color:var(--ag-text-secondary);font-size:11.5px;font-weight:500;
      cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease;
    }
    .drawer-trigger:hover{background:var(--ag-bg-card-hover);color:var(--ag-text-primary);border-color:var(--ag-border-card)}
    .drawer-trigger-left{display:flex;align-items:center;gap:6px}
    .drawer-arrow{font-size:11px;color:var(--ag-text-muted);font-weight:600}
    .drawer-body{margin-top:9px}

    /* 自定义颜色设置网格与自定义颜色选取器面板 */
    .color-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:6px}
    .color-item{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:6px 8px;border-radius:6px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }
    .color-item-lbl{font-size:11px;color:var(--ag-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .color-item-ctrls{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .color-picker{display:none!important}
    .color-swatch-btn{
      width:20px;height:20px;padding:0;border:1px solid var(--ag-border-card);
      border-radius:4px;background:var(--swatch-color,#7748cf);cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,0.18);transition:transform .12s ease,border-color .12s ease;
    }
    .color-swatch-btn:hover{transform:scale(1.08);border-color:var(--ag-text-primary)}
    .color-reset-btn{
      font-size:10.5px;padding:2px 6px;border-radius:4px;
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-muted);
    }
    .color-reset-btn:hover{color:var(--ag-text-primary);background:var(--ag-btn-hover)}
    .color-reset-btn[data-mode="auto"]{opacity:0.55}

    /* 自定义颜色选取器悬浮面板（参考样式：吸管 + 预设圆点 + SV主色区 + 色相条 + HEX/RGB/HSL三行） */
    #color-picker-popover{
      position:fixed;z-index:2147483640;width:304px;max-height:calc(100vh - 48px);overflow-y:auto;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);
      border:1px solid var(--ag-border-panel);border-radius:10px;
      box-shadow:var(--ag-shadow-panel);padding:12px;
      user-select:none;
      opacity:1;transform:translateY(0);
      transition:opacity 170ms cubic-bezier(0.16, 1, 0.3, 1), transform 170ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events:auto;
    }
    #color-picker-popover[hidden]{display:none!important}
    #color-picker-popover.is-opening{
      opacity:0;transform:translateY(-3px);
    }
    #color-picker-popover.is-closing{
      opacity:0;transform:translateY(-3px);
      transition:opacity 125ms cubic-bezier(0.4, 0, 1, 1), transform 125ms cubic-bezier(0.4, 0, 1, 1);
      pointer-events:none!important;
    }
    .cp-advanced-formats{
      margin-top:6px;border-top:1px solid var(--ag-border-subtle);padding-top:6px;
    }
    .cp-fmt-summary{
      font-size:11px;color:var(--ag-text-muted);cursor:pointer;outline:none;user-select:none;
    }
    .cp-fmt-summary:hover{color:var(--ag-text-primary)}
    .source-switch-bar,.view-switch-bar{
      display:inline-flex;align-items:center;background:var(--ag-bg-subcard);
      border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px;
    }
    .switch-pill-btn{
      border:0;background:transparent;color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:2px 8px;border-radius:4px;cursor:pointer;transition:background-color .12s,color .12s;
    }
    .switch-pill-btn:hover{color:var(--ag-text-primary)}
    .switch-pill-btn.active{
      background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;
      box-shadow:0 1px 3px rgba(0,0,0,0.18);
    }
    .plan-summary-price-badge{
      display:inline-flex;align-items:center;gap:4px;
      padding:2px 9px;border-radius:999px;
      font-size:10.5px;font-weight:600;white-space:nowrap;
      cursor:pointer;flex-shrink:0;user-select:none;
      background:rgba(167,139,250,0.14);
      border:1px solid rgba(167,139,250,0.32);
      color:var(--ag-token-accent-default,#a78bfa);
      transition:background 0.2s cubic-bezier(0.16,1,0.3,1), border-color 0.2s cubic-bezier(0.16,1,0.3,1), transform 0.2s cubic-bezier(0.16,1,0.3,1), box-shadow 0.25s ease;
    }
    .plan-summary-price-badge:hover{
      background:rgba(167,139,250,0.24);
      border-color:rgba(167,139,250,0.55);
      color:#ffffff;
      transform:scale(1.02);
    }
    .plan-summary-price-badge.is-animating{
      box-shadow:0 0 10px rgba(167,139,250,0.45);
      border-color:rgba(167,139,250,0.65);
    }
    :host([data-theme="light"]) .plan-summary-price-badge{
      background:rgba(124,58,237,0.10);
      border-color:rgba(124,58,237,0.28);
      color:#7c3aed;
    }
    :host([data-theme="light"]) .plan-summary-price-badge.is-animating{
      box-shadow:0 0 10px rgba(124,58,237,0.35);
      border-color:rgba(124,58,237,0.55);
    }
    .badge-symbol-anim{
      display:inline-block;
      transition:opacity 0.18s cubic-bezier(0.4, 0, 0.2, 1), transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), filter 0.18s ease;
      will-change:opacity, transform, filter;
    }
    .badge-symbol-anim.is-dissolving{
      opacity:0;
      transform:scale(0.72) translateY(-2px);
      filter:blur(1.5px);
    }
    .badge-symbol-anim.is-entering{
      opacity:0;
      transform:scale(1.25) translateY(2px);
      filter:blur(1.5px);
    }
    .badge-num-anim{
      display:inline-block;
      font-variant-numeric:tabular-nums;
      font-feature-settings:"tnum";
    }
    .badge-cycle-anim{
      display:inline-block;
    }
    .plan-summary-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;
      padding:7px 11px;margin-bottom:10px;font-size:11.5px;
    }
    .plan-summary-badge{
      display:inline-flex;align-items:center;gap:6px;font-weight:600;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
    }
    .plan-detail-dl{
      display:grid;
      grid-template-columns:115px minmax(0,1fr);
      gap:6px 12px;
      margin:0;
      align-items:baseline;
    }
    .plan-detail-dl dt{
      color:var(--ag-text-muted);
      font-size:11px;
      white-space:nowrap;
      text-align:left;
    }
    .plan-detail-dl dd{
      margin:0;
      text-align:left;
      max-width:none;
      min-width:0;
      color:var(--ag-text-primary);
      font-size:11.5px;
      line-height:1.45;
      overflow-wrap:break-word;
    }
    @media (max-width: 600px) {
      .plan-detail-dl{
        grid-template-columns:1fr;
        gap:3px 0;
      }
      .plan-detail-dl dt{
        font-weight:600;
        margin-top:3px;
      }
    }
        /* 所有详情与收起面板的丝滑物理展开动画 (匹配一级菜单质感) */
    @keyframes agSmoothExpand{
      0%{
        opacity:0;
        transform:translateY(-6px) scale(0.985);
      }
      100%{
        opacity:1;
        transform:translateY(0) scale(1);
      }
    }
    .collapsible-pane[style*="display: block"],
    .collapsible-pane:not([style*="display: none"]),
    #plan-detail-card:not([style*="display: none"]),
    #plan-custom-form:not([style*="display: none"]),
    #cost-details-pane:not([style*="display: none"]),
    .drawer-body:not([style*="display: none"]){
      animation: agSmoothExpand 0.2s cubic-bezier(0.16,1,0.3,1) forwards;
      transform-origin: top center;
    }

    /* 适度调和、略亮半度但温润自然的药丸编辑按钮 */
    .plan-edit-pill-btn{
      display:inline-flex;align-items:center;gap:5px;
      padding:4px 13px;border-radius:9999px;
      font-size:11px;font-weight:500;
      color:var(--ag-text-primary,#ececef);
      background:rgba(167,139,250,0.14);
      border:1px solid rgba(167,139,250,0.32);
      box-shadow:0 2px 6px rgba(0,0,0,0.25);
      cursor:pointer;user-select:none;
      transition:all 0.16s cubic-bezier(0.16,1,0.3,1);
    }
    .plan-edit-pill-btn:hover{
      background:rgba(167,139,250,0.24);
      border-color:rgba(167,139,250,0.55);
      color:#ffffff;
      box-shadow:0 3px 10px rgba(124,58,237,0.25);
      transform:translateY(-1px);
    }
    .plan-edit-pill-btn:active{
      transform:translateY(0);
      background:rgba(167,139,250,0.28);
    }
    :host([data-theme="light"]) .plan-edit-pill-btn{
      background:linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
      border-color:#6d28d9;color:#ffffff;
      box-shadow:0 3px 10px rgba(124,58,237,0.3);
    }

    /* Antigravity 原生定制下拉组件样式与动效 */
    .ag-dropdown-wrapper{
      position:relative;width:100%;box-sizing:border-box;
    }
    .ag-dropdown-trigger{
      width:100%;box-sizing:border-box;
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:5px 8px;font-size:11px;
      color:var(--ag-text-primary);
      background:var(--ag-bg-input);
      border:1px solid var(--ag-border-subcard);
      border-radius:5px;
      cursor:pointer;user-select:none;
      transition:background .15s cubic-bezier(0.16,1,0.3,1),border-color .15s cubic-bezier(0.16,1,0.3,1),box-shadow .15s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-trigger:hover{
      background:rgba(255,255,255,0.08);
      border-color:rgba(255,255,255,0.22);
    }
    :host([data-theme="light"]) .ag-dropdown-trigger:hover{
      background:rgba(0,0,0,0.05);
      border-color:rgba(0,0,0,0.22);
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-trigger{
      border-color:var(--ag-token-accent-default,#a78bfa);
      box-shadow:0 0 0 2px rgba(167,139,250,0.25);
      background:var(--ag-bg-subcard);
    }
    .ag-dropdown-arrow{
      width:10px;height:10px;display:flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.65;
      transition:transform 0.2s cubic-bezier(0.16,1,0.3,1),opacity 0.2s ease;
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-arrow{
      transform:rotate(180deg);opacity:1;
    }
    .plan-detail-card, .plan-detail-dl{
      overflow:visible !important;
    }
    .ag-dropdown-wrapper.is-open{
      z-index:2147483647 !important;
    }
    .ag-dropdown-menu{
      position:absolute;top:calc(100% + 4px);left:0;right:0;
      max-height:240px;overflow-y:auto;
      background:var(--ag-unified-bg,#1e1e24);
      border:1px solid var(--ag-float-border,rgba(255,255,255,0.14));
      border-radius:7px;
      box-shadow:0 16px 40px rgba(0,0,0,0.65),0 4px 12px rgba(0,0,0,0.4);
      backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
      padding:4px;z-index:2147483647 !important;
      opacity:0;transform:translateY(-6px) scale(0.97);
      transform-origin:top center;pointer-events:none;
      transition:opacity 0.16s cubic-bezier(0.16,1,0.3,1),transform 0.16s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-search-wrap{
      position:sticky;top:-4px;margin:-4px -4px 4px -4px;padding:6px;
      background:var(--ag-unified-bg,#1e1e24);
      border-bottom:1px solid var(--ag-border-subcard);
      z-index:10;
    }
    .ag-dropdown-search-input{
      width:100%;box-sizing:border-box;
      background:var(--ag-bg-input);
      border:1px solid var(--ag-border-subcard);
      border-radius:4px;padding:4px 7px;font-size:11px;
      color:var(--ag-text-primary);outline:none;
    }
    .ag-dropdown-search-input:focus{
      border-color:var(--ag-token-accent-default,#a78bfa);
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-menu{
      opacity:1;transform:translateY(0) scale(1);pointer-events:auto;
    }
    .ag-dropdown-item{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:5.5px 8px;border-radius:4px;
      font-size:11px;color:var(--ag-text-secondary);
      cursor:pointer;user-select:none;
      transition:background 0.12s ease,color 0.12s ease;
    }
    .ag-dropdown-item:hover{
      background:rgba(255,255,255,0.08);color:var(--ag-text-primary);
    }
    :host([data-theme="light"]) .ag-dropdown-item:hover{
      background:rgba(0,0,0,0.05);color:var(--ag-text-primary);
    }
    .ag-dropdown-item.is-selected{
      color:var(--ag-token-accent-default,#a78bfa);
      font-weight:600;background:rgba(167,139,250,0.12);
    }
    .ag-dropdown-item-check{
      font-size:10px;opacity:0;color:var(--ag-token-accent-default,#a78bfa);
    }
    .ag-dropdown-item.is-selected .ag-dropdown-item-check{
      opacity:1;
    }
    .ag-dropdown-item.is-keyboard-focus{
      background:rgba(255,255,255,0.12);outline:1px solid rgba(167,139,250,0.4);
    }
    :host([data-theme="light"]) .ag-dropdown-item.is-keyboard-focus{
      background:rgba(0,0,0,0.08);outline:1px solid rgba(124,58,237,0.4);
    }
    .ag-dropdown-wrapper.open-up .ag-dropdown-menu{
      top:auto;bottom:calc(100% + 4px);
      transform-origin:bottom center;
      transform:translateY(6px) scale(0.97);
    }
    .ag-dropdown-wrapper.is-open.open-up .ag-dropdown-menu{
      transform:translateY(0) scale(1);
    }
    .ag-dropdown-item-sub{
      font-size:9.5px;color:var(--ag-text-muted);margin-left:auto;padding-left:8px;
    }
    .ag-dropdown-item:hover .ag-dropdown-item-sub{
      color:var(--ag-text-secondary);
    }
    .ag-dropdown-menu::-webkit-scrollbar{width:4px}
    .ag-dropdown-menu::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb,rgba(255,255,255,0.2));border-radius:4px}

    .plan-detail-card{
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:11.5px;
    }
    .collapsible-pane{
      transition:opacity 0.18s ease;
    }
    .round-cost-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;
      padding:5px 9px;margin:6px 0 8px;font-size:11.5px;
    }
    .cp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
    .cp-title{font-size:12.5px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:6px}
    .cp-target-lbl{font-size:11px;font-weight:400;color:var(--ag-text-muted)}
    .cp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:9px}
    .cp-eyedropper-btn{
      display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:6px;
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-primary);
      font-size:11.5px;font-weight:500;cursor:pointer;flex-shrink:0;
    }
    .cp-eyedropper-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    .cp-presets{display:flex;align-items:center;gap:5px}
    .cp-preset-dot{
      width:16px;height:16px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.22);
      cursor:pointer;padding:0;transition:transform .12s ease;
    }
    :host([data-theme="light"]) .cp-preset-dot{border-color:rgba(0,0,0,0.18)}
    .cp-preset-dot:hover{transform:scale(1.16)}
    .cp-stage{display:grid;grid-template-columns:16px 1fr;gap:8px;margin-bottom:8px}
    .cp-side-preview{border-radius:6px;border:1px solid var(--ag-border-card);background:#652ab7}
    .cp-sv-area{
      position:relative;height:132px;border-radius:7px;overflow:hidden;cursor:crosshair;
      border:1px solid var(--ag-border-card);
      background-color:#ff0000;
      background-image:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);
    }
    .cp-sv-thumb{
      position:absolute;width:12px;height:12px;border-radius:50%;
      border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,0.75);
      transform:translate(-50%,-50%);pointer-events:none;left:50%;top:50%;
    }
    .cp-hue-wrap{
      position:relative;height:12px;border-radius:6px;margin-bottom:10px;cursor:ew-resize;
      border:1px solid var(--ag-border-card);
      background:linear-gradient(to right,#ff0000 0%,#ffff00 17%,#00ff00 33%,#00ffff 50%,#0000ff 67%,#ff00ff 83%,#ff0000 100%);
    }
    .cp-hue-thumb{
      position:absolute;top:50%;width:12px;height:12px;border-radius:50%;
      background:#fff;border:2px solid rgba(0,0,0,0.45);box-shadow:0 1px 3px rgba(0,0,0,0.5);
      transform:translate(-50%,-50%);pointer-events:none;left:0%;
    }
    .cp-rows{display:flex;flex-direction:column;gap:6px}
    .cp-row{
      display:grid;grid-template-columns:36px 1fr 24px;align-items:center;gap:6px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-card);
      border-radius:6px;padding:4px 7px;
    }
    .cp-fmt-lbl{font-size:11px;font-weight:600;color:var(--ag-text-muted)}
    .cp-fmt-input{
      width:100%;border:0;background:transparent;color:var(--ag-text-primary);
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;
      outline:none;padding:1px 2px;
    }
    .cp-copy-btn{
      border:0;background:transparent;color:var(--ag-text-muted);cursor:pointer;
      font-size:11.5px;padding:2px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;
    }
    .cp-copy-btn:hover{color:var(--ag-text-primary);background:var(--ag-toolbar-bg-hover)}
    .cp-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:7px;border-top:1px solid var(--ag-border-subtle)}

    /* 弹出面板：上下文 (#panel) 与 Token 用量一览 (#panel-tokens) 独立面板 */
    .ag-panel{
      box-sizing:border-box;
      position:fixed;top:38px;left:auto;right:16px;z-index:2147483500;
      max-width:calc(100vw - 24px);max-height:calc(100vh - 52px);
      overflow:auto;border:1px solid var(--ag-border-panel);border-radius:10px;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);box-shadow:var(--ag-shadow-panel);padding:14px;
      opacity:1;transform:translateY(0);visibility:visible;pointer-events:auto;
      transform-origin:top right;
      transition:opacity .16s cubic-bezier(0.16,1,0.3,1),transform .16s cubic-bezier(0.16,1,0.3,1),visibility .16s ease;
      contain:layout paint;
    }
    #panel{width:472px;max-width:calc(100vw - 24px)}
    #panel-tokens{width:730px;transition:width .22s cubic-bezier(0.16,1,0.3,1),left .22s cubic-bezier(0.16,1,0.3,1),max-width .22s cubic-bezier(0.16,1,0.3,1),opacity .16s cubic-bezier(0.16,1,0.3,1),transform .16s cubic-bezier(0.16,1,0.3,1)}
    #panel-tokens.cost-compact-view{width:400px!important;max-width:calc(100vw - 24px)}
    .ag-panel[hidden]{display:block!important;opacity:0;transform:translateY(-6px);visibility:hidden;pointer-events:none}

    /* 视图内平滑交叉淡入淡出（避免直接 display 硬切导致内容跳闪） */
    @keyframes agFadeIn{
      from{opacity:0;transform:translateY(4px)}
      to{opacity:1;transform:translateY(0)}
    }
    .view-pane-fade{transition:opacity .15s ease,transform .15s ease;opacity:1;transform:translateY(0)}
    .view-pane-fade.pane-hidden{opacity:0;transform:translateY(3px);display:none!important}

    /* 顶栏控制条（sticky 固定，防止表单或详情展开时滚出视口） */
    .panel-header-bar{
      position:sticky;top:-14px;background:var(--ag-bg-panel);z-index:20;
      margin-top:-14px;padding-top:14px;
      display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:nowrap;
      border-bottom:1px solid var(--ag-border-subtle);padding-bottom:9px;margin-bottom:9px
    }
    .panel-title{display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 auto;overflow:hidden}
    .panel-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .panel-title-tokens{color:var(--ag-custom-token-accent,var(--ag-token-accent-default))}
    .panel-header-actions{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;flex-shrink:0}
    .ctx-header-actions{justify-content:flex-end}

    .panel-icon-btn{
      background:none;border:0;color:var(--ag-text-muted);font-size:12px;line-height:1;
      padding:4px 7px;border-radius:6px;cursor:pointer;transition:background-color .14s ease,color .14s ease;
      display:inline-flex;align-items:center;justify-content:center;gap:3px;
    }
    .panel-icon-btn:hover{color:var(--ag-text-primary);background:var(--ag-toolbar-bg-hover)}
    #close,#close-tokens{font-size:16px;padding:2px 7px}

    h3{margin:0;font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    h4{margin:12px 0 5px;font-size:11.5px;font-weight:600;color:var(--ag-text-secondary)}
    p{margin:5px 0;color:var(--ag-text-muted)}
    .drawer-body dl{display:grid;grid-template-columns:1fr auto;gap:5px;margin:0}
    .drawer-body dt{color:var(--ag-text-muted)}
    .drawer-body dd{margin:0;text-align:right;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:270px}

    #key-summary{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:6px 0 10px}
    .key-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
    .key-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px}
    .key-pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid transparent}
    .pill-good, .pill-ok{color:#52c41a;background:rgba(82,196,26,0.12);border-color:rgba(82,196,26,0.28)}
    :host([data-theme="light"]) .pill-good, :host([data-theme="light"]) .pill-ok{color:#389e0d;background:#f6ffed;border-color:#b7eb8f}
    .pill-info{color:#1890ff;background:rgba(24,144,255,0.12);border-color:rgba(24,144,255,0.28)}
    :host([data-theme="light"]) .pill-info{color:#096dd9;background:#e6f7ff;border-color:#91d5ff}
    .pill-warn{color:#faad14;background:rgba(250,173,20,0.12);border-color:rgba(250,173,20,0.28)}
    :host([data-theme="light"]) .pill-warn{color:#d46b08;background:#fff7e6;border-color:#ffd591}
    .pill-danger{color:#ff4d4f;background:rgba(255,77,79,0.14);border-color:rgba(255,77,79,0.32)}
    :host([data-theme="light"]) .pill-danger{color:#cf1322;background:#fff1f0;border-color:#ffa39e}
    .pill-muted{color:var(--ag-pill-muted-text);background:var(--ag-pill-muted-bg);border-color:var(--ag-pill-muted-border)}

    .key-bar-track{width:100%;height:6px;background:var(--ag-custom-ring-track,var(--ag-track-bg));border-radius:3px;overflow:hidden;margin-bottom:9px}
    .key-bar-fill{height:100%;width:0%;border-radius:3px;background:var(--ag-custom-ring-used,var(--bar-color,#69c0ff));transition:width .24s ease,background-color .2s ease}
    :host([data-occupancy="warn"]) .key-bar-fill{background:var(--ag-ring-warn)}
    :host([data-occupancy="danger"]) .key-bar-fill{background:var(--ag-ring-danger)}
    .key-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;margin-bottom:7px}
    .key-stat{background:var(--ag-bg-subcard);padding:6px 4px;border-radius:6px;border:1px solid var(--ag-border-subcard)}
    .key-stat-label{font-size:10px;color:var(--ag-text-muted);margin-bottom:2px}
    .key-stat-val{font-size:12px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #key-used{color:var(--ag-custom-context-text,var(--ag-text-primary))}
    .key-takeaway{font-size:11px;color:var(--ag-text-secondary);padding-top:6px;border-top:1px solid var(--ag-border-subcard);line-height:1.4}

    #status{padding:7px 10px;border:0;border-left:2.5px solid var(--tone,#666);border-radius:4px;background:var(--ag-bg-status);color:var(--ag-text-status);font-weight:500;font-size:11.5px}
    #model{overflow-wrap:anywhere;font-size:11.5px;color:var(--ag-text-muted)}
    #note,#coverage,#updated{font-size:11px;color:var(--ag-text-muted)}
    #refresh{border:1px solid var(--ag-btn-border);border-radius:6px;background:var(--ag-btn-bg);color:var(--ag-btn-text);padding:4px 10px;margin-top:8px;transition:background-color .14s ease,border-color .14s ease}
    #refresh:hover:not(:disabled){background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    #files{max-height:220px;overflow:auto}
    .file{padding:7px 0;border-top:1px solid var(--ag-border-subtle)}
    .file-name{overflow-wrap:anywhere;color:var(--ag-text-primary)}
    .file-detail{color:var(--ag-text-muted);font-size:11px}
    .file-unknown{color:#e6b865;font-size:11px}
    :host([data-theme="light"]) .file-unknown{color:#b45309}
    #v{color:var(--ag-text-muted);font-size:10px;font-weight:400;margin-left:2px;flex-shrink:0}

    /* 全局 Token 用量一览 */
    #view-tokens{display:flex;flex-direction:column;gap:10px}
    .token-stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .t-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px;transition:background-color .14s ease}
    .t-card:hover{background:var(--ag-bg-card-hover)}
    .t-card-lbl{font-size:11px;color:var(--ag-text-muted);display:flex;justify-content:space-between}
    .t-card-val{font-size:16.5px;font-weight:700;color:var(--ag-text-primary);letter-spacing:-0.3px;font-variant-numeric:tabular-nums}
    #t-total-val{color:var(--ag-custom-token-total,var(--ag-text-primary))}
    #t-today-val{color:var(--ag-custom-token-accent,var(--ag-text-primary))}
    .t-card-sub{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .t-card-cost{font-size:9.5px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}

    .heatmap-section{background:var(--ag-heat-bg);border:1px solid var(--ag-border-card);border-radius:10px;padding:12px}
    .heat-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    .heat-header-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .heat-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .first-use-badge{
      font-size:11px;font-weight:500;color:var(--ag-text-secondary);
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-card);
      border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums;
    }
    .heat-win-nav{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .heat-nav-btn{
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-secondary);
      border-radius:4px;padding:1px 6px;font-size:11px;line-height:1.25;cursor:pointer;
    }
    .heat-nav-btn:hover:not(:disabled){background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .heat-nav-btn:disabled{opacity:0.35;cursor:default}
    .heat-tabs{
      position:relative;display:inline-flex;align-items:center;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      border-radius:9999px;padding:2px;gap:2px;user-select:none;
    }
    .heat-tab-thumb{
      position:absolute;top:2px;bottom:2px;left:0;width:0;
      border-radius:9999px;
      background:var(--ag-tab-thumb-bg, var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa)));
      opacity:0.25;pointer-events:none;
      transition:transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      will-change:transform, width;
    }
    @media (prefers-reduced-motion: reduce){
      .heat-tab-thumb{transition:none!important}
    }
    .heat-tab-btn{
      position:relative;z-index:1;border:0;background:transparent;
      color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:3px 10px;border-radius:9999px;cursor:pointer;
      transition:color .14s ease;outline:none;white-space:nowrap;
    }
    .heat-tab-btn:hover{color:var(--ag-text-primary)}
    .heat-tab-btn.active{color:var(--ag-text-primary);font-weight:600}
    .heat-tab-btn:focus-visible{box-shadow:0 0 0 1.5px var(--ag-token-accent-default,#a78bfa)}

    .heat-scroll-box{overflow-x:auto;overflow-y:hidden;padding:6px 6px 4px 6px}
    .heat-grid-cols{display:flex;gap:3px}
    .heat-week-col{display:flex;flex-direction:column;gap:3px}
    .heat-cell{width:10px;height:10px;border-radius:2px;background:var(--ag-heat-lvl-0);cursor:pointer;transition:transform .12s ease}
    .heat-cell:hover{transform:scale(1.3);z-index:5;outline:1.5px solid var(--ag-heat-outline)}
    .heat-cell.is-future{opacity:0.36}
    .heat-cell.is-today{outline:1.5px solid var(--ag-custom-token-accent,var(--ag-token-accent-default));outline-offset:0.5px}
    .lvl-0{background:var(--ag-heat-lvl-0)}
    .lvl-1{background:var(--ag-heat-lvl-1)}
    .lvl-2{background:var(--ag-heat-lvl-2)}
    .lvl-3{background:var(--ag-heat-lvl-3)}
    .lvl-4{background:var(--ag-heat-lvl-4)}

    .heat-months{position:relative;height:18px;margin-top:4px;font-size:11px;color:var(--ag-text-muted);overflow:hidden}
    .heat-month-item{position:absolute;white-space:nowrap}

    #h-weekly-box{display:none;height:105px;align-items:flex-end;gap:3px;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:3px}
    .w-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer}
    .w-bar-fill{width:100%;border-radius:2px 2px 0 0;background:var(--ag-heat-lvl-0);min-height:3px;transition:height .22s ease,background-color .14s ease}
    .w-bar-col:hover .w-bar-fill{background:var(--ag-custom-token-accent,var(--ag-heat-lvl-4))!important}

    #h-monthly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-month-grid{display:grid;width:100%;height:100%;align-content:center;justify-content:center}
    .heat-month-cell{display:flex;align-items:center;justify-content:center;border-radius:3px;cursor:pointer;transition:transform .12s ease}
    .heat-month-cell:hover{transform:scale(1.18);z-index:5;outline:1.5px solid var(--ag-heat-outline,#fff)}
    .heat-month-cell-num{font-size:9.5px;font-weight:600;color:rgba(255,255,255,0.9);text-shadow:0 1px 2px rgba(0,0,0,0.65);pointer-events:none}
    :host([data-theme="light"]) .heat-month-cell-num{color:#18181b;text-shadow:none}

    #h-yearly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-yearly-svg{width:100%;height:105px;display:block;overflow:visible}
    @keyframes bubblePopIn{0%{transform:scale(0.6);opacity:0}100%{transform:scale(1);opacity:1}}
    .heat-yearly-bubble-group{transform-origin:center center;animation:bubblePopIn 0.22s cubic-bezier(0.16,1,0.3,1) both;cursor:pointer}
    /* 上下文加长面板样式 */
    .unlock-panel-content{padding:4px 0 2px;display:flex;flex-direction:column;gap:8px}
    .unlock-status-row{display:flex;justify-content:space-between;align-items:flex-start;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .unlock-label{font-size:11px;font-weight:600;color:var(--ag-text-primary);margin-bottom:2px}
    .unlock-desc{font-size:11px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice{background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.22);border-radius:6px;padding:7px 9px}
    .unlock-notice-title{font-size:10.5px;font-weight:600;color:#eab308;margin-bottom:3px}
    .unlock-notice-list{margin:0;padding-left:14px;font-size:10px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice-list li{margin-bottom:2px}
    .unlock-notice-list strong{color:var(--ag-text-primary)}
    .unlock-actions-row{display:flex;gap:8px;align-items:center;margin-top:2px}
    .unlock-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease}
    .unlock-btn:disabled{opacity:0.5;cursor:not-allowed}
    .unlock-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}
    .unlock-btn-primary:hover:not(:disabled){background:#1d4ed8}
    .unlock-btn-secondary{background:var(--ag-bg-subcard);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard)}
    .unlock-btn-secondary:hover:not(:disabled){background:var(--ag-bg-card-hover)}
    .unlock-result-box{border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.4}
    .unlock-result-box.result-success{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:#22c55e}
    .unlock-result-box.result-error{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444}
    .unlock-meta-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:10.5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 10px;margin:2px 0}
    .unlock-meta-dl dt{color:var(--ag-text-muted);font-weight:500}
    .unlock-meta-dl dd{margin:0;color:var(--ag-text-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .unlock-credit-bar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;font-size:10.5px;color:var(--ag-text-muted);border-top:1px dashed var(--ag-border-subtle);padding-top:7px;margin-top:4px}
    .unlock-credit-left{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
    .unlock-author-link{color:var(--ag-link,#38bdf8);text-decoration:underline;text-underline-offset:2px;font-weight:600;cursor:pointer;padding:1px 4px;border-radius:4px;transition:all .15s ease;display:inline-flex;align-items:center}
    .unlock-author-link:hover{color:#7dd3fc;background:rgba(56,189,248,0.12)}
    .unlock-author-link:focus-visible{outline:2px solid var(--ag-link,#38bdf8);background:rgba(56,189,248,0.18)}
    .unlock-copy-link-btn{background:transparent;border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);border-radius:4px;font-size:10px;padding:1px 6px;cursor:pointer;transition:all .15s ease}
    .unlock-copy-link-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-text-muted);background:var(--ag-bg-card-hover)}
    .unlock-copy-link-btn:focus-visible{outline:1px solid var(--ag-link,#38bdf8)}
    .unlock-link-toast{margin-top:4px;font-size:10px;padding:4px 8px;border-radius:4px;background:rgba(56,189,248,0.12);color:var(--ag-text-primary);border:1px solid rgba(56,189,248,0.3);line-height:1.4;animation:agSmoothExpand 0.15s ease}
    .unlock-adapter-note{font-size:9.5px;opacity:0.8}
    .ctx-adjust-trigger{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}
    .ctx-adjust-trigger:hover{background:var(--ag-bg-card-hover);border-color:var(--ag-link,#38bdf8)}
    .ctx-model-card,.ctx-adjust-box{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
    .ctx-model-header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap}
    .ctx-model-name{font-size:11.5px;font-weight:600;color:var(--ag-text-primary);line-height:1.3}
    .ctx-model-id{font-size:10px;color:var(--ag-text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-all;margin-top:1px}
    .ctx-model-picker-wrap{display:flex;flex-direction:column;gap:2px;min-width:140px;max-width:190px;flex:1 1 140px}
    .ctx-small-label{font-size:10px;color:var(--ag-text-muted)}
    .ctx-model-select{background:var(--ag-bg-card);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard);border-radius:4px;padding:3px 6px;font-size:10.5px;width:100%;outline:none}
    .ctx-pref-banner{border-top:1px dashed var(--ag-border-subtle);padding-top:5px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}
    .ctx-pref-val{font-size:10.5px;font-weight:600;color:var(--ag-link,#38bdf8)}
    .ctx-preset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
    .ctx-preset-btn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:var(--ag-bg-card);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;cursor:pointer;transition:all .15s ease;color:var(--ag-text-primary)}
    .ctx-preset-btn:hover:not(:disabled){background:var(--ag-bg-card-hover);border-color:var(--ag-text-muted)}
    .ctx-preset-btn.active{border-color:#2563eb;background:rgba(37,99,235,0.14);box-shadow:inset 0 0 0 1px rgba(37,99,235,0.35)}
    .ctx-preset-btn:disabled,.ctx-preset-btn.is-disabled{opacity:0.48;cursor:not-allowed;border-style:dashed}
    .ctx-preset-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-preset-sub{font-size:9.5px;color:var(--ag-text-secondary);line-height:1.25}
    .ctx-custom-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
    .ctx-custom-input-wrap{display:flex;align-items:center;flex:1;background:var(--ag-bg-card);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:0 8px}
    .ctx-custom-input-wrap:focus-within{border-color:#2563eb}
    .ctx-custom-input{flex:1;min-width:0;background:transparent;border:none;color:var(--ag-text-primary);font-size:11px;padding:5px 0;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .ctx-input-unit{font-size:10px;color:var(--ag-text-muted);margin-left:4px}
    .ctx-validation-msg{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-validation-msg.is-error{color:#ef4444;font-weight:500}
    .ctx-validation-msg.is-warn{color:#eab308}
    .ctx-pref-actions,.unlock-actions-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px}
    .ctx-scope-note{font-size:10px;color:#eab308;margin-top:4px;line-height:1.35}

    @media (prefers-reduced-motion: reduce){.heat-yearly-bubble-group{animation:none!important}}
    .heat-yearly-bubble-group:hover circle.bubble-main{filter:brightness(1.22);stroke:var(--ag-text-primary);stroke-width:1.5px}

    #h-cum-box{display:none;height:105px;position:relative}
    canvas#h-cum-canvas{width:100%;height:105px;display:block}

    .heat-summary-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
      margin-top:8px;padding:5px 8px;background:var(--ag-bg-subcard);border-radius:6px;
      border:1px solid var(--ag-border-subcard);font-size:11px;
    }
    .heat-sum-item{display:inline-flex;align-items:center;gap:4px}
    .heat-sum-label{color:var(--ag-text-muted);font-size:10px}
    .heat-sum-val{color:var(--ag-text-primary);font-weight:600;font-variant-numeric:tabular-nums}
    .heat-cost-disclaimer{font-size:9.5px;color:var(--ag-text-muted);margin-top:4px;line-height:1.35}

    .update-btn{position:relative}
    .update-badge-dot{
      position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;
      background:#ef4444;box-shadow:0 0 0 1.5px var(--ag-bg-panel);
    }
    .update-popover{
      position:fixed;top:80px;right:24px;width:290px;max-width:calc(100vw - 28px);
      background:var(--ag-unified-bg,#1e1e24);border:1px solid var(--ag-float-border,rgba(255,255,255,0.18));
      border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.55),0 2px 8px rgba(0,0,0,0.3);
      padding:11px 13px;z-index:2147483647;
      animation:agSmoothExpand 0.2s cubic-bezier(0.16,1,0.3,1);
    }
    .update-pop-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;border-bottom:1px solid var(--ag-border-subcard);padding-bottom:5px}
    .update-pop-body{font-size:11px;color:var(--ag-text-secondary);line-height:1.45;max-height:130px;overflow-y:auto;white-space:pre-wrap;margin-bottom:9px}
    .update-pop-footer{display:flex;align-items:center;justify-content:flex-end;gap:6px}

    .heat-preset-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin:6px 0 8px}
    .heat-preset-group{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
    .heat-preset-btn{
      display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;
      border:1px solid var(--ag-border-card);background:var(--ag-bg-subcard);color:var(--ag-text-secondary);
      font-size:11px;cursor:pointer;transition:border-color .12s ease,color .12s ease;
    }
    .heat-preset-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .heat-preset-btn[data-active="true"]{
      color:var(--ag-text-primary);border-color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      font-weight:600;
    }
    .heat-preset-dots{display:inline-flex;gap:2px}
    .heat-preset-dots i{width:7px;height:7px;border-radius:1.5px;display:inline-block}

    .heat-leg-swatch{
      width:11px;height:11px;padding:0;border-radius:2.5px;
      border:1px solid var(--ag-border-card);
      background:var(--swatch-color,var(--ag-heat-lvl-0));
      cursor:pointer;flex-shrink:0;
      transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;
    }
    .heat-leg-swatch:hover{
      transform:scale(1.32);z-index:2;
      border-color:var(--ag-text-primary);
      box-shadow:0 0 0 1px var(--ag-text-primary);
    }
    .heat-leg-swatch[data-custom="true"]{
      border-color:var(--ag-text-secondary);
    }

    .heat-lvl-custom-bar{
      margin:6px 0 8px;padding:7px 8px;border-radius:7px;
      background:var(--ag-bg-card);border:1px solid var(--ag-border-card);
    }
    .heat-lvl-custom-hdr{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      margin-bottom:6px;flex-wrap:wrap;
    }
    .heat-lvl-grid{
      display:grid;grid-template-columns:repeat(auto-fit,minmax(122px,1fr));gap:6px;
    }
    .heat-lvl-item{
      display:flex;align-items:center;justify-content:space-between;gap:4px;
      padding:5px 7px;border-radius:6px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }
    .heat-lvl-lbl{
      font-size:10.5px;color:var(--ag-text-secondary);font-weight:500;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }

    .heat-popover{position:fixed;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);border-radius:8px;padding:7px 11px;box-shadow:var(--ag-pop-shadow);z-index:2147483600;opacity:0;transform:translate(-50%,-100%) translateY(-6px);transition:opacity .12s ease}
    .pop-date{font-size:11.5px;color:var(--ag-pop-muted)}
    .pop-val{font-size:13.5px;font-weight:600;color:var(--ag-pop-text);margin:2px 0 4px}
    .pop-det{font-size:10.5px;color:var(--ag-pop-sub);margin-top:2px;display:flex;gap:12px;align-items:flex-start}
    .pop-det-col{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px}
    .pop-det-val{font-size:11px;font-weight:500;color:var(--ag-pop-sub);font-variant-numeric:tabular-nums;white-space:nowrap}
    .pop-det-trans{font-size:9.5px;color:var(--ag-pop-muted);opacity:0.88;white-space:nowrap;line-height:1.2}

    /* 上下文面板分页、模型卡片、状态条与速度对比图表 */
    .unlock-panel-content{padding:4px 0 2px;display:flex;flex-direction:column;gap:8px}
    .unlock-status-row{display:flex;justify-content:space-between;align-items:flex-start;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .unlock-label{font-size:11px;font-weight:600;color:var(--ag-text-primary);margin-bottom:2px}
    .unlock-desc{font-size:11px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice{background:rgba(234,179,8,0.06);border:1px solid rgba(234,179,8,0.2);border-radius:6px;padding:8px 10px}
    .unlock-notice-list{margin:0;padding-left:15px;font-size:10.5px;color:var(--ag-text-secondary);line-height:1.45}
    .unlock-notice-list li{margin-bottom:4px}
    .unlock-notice-list strong{color:var(--ag-text-primary)}
    .unlock-actions-row{display:flex;gap:8px;align-items:center;margin-top:2px;flex-wrap:wrap}
    .unlock-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 11px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}
    .unlock-btn:disabled{opacity:0.5;cursor:not-allowed}
    .unlock-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}
    .unlock-btn-primary:hover:not(:disabled){background:#1d4ed8}
    .unlock-btn-secondary{background:var(--ag-bg-subcard);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard)}
    .unlock-btn-secondary:hover:not(:disabled){background:var(--ag-bg-card-hover)}
    .unlock-result-box{border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.4;margin-top:4px}
    .unlock-result-box.result-success{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:#22c55e}
    .unlock-result-box.result-error{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444}
    .unlock-meta-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:10.5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 10px;margin:2px 0}
    .unlock-meta-dl dt{color:var(--ag-text-muted);font-weight:500}
    .unlock-meta-dl dd{margin:0;color:var(--ag-text-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .unlock-credit-bar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;font-size:10.5px;color:var(--ag-text-muted);border-top:1px dashed var(--ag-border-subtle);padding-top:7px;margin-top:4px}
    .unlock-credit-left{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
    .unlock-author-link{color:var(--ag-link,#38bdf8);text-decoration:underline;text-underline-offset:2px;font-weight:600;cursor:pointer;padding:1px 4px;border-radius:4px;transition:all .15s ease;display:inline-flex;align-items:center}
    .unlock-author-link:hover{color:#7dd3fc;background:rgba(56,189,248,0.12)}
    .unlock-author-link:focus-visible{outline:2px solid var(--ag-link,#38bdf8);background:rgba(56,189,248,0.18)}
    .unlock-copy-link-btn{background:transparent;border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);border-radius:4px;font-size:10px;padding:1px 6px;cursor:pointer;transition:all .15s ease}
    .unlock-copy-link-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-text-muted);background:var(--ag-bg-card-hover)}
    .unlock-link-toast{margin-top:4px;font-size:10px;padding:4px 8px;border-radius:4px;background:rgba(56,189,248,0.12);color:var(--ag-text-primary);border:1px solid rgba(56,189,248,0.3);line-height:1.4;animation:agSmoothExpand 0.15s ease}
    .unlock-adapter-note{font-size:9.5px;opacity:0.8}

    /* 模型选择器（模型设置页内） & 分页栏 */
    .ctx-header-model-ctrl{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex-wrap:wrap}
    .ctx-models-toolbar{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:7px 9px;margin-bottom:8px}
    .ctx-selector-role-lbl{font-size:10.5px;color:var(--ag-text-muted);white-space:nowrap;flex-shrink:0}
    .ctx-header-dropdown{flex:1 1 160px;min-width:0;max-width:100%}
    .ctx-compact-trigger{padding:4px 8px!important;font-size:11px!important;max-width:100%}
    .ctx-compact-trigger .ag-dropdown-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
    .ctx-model-dropdown-menu{min-width:220px;max-width:100%;left:0;right:auto}
    .ctx-card-details-drawer{border-top:1px solid var(--ag-border-subtle);padding-top:6px;margin-top:2px}
    .ctx-card-drawer-trigger{font-size:11px;padding:2px 0}
    .ctx-card-drawer-body{padding-top:6px}
    .ctx-model-group-hdr.is-history-hdr{margin-top:4px;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;opacity:0.85}
    .ctx-product-row-history-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);flex-shrink:0}
    .ctx-mini-link-btn{background:none;border:0;color:var(--ag-link,#38bdf8);font-size:10px;padding:2px 4px;cursor:pointer;white-space:nowrap;text-decoration:underline;text-underline-offset:2px}
    .ctx-mini-link-btn[hidden]{display:none!important}
    .ag-dropdown-group-title{display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:10px;font-weight:600;color:var(--ag-text-muted);letter-spacing:0.2px;cursor:default;user-select:none;border-top:1px solid var(--ag-border-subtle);margin-top:3px}
    .ag-dropdown-group-title:first-child{border-top:0;margin-top:0}
    .ag-vendor-dot{width:7px;height:7px;border-radius:999px;display:inline-block;flex-shrink:0;background:var(--ag-text-muted)}
    .ag-dropdown-badge{font-size:9.5px;padding:0 5px;border-radius:9px;background:rgba(56,189,248,0.14);color:var(--ag-link,#38bdf8);border:1px solid rgba(56,189,248,0.3);margin-left:4px;flex-shrink:0}

    .ctx-tabs-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:7px;padding:3px;margin-bottom:9px;box-sizing:border-box;width:100%}
    .ctx-tab-btn{display:flex;align-items:center;justify-content:center;min-width:0;border:1px solid transparent;background:transparent;color:var(--ag-text-muted);font-size:11.5px;font-weight:500;padding:5px 4px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .05s ease}
    .ctx-tab-btn:hover{color:var(--ag-text-primary);background:rgba(255,255,255,0.05)}
    .ctx-tab-btn:active{transform:scale(0.97);background:rgba(255,255,255,0.08)}
    .ctx-tab-btn:focus-visible{outline:2px solid var(--primary,#38bdf8);outline-offset:1px}
    .ctx-tab-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.28);border:1px solid var(--ag-border-card)}
    :host([data-theme="light"]) .ctx-tab-btn.active{box-shadow:0 1px 3px rgba(0,0,0,0.12);border-color:rgba(0,0,0,0.12)}

    .ctx-lang-top-segmented{display:inline-flex;align-items:center;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px;flex-shrink:0;vertical-align:middle;margin-right:2px}
    .ctx-lang-top-segmented .ctx-seg-btn{border:1px solid transparent;background:transparent;color:var(--ag-text-muted);font-size:10.5px;font-weight:500;padding:2px 6px;border-radius:4px;cursor:pointer;line-height:15px;transition:all .15s ease}
    .ctx-lang-top-segmented .ctx-seg-btn:hover{color:var(--ag-text-primary);background:rgba(255,255,255,0.05)}
    .ctx-lang-top-segmented .ctx-seg-btn:active{transform:scale(0.96)}
    .ctx-lang-top-segmented .ctx-seg-btn:focus-visible{outline:1.5px solid var(--primary,#38bdf8);outline-offset:1px}
    .ctx-lang-top-segmented .ctx-seg-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,0.2);border:1px solid var(--ag-border-card)}

    .ag-modal-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;animation:agFadeIn .15s ease-out}
    .ag-modal-overlay[hidden]{display:none !important}
    .ag-modal-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:10px;padding:16px 18px;max-width:340px;width:100%;box-shadow:0 16px 40px rgba(0,0,0,0.6),0 2px 10px rgba(0,0,0,0.3);display:flex;flex-direction:column;gap:12px}
    .ag-modal-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .ag-modal-body{font-size:11.5px;line-height:1.5;color:var(--ag-text-secondary)}
    .ag-modal-feedback{font-size:11px;line-height:1.4;padding:6px 8px;border-radius:5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary)}
    .ag-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
    .ctx-brand-feedback{font-size:11px;margin-top:6px;padding:5px 8px;border-radius:5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary)}
    .ctx-tab-pane[hidden]{display:none!important}

    /* 当前会话紧凑卡片 */
    .ctx-compact-card{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 11px;margin:8px 0 4px}
    .ctx-compact-info{min-width:0;display:flex;flex-direction:column;gap:3px}
    .ctx-compact-title{font-size:11.5px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-compact-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10.5px;color:var(--ag-text-secondary)}
    .ctx-compact-meta strong{color:var(--ag-text-primary);font-weight:600}
    .ctx-compact-link-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:4px 9px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0}
    .ctx-compact-link-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    /* 模型设置页：全局状态条 */
    .ctx-status-bar{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:8px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}
    .ctx-status-bar-main{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-status-left{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .ctx-client-status-text{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-restart-btn[hidden],.ctx-restart-confirm[hidden],.ctx-manual-restart-note[hidden],.ctx-restart-feedback[hidden],.ctx-status-subnote[hidden]{display:none!important}
    .ctx-status-subnote{font-size:10.5px;color:#eab308;line-height:1.35}
    .ctx-manual-restart-note{font-size:10.5px;color:var(--ag-text-secondary);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;line-height:1.4}
    .ctx-restart-confirm{background:rgba(234,179,8,0.09);border:1px solid rgba(234,179,8,0.3);border-radius:6px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-restart-confirm-text{font-size:10.5px;color:var(--ag-text-primary);line-height:1.35;flex:1;min-width:170px}
    .ctx-restart-confirm-actions{display:flex;gap:6px;align-items:center}
    .ctx-restart-feedback{font-size:10.5px;color:var(--ag-link,#38bdf8);line-height:1.35}

    /* 模式选择器（统一设置 vs 按模型分别设置） */
    .ctx-scope-selector-wrap{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:5px;margin-bottom:8px}
    .ctx-scope-mode-toggle{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .ctx-mode-tab-btn{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;cursor:pointer;color:var(--ag-text-secondary);transition:all .15s ease}
    .ctx-mode-tab-btn:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .ctx-mode-tab-btn.is-active{background:rgba(37,99,235,0.12);border-color:rgba(37,99,235,0.48);color:var(--ag-text-primary);box-shadow:0 1px 3px rgba(0,0,0,0.06)}
    .ctx-mode-tab-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-mode-tab-desc{font-size:9.5px;color:var(--ag-text-muted);line-height:1.3}

    /* 厂商分组模型列表 */
    .ctx-model-list{display:flex;flex-direction:column;gap:6px;max-height:175px;overflow-y:auto;background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:7px;margin-bottom:8px}
    .ctx-model-group{display:flex;flex-direction:column;gap:3px}
    .ctx-model-group-hdr{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;color:var(--ag-text-muted);padding:2px 4px}
    .ctx-product-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:5px;padding:5px 7px;cursor:pointer;color:var(--ag-text-secondary);font-size:11px;transition:background .12s ease,border-color .12s ease}
    .ctx-product-row:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .ctx-product-row.is-active{background:rgba(37,99,235,0.14);border-color:rgba(37,99,235,0.42);color:var(--ag-text-primary);font-weight:600}
    .ctx-product-row.is-unavailable{opacity:0.65}
    .ctx-product-row-unavailable-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;flex-shrink:0}
    .ctx-product-row-notice-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;flex-shrink:0}
    .ctx-product-row-left{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
    .ctx-product-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-product-row-right{display:flex;align-items:center;gap:4px;flex-shrink:0;font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .ctx-product-row-val.is-conflict{color:#f59e0b;font-weight:600}

    /* 模型大卡片 */
    .ctx-detail-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px 11px;margin-bottom:8px;display:flex;flex-direction:column;gap:8px}
    .ctx-conflict-banner{background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.34);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:5px}
    .ctx-conflict-banner[hidden]{display:none!important}
    .ctx-conflict-title{font-size:10.5px;font-weight:600;color:#f59e0b}
    .ctx-conflict-rows{display:flex;flex-direction:column;gap:4px}
    .ctx-conflict-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--ag-text-primary)}
    .ctx-conflict-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer}
    .ctx-conflict-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    .ctx-card-top{display:flex;flex-direction:column;gap:3px}
    .ctx-card-vendor-row{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--ag-text-muted)}
    .ctx-card-product-name{font-size:13.5px;font-weight:600;color:var(--ag-text-primary);line-height:1.3;overflow-wrap:anywhere;word-break:break-word}
    .ctx-card-efforts-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--ag-text-secondary)}
    .ctx-card-session-effort{font-weight:600;color:var(--ag-link,#38bdf8)}
    .ctx-card-session-effort[hidden]{display:none!important}

    /* 精简主界面三项高亮网格 */
    .ctx-summary-highlight-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .ctx-summary-item{display:flex;flex-direction:column;gap:2px;min-width:0}
    .ctx-summary-item-length{grid-column:1 / -1;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;margin-top:2px}
    .ctx-summary-label{font-size:10px;font-weight:500;color:var(--ag-text-muted)}
    .ctx-summary-value{font-size:11.5px;font-weight:600;color:var(--ag-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-summary-length-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .ctx-length-val{font-size:12.5px;color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))}

    .ctx-card-metrics{display:flex;flex-direction:column;gap:5px}
    .ctx-metric-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:start;gap:6px 8px;padding:5px 8px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-left-width:3px;border-radius:5px;font-size:11px}
    .ctx-metric-saved{border-left-color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))}
    .ctx-metric-request{border-left-color:var(--ag-custom-speed,var(--ag-speed-default,#38bdf8))}
    .ctx-metric-client{border-left-color:var(--ag-text-muted)}
    .ctx-metric-observed{border-left-color:var(--ag-custom-speed,var(--ag-speed-default,#38bdf8))}
    .ctx-metric-convo{border-left-color:var(--ag-text-muted)}
    .ctx-metric-diagnosis{border-left-color:#10b981}
    .ctx-metric-diagnosis-val{font-size:10.5px;font-weight:500;line-height:1.4}
    .ctx-metric-diagnosis-val.is-confirmed{color:#10b981}
    .ctx-metric-diagnosis-val.is-mismatch{color:#ef4444}
    .ctx-metric-diagnosis-val.is-dispatched_pending_confirm,
    .ctx-metric-diagnosis-val.is-saved_pending_dispatch{color:#f59e0b}
    .ctx-metric-label{font-size:10.5px;color:var(--ag-text-muted);font-weight:500;padding-top:1px}
    .ctx-metric-value{font-size:11px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
    .ctx-metric-value-col{display:flex;flex-direction:column;gap:3px;min-width:0}
    .ctx-metric-side{font-size:9.5px;color:var(--ag-text-muted);white-space:nowrap;padding-top:2px}
    .ctx-metric-pre-restart{font-size:10px;color:var(--ag-text-muted);opacity:0.78}
    .ctx-metric-pre-restart[hidden],.ctx-metric-service-limit[hidden],.ctx-card-hints[hidden],.ctx-reset-notice[hidden]{display:none!important}
    .ctx-metric-service-limit{font-size:10.5px;color:#f59e0b;font-weight:500}
    .ctx-speed-effort-lines{display:flex;flex-direction:column;gap:2px;font-size:10.5px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .ctx-inline-link-btn{background:none;border:0;padding:0;color:var(--ag-link,#38bdf8);font-size:10.5px;font-weight:500;cursor:pointer;text-align:left;align-self:flex-start}
    .ctx-inline-link-btn:hover{text-decoration:underline}
    .ctx-card-hints{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;font-size:10.5px;color:var(--ag-text-secondary);line-height:1.4}
    .ctx-card-hint-item{padding:4px 7px;background:var(--ag-bg-subcard);border-radius:4px;border-left:2px solid var(--ag-ring-warn,#f59e0b)}

    /* 设置操作区 */
    .ctx-adjust-box{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 10px;display:flex;flex-direction:column;gap:7px}
    .ctx-small-label{font-size:10.5px;color:var(--ag-text-muted)}
    .ctx-model-select{background:var(--ag-bg-card);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard);border-radius:4px;padding:3px 6px;font-size:10.5px;width:100%;outline:none}
    .ctx-preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .ctx-preset-btn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;cursor:pointer;transition:all .15s ease;color:var(--ag-text-primary)}
    .ctx-preset-btn:hover:not(:disabled){background:var(--ag-bg-card-hover);border-color:var(--ag-text-muted)}
    .ctx-preset-btn.active{border-color:#2563eb;background:rgba(37,99,235,0.14);box-shadow:inset 0 0 0 1px rgba(37,99,235,0.35)}
    .ctx-preset-btn:disabled,.ctx-preset-btn.is-disabled{opacity:0.48;cursor:not-allowed;border-style:dashed}
    .ctx-preset-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-preset-sub{font-size:9.5px;color:var(--ag-text-secondary);line-height:1.25}
    .ctx-cap-ref-card{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:6px;margin-top:2px}
    .ctx-cap-ref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 10px}
    .ctx-cap-item{display:flex;flex-direction:column;gap:1px;min-width:0}
    .ctx-cap-item-wide{grid-column:1 / -1;border-top:1px dashed var(--ag-border-subtle);padding-top:4px;margin-top:1px}
    .ctx-cap-lbl{font-size:9.5px;color:var(--ag-text-muted);font-weight:500}
    .ctx-cap-val{font-size:11px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .ctx-cap-sub{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-cap-verify-strip{display:flex;flex-wrap:wrap;gap:6px 12px;border-top:1px dashed var(--ag-border-subtle);padding-top:5px;font-size:10px;color:var(--ag-text-secondary)}
    .ctx-cap-v-cell{display:inline-flex;align-items:center;gap:4px;min-width:0}
    .ctx-cap-v-cell em{font-style:normal;color:var(--ag-text-muted)}
    .ctx-cap-v-cell strong{font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums}
    .ctx-unified-proj{display:flex;flex-direction:column;gap:3px;border-top:1px dashed var(--ag-border-subtle);padding-top:5px;font-size:10px}
    .ctx-unified-proj-title{font-weight:600;color:var(--ag-text-primary);margin-bottom:1px}
    .ctx-unified-proj-row{display:flex;justify-content:space-between;gap:8px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .ctx-unified-proj-row.is-clamped strong{color:#f59e0b}
    .ctx-custom-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:1px}
    .ctx-custom-input-wrap{display:flex;align-items:center;flex:1;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:0 8px}
    .ctx-custom-input-wrap:focus-within{border-color:#2563eb}
    .ctx-custom-input{flex:1;min-width:0;background:transparent;border:none;color:var(--ag-text-primary);font-size:11px;padding:5px 0;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .ctx-input-unit{font-size:10px;color:var(--ag-text-muted);margin-left:4px}
    .ctx-validation-msg{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-validation-msg.is-error{color:#ef4444;font-weight:500}
    .ctx-validation-msg.is-warn{color:#eab308}
    .ctx-pref-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px}
    .ctx-text-action-btn{background:none;border:0;color:var(--ag-text-muted);font-size:11px;padding:4px 6px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
    .ctx-text-action-btn:hover{color:var(--ag-text-primary)}
    .ctx-reset-notice{font-size:10.5px;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.24);border-radius:5px;padding:5px 8px;line-height:1.4}
    .ctx-plain-help{font-size:10px;color:var(--ag-text-muted);line-height:1.45;border-top:1px dashed var(--ag-border-subtle);padding-top:6px}
    .ctx-detail-ol{padding-left:16px}

    /* 速度对比分页与 SVG 图表 */
    .ctx-speed-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .ctx-segmented{display:inline-flex;align-items:center;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px}
    .ctx-seg-btn{border:0;background:transparent;color:var(--ag-text-muted);font-size:10.5px;font-weight:500;padding:3px 7px;border-radius:4px;cursor:pointer;white-space:nowrap}
    .ctx-seg-btn:hover{color:var(--ag-text-primary)}
    .ctx-seg-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,0.2)}
    .ctx-chart-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}
    .ctx-chart-header{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
    .ctx-chart-title{font-size:11.5px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-speed-dropdown{min-width:170px;max-width:250px;flex:1}
    .ctx-svg-wrap{width:100%;overflow:hidden}
    .ctx-speed-svg{display:block;width:100%;height:auto;font-family:inherit}
    .ctx-chart-tooltip{position:absolute;z-index:30;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);border-radius:6px;padding:5px 8px;box-shadow:var(--ag-pop-shadow);font-size:10px;color:var(--ag-pop-text);line-height:1.4;max-width:220px}
    .ctx-chart-tooltip[hidden]{display:none!important}
    .ctx-chart-note{font-size:10px;color:var(--ag-text-muted);line-height:1.35}
    .ctx-speed-empty{font-size:11px;color:var(--ag-text-muted);text-align:center;padding:18px 8px;background:var(--ag-bg-subcard);border:1px dashed var(--ag-border-subcard);border-radius:6px}
    .ctx-speed-empty[hidden],.ctx-svg-wrap[hidden]{display:none!important}
    .ctx-active-test-note{font-size:10.5px;color:var(--ag-text-muted);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;line-height:1.4}

    /* 设置视图 */
    .ctx-settings-header{display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:4px;border-bottom:1px solid var(--ag-border-subtle)}
    .ctx-back-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer}
    .ctx-back-btn:hover{background:var(--ag-btn-hover)}
    .ctx-settings-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-settings-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px 11px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}
    .ctx-settings-card-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-settings-card-title{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-settings-card-desc{font-size:10.5px;color:var(--ag-text-muted);line-height:1.45}
    .ctx-lang-segmented{display:flex;width:100%;box-sizing:border-box}
    .ctx-lang-segmented .ctx-seg-btn{flex:1 1 0;min-width:0;text-align:center;padding:5px 8px;font-size:11px}
    .ctx-client-lang-note{font-size:10.5px;color:var(--ag-text-muted);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:6px 8px;margin-top:8px;line-height:1.45}
    .ctx-pref-actions{flex-wrap:wrap}
    .ctx-preset-btn{min-width:0}
    .ctx-preset-sub{overflow-wrap:anywhere}
    .ctx-metric-label{flex-shrink:0}
    .ctx-metric-value,.ctx-metric-side{min-width:0;overflow-wrap:anywhere}

    /* 结果框内联重启操作区与增强设置中心 */
    .unlock-result-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}
    .unlock-result-actions[hidden],.ctx-enhance-confirm[hidden],.ctx-preset-preview-box[hidden]{display:none!important}
    .ctx-result-manual-note{font-size:10px;color:var(--ag-text-secondary);line-height:1.4;margin-top:4px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:5px 7px}
    .ctx-selector-hint{font-size:10px;color:var(--ag-text-muted);line-height:1.35;margin-top:4px}

    .ctx-settings-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
    .ctx-enhance-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:2px 0}
    .ctx-enhance-stat{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:6px 8px;min-width:0}
    .ctx-enhance-stat-lbl{font-size:10px;color:var(--ag-text-muted);margin-bottom:2px}
    .ctx-enhance-stat-val{font-size:11px;font-weight:600;color:var(--ag-text-primary);overflow-wrap:anywhere}

    .ctx-tier-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
    .ctx-tier-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 4px;border-radius:6px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-secondary);cursor:pointer;text-align:center;min-width:0;transition:all .14s ease}
    .ctx-tier-btn:hover{background:var(--ag-bg-card-hover);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .ctx-tier-btn.active{background:rgba(37,99,235,0.16);border-color:#2563eb;color:var(--ag-text-primary);font-weight:600;box-shadow:inset 0 0 0 1px rgba(37,99,235,0.32)}
    .ctx-tier-num{font-size:11px;font-weight:700;line-height:1.1}
    .ctx-tier-name{font-size:10px;line-height:1.2;overflow-wrap:anywhere}

    .ctx-tier-matrix{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:4px;font-size:10.5px;line-height:1.4}
    .ctx-tier-matrix-title{font-weight:600;color:var(--ag-text-primary);margin-bottom:1px}
    .ctx-tier-matrix-row{display:grid;grid-template-columns:46px minmax(0,1fr);gap:6px;align-items:start}
    .ctx-tier-matrix-k{font-weight:600;color:var(--ag-text-muted);white-space:nowrap}
    .ctx-tier-matrix-v{color:var(--ag-text-secondary);overflow-wrap:anywhere}
    .ctx-tier-note-warn{font-size:10px;color:var(--ag-text-muted);background:rgba(234,179,8,0.07);border:1px solid rgba(234,179,8,0.22);border-radius:5px;padding:5px 8px;line-height:1.4}

    .ctx-toggle-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;cursor:pointer}
    .ctx-toggle-row-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
    .ctx-toggle-row-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-toggle-row-sub{font-size:10px;color:var(--ag-text-muted);line-height:1.35}

    .ctx-preset-checklist{display:flex;flex-direction:column;gap:5px}
    .ctx-preset-check-item{display:flex;align-items:flex-start;gap:7px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:6px 8px;cursor:pointer;font-size:10.5px;line-height:1.35}
    .ctx-preset-check-item input[type="checkbox"]{margin-top:2px;flex-shrink:0}
    .ctx-preset-check-meta{display:flex;flex-direction:column;gap:1px;min-width:0}
    .ctx-preset-check-meta strong{color:var(--ag-text-primary);font-size:11px}
    .ctx-preset-check-meta span{color:var(--ag-text-muted);font-size:10px}

    .ctx-enhance-confirm{background:rgba(234,179,8,0.09);border:1px solid rgba(234,179,8,0.32);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:6px;font-size:10.5px;line-height:1.4;color:var(--ag-text-primary)}
    .ctx-enhance-confirm-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
    .unlock-btn-danger{background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.35)}
    .unlock-btn-danger:hover:not(:disabled){background:rgba(239,68,68,0.2)}
    :host([data-theme="light"]) .unlock-btn-danger{color:#dc2626}

    @media (max-width:440px){
      .ctx-preset-grid{grid-template-columns:1fr}
      .ctx-tier-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .ctx-enhance-status-grid{grid-template-columns:1fr}
      .color-grid{grid-template-columns:1fr}
    }
    @media (prefers-reduced-motion: reduce){
      *,.ag-unit,.ring-fill,.key-bar-fill,.ag-panel,#context-tooltip,.heat-cell,.w-bar-fill{
        transition:none!important;animation:none!important;
      }
    }
    @media(max-width:500px){
      #panel{width:calc(100vw - 24px)}
    }
    @media(max-width:760px){
      #panel-tokens:not(.cost-compact-view){width:calc(100vw - 24px)}
    }
  </style>

  <!-- 顶部基本单元 1: 上下文小圆环 -->
  <button id="badge" class="ag-unit ag-unit-ring" type="button" aria-label="会话与上下文统计" data-i18n-aria="badge.aria" aria-describedby="context-tooltip" aria-expanded="false">
    <svg id="ring-svg" class="ring-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle id="ring-track" class="ring-track" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1"></circle>
      <circle id="ring-fill" class="ring-fill" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1" stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="3.2 4.97"></circle>
    </svg>
    <span id="badge-pct-val" class="badge-pct-val">--%</span>
    <div id="bar-wrap" class="sr-only" aria-hidden="true"><div id="bar-fill" class="meter-bar-fill"></div></div>
    <span id="amount" class="sr-only" data-i18n="badge.reading">读取中…</span>
    <span id="hover-wrap" class="sr-only"><span id="hover-extra"></span></span>
  </button>

  <!-- 顶部基本单元 2: 输出速度 (tok/s) -->
  <button id="badge-speed" class="ag-unit" type="button" aria-label="模型输出速度与耗时统计" data-i18n-aria="badge.speed.aria" aria-expanded="false">
    <span class="speed-icon" aria-hidden="true">⚡</span>
    <span id="speed-amount">-- tok/s</span>
    <span id="speed-hover-extra" class="sr-only"></span>
  </button>

  <!-- 顶部基本单元 3: 累计 Token 用量（细线统计图标） -->
  <button id="badge-tokens" class="ag-unit" type="button" aria-label="Token 用量一览" data-i18n-aria="badge.tokens.aria" aria-expanded="false">
    <span class="token-fire-dot" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13V9M8 13V4M13 13V7"></path></svg></span>
    <span id="token-amount">--</span>
    <span id="token-hover-extra" class="sr-only"></span>
  </button>

  <!-- 顶部基本单元 4: 一键启动 CLI 模式 -->
  <button id="badge-cli" class="ag-unit" type="button" aria-label="启动 CLI" data-i18n-aria="badge.cli.aria" title="一键启动 Antigravity CLI 终端（自动进入当前项目目录）" data-i18n-title="badge.cli.title">
    <span class="cli-icon" aria-hidden="true">&gt;_</span>
    <span id="cli-label">CLI</span>
  </button>

  <!-- 顶部基本单元 5: 窄屏溢出菜单按钮 -->
  <button id="badge-overflow" class="ag-unit" type="button" aria-label="更多统计指标" data-i18n-aria="badge.overflow.aria" aria-expanded="false">
    <svg class="overflow-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25"></circle>
      <circle cx="8" cy="8" r="1.25"></circle>
      <circle cx="12.5" cy="8" r="1.25"></circle>
    </svg>
  </button>

  <!-- CLI 启动反馈提示气泡 -->
  <div id="cli-launch-toast" hidden role="status" aria-live="polite"></div>

  <!-- 上下文圆环悬停/聚焦信息气泡（参考图三层结构） -->
  <div id="context-tooltip" role="tooltip" data-visible="false" data-placement="bottom">
    <div id="ctx-tip-title" class="ctx-tip-title" data-i18n="tip.title.default">上下文窗口：</div>
    <div id="ctx-tip-pct" class="ctx-tip-pct" data-i18n="tip.pct.notReady">数据尚未就绪</div>
    <div id="ctx-tip-detail" class="ctx-tip-detail" data-i18n="tip.detail.loading">正在读取当前会话上下文用量…</div>
  </div>

  <!-- 窄屏溢出菜单 -->
  <div id="overflow-menu" hidden aria-label="更多统计快捷菜单" data-i18n-aria="overflow.aria">
    <button id="overflow-speed-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span>⚡</span><span data-i18n="overflow.speed">输出速度</span></span>
      <span id="overflow-speed-val" class="overflow-item-val">-- tok/s</span>
    </button>
    <button id="overflow-tokens-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span class="token-fire-dot"></span><span data-i18n="overflow.tokens">Token 用量一览</span></span>
      <span id="overflow-tokens-val" class="overflow-item-val">--</span>
    </button>
    <button id="overflow-cli-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span class="cli-icon">&gt;_</span><span data-i18n="overflow.cli">启动 CLI 终端</span></span>
      <span id="overflow-cli-val" class="overflow-item-val">agy</span>
    </button>
  </div>

  <!-- 弹出式面板 1: 会话上下文与速度监控 (#panel, 450px) -->
  <section id="panel" class="ag-panel" hidden aria-label="会话与上下文详情" data-i18n-aria="panel.ctx.aria">
    <div class="panel-header-bar">
      <div class="panel-title">
        <span class="panel-title-text" style="font-size:13px;font-weight:600;color:var(--ag-text-primary)" data-i18n="panel.ctx.title">💬 当前会话上下文</span>
        <span id="v">v0.8.3</span>
      </div>
      <div class="panel-header-actions ctx-header-actions">
        <!-- 插件面板三语言快速切换分段按钮 -->
        <div id="panel-lang-top-segmented" class="ctx-segmented ctx-lang-top-segmented" role="group" aria-label="插件面板语言" data-i18n-aria="settings.panelLang.aria">
          <button id="btn-top-lang-zh-CN" class="ctx-seg-btn active" type="button" data-panel-lang="zh-CN" title="简体中文" aria-label="简体中文">简</button>
          <button id="btn-top-lang-zh-TW" class="ctx-seg-btn" type="button" data-panel-lang="zh-TW" title="繁體中文" aria-label="繁體中文">繁</button>
          <button id="btn-top-lang-en" class="ctx-seg-btn" type="button" data-panel-lang="en" title="English" aria-label="English">EN</button>
        </div>
        <button id="btn-github-repo-ctx" class="panel-icon-btn" type="button" aria-label="打开 GitHub 仓库" data-i18n-aria="header.github.aria" title="打开 GitHub 仓库" data-i18n-title="header.github.aria">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
        </button>
        <button id="btn-check-update-ctx" class="panel-icon-btn update-btn" type="button" aria-label="检查插件更新" data-i18n-aria="header.update.aria" title="检查插件更新" data-i18n-title="header.update.aria" style="position:relative">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8A6 6 0 1 1 8 2M14 2v6h-6"></path></svg>
          <span id="update-badge-dot-ctx" class="update-badge-dot" style="display:none"></span>
        </button>
        <button id="btn-panel-palette" class="panel-icon-btn" type="button" aria-label="外观与调色设置" data-i18n-aria="header.palette.aria" title="外观与调色设置" data-i18n-title="header.palette.aria">🎨</button>
        <button id="theme-toggle" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" data-i18n-aria="header.theme.aria" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）" data-i18n-title="header.theme.title">🌓</button>
        <button id="close" class="panel-icon-btn" type="button" aria-label="收起详情" data-i18n-aria="header.close.aria">×</button>
      </div>
    </div>

    <div id="view-context">
      <!-- 顶部 4 分页标签栏 -->
      <div id="ctx-tabs-bar" class="ctx-tabs-bar" role="tablist" aria-label="上下文面板分页" data-i18n-aria="tabs.aria">
        <button id="tab-ctx-session" class="ctx-tab-btn active" type="button" role="tab" aria-selected="true" data-ctx-tab="session" data-i18n="tab.session">当前会话</button>
        <button id="tab-ctx-models" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="models" data-i18n="tab.models">模型设置</button>
        <button id="tab-ctx-speed" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="speed" data-i18n="tab.speed">速度对比</button>
        <button id="tab-ctx-settings" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="settings" data-i18n="tab.settings">配置</button>
      </div>

      <!-- 分页 1: 当前会话 -->
      <div id="pane-ctx-session" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-session">
        <!-- 本轮与当前会话实时 API 等值参考行 -->
        <div id="round-cost-bar" class="round-cost-bar" title="当前模型调用的 API 等值参考金额（按已返回用量或实时生成估算）" data-i18n-title="session.costBar.title">
          <span id="round-cost-text" style="font-weight:600;color:var(--ag-text-primary)" data-i18n="session.roundCost.dash">本轮估值：—</span>
          <span id="session-cost-text" style="font-size:11px;color:var(--ag-text-muted)" data-i18n="session.sessionCost.dash">当前会话合计：—</span>
        </div>

        <!-- 卡片 1: 核心用量速览 -->
        <div id="key-summary">
          <div class="key-header"><span class="key-title" data-i18n="session.keySummary.title">⭐ 核心用量速览</span><span id="key-badge" class="key-pill pill-muted" data-i18n="session.badge.reading">读取中</span></div>
          <div class="key-bar-track"><div id="key-bar-fill" class="key-bar-fill"></div></div>
          <div class="key-stats"><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.used">当前已用</div><div id="key-used" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.limit">预算上限</div><div id="key-limit" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.remaining">剩余可用</div><div id="key-remaining" class="key-stat-val">—</div></div></div>
          <div id="key-takeaway" class="key-takeaway" data-i18n="session.keyTakeaway.loading">正在计算核心指标…</div>
        </div>

        <!-- 卡片 2: 输出速度与延迟速览 -->
        <div id="speed-summary" style="background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:8px 0 10px;">
          <div class="key-header">
            <span class="key-title" style="color:var(--ag-custom-speed,var(--ag-text-primary));" data-i18n="session.speedSummary.title">⚡ 最新生成速度与耗时</span>
            <span id="speed-badge" class="key-pill pill-muted" data-i18n="session.speed.pending">待生成</span>
          </div>
          <div class="key-stats" style="grid-template-columns:repeat(4,1fr);">
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.rate">输出速度</div>
              <div id="speed-val" class="key-stat-val" style="color:var(--ag-custom-speed,var(--ag-text-primary));">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.duration">生成耗时</div>
              <div id="speed-duration" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.ttft">首字延迟</div>
              <div id="speed-ttft" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.tokens">本次输出</div>
              <div id="speed-tokens" class="key-stat-val">—</div>
            </div>
          </div>
          <div id="speed-takeaway" class="key-takeaway" data-i18n="session.speed.wait">等待首次模型输出产生速度统计…</div>
        </div>

        <!-- 紧凑上下文设置入口卡片 -->
        <div id="ctx-compact-card" class="ctx-compact-card">
          <div class="ctx-compact-info">
            <div class="ctx-compact-title" data-i18n="session.compact.title">上下文设置</div>
            <div class="ctx-compact-meta">
              <span><span data-i18n="session.compact.savedLabel">本模型已保存：</span><strong id="ctx-compact-saved">未单独设置（使用默认）</strong></span>
              <span><span data-i18n="session.compact.clientLabel">客户端当前使用：</span><strong id="ctx-compact-client">状态读取中…</strong></span>
            </div>
          </div>
          <button id="btn-goto-model-settings" class="ctx-compact-link-btn" type="button" data-i18n="session.compact.gotoModels">去模型设置 ›</button>
        </div>

        <!-- 底层技术参数与附件审计 -->
        <div class="tech-drawer">
          <button id="btn-toggle-details" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left">
              <span data-i18n="session.techDrawer.title">📋 底层技术参数与附件审计</span>
            </span>
            <span id="drawer-arrow" class="drawer-arrow" data-i18n="session.techDrawer.expand">▼ 点击展开明细</span>
          </button>
          <div id="drawer-body" class="drawer-body" style="display:none;">
            <p id="status" data-i18n="session.tech.checking">正在核对请求和附件…</p><p id="model"></p>
            <h4 data-i18n="session.tech.latestReq">最近一次模型请求</h4>
            <dl><dt data-i18n="session.tech.reqStatus">请求状态</dt><dd id="request-status">—</dd><dt data-i18n="session.tech.actual">模型返回输入＋输出</dt><dd id="actual">—</dd><dt data-i18n="session.tech.estimate">客户端估算（可能漏附件）</dt><dd id="estimate">—</dd><dt data-i18n="session.tech.budget">客户端预算字段</dt><dd id="budget">—</dd><dt data-i18n="session.tech.serviceLimit">该次报错的服务端限制</dt><dd id="service-limit">—</dd><dt data-i18n="session.tech.percent">相对客户端预算</dt><dd id="percent">—</dd></dl>
            <h4 data-i18n="session.tech.sessionHeading">整个会话累计内容 · 本地估算</h4>
            <dl><dt data-i18n="session.tech.sessionTotal">可读取文本 token 估算</dt><dd id="session-total" data-i18n="session.tech.scanning">扫描中…</dd><dt data-i18n="session.tech.characters">实际读取文字字符数</dt><dd id="characters">—</dd><dt data-i18n="session.tech.user">用户消息</dt><dd id="user">—</dd><dt data-i18n="session.tech.assistant">模型回复</dt><dd id="assistant">—</dd><dt data-i18n="session.tech.thinking">可见思考内容</dt><dd id="thinking">—</dd><dt data-i18n="session.tech.tools">工具调用与工具输出</dt><dd id="tools">—</dd><dt data-i18n="session.tech.summaries">历史压缩摘要</dt><dd id="summaries">—</dd><dt data-i18n="session.tech.system">当前系统提示与工具定义</dt><dd id="system">—</dd><dt data-i18n="session.tech.attachments">上传／输出附件文本</dt><dd id="attachment-total">—</dd><dt data-i18n="session.tech.steps">历史步骤完整性</dt><dd id="steps">—</dd></dl>
            <p id="coverage"></p><h4 data-i18n="session.tech.filesHeading">附件逐项检查</h4><div id="files"></div><button id="refresh" type="button" data-i18n="session.tech.rescan">重新扫描整段会话与附件</button>
            <p id="note" data-i18n-html="session.tech.note">会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。</p>
            <p id="updated"></p>
          </div>
        </div>
      </div>

      <!-- 分页 2: 模型设置 -->
      <div id="pane-ctx-models" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-models" hidden>
        <!-- 1. 客户端状态条（全局一条） -->
        <div id="ctx-client-status-bar" class="ctx-status-bar">
          <div class="ctx-status-bar-main">
            <div class="ctx-status-left">
              <span id="ctx-client-status-text" class="ctx-client-status-text" data-i18n="status.client.reading">客户端当前使用：状态读取中…</span>
              <span id="unlock-badge" class="key-pill pill-muted" data-i18n="status.badge.reading">状态读取中…</span>
            </div>
            <div class="ctx-status-actions">
              <button id="btn-restart-host" class="unlock-btn unlock-btn-primary ctx-restart-btn" type="button" hidden data-i18n="models.restartBtn">重启客户端使设置生效</button>
            </div>
          </div>
          <div id="ctx-restart-mismatch-note" class="ctx-status-subnote" hidden></div>
          <div id="ctx-manual-restart-note" class="ctx-manual-restart-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。</div>
          <div id="ctx-restart-confirm" class="ctx-restart-confirm" hidden>
            <div class="ctx-restart-confirm-text" data-i18n="models.restartConfirm.text">重启会中断正在运行的任务。请先保存未保存的内容。</div>
            <div class="ctx-restart-confirm-actions">
              <button id="btn-restart-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
              <button id="btn-restart-confirm-go" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartConfirm.go">重启</button>
            </div>
          </div>
          <div id="ctx-restart-feedback" class="ctx-restart-feedback" hidden></div>
        </div>

        <!-- 2. 模式选择器（统一设置 vs 按模型分别设置） -->
        <div class="ctx-scope-selector-wrap" id="ctx-scope-selector-wrap">
          <div class="ctx-scope-mode-toggle" role="radiogroup" aria-label="上下文设置模式" data-i18n-aria="models.mode.aria">
            <button type="button" class="ctx-mode-tab-btn is-active" id="btn-ctx-mode-unified" data-mode="unified" role="radio" aria-checked="true">
              <span class="ctx-mode-tab-title" data-i18n="models.mode.unifiedTitle">所有模型统一设置</span>
              <span class="ctx-mode-tab-desc" data-i18n="models.mode.unifiedDesc">设置一次，所有模型使用相同的上下文长度。</span>
            </button>
            <button type="button" class="ctx-mode-tab-btn" id="btn-ctx-mode-per-model" data-mode="per_model" role="radio" aria-checked="false">
              <span class="ctx-mode-tab-title" data-i18n="models.mode.perModelTitle">按模型分别设置</span>
              <span class="ctx-mode-tab-desc" data-i18n="models.mode.perModelDesc">每个模型分别保存，使用哪个模型，就采用它的上下文长度。</span>
            </button>
          </div>
        </div>

        <!-- 3. 模型查看与切换条（仅在分别设置模式下呈现） -->
        <div class="ctx-models-toolbar" id="ctx-models-toolbar" hidden>
          <div class="ctx-header-model-ctrl">
            <span id="ctx-model-selector-role" class="ctx-selector-role-lbl" data-i18n="panel.ctx.viewModel">查看模型</span>
            <select id="ctx-model-select" class="ctx-model-select" aria-label="查看模型" data-i18n-aria="panel.ctx.viewModel" style="display:none"></select>
            <div id="ctx-model-dropdown-wrap" class="ag-dropdown-wrapper ctx-header-dropdown">
              <div id="ctx-model-dropdown-trigger" class="ag-dropdown-trigger ctx-compact-trigger" tabindex="0" title="按厂商查看不同模型的上下文设置" data-i18n-title="panel.ctx.viewModelTitle">
                <span id="ctx-model-dropdown-label" class="ag-dropdown-label" data-i18n="panel.ctx.loadingModels">正在读取模型…</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="ctx-model-dropdown-menu" class="ag-dropdown-menu ctx-model-dropdown-menu"></div>
            </div>
            <button id="btn-ctx-back-current" class="ctx-mini-link-btn" type="button" hidden title="回到当前会话正在使用的模型" data-i18n="panel.ctx.backCurrent" data-i18n-title="panel.ctx.backCurrentTitle">回到当前模型</button>
          </div>
          <div class="ctx-selector-hint" data-i18n="panel.ctx.viewModelHint">仅查看模型配置与实测数据；切换聊天模型请在输入框右侧选择。</div>
        </div>

        <!-- 4. 模型列表（按厂商分组，仅在分别设置模式下呈现） -->
        <div id="ctx-model-list" class="ctx-model-list" aria-label="按厂商分组的模型产品列表" data-i18n-aria="models.list.aria" hidden></div>

        <!-- 5. 选中模型的大卡片（主视图只展示当前模式、当前模型、当前使用长度；详细信息折叠至抽屉） -->
        <div id="ctx-model-card" class="ctx-detail-card">
          <div id="ctx-conflict-banner" class="ctx-conflict-banner" hidden>
            <div class="ctx-conflict-title" data-i18n="models.conflict.title">这个模型的不同档位保存过不同长度，请选一个统一值。</div>
            <div id="ctx-conflict-rows" class="ctx-conflict-rows"></div>
          </div>

          <div class="ctx-card-top">
            <div class="ctx-card-vendor-row">
              <span id="ctx-card-vendor-dot" class="ag-vendor-dot"></span>
              <span id="ctx-card-vendor-name" class="ctx-card-vendor-name">—</span>
            </div>
            <div id="ctx-card-product-name" class="ctx-card-product-name" data-i18n="models.card.waiting">等待读取模型…</div>
            <div class="ctx-card-efforts-row">
              <span id="ctx-card-efforts-list" class="ctx-card-efforts-list" data-i18n="models.card.effortsEmpty">可用档位：—</span>
              <span id="ctx-card-session-effort" class="ctx-card-session-effort" hidden>当前会话：—</span>
            </div>
          </div>

          <!-- 主界面极简核心展示区：当前模式、当前模型、当前使用长度 -->
          <div class="ctx-summary-highlight-grid" id="ctx-summary-highlight-grid">
            <div class="ctx-summary-item">
              <span class="ctx-summary-label" data-i18n="models.summary.mode">当前模式</span>
              <span class="ctx-summary-value" id="ctx-summary-mode" data-i18n="models.mode.unifiedTitle">所有模型统一设置</span>
            </div>
            <div class="ctx-summary-item">
              <span class="ctx-summary-label" data-i18n="models.summary.model">当前模型</span>
              <span class="ctx-summary-value" id="ctx-summary-model">—</span>
            </div>
            <div class="ctx-summary-item ctx-summary-item-length">
              <span class="ctx-summary-label" data-i18n="models.summary.length">目标设置与状态</span>
              <div class="ctx-summary-length-row">
                <span class="ctx-summary-value ctx-length-val" id="ctx-summary-length" data-i18n="models.summary.modelDefault">使用模型默认值</span>
                <span class="key-pill pill-muted" id="ctx-summary-status-pill" hidden>待重启生效</span>
              </div>
            </div>
          </div>

          <!-- 模型能力与当前生效参考（紧邻预算设置区，不隐藏） -->
          <div class="ctx-cap-ref-card" id="ctx-capability-ref">
            <div class="ctx-cap-ref-grid">
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.window">模型总窗口</span>
                <span class="ctx-cap-val" id="ctx-cap-window">—</span>
              </div>
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.output">最大输出</span>
                <span class="ctx-cap-val" id="ctx-cap-output">—</span>
              </div>
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.modelMax">模型理论输入上限</span>
                <span class="ctx-cap-val" id="ctx-cap-model-max">—</span>
              </div>
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.clientPolicy">当前客户端限制</span>
                <span class="ctx-cap-val" id="ctx-cap-client-policy">—</span>
              </div>
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.defaultCap">当前策略默认预算</span>
                <span class="ctx-cap-val" id="ctx-cap-default">—</span>
              </div>
              <div class="ctx-cap-item">
                <span class="ctx-cap-lbl" data-i18n="models.cap.range">当前可采纳输入范围</span>
                <span class="ctx-cap-val" id="ctx-cap-range">16,384 – 2,097,152</span>
              </div>
              <div class="ctx-cap-item ctx-cap-item-wide">
                <span class="ctx-cap-lbl" data-i18n="models.cap.formulaLbl">来源与计算说明</span>
                <span class="ctx-cap-sub" id="ctx-cap-formula">等待读取模型元数据…</span>
              </div>
            </div>
            <div class="ctx-cap-verify-strip" id="ctx-cap-verify-strip">
              <span class="ctx-cap-v-cell"><em data-i18n="models.cap.saved">已保存</em> <strong id="ctx-ref-saved">—</strong></span>
              <span class="ctx-cap-v-cell"><em data-i18n="models.cap.sent">最近请求携带</em> <strong id="ctx-ref-sent">尚无本次验证</strong></span>
              <span class="ctx-cap-v-cell"><em data-i18n="models.cap.adopted">后端实际采用</em> <strong id="ctx-ref-adopted">尚无本次验证</strong></span>
            </div>
            <div class="ctx-unified-proj" id="ctx-unified-projection" hidden></div>
          </div>

          <!-- 折叠抽屉：详细信息（配置来源、请求参数、底座状态、实测预算） -->
          <div class="ctx-card-details-drawer">
            <button id="btn-toggle-card-details" class="drawer-trigger ctx-card-drawer-trigger" aria-expanded="false" type="button">
              <span class="drawer-trigger-left" data-i18n="models.card.detailsToggle">详细信息（配置来源、请求参数与预算验证）</span>
              <span id="ctx-card-drawer-arrow" class="drawer-arrow" data-i18n="session.techDrawer.expand">▼ 点击展开明细</span>
            </button>
            <div id="ctx-card-drawer-body" class="drawer-body ctx-card-drawer-body" style="display:none;">
              <div class="ctx-card-metrics">
                <div class="ctx-metric-row ctx-metric-saved">
                  <span class="ctx-metric-label" data-i18n="models.card.saved">已保存</span>
                  <span class="ctx-metric-value" id="ctx-card-saved" data-i18n="status.savedDefault">未单独设置（使用默认）</span>
                  <span class="ctx-metric-side" data-i18n="models.card.savedSide">为这个模型记下的长度</span>
                </div>
                <div class="ctx-metric-row ctx-metric-request">
                  <span class="ctx-metric-label" data-i18n="models.card.request">请求携带</span>
                  <span class="ctx-metric-value" id="ctx-card-request">默认透传</span>
                  <span class="ctx-metric-side" data-i18n="models.card.requestSide">本次请求发送给底座的参数</span>
                </div>
                <div class="ctx-metric-row ctx-metric-client">
                  <span class="ctx-metric-label" data-i18n="models.card.client">底座状态</span>
                  <span class="ctx-metric-value">
                    <span id="ctx-card-client" data-i18n="status.badge.reading">状态读取中…</span>
                    <span id="ctx-card-client-tag" class="key-pill pill-muted" data-i18n="status.badge.reading">状态读取中…</span>
                  </span>
                  <span class="ctx-metric-side" data-i18n="models.card.clientSide">底座运行模式</span>
                </div>
                <div class="ctx-metric-row ctx-metric-observed">
                  <span class="ctx-metric-label" data-i18n="models.card.observedBudget">实测预算</span>
                  <div class="ctx-metric-value-col">
                    <span class="ctx-metric-value" id="ctx-card-observed-budget" data-i18n="models.card.observedBudgetNone">尚未观测</span>
                    <span class="ctx-metric-pre-restart" id="ctx-card-pre-restart-budget" hidden></span>
                    <span class="ctx-metric-service-limit" id="ctx-card-service-limit" hidden></span>
                  </div>
                  <span class="ctx-metric-side" data-i18n="models.card.observedBudgetSide">对话中实际分配</span>
                </div>
                <div class="ctx-metric-row ctx-metric-convo">
                  <span class="ctx-metric-label" data-i18n="models.card.convoIdTitle">对应会话</span>
                  <span class="ctx-metric-value" id="ctx-card-convo">—</span>
                  <span class="ctx-metric-side">发生调用的会话标识</span>
                </div>
                <div class="ctx-metric-row ctx-metric-diagnosis">
                  <span class="ctx-metric-label" data-i18n="models.card.diagnosisTitle">生效诊断</span>
                  <span class="ctx-metric-value" id="ctx-card-diagnosis">—</span>
                  <span class="ctx-metric-side">目标值与观测值比对结果</span>
                </div>
                <div class="ctx-metric-row ctx-metric-observed">
                  <span class="ctx-metric-label" data-i18n="models.card.observedSpeed">实测速度</span>
                  <div class="ctx-metric-value-col">
                    <div id="ctx-card-observed-speed" class="ctx-speed-effort-lines" data-i18n="models.card.observedSpeedNone">暂无实测数据</div>
                    <button id="btn-card-goto-speed" class="ctx-inline-link-btn" type="button" data-i18n="models.card.gotoSpeed">查看速度对比 ›</button>
                  </div>
                </div>
                <div class="ctx-metric-row ctx-metric-client" id="ctx-card-tier-caps-row" hidden>
                  <span class="ctx-metric-label" data-i18n="models.card.tierCaps">档位能力</span>
                  <div class="ctx-metric-value-col">
                    <div id="ctx-card-tier-caps" class="ctx-speed-effort-lines">—</div>
                  </div>
                </div>
              </div>
              <div id="ctx-card-hints" class="ctx-card-hints" hidden></div>
            </div>
          </div>
        </div>

        <!-- 4. 设置操作区 -->
        <div class="ctx-adjust-box" id="ctx-adjust-box">
          <div class="ctx-preset-grid" id="ctx-preset-grid" role="group" aria-label="上下文长度预设" data-i18n-aria="models.preset.aria">
            <button type="button" class="ctx-preset-btn" data-ctx-mode="default" data-ctx-limit="">
              <span class="ctx-preset-title" data-i18n="models.preset.default">恢复客户端默认</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.defaultSub">清除请求覆盖，由当前底座策略决定</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="fixed" data-ctx-limit="128000">
              <span class="ctx-preset-title">128,000</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.p128Sub">插件预设 · 128,000 tokens</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="fixed" data-ctx-limit="256000">
              <span class="ctx-preset-title">256,000</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.p256Sub">插件预设 · 256,000 tokens</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="fixed" data-ctx-limit="512000">
              <span class="ctx-preset-title">512,000</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.p512Sub">插件预设 · 512,000 tokens</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="model_max" data-ctx-limit="">
              <span class="ctx-preset-title" data-i18n="models.preset.modelMax">按模型最大可用</span>
              <span class="ctx-preset-sub" id="ctx-preset-modelmax-sub" data-i18n="models.preset.modelMaxSub">总窗口 - 最大输出（需元数据）</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="dynamic" data-ctx-limit="">
              <span class="ctx-preset-title" data-i18n="models.preset.dynamic">动态跟随</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.dynamicSub">不固定数值，按底座动态计算</span>
            </button>
          </div>

          <div class="ctx-custom-row">
            <label for="ctx-custom-limit-input" class="ctx-small-label" data-i18n="models.custom.label">自定义长度</label>
            <div class="ctx-custom-input-wrap">
              <input id="ctx-custom-limit-input" class="ctx-custom-input" type="text" inputmode="numeric" placeholder="输入整数，例如 300000" data-i18n-placeholder="models.custom.placeholder" autocomplete="off">
              <span class="ctx-input-unit">tokens</span>
            </div>
          </div>
          <div id="ctx-limit-validation" class="ctx-validation-msg" data-i18n="models.validation.defaultRange">可设置范围：16,384 – 2,097,152 tokens。</div>

          <div class="ctx-pref-actions">
            <button id="btn-save-model-ctx" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.save">保存</button>
            <button id="btn-apply-unlock" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.btn.saveApply">保存并应用</button>
            <button id="btn-reset-model-ctx" class="ctx-text-action-btn" type="button" data-i18n="models.btn.reset">恢复默认</button>
          </div>

          <div id="ctx-reset-notice" class="ctx-reset-notice" hidden></div>

          <div class="ctx-plain-help">
            <div data-i18n="models.help.line1">保存：记住当前模型的设置。底座引擎：一次性解除 256K 限制并启用动态跟随。</div>
            <div data-i18n="models.help.line2">各模型根据保存的设置独立生效，多会话与模型切换互不干扰。</div>
          </div>

          <div id="unlock-result-box" class="unlock-result-box" style="display:none;">
            <div id="unlock-result-text" class="unlock-result-text"></div>
            <div id="unlock-result-actions" class="unlock-result-actions" hidden>
              <button id="btn-unlock-result-restart" class="unlock-btn unlock-btn-primary" type="button" hidden data-i18n="models.restartBtn">重启客户端使设置生效</button>
              <button id="btn-unlock-result-retry" class="unlock-btn unlock-btn-secondary" type="button" hidden data-i18n="models.btn.retryApply">重新检测并应用</button>
            </div>
            <div id="unlock-result-manual" class="ctx-result-manual-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。</div>
          </div>
        </div>

        <!-- 5. 唯一保留的折叠区：详细说明 -->
        <div class="tech-drawer" id="context-unlock-drawer">
          <button id="btn-toggle-unlock-details" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left">
              <span data-i18n="models.details.title">详细说明</span>
            </span>
            <span id="unlock-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expand">▼ 展开</span>
          </button>
          <div id="unlock-drawer-body" class="drawer-body" style="display:none;">
            <div class="unlock-panel-content">
              <div class="unlock-notice">
                <ol class="unlock-notice-list ctx-detail-ol">
                  <li data-i18n-html="models.details.li1"><strong>底座解锁与按模型请求注入的分工</strong>：客户端语言服务原版会对默认与回落预算实施 256,000 tokens 钳位（256K 限制点），并允许远程实验覆写。底座解锁用于一次性开启「动态跟随（Dynamic）」默认策略并屏蔽远程实验覆写；每次发送消息时，插件再按当次请求实际选中的模型在请求参数 <code>checkpointConfig.maxTokenLimit</code> 中写入你设定的预算。若设定超过 256,000 tokens，仍需底座处于「动态跟随」已解锁状态。</li>
                  <li data-i18n-html="models.details.li2"><strong>多项安全检查点说明</strong>：客户端包含默认/钳位双检查点、远程实验覆写拦截点以及上下文窗口序列上限检查点；本插件只依赖本地偏好配合每次请求参数写入实现按模型隔离，不会在切换模型时反复改写宿主程序文件。</li>
                  <li data-i18n-html="models.details.li3"><strong>恢复客户端默认 vs 按模型最大可用</strong>：「恢复客户端默认」仅清除请求级覆盖参数，把决定权交回当前语言服务的全局策略（若已开启「动态跟随」则走模型动态默认，无法逐模型单切回原版 256K 钳位）；「按模型最大可用」则按 IDE 元数据公式 <code>maxTokens - maxOutputTokens</code> 计算并显式发送该整数上限。</li>
                  <li data-i18n-html="models.details.li4"><strong>几个数字的区别</strong>：
                    <div>模型总窗口 / 最大输出：来自 IDE 模型目录与步骤元数据，不代表实际已分配配额。</div>
                    <div>已保存：你为当前模型或统一模式保存的目标值。</div>
                    <div>最近请求携带 / 后端实际采用：按当前会话与模型轮次严格隔离对照，尚无对应发送时显示「尚无本次验证」。</div>
                    <div>服务端报错上限：仅当请求被服务端拒绝且报错给出明确数字时出现。</div>
                  </li>
                  <li data-i18n-html="models.details.li5"><strong>工程范围与预设说明</strong>：128,000 / 256,000 / 512,000 属于插件预设；合法自定义工程范围为 16,384 – 2,097,152 任意整数 tokens，真实超长请求能否被服务端接受取决于各模型自身配额与风控策略。</li>
                </ol>
              </div>

              <div class="unlock-actions-row">
                <button id="btn-restore-unlock" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.restoreOriginal">客户端恢复原始设置</button>
                <button id="btn-refresh-unlock" class="unlock-btn unlock-btn-secondary" type="button" title="重新检测状态" data-i18n="models.btn.refreshStatus" data-i18n-title="models.btn.refreshStatus">刷新状态</button>
              </div>

              <div id="unlock-status-desc" class="unlock-desc" style="margin-top:8px;" data-i18n="models.status.detecting">正在检测当前 Antigravity 状态…</div>
              <dl class="unlock-meta-dl">
                <dt data-i18n="models.meta.mode">当前配置 / 实测</dt><dd id="unlock-meta-mode">—</dd>
                <dt data-i18n="models.meta.target">目标进程</dt><dd id="unlock-meta-target">—</dd>
                <dt data-i18n="models.meta.arch">系统架构</dt><dd id="unlock-meta-arch">—</dd>
                <dt data-i18n="models.meta.backup">原版备份状态</dt><dd id="unlock-meta-backup">—</dd>
              </dl>

              <div class="unlock-credit-bar">
                <div class="unlock-credit-left">
                  <span class="unlock-credit-lbl" data-i18n="models.credit.source">方案来源：</span>
                  <a id="link-unlock-author" href="https://linux.do/t/topic/3117832" target="_blank" rel="noopener noreferrer" class="unlock-author-link" role="link" tabindex="0" title="点击在系统默认浏览器中打开原作者帖子" data-i18n="models.credit.author">原作者帖子 (Linux.do @23375) ↗</a>
                  <button id="btn-copy-unlock-link" class="unlock-copy-link-btn" type="button" title="复制原作者帖子链接" data-i18n="models.credit.copy">📋 复制链接</button>
                </div>
                <span class="unlock-adapter-note" data-i18n="models.credit.adapter">本项目负责 Node.js 适配与集成</span>
              </div>
              <div id="unlock-link-toast" class="unlock-link-toast" style="display:none;" role="status"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 分页 3: 速度对比 -->
      <div id="pane-ctx-speed" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-speed" hidden>
        <div class="ctx-speed-toolbar">
          <div class="ctx-segmented" role="group" aria-label="时间范围" data-i18n-aria="speed.range.aria">
            <button id="speed-range-7d" class="ctx-seg-btn active" type="button" data-speed-range="7" data-i18n="speed.range.7d">近 7 天</button>
            <button id="speed-range-30d" class="ctx-seg-btn" type="button" data-speed-range="30" data-i18n="speed.range.30d">近 30 天</button>
            <button id="speed-range-all" class="ctx-seg-btn" type="button" data-speed-range="all" data-i18n="speed.range.all">全部</button>
          </div>
          <div id="speed-origin-filter-wrap" class="ctx-segmented" role="group" aria-label="样本来源" data-i18n-aria="speed.origin.aria">
            <button id="speed-origin-all" class="ctx-seg-btn active" type="button" data-speed-origin="all" data-i18n="speed.origin.all">全部来源</button>
            <button id="speed-origin-chat" class="ctx-seg-btn" type="button" data-speed-origin="chat" data-i18n="speed.origin.chat">日常对话</button>
          </div>
        </div>

        <!-- 柱状图卡片 -->
        <div class="ctx-chart-card">
          <div class="ctx-chart-header">
            <span id="speed-bar-title" class="ctx-chart-title" data-i18n="speed.barTitle.tps">输出速度对比</span>
            <div class="ctx-segmented" role="group" aria-label="对比指标" data-i18n-aria="speed.metric.aria">
              <button id="speed-metric-tps" class="ctx-seg-btn active" type="button" data-speed-metric="tps" data-i18n="speed.metric.tps">输出速度</button>
              <button id="speed-metric-ttft" class="ctx-seg-btn" type="button" data-speed-metric="ttft" data-i18n="speed.metric.ttft">首字延迟</button>
              <button id="speed-metric-duration" class="ctx-seg-btn" type="button" data-speed-metric="duration" data-i18n="speed.metric.duration">总耗时</button>
            </div>
          </div>
          <div id="speed-bar-empty" class="ctx-speed-empty" hidden data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
          <div id="speed-bar-chart-wrap" class="ctx-svg-wrap" style="position:relative;">
            <svg id="speed-bar-svg" class="ctx-speed-svg" role="img" aria-label="各模型与档位速度对比柱状图" data-i18n-aria="speed.barSvg.aria"></svg>
            <div id="speed-bar-tooltip" class="ctx-chart-tooltip" hidden></div>
          </div>
          <div id="speed-bar-note" class="ctx-chart-note" data-i18n="speed.barNote">以各模型与档位的中位数统计；不足 3 条标注“样本少”。总耗时受输出长度影响，条件相近时才可比较。</div>
        </div>

        <!-- 单模型折线图卡片 -->
        <div class="ctx-chart-card">
          <div class="ctx-chart-header ctx-line-header">
            <span class="ctx-chart-title" data-i18n="speed.lineTitle">单模型速度趋势</span>
            <div id="speed-model-dropdown-wrap" class="ag-dropdown-wrapper ctx-speed-dropdown">
              <div id="speed-model-dropdown-trigger" class="ag-dropdown-trigger ctx-compact-trigger" tabindex="0" title="选择一个模型与档位查看速度变化" data-i18n-title="speed.linePickTitle">
                <span id="speed-model-dropdown-label" class="ag-dropdown-label" data-i18n="speed.lineNoModel">暂无模型记录</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="speed-model-dropdown-menu" class="ag-dropdown-menu"></div>
            </div>
          </div>
          <div id="speed-line-empty" class="ctx-speed-empty" data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
          <div id="speed-line-chart-wrap" class="ctx-svg-wrap" style="position:relative;" hidden>
            <svg id="speed-line-svg" class="ctx-speed-svg" role="img" aria-label="所选模型与档位历史输出速度折线图" data-i18n-aria="speed.lineSvg.aria"></svg>
            <div id="speed-line-tooltip" class="ctx-chart-tooltip" hidden></div>
          </div>
        </div>

        <div id="speed-active-test-note" class="ctx-active-test-note" data-i18n="speed.activeTestNote">主动测试：未接通。目前没有可靠的指定模型调用入口，暂时只能使用日常对话的实测记录。</div>
      </div>

      <!-- 设置与系统配置 (第四分页: 配置 / setting) -->
      <div id="pane-ctx-settings" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-settings" hidden>
        <!-- 1. 一键推荐配置与总览（默认不自动应用，需用户预览勾选并确认） -->
        <div class="ctx-settings-card" id="enhance-preset-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="enhance.preset.title">✨ 一键推荐配置（按需勾选预览）</div>
            <span id="enhance-global-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <div class="ctx-settings-card-desc" data-i18n="enhance.preset.desc">正常安装默认保持客户端原样。下方列出推荐增强组合；只有你勾选并确认后才会实际写入。</div>
          <div class="ctx-preset-checklist">
            <label class="ctx-preset-check-item">
              <input id="chk-rec-prompt" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemPrompt">系统提示词 4 档（极简防幻觉）</strong>
                <span data-i18n="enhance.preset.itemPromptSub">精简模板套话并保留真实工具契约；仅作用于系统提示，不能保证模型永不犯错。</span>
              </div>
            </label>
            <label class="ctx-preset-check-item">
              <input id="chk-rec-title" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemTitle">自动中文会话标题</strong>
                <span data-i18n="enhance.preset.itemTitleSub">新会话自动生成简体中文标题（等长替换指令文本，不破坏结构）。</span>
              </div>
            </label>
            <label class="ctx-preset-check-item">
              <input id="chk-rec-lang" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemLang">客户端简体中文界面（Antigravity 本身）</strong>
                <span data-i18n="enhance.preset.itemLangSub">仅改变桌面端壳层中文，不影响你选择的插件面板语言。</span>
              </div>
            </label>
            <label class="ctx-preset-check-item">
              <input id="chk-rec-ctx" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemCtx">上下文模式：跟随模型</strong>
                <span data-i18n="enhance.preset.itemCtxSub">按模型各自支持的最大长度运行，不硬锁固定 983,040 或 512,000。</span>
              </div>
            </label>
          </div>
          <div class="ctx-settings-card-actions">
            <button id="btn-enhance-preset-apply" class="unlock-btn unlock-btn-primary" type="button" data-i18n="enhance.preset.applyBtn">应用所选推荐配置</button>
            <button id="btn-enhance-restore-all" class="unlock-btn unlock-btn-danger" type="button" data-i18n="enhance.restoreAll.btn">全部恢复官方默认</button>
          </div>
          <div id="enhance-preset-confirm" class="ctx-enhance-confirm" hidden>
            <div id="enhance-preset-confirm-text"></div>
            <div class="ctx-enhance-confirm-actions">
              <button id="btn-enhance-confirm-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
              <button id="btn-enhance-confirm-go" class="unlock-btn unlock-btn-primary" type="button" data-i18n="enhance.confirm.go">确认应用</button>
            </div>
          </div>
          <div id="enhance-global-result" class="unlock-result-box" style="display:none;">
            <div id="enhance-global-result-text" class="unlock-result-text"></div>
            <div id="enhance-global-result-actions" class="unlock-result-actions" hidden>
              <button id="btn-enhance-restart-ls" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="enhance.btn.restartLs">重启语言服务</button>
              <button id="btn-enhance-restart-host" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartBtn">重启客户端使设置生效</button>
            </div>
            <div id="enhance-global-manual-note" class="ctx-result-manual-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。</div>
          </div>
        </div>

        <!-- 2. 客户端界面语言与品牌标题 (Antigravity 本身) -->
        <div class="ctx-settings-card" id="client-brand-lang-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="settings.clientLang.title">🖥️ 客户端界面语言与品牌（Antigravity 本身）</div>
            <span id="chinese-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <div id="chinese-status-desc" class="ctx-settings-card-desc" data-i18n="settings.clientLang.detecting">正在检测桌面端汉化运行状态…</div>
          <div class="ctx-segmented ctx-lang-segmented" id="client-lang-segmented" role="group" aria-label="客户端界面语言" data-i18n-aria="settings.clientLang.aria">
            <button id="btn-client-lang-zh-CN" class="ctx-seg-btn" type="button" data-client-lang="zh-CN">简体中文</button>
            <button id="btn-client-lang-en" class="ctx-seg-btn" type="button" data-client-lang="en">English</button>
          </div>
          <div class="ctx-small-label" style="margin-top:8px" data-i18n="enhance.brand.label">左上角品牌文字显示（仅作用于左上角品牌位，不影响 Logo、菜单或代码）：</div>
          <div class="ctx-segmented ctx-lang-segmented" id="brand-title-segmented" role="group" aria-label="品牌名称选项" data-i18n-aria="enhance.brand.aria">
            <button id="btn-brand-english" class="ctx-seg-btn active" type="button" data-brand-title="english" data-i18n="enhance.brand.english">Antigravity (英文原样)</button>
            <button id="btn-brand-hidden" class="ctx-seg-btn" type="button" data-brand-title="hidden" data-i18n="enhance.brand.hidden">隐藏品牌字样</button>
            <button id="btn-brand-translated" class="ctx-seg-btn" type="button" data-brand-title="translated" data-i18n="enhance.brand.translated">反重力</button>
          </div>
          <div id="brand-apply-feedback" class="ctx-brand-feedback" style="display:none;"></div>
          <div id="client-lang-license-note" class="ctx-client-lang-note" data-i18n="settings.clientLang.licenseNote">说明：此设置控制 Antigravity 客户端本身，与顶部插件面板语言相互独立。切换客户端语言或品牌标题在保存后需重启客户端完全生效。</div>
          <div class="ctx-settings-card-actions">
            <button id="btn-toggle-chinese-module" class="unlock-btn unlock-btn-primary" type="button" data-i18n="settings.clientLang.toggle">切换汉化状态</button>
            <button id="btn-apply-brand-title" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="enhance.brand.applyBtn">保存品牌选择并应用</button>
          </div>
        </div>

        <!-- 3. 回答与工具使用规则 (原防幻觉档位) 与自动中文标题 -->
        <div class="ctx-settings-card" id="enhance-prompt-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="enhance.prompt.title">🧠 回答与工具使用规则</div>
            <span id="enhance-prompt-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <!-- 第一层：默认可见的白话说明 -->
          <div class="ctx-plain-help" style="margin:4px 0 8px 0;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px;">
            <div style="font-size:11.5px;line-height:1.55;color:var(--ag-text-primary);" data-i18n="enhance.prompt.plainIntro">
              调整客户端给 AI 的工作说明，让它更重视证据：没读过的文件不猜，没运行的测试不说通过。它不会升级模型底层能力，也不能保证回答永远正确。
            </div>
            <div id="enhance-tier-current-desc" style="font-size:11px;line-height:1.5;color:var(--ag-text-secondary);margin-top:4px;">
              当前档位说明加载中…
            </div>
          </div>
          <div class="ctx-enhance-status-grid">
            <div class="ctx-enhance-stat">
              <div class="ctx-enhance-stat-lbl" data-i18n="enhance.stat.prompt">当前检测档位</div>
              <div id="enhance-stat-prompt" class="ctx-enhance-stat-val">—</div>
            </div>
            <div class="ctx-enhance-stat">
              <div class="ctx-enhance-stat-lbl" data-i18n="enhance.stat.title">自动中文标题</div>
              <div id="enhance-stat-title" class="ctx-enhance-stat-val">—</div>
            </div>
            <div class="ctx-enhance-stat">
              <div class="ctx-enhance-stat-lbl" data-i18n="enhance.stat.evidence">证据检测状态</div>
              <div id="enhance-stat-slots" class="ctx-enhance-stat-val">—</div>
            </div>
            <div class="ctx-enhance-stat">
              <div class="ctx-enhance-stat-lbl" data-i18n="enhance.stat.backup">原版内核备份</div>
              <div id="enhance-stat-backup" class="ctx-enhance-stat-val">—</div>
            </div>
          </div>
          <div id="enhance-tier-grid" class="ctx-tier-grid" role="group" aria-label="规则档位" data-i18n-aria="enhance.prompt.aria">
            <button id="enhance-tier-0" class="ctx-tier-btn" type="button" data-enhance-tier="0">
              <span class="ctx-tier-num">0</span>
              <span class="ctx-tier-name" data-i18n="enhance.tier.0.short">原版</span>
            </button>
            <button id="enhance-tier-1" class="ctx-tier-btn" type="button" data-enhance-tier="1">
              <span class="ctx-tier-num">1</span>
              <span class="ctx-tier-name" data-i18n="enhance.tier.1.short">基础</span>
            </button>
            <button id="enhance-tier-2" class="ctx-tier-btn" type="button" data-enhance-tier="2">
              <span class="ctx-tier-num">2</span>
              <span class="ctx-tier-name" data-i18n="enhance.tier.2.short">精简</span>
            </button>
            <button id="enhance-tier-3" class="ctx-tier-btn" type="button" data-enhance-tier="3">
              <span class="ctx-tier-num">3</span>
              <span class="ctx-tier-name" data-i18n="enhance.tier.3.short">深度</span>
            </button>
            <button id="enhance-tier-4" class="ctx-tier-btn" type="button" data-enhance-tier="4">
              <span class="ctx-tier-num">4</span>
              <span class="ctx-tier-name" data-i18n="enhance.tier.4.short">极简</span>
            </button>
          </div>
          <div id="enhance-tier-matrix" class="ctx-tier-matrix">
            <div id="enhance-tier-matrix-title" class="ctx-tier-matrix-title">—</div>
            <div class="ctx-tier-matrix-row">
              <span class="ctx-tier-matrix-k" data-i18n="enhance.matrix.keeps">保留</span>
              <span id="enhance-tier-keeps" class="ctx-tier-matrix-v">—</span>
            </div>
            <div class="ctx-tier-matrix-row">
              <span class="ctx-tier-matrix-k" data-i18n="enhance.matrix.clears">清空</span>
              <span id="enhance-tier-clears" class="ctx-tier-matrix-v">—</span>
            </div>
            <div class="ctx-tier-matrix-row">
              <span class="ctx-tier-matrix-k" data-i18n="enhance.matrix.replaces">替换</span>
              <span id="enhance-tier-replaces" class="ctx-tier-matrix-v">—</span>
            </div>
            <div class="ctx-tier-matrix-row">
              <span class="ctx-tier-matrix-k" data-i18n="enhance.matrix.meaning">对你的影响</span>
              <span id="enhance-tier-meaning" class="ctx-tier-matrix-v">—</span>
            </div>
          </div>
          <div id="enhance-hallucination-note" class="ctx-tier-note-warn" data-i18n="enhance.hallucinationNote">说明：规则档位通过精简冗余指引并强化真实工具核对来规范行为。高档位删减提示模板中的工作指引，不等于删除用户文件或工件本身；是否影响具体能力需在对话中实际验证。</div>
          <label class="ctx-toggle-row">
            <div class="ctx-toggle-row-text">
              <span class="ctx-toggle-row-title" data-i18n="enhance.titlePatch.label">自动生成简体中文会话标题</span>
              <span class="ctx-toggle-row-sub" data-i18n="enhance.titlePatch.sub">等长替换会话命名提示词，不破坏原有长度对齐；支持随时改回官方英文。</span>
            </div>
            <input id="chk-enhance-chinese-title" type="checkbox">
          </label>
          <div class="ctx-settings-card-actions">
            <button id="btn-enhance-apply-prompt" class="unlock-btn unlock-btn-primary" type="button" data-i18n="enhance.btn.applyPrompt">应用提示词与标题设置</button>
            <button id="btn-enhance-refresh" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.refreshStatus">刷新状态</button>
          </div>
          <div id="enhance-prompt-result" class="unlock-result-box" style="display:none;">
            <div id="enhance-prompt-result-text" class="unlock-result-text"></div>
          </div>

          <!-- 第二层：可展开的“详细说明” -->
          <div class="tech-drawer" id="enhance-details-drawer" style="margin-top:4px">
            <button id="btn-toggle-enhance-details" class="drawer-trigger" aria-expanded="false" type="button">
              <span class="drawer-trigger-left" data-i18n="enhance.details.toggle">详细说明：来源范围、三层状态与检测依据</span>
              <span id="enhance-details-arrow" class="drawer-arrow" data-i18n="drawer.expand">▼ 展开</span>
            </button>
            <div id="enhance-details-body" class="drawer-body" style="display:none;">
              <div class="unlock-panel-content">
                <div class="unlock-notice">
                  <div class="unlock-desc" data-i18n="enhance.details.body">方案来源：PR #4 (Jia131313) 与 PR #3 (anyu0804 / Linux.do @23375)，由本项目进行本地适配、工具契约安全核对与多语言整合。<br><br>
                  <strong>修改目标程序</strong>：仅修改本地桌面端语言服务核心程序内嵌模板表；不改动任何云端模型，亦不影响 CLI 以外的外部环境。<br><br>
                  <strong>三层状态区别</strong>：<br>
                  1. <strong>写入状态</strong>：检测目标程序磁盘文件已覆写指定槽位（安全空格对齐填充，零结构偏移）。<br>
                  2. <strong>服务加载状态</strong>：需完全退出并重启客户端后，由新启动的语言服务进程加载读取。<br>
                  3. <strong>行为效果验证</strong>：提示词仅是 AI 的工作指南，不能保证永不犯错；实际表现需由用户在真实会话中体验，不宣称数学上的绝对消除。</div>
                </div>
                <div id="enhance-binary-list" class="unlock-desc" style="margin-top:6px;"></div>
                <div class="unlock-credit-row">
                  <span class="unlock-credit-lbl" data-i18n="enhance.details.credit">恢复操作：点击上方“全部恢复官方默认”将无损还原官方备份模板。</span>
                </div>
              </div>
            </div>
          </div>
        </div>
          </div>
        </div>

        <!-- 保留：兼容隐藏旧中文折叠触发节点以防测试脚本寻找该 ID -->
        <div id="chinese-i18n-drawer" hidden>
          <button id="btn-toggle-chinese" type="button" hidden></button>
          <div id="chinese-drawer-body" style="display:none;"><span id="chinese-drawer-arrow"></span></div>
        </div>

        <!-- 5. 免 TUN 网络直连 (AntigravityProxyNoTun) -->
        <div class="tech-drawer" id="proxy-notun-drawer">
          <button id="btn-toggle-proxy" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left">
              <span data-i18n="settings.proxy.title">🌐 免 TUN 网络直连（本地代理）</span>
              <span id="proxy-badge" class="key-pill pill-muted" style="margin-left:6px;font-size:10.5px;" data-i18n="settings.common.reading">读取中…</span>
            </span>
            <span id="proxy-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expand">▼ 展开</span>
          </button>
          <div id="proxy-drawer-body" class="drawer-body" style="display:none;">
            <div class="unlock-panel-content">
              <div class="unlock-status-row">
                <div class="unlock-status-meta">
                  <div class="unlock-label" data-i18n="settings.proxy.statusLabel">代理直连配置与状态</div>
                  <div id="proxy-status-desc" class="unlock-desc" data-i18n="settings.proxy.checking">正在核对代理设置…</div>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px;margin:8px 0;">
                <label style="font-size:11px;color:var(--ag-text-secondary);display:flex;flex-direction:column;gap:4px;">
                  <span data-i18n="settings.proxy.urlLabel">本地代理地址 (例如 http://127.0.0.1:7897 或 socks5://...)：</span>
                  <input id="input-proxy-url" type="text" class="unlock-input" style="padding:4px 8px;font-size:11px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:4px;" value="http://127.0.0.1:7897" />
                </label>
                <label style="font-size:11px;color:var(--ag-text-secondary);display:flex;flex-direction:column;gap:4px;">
                  <span data-i18n="settings.proxy.bypassLabel">绕过代理列表 (NO_PROXY)：</span>
                  <input id="input-proxy-bypass" type="text" class="unlock-input" style="padding:4px 8px;font-size:11px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:4px;" value="localhost,127.0.0.1,::1,<local>" />
                </label>
              </div>
              <div class="unlock-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="btn-test-proxy" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="settings.proxy.testBtn">🔍 测试代理连通性</button>
                <button id="btn-toggle-proxy-module" class="unlock-btn unlock-btn-primary" type="button" data-i18n="mod.proxy.btnEnable">开启免 TUN 直连</button>
              </div>
              <div id="proxy-test-result" style="font-size:11px;margin-top:6px;display:none;color:var(--ag-text-secondary);"></div>
            </div>
          </div>
        </div>

        <!-- 6. 面板背景与指标颜色自定义 -->
        <div class="tech-drawer">
          <button id="btn-toggle-colors" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left"><span data-i18n="settings.colors.title">🎨 指标与背景颜色自定义（默认跟随主题）</span></span>
            <span id="color-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expandSettings">▼ 展开设置</span>
          </button>
          <div id="color-drawer-body" class="drawer-body" style="display:none;">
            <div class="color-grid">
              <div class="color-item" style="grid-column:1 / -1">
                <span class="color-item-lbl" data-i18n="settings.colors.panelBg">面板与菜单统一背景色（0级跟随 / 自定义）</span>
                <div class="color-item-ctrls">
                  <input id="color-panelBg" class="color-picker" type="color" value="#181818" data-i18n-aria="settings.colors.panelBg" aria-label="面板背景色" />
                  <button id="swatch-panelBg" class="color-swatch-btn" type="button" data-color-slot="panelBg" data-color-label="面板与菜单背景色" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-panelBg" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.ringUsed">圆环已用部分</span>
                <div class="color-item-ctrls">
                  <input id="color-ringUsed" class="color-picker" type="color" value="#e6e6eb" data-i18n-aria="settings.colors.ringUsed" aria-label="上下文圆环已用部分颜色" />
                  <button id="swatch-ringUsed" class="color-swatch-btn" type="button" data-color-slot="ringUsed" data-color-label="圆环已用部分" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-ringUsed" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.ringTrack">圆环轨道</span>
                <div class="color-item-ctrls">
                  <input id="color-ringTrack" class="color-picker" type="color" value="#52525b" data-i18n-aria="settings.colors.ringTrack" aria-label="圆环轨道颜色" />
                  <button id="swatch-ringTrack" class="color-swatch-btn" type="button" data-color-slot="ringTrack" data-color-label="圆环轨道" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-ringTrack" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.contextText">上下文用量文字</span>
                <div class="color-item-ctrls">
                  <input id="color-contextText" class="color-picker" type="color" value="#ececef" data-i18n-aria="settings.colors.contextText" aria-label="上下文用量文字颜色" />
                  <button id="swatch-contextText" class="color-swatch-btn" type="button" data-color-slot="contextText" data-color-label="上下文用量文字" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-contextText" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.speedText">输出速度</span>
                <div class="color-item-ctrls">
                  <input id="color-speedText" class="color-picker" type="color" value="#38bdf8" data-i18n-aria="settings.colors.speedText" aria-label="输出速度颜色" />
                  <button id="swatch-speedText" class="color-swatch-btn" type="button" data-color-slot="speedText" data-color-label="输出速度" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-speedText" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.tokenTotal">累计 token 用量</span>
                <div class="color-item-ctrls">
                  <input id="color-tokenTotal" class="color-picker" type="color" value="#c084fc" data-i18n-aria="settings.colors.tokenTotal" aria-label="累计 token 用量颜色" />
                  <button id="swatch-tokenTotal" class="color-swatch-btn" type="button" data-color-slot="tokenTotal" data-color-label="累计 token 用量" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-tokenTotal" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.tokenAccent">其他 token 指标</span>
                <div class="color-item-ctrls">
                  <input id="color-tokenAccent" class="color-picker" type="color" value="#a78bfa" data-i18n-aria="settings.colors.tokenAccent" aria-label="其他 token 指标颜色" />
                  <button id="swatch-tokenAccent" class="color-swatch-btn" type="button" data-color-slot="tokenAccent" data-color-label="其他 token 指标" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-tokenAccent" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:7px">
              <span style="font-size:10.5px;color:var(--ag-text-muted)" data-i18n="settings.colors.note">注：高占用与超限告警色独立保留，不被常态颜色覆盖。</span>
              <button id="reset-all-colors" class="color-reset-btn" type="button" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全局统一居中重启确认模态弹窗（立即可见，支持顶部、底部与配置区所有重启入口） -->
    <div id="global-restart-modal" class="ag-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="modal-restart-title">
      <div class="ag-modal-card">
        <div id="modal-restart-title" class="ag-modal-title" data-i18n="models.restartConfirm.title">重启 Antigravity 客户端</div>
        <div id="modal-restart-text" class="ag-modal-body" data-i18n="models.restartConfirm.text">重启会中断正在运行的任务。请先保存未保存的内容。</div>
        <div id="modal-restart-feedback" class="ag-modal-feedback" hidden></div>
        <div class="ag-modal-actions">
          <button id="btn-modal-restart-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
          <button id="btn-modal-restart-confirm" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartConfirm.go">确认重启</button>
        </div>
      </div>
    </div>
  </section>

  <!-- 弹出式面板 2: Token 用量一览 (#panel-tokens, 730px) -->
  <section id="panel-tokens" class="ag-panel" hidden aria-label="Token 用量一览" data-i18n-aria="badge.tokens.aria">
    <div class="panel-header-bar">
      <div class="panel-title panel-title-tokens">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))"><path d="M3 13V9M8 13V4M13 13V7"></path></svg>
        <span id="panel-tokens-title" style="font-size:13px;font-weight:600;color:var(--ag-custom-token-accent,var(--ag-token-accent-default))" data-i18n="tokens.title">本机已记录用量</span>
      </div>
      <div class="panel-header-actions">
        <button id="btn-github-repo" class="panel-icon-btn" type="button" aria-label="打开 GitHub 仓库" data-i18n-aria="header.github.aria" title="打开 GitHub 仓库" data-i18n-title="header.github.aria">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
        </button>
        <button id="btn-check-update" class="panel-icon-btn update-btn" type="button" aria-label="检查插件更新" data-i18n-aria="header.update.aria" title="检查插件更新" data-i18n-title="header.update.aria" style="position:relative">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8A6 6 0 1 1 8 2M14 2v6h-6"></path></svg>
          <span id="update-badge-dot" class="update-badge-dot" style="display:none"></span>
        </button>
        <button id="btn-panel-tokens-palette" class="panel-icon-btn" type="button" aria-label="外观与调色设置" data-i18n-aria="header.palette.aria" title="外观与调色设置" data-i18n-title="header.palette.aria">🎨</button>
        <button id="theme-toggle-tokens" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" data-i18n-aria="header.theme.aria" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）" data-i18n-title="header.theme.title">🌓</button>
        <button id="close-tokens" class="panel-icon-btn" type="button" aria-label="收起详情" data-i18n-aria="header.close.aria">×</button>
      </div>
    </div>

    <div id="view-tokens">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        <div class="source-switch-bar">
          <span style="font-size:10.5px;color:var(--ag-text-muted);padding:0 4px" data-i18n="tokens.sourceLabel">来源:</span>
          <button id="src-tab-all" class="switch-pill-btn active" type="button" data-i18n="tokens.src.all">全部</button>
          <button id="src-tab-desktop" class="switch-pill-btn" type="button" data-i18n="tokens.src.desktop">桌面端</button>
          <button id="src-tab-cli" class="switch-pill-btn" type="button" data-i18n="tokens.src.cli">CLI</button>
        </div>
        <div class="view-switch-bar">
          <button id="tok-view-tokens" class="switch-pill-btn active" type="button" data-i18n="tokens.view.tokens">Token 统计</button>
          <button id="tok-view-cost" class="switch-pill-btn" type="button" data-i18n="tokens.view.cost">API 参考金额</button>
        </div>
      </div>

      <!-- 账号套餐状态摘要行 -->
      <div id="plan-summary-bar" class="plan-summary-bar">
        <div class="plan-summary-badge" style="display:flex;align-items:center;gap:6px;flex:1;overflow:hidden">
          <span>💎</span>
          <span id="plan-summary-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Pro · ...</span>
        </div>
        <!-- 黄框位置：实时联动的订阅费与汇率胶囊 -->
        <div id="plan-summary-price-badge" class="plan-summary-price-badge" title="当前地区订阅费与最新汇率折算 (点击展开/收起详情)" data-i18n-title="plan.summary.priceBadgeTitle">
          <span id="plan-summary-price-val">$19.99/月</span>
          <span id="plan-summary-price-cny" style="font-size:9.5px;opacity:0.85;font-weight:400">(≈ ¥134.3 CNY)</span>
        </div>
        <button id="btn-plan-detail-toggle" class="switch-pill-btn" type="button" style="padding:2px 6px;flex-shrink:0" data-i18n="plan.detail.toggleOpen">详情 ▼</button>
      </div>

      <!-- 套餐详情卡片（可折叠，紧凑左对齐，支持就地自定义与获取方式设置） -->
      <div id="plan-detail-card" class="plan-detail-card collapsible-pane" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--ag-border-subcard)">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11.5px;font-weight:600;color:var(--ag-text-primary)" data-i18n="plan.detail.title">💎 AI 订阅与额度详情</span>
            <span id="plan-save-feedback" style="font-size:10px;color:var(--ag-text-muted);display:none"></span>
          </div>
          <button id="btn-plan-detail-collapse-top" class="switch-pill-btn" type="button" style="padding:2px 8px;font-size:10.5px" data-i18n="plan.detail.toggleClose">详情收回 ▲</button>
        </div>
        <dl class="plan-detail-dl">
          <dt data-i18n="plan.dt.plan">当前套餐：</dt>
          <dd id="p-det-name" style="font-weight:600">Google AI Pro</dd>
          <dt data-i18n="plan.dt.account">当前账号：</dt>
          <dd id="p-det-account">—</dd>
          <dt data-i18n="plan.dt.country">账号所在地区：</dt>
          <dd style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">
            <span id="p-det-country" style="display:none">未知</span>
            <select id="direct-country-select" aria-label="账号所在地区 (仅本地记录)" style="display:none">
              <option value="未知">🌐 未设置 / 自动</option>
              <option value="美国 (US)">🇺🇸 美国 (US)</option>
              <option value="日本 (JP)">🇯🇵 日本 (JP)</option>
              <option value="韩国 (KR)">🇰🇷 韩国 (KR)</option>
              <option value="中国台湾 (TW)">🇹🇼 中国台湾 (TW)</option>
              <option value="中国香港 (HK)">🇭🇰 中国香港 (HK)</option>
              <option value="澳大利亚 (AU)">🇦🇺 澳大利亚 (AU)</option>
              <option value="新加坡 (SG)">🇸🇬 新加坡 (SG)</option>
              <option value="英国 (UK)">🇬🇧 英国 (UK)</option>
              <option value="德国 (DE)">🇩🇪 德国 (DE)</option>
              <option value="加拿大 (CA)">🇨🇦 加拿大 (CA)</option>
              <option value="土耳其 (TR)">🇹🇷 土耳其 (TR)</option>
              <option value="尼日利亚 (NG)">🇳🇬 尼日利亚 (NG)</option>
              <option value="菲律宾 (PH)">🇵🇭 菲律宾 (PH)</option>
              <option value="印度 (IN)">🇮🇳 印度 (IN)</option>
              <option value="马来西亚 (MY)">🇲🇾 马来西亚 (MY)</option>
              <option value="巴西 (BR)">🇧🇷 巴西 (BR)</option>
              <option value="中国大陆 (CN)">🇨🇳 中国大陆 (CN)</option>
            </select>
            <div id="direct-country-wrap" class="ag-dropdown-wrapper" style="flex:1;min-width:0;max-width:270px">
              <div id="direct-country-trigger" class="ag-dropdown-trigger" tabindex="0" title="用户记录或可靠来源识别的 Google 账号所属地区 (仅本地生效，不修改 Google 账号本身)" data-i18n-title="plan.country.title">
                <span id="direct-country-label" class="ag-dropdown-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" data-i18n="plan.country.auto">🌐 未设置 / 自动</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="direct-country-menu" class="ag-dropdown-menu"></div>
            </div>
            <span id="p-det-country-tag" class="key-pill pill-muted" style="font-size:9.5px;padding:1px 5px;display:none;flex-shrink:0;white-space:nowrap" data-i18n="plan.tag.saved">已保存</span>
          </dd>
          <dt data-i18n="plan.dt.region">订阅国家：</dt>
          <dd style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">
            <span id="p-det-region" style="display:none">未知</span>
            <div id="direct-region-wrap" class="ag-dropdown-wrapper" style="flex:1;min-width:0;max-width:270px">
              <div id="direct-region-trigger" class="ag-dropdown-trigger" tabindex="0" title="这份订阅的购买或订阅所在国家/地区 (可与账号所在地区不同)" data-i18n-title="plan.region.title">
                <span id="direct-region-label" class="ag-dropdown-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" data-i18n="plan.region.unknown">🌏 未知 (点击选择订阅国家与币种建议)</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="direct-region-menu" class="ag-dropdown-menu"></div>
            </div>
            <span id="p-det-region-tag" class="key-pill pill-muted" style="font-size:9.5px;padding:1px 5px;display:none;flex-shrink:0;white-space:nowrap" data-i18n="plan.tag.custom">自定义</span>
          </dd>
          <dt data-i18n="plan.dt.currency">订阅币种：</dt>
          <dd style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">
            <span id="p-det-currency" style="display:none">USD</span>
            <select id="direct-currency-select" aria-label="订阅币种" data-i18n-aria="plan.currency.aria" style="display:none">
              <option value="USD">USD ($ 美元)</option>
              <option value="KRW">KRW (₩ 韩元)</option>
              <option value="AUD">AUD (AU$ 澳元)</option>
              <option value="JPY">JPY (¥ 日元)</option>
              <option value="HKD">HKD (HK$ 港币)</option>
              <option value="TWD">TWD (NT$ 台币)</option>
              <option value="TRY">TRY (₺ 里拉)</option>
              <option value="NGN">NGN (₦ 奈拉)</option>
              <option value="CNY">CNY (¥ 人民币)</option>
              <option value="EUR">EUR (€ 欧元)</option>
              <option value="GBP">GBP (£ 英镑)</option>
              <option value="SGD">SGD (S$ 新元)</option>
              <option value="CAD">CAD (CA$ 加元)</option>
              <option value="PHP">PHP (₱ 比索)</option>
              <option value="INR">INR (₹ 卢比)</option>
              <option value="MYR">MYR (RM 令吉)</option>
              <option value="BRL">BRL (R$ 雷亚尔)</option>
            </select>
            <div id="direct-currency-wrap" class="ag-dropdown-wrapper" style="flex:1;min-width:0;max-width:270px">
              <div id="direct-currency-trigger" class="ag-dropdown-trigger" tabindex="0" title="该订阅记录使用的计价与结算币种 (独立保存，可手动指定或自动跟随)" data-i18n-title="plan.currency.title">
                <span id="direct-currency-label" class="ag-dropdown-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">USD</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="direct-currency-menu" class="ag-dropdown-menu"></div>
            </div>
            <span id="p-det-currency-tag" class="key-pill pill-muted" style="font-size:9.5px;padding:1px 5px;display:none;flex-shrink:0;white-space:nowrap" data-i18n="plan.tag.saved">已保存</span>
          </dd>
          <dt data-i18n="plan.dt.acq">获取方式：</dt>
          <dd style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span id="p-det-acq" data-i18n="plan.acq.normal">正常付费订阅</span>
            <span id="p-det-acq-tag" class="key-pill pill-muted" style="font-size:9.5px;padding:1px 4px;display:none" data-i18n="plan.tag.promo">活动权益</span>
          </dd>
          <dt data-i18n="plan.dt.price">计费周期与价格：</dt>
          <dd style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span id="p-det-price">$19.99</span>
            <span id="p-det-price-tag" class="key-pill pill-muted" style="font-size:9.5px;padding:1px 4px;display:none" data-i18n="plan.tag.regionRef">地区参考价</span>
            <div id="price-mode-switch-group" style="display:inline-flex;align-items:center;gap:4px;margin-left:4px">
              <button id="btn-mode-preset" class="switch-pill-btn active" type="button" style="padding:1px 6px;font-size:10px" data-i18n="plan.price.modePreset">跟随参考价</button>
              <button id="btn-mode-custom" class="switch-pill-btn" type="button" style="padding:1px 6px;font-size:10px" data-i18n="plan.price.modeCustom">自定义实付</button>
            </div>
          </dd>
          <dt id="p-dt-validity" style="display:none" data-i18n="plan.dt.validity">权益有效期：</dt>
          <dd id="p-det-validity" style="display:none;color:var(--ag-text-secondary);font-size:11px">—</dd>
          <dt id="p-dt-note" style="display:none" data-i18n="plan.dt.note">补充备注：</dt>
          <dd id="p-det-note" style="display:none;color:var(--ag-text-secondary);font-size:11px">—</dd>
          <dt data-i18n="plan.dt.promptCredits">Prompt 额度池：</dt>
          <dd id="p-det-prompt-credits"><span id="p-det-credits">—</span></dd>
          <dt data-i18n="plan.dt.flowCredits">Flow 额度池：</dt>
          <dd id="p-det-flow-credits">—</dd>
          <dt data-i18n="plan.dt.updated">状态更新时间：</dt>
          <dd id="p-det-time" style="font-size:11px;color:var(--ag-text-muted)">—</dd>
        </dl>

        <!-- 底部操作栏：左侧提供详情收回按钮，右侧提供自定义订阅设置按钮 -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:6px;border-top:1px dashed var(--ag-border-subcard)">
          <button id="btn-plan-detail-collapse" class="switch-pill-btn" type="button" style="padding:3px 10px;font-size:11px" data-i18n="plan.detail.toggleClose">详情收回 ▲</button>
          <button id="btn-edit-plan-custom" class="plan-edit-pill-btn" type="button">
            <span style="font-size:12px">✎</span>
            <span data-i18n="plan.btn.editCustom">自定义订阅设置</span>
          </button>
        </div>

        <!-- 就地行内自定义编辑表单 -->
        <div id="plan-custom-form" style="display:none;margin-top:8px;padding:10px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px">
          <div style="font-size:11px;font-weight:600;margin-bottom:6px;color:var(--ag-text-primary)" data-i18n="plan.form.title">
            设置当前账号订阅信息
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.acqLabel">获取方式 / 活动来源</label>
              <select id="select-custom-acq" style="width:100%;font-size:11px;padding:4px;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
                <option value="normal_paid" data-i18n="plan.acqOpt.normal_paid">正常付费订阅</option>
                <option value="student_offer" data-i18n="plan.acqOpt.student_offer">学生认证优惠</option>
                <option value="pixel_bundle" data-i18n="plan.acqOpt.pixel_bundle">Google Pixel 设备赠送</option>
                <option value="chromebook_bundle" data-i18n="plan.acqOpt.chromebook_bundle">Chromebook Plus 设备赠送</option>
                <option value="samsung_galaxy" data-i18n="plan.acqOpt.samsung_galaxy">Samsung Galaxy 设备指定活动</option>
                <option value="jio_offer" data-i18n="plan.acqOpt.jio_offer">Jio 运营商套餐权益</option>
                <option value="partner_carrier" data-i18n="plan.acqOpt.partner_carrier">其他运营商 / 合作伙伴权益</option>
                <option value="family_sharing" data-i18n="plan.acqOpt.family_sharing">家庭组共享 / 他人赠送</option>
                <option value="official_promo" data-i18n="plan.acqOpt.official_promo">官方限时试用 / 促销活动</option>
                <option value="custom_source" data-i18n="plan.acqOpt.custom_source">其他 / 自由命名</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.acqCustomLabel">自定义活动 / 合作方名称</label>
              <input id="input-custom-acq-name" type="text" placeholder="选填，如 Pixel 11 Pro 赠送" data-i18n-placeholder="plan.form.acqCustomPh" style="width:100%;font-size:11px;padding:4px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
            </div>
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:10.5px;color:var(--ag-text-primary);display:flex;align-items:center;gap:6px;cursor:pointer">
              <input id="check-zero-extra" type="checkbox">
              <span data-i18n="plan.form.zeroExtra">本权益期间无需另付订阅费</span>
            </label>
          </div>
          <div style="margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
              <label style="font-size:10px;color:var(--ag-text-muted)" data-i18n="plan.form.presetLabel">预设订阅国家与汇率 (可选快捷套用)</label>
              <span id="region-cny-preview" style="font-size:9.5px;color:var(--ag-text-secondary)"></span>
            </div>
            <select id="select-custom-region-preset" style="width:100%;font-size:11px;padding:4px;margin-bottom:4px;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
              <option value="" data-i18n="plan.form.presetPlaceholder">-- 选择预设地区 (自动填入价格与汇率) --</option>
              <option value="US">🇺🇸 美国 (US) · $19.99/月 (折合 ≈ ¥134.3)</option>
              <option value="KR">🇰🇷 韩国 (KR) · ₩29,000/月 (折合 ≈ ¥147.9)</option>
              <option value="HK">🇭🇰 中国香港 (HK) · HK$158/月 (折合 ≈ ¥135.4)</option>
              <option value="JP">🇯🇵 日本 (JP) · ¥2,900/月 (折合 ≈ ¥123.3)</option>
              <option value="TR">🇹🇷 土耳其 (TR) · ₺869.99/月 (折合 ≈ ¥115.7)</option>
              <option value="NG">🇳🇬 尼日利亚 (NG) · ₦28,500/月 (折合 ≈ ¥119.7)</option>
              <option value="TW">🇹🇼 中国台湾 (TW) · NT$650/月 (折合 ≈ ¥136.5)</option>
              <option value="PH">🇵🇭 菲律宾 (PH) · ₱1,100/月 (折合 ≈ ¥128.7)</option>
              <option value="IN">🇮🇳 印度 (IN) · ₹1,950/月 (折合 ≈ ¥148.2)</option>
              <option value="GB">🇬🇧 英国 (UK) · £18.99/月 (折合 ≈ ¥166.2)</option>
              <option value="EU">🇪🇺 欧洲 (EU) · €21.99/月 (折合 ≈ ¥165.4)</option>
              <option value="BR">🇧🇷 巴西 (BR) · R$96.99/月 (折合 ≈ ¥114.4)</option>
              <option value="SG">🇸🇬 新加坡 (SG) · S$27.99/月 (折合 ≈ ¥143.3)</option>
              <option value="CA">🇨🇦 加拿大 (CA) · CA$26.99/月 (折合 ≈ ¥131.7)</option>
              <option value="AU">🇦🇺 澳大利亚 (AU) · AU$32.99/月 (折合 ≈ ¥146.8)</option>
              <option value="MY">🇲🇾 马来西亚 (MY) · RM 97.99/月 (折合 ≈ ¥151.9)</option>
              <option value="CN">🇨🇳 中国大陆/自定义 (CNY) · ¥140/月</option>
              <option value="custom" data-i18n="plan.form.presetCustom">✎ 自定义输入地区</option>
            </select>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px">
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.countryLabel">账号所在地区 (仅本地记录)</label>
              <input id="input-custom-country" type="text" placeholder="例如：美国 (US)" data-i18n-placeholder="plan.form.countryPh" title="仅作为本地显示记录，不修改实际 Google 账号" data-i18n-title="plan.country.title" style="width:100%;font-size:11px;padding:4px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
            </div>
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.regionLabel">订阅国家 (购买/结算地区)</label>
              <input id="input-custom-region" type="text" placeholder="例如：韩国 / 澳大利亚" data-i18n-placeholder="plan.form.regionPh" title="实际购买或支付订阅所在的国家或地区" data-i18n-title="plan.region.title" style="width:100%;font-size:11px;padding:4px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
            </div>
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.currencyLabel">订阅币种与实付金额</label>
              <div style="display:flex;gap:4px">
                <select id="select-custom-currency" title="订阅计价/结算币种" data-i18n-title="plan.currency.title" style="font-size:11px;padding:3px;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
                  <option value="USD">USD</option>
                  <option value="KRW">KRW</option>
                  <option value="HKD">HKD</option>
                  <option value="JPY">JPY</option>
                  <option value="TRY">TRY</option>
                  <option value="NGN">NGN</option>
                  <option value="TWD">TWD</option>
                  <option value="PHP">PHP</option>
                  <option value="INR">INR</option>
                  <option value="CNY">CNY</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="SGD">SGD</option>
                  <option value="BRL">BRL</option>
                  <option value="CAD">CAD</option>
                  <option value="AUD">AUD</option>
                  <option value="MYR">MYR</option>
                </select>
                <input id="input-custom-paid" type="number" step="0.01" placeholder="实付金额" data-i18n-placeholder="plan.form.paidPh" style="width:100%;font-size:11px;padding:4px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
              </div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.cycleLabel">计费周期</label>
              <select id="select-custom-cycle" style="width:100%;font-size:11px;padding:4px 6px;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
                <option value="月付" data-i18n="plan.cycleOpt.monthly">月付</option>
                <option value="年付" data-i18n="plan.cycleOpt.yearly">年付</option>
                <option value="免费/赠送" data-i18n="plan.cycleOpt.free">免费 / 促销赠送</option>
                <option value="随套餐包含" data-i18n="plan.cycleOpt.included">随套餐包含</option>
                <option value="其他周期" data-i18n="plan.cycleOpt.other">其他周期</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.validEndLabel">权益到期日</label>
              <input id="input-valid-end" type="date" style="width:100%;font-size:11px;padding:3px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
            </div>
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:10px;color:var(--ag-text-muted);display:block;margin-bottom:2px" data-i18n="plan.form.noteLabel">补充说明备注</label>
            <input id="input-custom-note" type="text" placeholder="例如：Pixel 11 Pro 赠送 6 个月 / 家庭拼车" data-i18n-placeholder="plan.form.notePh" style="width:100%;font-size:11px;padding:4px 6px;box-sizing:border-box;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:4px;color:var(--ag-text-primary)">
          </div>
          <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px">
            <button id="btn-custom-plan-clear" class="switch-pill-btn" type="button" style="padding:2px 8px;font-size:11px;color:#ef4444" data-i18n="plan.form.clear">清除自定义</button>
            <button id="btn-custom-plan-cancel" class="switch-pill-btn" type="button" style="padding:2px 8px;font-size:11px" data-i18n="plan.form.cancel">取消</button>
            <button id="btn-custom-plan-save" class="switch-pill-btn active" type="button" style="padding:2px 10px;font-size:11px" data-i18n="plan.form.save">保存</button>
          </div>
        </div>
      </div>

      <!-- API 费用估算卡片（整个费用面板默认收为小摘要，展开后才显示详情） -->
      <div id="cost-estimate-card" style="display:none;background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:12px;margin-bottom:10px">
        <!-- 紧凑小摘要区（默认常驻展示） -->
        <div id="cost-compact-summary">
          <!-- 1. 标题与范围标签 -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span id="cost-card-title" style="font-size:12.5px;font-weight:600;color:var(--ag-text-primary)" data-i18n="cost.title">💰 本期 API 参考金额</span>
            <span id="cost-period-tag" class="key-pill pill-muted" style="font-size:10px" data-i18n="cost.periodTag">本月自然月</span>
          </div>
          <!-- 2. 来源与时间短行 -->
          <div id="cost-scope-desc" style="font-size:11px;color:var(--ag-text-muted);margin-bottom:6px">—</div>
          <!-- 3. 主要参考金额及常驻“非实付”标识 -->
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
            <div id="cost-grand-val" style="font-size:22px;font-weight:700;color:var(--ag-text-primary);letter-spacing:-0.5px">$0.00</div>
            <span id="cost-non-paid-badge" class="key-pill pill-muted" style="font-size:10px;padding:1px 6px" data-i18n="cost.nonPaidBadge">API折算 · 非实付</span>
          </div>
          <!-- 4. 一行参考模型/情景假设 -->
          <div id="cost-grand-sub" style="font-size:11px;color:var(--ag-text-secondary);margin-bottom:6px;line-height:1.35">—</div>
          <!-- 5. 一行订阅实付及补充入口 -->
          <div id="cost-sub-line-wrap" style="display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:var(--ag-bg-subcard);border-radius:6px;margin:6px 0 8px">
            <div style="display:flex;align-items:center;gap:4px">
              <span id="cost-sub-line" style="font-size:11px;color:var(--ag-text-primary)" data-i18n="cost.subUnknown">订阅实付：未填写</span>
              <span id="cost-sub-spend-val" style="display:none">—</span>
              <span id="cost-sub-compare-note" style="display:none"></span>
              <span id="cost-sub-spend-lbl" style="display:none"></span>
            </div>
            <button id="btn-cost-fill-sub" class="switch-pill-btn" type="button" style="padding:1px 6px;font-size:10.5px" data-i18n="cost.btnFill">补充</button>
          </div>
          <!-- 6. 展开详情入口 -->
          <div id="cost-expand-bar" style="display:flex;justify-content:flex-end">
            <button id="btn-cost-details-toggle" class="switch-pill-btn" type="button" style="padding:2px 10px;font-size:10.5px" data-i18n="cost.btnExpand">展开详情 ▼</button>
          </div>
        </div>

        <!-- 详细选项与分析区（展开后完整呈现，默认收起） -->
        <div id="cost-details-pane" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--ag-border-subcard)">
          <!-- 高级控制条：范围与覆盖率 -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
            <span style="font-size:11px;color:var(--ag-text-muted)" data-i18n="cost.scopeLabel">统计范围:</span>
            <div style="display:flex;align-items:center;gap:4px">
              <button id="cost-btn-scope-period" class="switch-pill-btn active" type="button" style="padding:1px 6px;font-size:10.5px" data-i18n="cost.scopePeriod">本期</button>
              <button id="cost-btn-scope-all" class="switch-pill-btn" type="button" style="padding:1px 6px;font-size:10.5px" data-i18n="cost.scopeAll">全量历史</button>
              <span id="cost-coverage-pill" class="key-pill pill-muted" style="font-size:10.5px">100%</span>
            </div>
          </div>

          <!-- 估值模式快捷切换（中性“参考模型估算”） -->
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--ag-border-subcard)">
            <span style="font-size:10.5px;color:var(--ag-text-muted)" data-i18n="cost.modeLabel">估值模式:</span>
            <div class="source-switch-bar">
              <button id="cost-btn-mode-ref" class="switch-pill-btn active" type="button" style="padding:1px 6px;font-size:10px" data-i18n="cost.modeRef">参考模型估算</button>
              <button id="cost-btn-mode-hybrid" class="switch-pill-btn" type="button" style="padding:1px 6px;font-size:10px" data-i18n="cost.modeHybrid">混合模式</button>
              <button id="cost-btn-mode-identified" class="switch-pill-btn" type="button" style="padding:1px 6px;font-size:10px" data-i18n="cost.modeIdentified">仅已识别模型</button>
            </div>
          </div>

          <!-- 用量与参考差额指标条（注明包含缓存读取） -->
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 8px;background:var(--ag-bg-subcard);border-radius:6px;margin-bottom:8px">
            <span id="cost-usage-summary" style="font-size:11px;font-weight:600;color:var(--ag-text-primary)">—</span>
            <span id="cost-diff-summary" style="font-size:10.5px;color:var(--ag-text-muted)">—</span>
          </div>

          <!-- 分类单价与公式明细卡片（输入、缓存读取、输出） -->
          <div id="ref-cost-breakdown-cards" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
            <div class="t-card" style="padding:6px">
              <div style="font-size:10px;color:var(--ag-text-muted)"><span data-i18n="cost.card.input">输入 Token</span> ($0.75/M)</div>
              <div id="ref-cost-input-val" style="font-size:12px;font-weight:600;color:var(--ag-text-primary)">$0.00</div>
              <div id="ref-cost-input-tok" style="font-size:9.5px;color:var(--ag-text-muted)">0 tok</div>
            </div>
            <div class="t-card" style="padding:6px">
              <div style="font-size:10px;color:var(--ag-text-muted)"><span data-i18n="cost.card.cache">缓存读取 (优惠)</span> ($0.075/M)</div>
              <div id="ref-cost-cache-val" style="font-size:12px;font-weight:600;color:var(--ag-text-primary)">$0.00</div>
              <div id="ref-cost-cache-tok" style="font-size:9.5px;color:var(--ag-text-muted)">0 tok</div>
            </div>
            <div class="t-card" style="padding:6px">
              <div style="font-size:10px;color:var(--ag-text-muted)"><span data-i18n="cost.card.output">输出 Token</span> ($3.75/M)</div>
              <div id="ref-cost-output-val" style="font-size:12px;font-weight:600;color:var(--ag-text-primary)">$0.00</div>
              <div id="ref-cost-output-tok" style="font-size:9.5px;color:var(--ag-text-muted)">0 tok</div>
            </div>
          </div>

          <!-- 详细分析与未计价原因 -->
          <div id="cost-breakdown-info" style="font-size:10.5px;color:var(--ag-text-secondary);line-height:1.4;padding-top:6px;border-top:1px solid var(--ag-border-subcard)" data-i18n="cost.analyzing">
            正在分析请求模型与计价覆盖率…
          </div>

          <div style="font-size:10px;color:var(--ag-text-muted);line-height:1.4;margin-top:8px" data-i18n="cost.disclaimer">
            注：此折算反映按公开零售价调用同等资源之费用，包月订阅/活动赠送与 API 零售非同类计费模式，该差额不等于真实节省现金；缓存读取按 10% 优惠计价；不含缓存存储费与搜索落地费用。缓存可在多次请求中重复读取相同上下文，该总量不代表独立文本量或用户输入字数。
          </div>

          <!-- 底部收起详情按钮 -->
          <div style="display:flex;justify-content:center;margin-top:10px">
            <button id="btn-cost-details-collapse" class="switch-pill-btn" type="button" style="padding:2px 14px;font-size:10.5px" data-i18n="cost.btnCollapse">收起详情 ▴</button>
          </div>
        </div>

        <!-- 隐藏辅助兼容层 -->
        <div id="ref-cost-drawer-body" style="display:none">
          <span id="ref-cost-grand-val">$0.00</span>
          <span id="ref-cost-mode-label">参考模型折算</span>
          <button id="btn-toggle-ref-cost-drawer" type="button" style="display:none"></button>
          <button id="btn-ref-mode-all" type="button" style="display:none"></button>
          <button id="btn-ref-mode-hybrid" type="button" style="display:none"></button>
        </div>
      </div>

      <!-- 专属 Token 统计页（包含卡片统计、热力图与调色抽屉，费用模式下完全不渲染） -->
      <div id="tokens-main-view">
        <div class="token-stat-cards" id="token-stat-cards">
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.total">累计处理 Token</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Total</span></div>
            <div style="font-size:9.5px;color:var(--ag-text-muted);margin:-2px 0 4px" data-i18n="tokens.card.includeCache">含缓存读取</div>
            <div class="t-card-val" id="t-total-val">--</div>
            <div class="t-card-sub" id="t-total-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-total-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 (¥0.00) · 日均 $0.00</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.today">今日使用</span><span style="color:var(--ag-custom-token-accent,#0284c7)">Today</span></div>
            <div class="t-card-val" id="t-today-val">--</div>
            <div class="t-card-sub" id="t-today-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-today-cost">≈ $0.00 (¥0.00)</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.month">本月使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Month</span></div>
            <div class="t-card-val" id="t-month-val">--</div>
            <div class="t-card-sub" id="t-month-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-month-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 (¥0.00) · 日均 $0.00</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.year">年度使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Year</span></div>
            <div class="t-card-val" id="t-year-val">--</div>
            <div class="t-card-sub" id="t-year-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-year-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 (¥0.00) · 日均 $0.00</div>
          </div>
        </div>

      <div class="heatmap-section">
        <div class="heat-header">
          <div class="heat-header-left">
            <div class="heat-title" data-i18n="tokens.heat.title">Token 活动</div>
            <span id="first-use-badge" class="first-use-badge" data-i18n="tokens.heat.firstUsePlaceholder">首次使用：--</span>
            <div class="heat-win-nav">
              <button id="h-page-prev" class="heat-nav-btn" type="button" title="查看更早的 12 个月窗口" data-i18n-title="tokens.heat.prevTitle" disabled>‹</button>
              <span id="h-win-range">--</span>
              <button id="h-page-next" class="heat-nav-btn" type="button" title="查看更新的 12 个月窗口" data-i18n-title="tokens.heat.nextTitle" disabled>›</button>
            </div>
          </div>
          <div class="heat-tabs" id="heat-tabs-bar" role="tablist" aria-label="热力图统计周期" data-i18n-aria="tokens.heat.tabsAria">
            <div class="heat-tab-thumb" id="heat-tab-thumb" aria-hidden="true"></div>
            <button class="heat-tab-btn active" id="h-tab-daily" role="tab" aria-selected="true" type="button" tabindex="0" data-i18n="tokens.heat.daily">每天</button>
            <button class="heat-tab-btn" id="h-tab-weekly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.weekly">每周</button>
            <button class="heat-tab-btn" id="h-tab-monthly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.monthly">每月</button>
            <button class="heat-tab-btn" id="h-tab-yearly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.yearly">今年</button>
            <button class="heat-tab-btn" id="h-tab-cum" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.cum">累计总量</button>
          </div>
        </div>
        <div class="heat-scroll-box" id="h-scroll-box">
          <div id="h-daily-box">
            <div class="heat-grid-cols" id="h-grid-cols"></div>
            <div class="heat-months" id="h-months"></div>
          </div>
          <div id="h-weekly-box" style="display:none"></div>
          <div id="h-monthly-box" style="display:none"></div>
          <div id="h-yearly-box" style="display:none"></div>
          <div id="h-cum-box" style="display:none">
            <canvas id="h-cum-canvas"></canvas>
          </div>
        </div>
        <div id="h-summary-bar" class="heat-summary-bar">
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumTokens">区间合计:</span>
            <span id="h-sum-tokens" class="heat-sum-val">-- Tokens</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumCost">预估费用:</span>
            <span id="h-sum-cost" class="heat-sum-val">≈ $0.00 (¥0.00)</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumDailyAvg">折合每天:</span>
            <span id="h-sum-daily-avg" class="heat-sum-val">$0.00</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumActiveAvg">活跃日均:</span>
            <span id="h-sum-active-avg" class="heat-sum-val" data-i18n="tokens.heat.activeAvgPlaceholder">$0.00 (0天)</span>
          </div>
          <div id="h-sum-sub-ratio-wrap" class="heat-sum-item" style="display:none">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumSubRatio">订阅性价比:</span>
            <span id="h-sum-sub-ratio" class="heat-sum-val" style="color:var(--ag-token-accent-default,#a78bfa)">--</span>
          </div>
        </div>
        <div class="heat-cost-disclaimer" data-i18n="tokens.heat.disclaimer">
          注：按日聚合按基础档估算，未拆分长上下文分档，结果偏下限。有逐请求记录时优先精确入账。
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11px;color:var(--ag-text-muted);flex-wrap:wrap;gap:6px">
          <span data-i18n="tokens.heat.tip">点击或悬浮格子查看当日详细 Token 构成</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div id="heat-legend-scale" style="display:flex;align-items:center;gap:4px;cursor:pointer" title="点击任一色块单独修改该档位颜色，或点击文字展开设置" data-i18n-title="tokens.heat.legendTitle">
              <span data-i18n="tokens.heat.less">少</span>
              <button id="heat-leg-0" class="heat-leg-swatch" type="button" data-color-slot="heatLvl0" data-color-label="色阶第 1 档（少/无用量）" title="第 1 档（少/无用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl0Title"></button>
              <button id="heat-leg-1" class="heat-leg-swatch" type="button" data-color-slot="heatLvl1" data-color-label="色阶第 2 档（低用量）" title="第 2 档（低用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl1Title"></button>
              <button id="heat-leg-2" class="heat-leg-swatch" type="button" data-color-slot="heatLvl2" data-color-label="色阶第 3 档（中等用量）" title="第 3 档（中等用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl2Title"></button>
              <button id="heat-leg-3" class="heat-leg-swatch" type="button" data-color-slot="heatLvl3" data-color-label="色阶第 4 档（高用量）" title="第 4 档（高用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl3Title"></button>
              <button id="heat-leg-4" class="heat-leg-swatch" type="button" data-color-slot="heatLvl4" data-color-label="色阶第 5 档（多/峰值用量）" title="第 5 档（多/峰值用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl4Title"></button>
              <span data-i18n="tokens.heat.more">多</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 二级交互折叠区（就近放置于面板 A 内部）：面板背景色 + 热力图 5 档色阶预设、5 档逐格独立自定义与两端插值自定义 -->
      <div class="tech-drawer" style="margin-top:2px">
        <button id="btn-toggle-token-colors" class="drawer-trigger" aria-expanded="false" type="button">
          <span class="drawer-trigger-left"><span data-i18n="tokens.colors.title">🎨 热力图色阶与面板外观自定义（默认跟随主题）</span></span>
          <span id="token-color-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expandSettings">▼ 展开设置</span>
        </button>
        <div id="token-color-drawer-body" class="drawer-body" style="display:none;">
          <div class="heat-preset-bar">
            <span style="font-size:11px;color:var(--ag-text-secondary);font-weight:500" data-i18n="tokens.heat.presetLabel">5 档色阶预设：</span>
            <div class="heat-preset-group" id="heat-preset-group">
              <button class="heat-preset-btn" type="button" data-heat-preset="purple" data-active="true">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#3f1e6b"></i><i style="background:#652ab7"></i><i style="background:#9053f8"></i><i style="background:#c084fc"></i></span>
                <span data-i18n="tokens.heat.presetPurple">紫色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="yellow" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#713f12"></i><i style="background:#a16207"></i><i style="background:#eab308"></i><i style="background:#fde047"></i></span>
                <span data-i18n="tokens.heat.presetYellow">黄色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="green" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#14532d"></i><i style="background:#15803d"></i><i style="background:#22c55e"></i><i style="background:#86efac"></i></span>
                <span data-i18n="tokens.heat.presetGreen">绿色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="blue" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#1e3a8a"></i><i style="background:#1d4ed8"></i><i style="background:#3b82f6"></i><i style="background:#93c5fd"></i></span>
                <span data-i18n="tokens.heat.presetBlue">蓝色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="red" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#7f1d1d"></i><i style="background:#b91c1c"></i><i style="background:#ef4444"></i><i style="background:#fca5a5"></i></span>
                <span data-i18n="tokens.heat.presetRed">红色系</span>
              </button>
            </div>
          </div>

          <div class="heat-lvl-custom-bar">
            <div class="heat-lvl-custom-hdr">
              <span style="font-size:11px;color:var(--ag-text-secondary);font-weight:500" data-i18n="tokens.heat.customTitle">5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：</span>
              <button id="reset-heat-lvls" class="color-reset-btn" type="button" data-i18n="tokens.heat.resetLvls">恢复 5 档预设</button>
            </div>
            <div class="heat-lvl-grid" id="heat-lvl-grid">
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl0">1档 · 少/无</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl0" class="color-picker" type="color" value="#27272a" aria-label="热力图第1档颜色" data-i18n-aria-label="tokens.heat.lvl0Aria" />
                  <button id="swatch-heatLvl0" class="color-swatch-btn" type="button" data-color-slot="heatLvl0" data-color-label="色阶第 1 档（少/无用量）" data-i18n-color-label="tokens.heat.lvl0Swatch"></button>
                  <button id="reset-heatLvl0" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl1">2档 · 低</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl1" class="color-picker" type="color" value="#3f1e6b" aria-label="热力图第2档颜色" data-i18n-aria-label="tokens.heat.lvl1Aria" />
                  <button id="swatch-heatLvl1" class="color-swatch-btn" type="button" data-color-slot="heatLvl1" data-color-label="色阶第 2 档（低用量）" data-i18n-color-label="tokens.heat.lvl1Swatch"></button>
                  <button id="reset-heatLvl1" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl2">3档 · 中</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl2" class="color-picker" type="color" value="#652ab7" aria-label="热力图第3档颜色" data-i18n-aria-label="tokens.heat.lvl2Aria" />
                  <button id="swatch-heatLvl2" class="color-swatch-btn" type="button" data-color-slot="heatLvl2" data-color-label="色阶第 3 档（中等用量）" data-i18n-color-label="tokens.heat.lvl2Swatch"></button>
                  <button id="reset-heatLvl2" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl3">4档 · 高</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl3" class="color-picker" type="color" value="#9053f8" aria-label="热力图第4档颜色" data-i18n-aria-label="tokens.heat.lvl3Aria" />
                  <button id="swatch-heatLvl3" class="color-swatch-btn" type="button" data-color-slot="heatLvl3" data-color-label="色阶第 4 档（高用量）" data-i18n-color-label="tokens.heat.lvl3Swatch"></button>
                  <button id="reset-heatLvl3" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl4">5档 · 多/峰</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl4" class="color-picker" type="color" value="#c084fc" aria-label="热力图第5档颜色" data-i18n-aria-label="tokens.heat.lvl4Aria" />
                  <button id="swatch-heatLvl4" class="color-swatch-btn" type="button" data-color-slot="heatLvl4" data-color-label="色阶第 5 档（多/峰值用量）" data-i18n-color-label="tokens.heat.lvl4Swatch"></button>
                  <button id="reset-heatLvl4" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
            </div>
          </div>

          <div class="color-grid">
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.lowEnd">色阶「少」端颜色（自动插值）</span>
              <div class="color-item-ctrls">
                <input id="color-heatLow" class="color-picker" type="color" value="#27272a" aria-label="热力图少端颜色" data-i18n-aria-label="tokens.heat.lowEndAria" />
                <button id="swatch-heatLow" class="color-swatch-btn" type="button" data-color-slot="heatLow" data-color-label="热力图「少」端颜色" data-i18n-color-label="tokens.heat.lowEndSwatch"></button>
                <button id="reset-heatLow" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.highEnd">色阶「多」端颜色（自动插值）</span>
              <div class="color-item-ctrls">
                <input id="color-heatHigh" class="color-picker" type="color" value="#c084fc" aria-label="热力图多端颜色" data-i18n-aria-label="tokens.heat.highEndAria" />
                <button id="swatch-heatHigh" class="color-swatch-btn" type="button" data-color-slot="heatHigh" data-color-label="热力图「多」端颜色" data-i18n-color-label="tokens.heat.highEndSwatch"></button>
                <button id="reset-heatHigh" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.panelBg">面板与菜单统一背景色</span>
              <div class="color-item-ctrls">
                <button id="swatch-panelBg-tokens" class="color-swatch-btn" type="button" data-color-slot="panelBg" data-color-label="面板与菜单背景色" data-i18n-color-label="colors.panelBgSwatch"></button>
                <button id="reset-panelBg-tokens" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.colors.followTheme">跟随主题</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.accentColors">累计与强调指标色</span>
              <div class="color-item-ctrls">
                <button id="swatch-tokenTotal-tokens" class="color-swatch-btn" type="button" data-color-slot="tokenTotal" data-color-label="累计 token 用量" data-i18n-color-label="tokens.heat.totalSwatch"></button>
                <button id="swatch-tokenAccent-tokens" class="color-swatch-btn" type="button" data-color-slot="tokenAccent" data-color-label="Token 强调色" data-i18n-color-label="tokens.heat.accentSwatch"></button>
                <button id="reset-all-colors-tokens" class="color-reset-btn" type="button" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
              </div>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px dashed var(--ag-border-subcard);font-size:11px">
            <span style="color:var(--ag-text-primary);font-weight:500" data-i18n="tokens.update.title">更新设置</span>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--ag-text-secondary)">
              <input id="check-auto-update" type="checkbox" checked>
              <span data-i18n="tokens.update.auto">启动时自动检查更新（不自动安装）</span>
            </label>
          </div>
        </div>
      </div>
      </div><!-- end #tokens-main-view -->
    </div>
  </section>

  <!-- 自定义颜色选取器面板（替换系统原生取色器） -->
  <div id="color-picker-popover" hidden role="dialog" aria-label="颜色选取器" data-i18n-aria="cp.title">
    <div class="cp-header">
      <div class="cp-title">
        <span data-i18n="cp.title">🎨 颜色选取器</span>
        <span id="cp-target-name" class="cp-target-lbl"></span>
      </div>
      <button id="cp-close" class="panel-icon-btn" type="button" aria-label="关闭颜色选取器" data-i18n-aria="cp.closeAria">×</button>
    </div>
    <div class="cp-toolbar">
      <button id="cp-eyedropper" class="cp-eyedropper-btn" type="button" title="从屏幕吸取颜色" data-i18n-title="cp.eyedropperTitle" data-i18n="cp.eyedropper">🖊 取色</button>
      <div class="cp-presets" id="cp-presets">
        <button class="cp-preset-dot" type="button" data-cp-hex="#ef4444" style="background:#ef4444" title="#EF4444"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#f97316" style="background:#f97316" title="#F97316"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#eab308" style="background:#eab308" title="#EAB308"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#22c55e" style="background:#22c55e" title="#22C55E"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#06b6d4" style="background:#06b6d4" title="#06B6D4"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#3b82f6" style="background:#3b82f6" title="#3B82F6"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#a855f7" style="background:#a855f7" title="#A855F7"></button>
      </div>
    </div>
    <div class="cp-stage">
      <div id="cp-side-preview" class="cp-side-preview"></div>
      <div id="cp-sv-area" class="cp-sv-area">
        <div id="cp-sv-thumb" class="cp-sv-thumb"></div>
      </div>
    </div>
    <div id="cp-hue-wrap" class="cp-hue-wrap">
      <div id="cp-hue-thumb" class="cp-hue-thumb"></div>
    </div>
    <div class="cp-rows">
      <div class="cp-row">
        <span class="cp-fmt-lbl">HEX</span>
        <input id="cp-input-hex" class="cp-fmt-input" type="text" value="#652ab7" spellcheck="false" aria-label="HEX 色值输入" data-i18n-aria="cp.hexAria" />
        <button id="cp-copy-hex" class="cp-copy-btn" type="button" title="复制 HEX" data-i18n-title="cp.copyHex">📋</button>
      </div>
      <details class="cp-advanced-formats">
        <summary class="cp-fmt-summary" data-i18n="cp.moreFormats">更多格式 (RGB / HSL)</summary>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
          <div class="cp-row">
            <span class="cp-fmt-lbl">RGB</span>
            <input id="cp-input-rgb" class="cp-fmt-input" type="text" value="rgb(101, 42, 183)" spellcheck="false" aria-label="RGB 色值输入" data-i18n-aria="cp.rgbAria" />
            <button id="cp-copy-rgb" class="cp-copy-btn" type="button" title="复制 RGB" data-i18n-title="cp.copyRgb">📋</button>
          </div>
          <div class="cp-row">
            <span class="cp-fmt-lbl">HSL</span>
            <input id="cp-input-hsl" class="cp-fmt-input" type="text" value="hsl(265, 63%, 44%)" spellcheck="false" aria-label="HSL 色值输入" data-i18n-aria="cp.hslAria" />
            <button id="cp-copy-hsl" class="cp-copy-btn" type="button" title="复制 HSL" data-i18n-title="cp.copyHsl">📋</button>
          </div>
        </div>
      </details>
    </div>
    <div class="cp-footer">
      <span id="cp-status-msg" style="font-size:10.5px;color:var(--ag-text-muted)" data-i18n="cp.hint">支持直接输入或粘贴 HEX 色值</span>
      <button id="cp-reset-slot" class="color-reset-btn" type="button" data-i18n="cp.followTheme">跟随主题</button>
    </div>
  </div>

  <!-- 全局在线更新浮层（跨面板独立定位与显示） -->
  <div class="update-popover" id="update-popover" style="display:none" role="dialog" aria-label="版本更新详情" data-i18n-aria="update.dialogAria">
    <div class="update-pop-hdr">
      <div style="display:flex;align-items:center;gap:6px">
        <span id="up-pop-title" style="font-weight:600;font-size:12px;color:var(--ag-text-primary)" data-i18n="update.title">🚀 检查更新</span>
        <span id="up-pop-ver" class="key-pill pill-good" style="font-size:10px">v0.8.3</span>
      </div>
      <button id="btn-close-update-pop" class="panel-icon-btn" type="button" style="padding:1px 5px;font-size:13px">×</button>
    </div>
    <div id="up-pop-body" class="update-pop-body" data-i18n="update.checking">
      正在检测最新版本…
    </div>
    <div id="up-pop-footer" class="update-pop-footer">
      <button id="btn-view-release-page" class="switch-pill-btn" type="button" data-i18n="update.viewRelease">查看发布页</button>
      <button id="btn-update-later" class="switch-pill-btn" type="button" data-i18n="update.later">稍后</button>
      <button id="btn-apply-update" class="switch-pill-btn active" type="button" data-i18n="update.applyNow">立即更新</button>
    </div>
    <div id="up-pop-status" style="display:none;font-size:10.5px;color:var(--ag-text-muted);margin-top:6px;text-align:center"></div>
  </div>

  <!-- 热力图浮动 Tooltip -->
  <div class="heat-popover" id="heat-pop">
    <div class="pop-date" id="heat-pop-date">10月24日</div>
    <div class="pop-val" id="heat-pop-val">2.47亿 个 Token</div>
    <div class="pop-det" id="heat-pop-det"></div>
  </div>`;

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
// =========================================================================
  // 模块 0: 插件面板三语言国际化 (简体中文 / 繁體中文 / English)
  // =========================================================================
  const VALID_PANEL_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);
  let currentPanelLanguage = 'zh-CN';

  function normalizePanelLanguage(lang) {
    if (typeof lang !== 'string') return 'zh-CN';
    const trimmed = lang.trim();
    if (VALID_PANEL_LANGUAGES.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'tw') return 'zh-TW';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    return 'zh-CN';
  }

  function getPanelLanguage() {
    return currentPanelLanguage;
  }

  const PANEL_I18N = {
    // 顶部入口单元与气泡
    'badge.aria': { 'zh-CN': '会话与上下文统计', 'zh-TW': '工作階段與上下文統計', en: 'Session and context statistics' },
    'badge.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
    'badge.speed.aria': { 'zh-CN': '模型输出速度与耗时统计', 'zh-TW': '模型輸出速度與耗時統計', en: 'Model output speed and latency' },
    'badge.tokens.aria': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量一覽', en: 'Token usage overview' },
    'badge.cli.aria': { 'zh-CN': '启动 CLI', 'zh-TW': '啟動 CLI', en: 'Launch CLI' },
    'badge.cli.title': { 'zh-CN': '一键启动 Antigravity CLI 终端（自动进入当前项目目录）', 'zh-TW': '一鍵啟動 Antigravity CLI 終端機（自動進入目前專案目錄）', en: 'Launch Antigravity CLI in the current workspace' },
    'badge.overflow.aria': { 'zh-CN': '更多统计指标', 'zh-TW': '更多統計指標', en: 'More metrics' },
    'tip.title.default': { 'zh-CN': '上下文窗口：', 'zh-TW': '上下文視窗：', en: 'Context window:' },
    'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
    'tip.detail.loading': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前工作階段上下文用量…', en: 'Reading current session context usage…' },
    'overflow.aria': { 'zh-CN': '更多统计快捷菜单', 'zh-TW': '更多統計快捷選單', en: 'More metrics menu' },
    'overflow.speed': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
    'overflow.tokens': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量一覽', en: 'Token usage' },
    'overflow.cli': { 'zh-CN': '启动 CLI 终端', 'zh-TW': '啟動 CLI 終端機', en: 'Launch CLI' },
    'cli.launching': { 'zh-CN': '正在打开 Antigravity CLI…', 'zh-TW': '正在開啟 Antigravity CLI…', en: 'Opening Antigravity CLI…' },
    'cli.launched': { 'zh-CN': '已启动 CLI：{path}', 'zh-TW': '已啟動 CLI：{path}', en: 'CLI launched: {path}' },
    'cli.error': { 'zh-CN': '启动 CLI 失败：{err}', 'zh-TW': '啟動 CLI 失敗：{err}', en: 'Failed to launch CLI: {err}' },
    'cli.unavailable': { 'zh-CN': '当前环境不支持启动 CLI', 'zh-TW': '目前環境不支援啟動 CLI', en: 'CLI launch is unavailable in this environment' },

    // 上下文面板头部与分页
    'panel.ctx.aria': { 'zh-CN': '会话与上下文详情', 'zh-TW': '工作階段與上下文詳情', en: 'Session & Context Details' },
    'panel.ctx.title': { 'zh-CN': '💬 当前会话上下文', 'zh-TW': '💬 目前工作階段上下文', en: '💬 Current Session Context' },
    'panel.ctx.viewModel': { 'zh-CN': '查看模型', 'zh-TW': '檢視模型', en: 'Model' },
    'panel.ctx.viewModelTitle': { 'zh-CN': '按厂商查看不同模型的上下文设置', 'zh-TW': '依廠商檢視不同模型的上下文設定', en: 'Inspect context settings by vendor and model' },
    'panel.ctx.loadingModels': { 'zh-CN': '正在读取模型…', 'zh-TW': '正在讀取模型…', en: 'Loading models…' },
    'panel.ctx.backCurrent': { 'zh-CN': '回到当前模型', 'zh-TW': '回到目前模型', en: 'Back to current' },
    'panel.ctx.backCurrentTitle': { 'zh-CN': '回到当前会话正在使用的模型', 'zh-TW': '回到目前工作階段正在使用的模型', en: 'Switch back to the active session model' },
    'header.settings.aria': { 'zh-CN': '打开设置', 'zh-TW': '開啟設定', en: 'Open settings' },
    'header.settings.title': { 'zh-CN': '设置（语言、代理、外观）', 'zh-TW': '設定（語言、代理與外觀）', en: 'Settings (Language, Proxy, Appearance)' },
    'header.github.aria': { 'zh-CN': '打开 GitHub 仓库', 'zh-TW': '開啟 GitHub 儲存庫', en: 'Open GitHub repository' },
    'header.update.aria': { 'zh-CN': '检查插件更新', 'zh-TW': '檢查外掛更新', en: 'Check for updates' },
    'header.palette.aria': { 'zh-CN': '外观与调色设置', 'zh-TW': '外觀與調色設定', en: 'Appearance & color settings' },
    'header.close.aria': { 'zh-CN': '收起详情', 'zh-TW': '收起詳情', en: 'Close panel' },
    'tabs.aria': { 'zh-CN': '上下文面板分页', 'zh-TW': '上下文面板分頁', en: 'Context panel tabs' },
    'tab.session': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
    'tab.models': { 'zh-CN': '模型设置', 'zh-TW': '模型設定', en: 'Models' },
    'tab.speed': { 'zh-CN': '速度对比', 'zh-TW': '速度對比', en: 'Speed' },
    'tab.settings': { 'zh-CN': '配置', 'zh-TW': '配置', en: 'setting' },

    // 分页 1: 当前会话
    'session.costBar.title': { 'zh-CN': '当前模型调用的 API 等值参考金额（按已返回用量或实时生成估算）', 'zh-TW': '目前模型呼叫的 API 等值參考金額（依已回傳用量或即時生成估算）', en: 'Estimated API-equivalent cost for the current model (based on returned usage or live output)' },
    'session.roundCost': { 'zh-CN': '本轮估值：{val}', 'zh-TW': '本輪估值：{val}', en: 'This turn: {val}' },
    'session.sessionCost': { 'zh-CN': '当前会话合计：{val}', 'zh-TW': '目前工作階段合計：{val}', en: 'Session total: {val}' },
    'session.roundCost.dash': { 'zh-CN': '本轮估值：—', 'zh-TW': '本輪估值：—', en: 'This turn: —' },
    'session.sessionCost.dash': { 'zh-CN': '当前会话合计：—', 'zh-TW': '目前工作階段合計：—', en: 'Session total: —' },
    'session.keySummary.title': { 'zh-CN': '⭐ 核心用量速览', 'zh-TW': '⭐ 核心用量速覽', en: '⭐ Context Summary' },
    'session.badge.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Loading' },
    'session.stat.used': { 'zh-CN': '当前已用', 'zh-TW': '目前已用', en: 'Used' },
    'session.stat.limit': { 'zh-CN': '预算上限', 'zh-TW': '預算上限', en: 'Budget Limit' },
    'session.stat.remaining': { 'zh-CN': '剩余可用', 'zh-TW': '剩餘可用', en: 'Remaining' },
    'session.keyTakeaway.loading': { 'zh-CN': '正在计算核心指标…', 'zh-TW': '正在計算核心指標…', en: 'Calculating key metrics…' },
    'session.speedSummary.title': { 'zh-CN': '⚡ 最新生成速度与耗时', 'zh-TW': '⚡ 最新生成速度與耗時', en: '⚡ Latest Speed & Latency' },
    'session.speed.pending': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
    'session.speed.rate': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output Speed' },
    'session.speed.duration': { 'zh-CN': '生成耗时', 'zh-TW': '生成耗時', en: 'Duration' },
    'session.speed.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
    'session.speed.tokens': { 'zh-CN': '本次输出', 'zh-TW': '本次輸出', en: 'Output' },
    'session.speed.wait': { 'zh-CN': '等待首次模型输出产生速度统计…', 'zh-TW': '等待首次模型輸出產生速度統計…', en: 'Waiting for the first model response…' },
    'session.compact.title': { 'zh-CN': '上下文设置', 'zh-TW': '上下文設定', en: 'Context Settings' },
    'session.compact.savedLabel': { 'zh-CN': '本模型已保存：', 'zh-TW': '本模型已儲存：', en: 'Saved for model: ' },
    'session.compact.clientLabel': { 'zh-CN': '客户端当前使用：', 'zh-TW': '用戶端目前使用：', en: 'Client active: ' },
    'session.compact.gotoModels': { 'zh-CN': '去模型设置 ›', 'zh-TW': '前往模型設定 ›', en: 'Model settings ›' },
    'session.techDrawer.title': { 'zh-CN': '📋 底层技术参数与附件审计', 'zh-TW': '📋 底層技術參數與附件稽核', en: '📋 Technical Metrics & Attachment Audit' },
    'session.techDrawer.expand': { 'zh-CN': '▼ 点击展开明细', 'zh-TW': '▼ 點擊展開明細', en: '▼ Show details' },
    'session.techDrawer.collapse': { 'zh-CN': '▲ 点击收起明细', 'zh-TW': '▲ 點擊收起明細', en: '▲ Hide details' },
    'session.tech.checking': { 'zh-CN': '正在核对请求和附件…', 'zh-TW': '正在核對請求與附件…', en: 'Checking requests and attachments…' },
    'session.tech.latestReq': { 'zh-CN': '最近一次模型请求', 'zh-TW': '最近一次模型請求', en: 'Latest Model Request' },
    'session.tech.reqStatus': { 'zh-CN': '请求状态', 'zh-TW': '請求狀態', en: 'Request status' },
    'session.tech.actual': { 'zh-CN': '模型返回输入＋输出', 'zh-TW': '模型回傳輸入＋輸出', en: 'Returned input + output' },
    'session.tech.estimate': { 'zh-CN': '客户端估算（可能漏附件）', 'zh-TW': '用戶端估算（可能漏附件）', en: 'Client estimate (may miss files)' },
    'session.tech.budget': { 'zh-CN': '客户端预算字段', 'zh-TW': '用戶端預算欄位', en: 'Client budget field' },
    'session.tech.serviceLimit': { 'zh-CN': '该次报错的服务端限制', 'zh-TW': '該次報錯的伺服器端限制', en: 'Server limit from error' },
    'session.tech.percent': { 'zh-CN': '相对客户端预算', 'zh-TW': '相對用戶端預算', en: 'Share of client budget' },
    'session.tech.sessionHeading': { 'zh-CN': '整个会话累计内容 · 本地估算', 'zh-TW': '整個工作階段累計內容 · 本機估算', en: 'Cumulative Session Content · Local Estimate' },
    'session.tech.sessionTotal': { 'zh-CN': '可读取文本 token 估算', 'zh-TW': '可讀取文字 token 估算', en: 'Readable text token est.' },
    'session.tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
    'session.tech.characters': { 'zh-CN': '实际读取文字字符数', 'zh-TW': '實際讀取文字字元數', en: 'Readable characters' },
    'session.tech.user': { 'zh-CN': '用户消息', 'zh-TW': '使用者訊息', en: 'User messages' },
    'session.tech.assistant': { 'zh-CN': '模型回复', 'zh-TW': '模型回覆', en: 'Assistant replies' },
    'session.tech.thinking': { 'zh-CN': '可见思考内容', 'zh-TW': '可見思考內容', en: 'Visible thinking' },
    'session.tech.tools': { 'zh-CN': '工具调用与工具输出', 'zh-TW': '工具呼叫與工具輸出', en: 'Tool calls & outputs' },
    'session.tech.summaries': { 'zh-CN': '历史压缩摘要', 'zh-TW': '歷史壓縮摘要', en: 'Compressed summaries' },
    'session.tech.system': { 'zh-CN': '当前系统提示与工具定义', 'zh-TW': '目前系統提示與工具定義', en: 'System prompt & tools' },
    'session.tech.attachments': { 'zh-CN': '上传／输出附件文本', 'zh-TW': '上傳／輸出附件文字', en: 'Attachment text' },
    'session.tech.steps': { 'zh-CN': '历史步骤完整性', 'zh-TW': '歷史步驟完整性', en: 'History completeness' },
    'session.tech.filesHeading': { 'zh-CN': '附件逐项检查', 'zh-TW': '附件逐項檢查', en: 'Attachment Inspection' },
    'session.tech.rescan': { 'zh-CN': '重新扫描整段会话与附件', 'zh-TW': '重新掃描整段工作階段與附件', en: 'Rescan session & attachments' },
    'session.tech.note': {
      'zh-CN': '会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。',
      'zh-TW': '工作階段累計包含可讀取的全部封存歷史；已壓縮內容仍計入累計。它不等於目前實際傳送給模型的上下文，不能用累計值除以 1M 判斷剩餘空間。附件原文與工具讀出的文字可能在歷史中分別出現，各按一次出現計入。尚未傳送的草稿與待上傳附件不在封存內，暫未計入；新上傳可能使下一次請求明顯增長。<br><br>本機 token 區間是文字啟發式估算，不是 Gemini 分詞結果，也不是嚴格上下界。影像、音視訊、加密檔案、無法存取檔案與未解析部分會明確列為未知。未知內容不按零處理；只有伺服器端回傳的用量才標為實際統計。此功能不向外部傳送檔案，不執行巨集或公式。',
      en: 'Cumulative session totals include all readable archived history (including compressed turns). They do not equal the active context sent to the model and must not be divided by 1M to judge remaining space. Attachment text and tool-read text may appear separately in history and are counted per occurrence. Unsent drafts and pending uploads are excluded.<br><br>Local token ranges are text heuristics, not exact Gemini tokenization or strict bounds. Images, audio/video, encrypted, inaccessible, or unparsed items are marked unknown (never zero). Only server-returned counts are labeled actual usage. No files are sent externally and no macros are executed.'
    },

    // 分页 2: 模型设置
    'models.list.aria': { 'zh-CN': '按厂商分组的模型产品列表', 'zh-TW': '依廠商分組的模型產品清單', en: 'Models grouped by vendor' },
    'models.list.empty': { 'zh-CN': '暂无已知模型，发一条消息或等待模型列表加载后显示。', 'zh-TW': '暫無已知模型，發送一則訊息或等待模型清單載入後顯示。', en: 'No models detected yet. Send a message or wait for the model list to load.' },
    'models.restartBtn': { 'zh-CN': '重启客户端使设置生效', 'zh-TW': '重新啟動用戶端使設定生效', en: 'Restart client to apply' },
    'models.manualRestart': { 'zh-CN': '请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。', 'zh-TW': '請手動重新啟動：關閉所有 Antigravity 視窗（包含系統匣圖示中的「結束」），再重新開啟 Antigravity。', en: 'Please restart manually: close all Antigravity windows (including Quit from the tray icon) and reopen Antigravity.' },
    'models.restartConfirm.text': { 'zh-CN': '重启会中断正在运行的任务。请先保存未保存的内容。', 'zh-TW': '重新啟動會中斷正在執行的任務。請先儲存未儲存的內容。', en: 'Restarting will interrupt active tasks. Please save any unsaved work first.' },
    'models.restartConfirm.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
    'models.restartConfirm.go': { 'zh-CN': '重启', 'zh-TW': '重新啟動', en: 'Restart' },
    'models.restart.restarting': { 'zh-CN': '正在重启客户端…', 'zh-TW': '正在重新啟動用戶端…', en: 'Restarting client…' },
    'models.restart.notExited': { 'zh-CN': '客户端没有退出，可能被取消或正在等待。请手动重启。', 'zh-TW': '用戶端沒有結束，可能被取消或正在等待。請手動重新啟動。', en: 'The client did not exit (cancelled or busy). Please restart manually.' },
    'models.conflict.title': { 'zh-CN': '这个模型的不同档位保存过不同长度，请选一个统一值。', 'zh-TW': '此模型的不同檔位儲存過不同長度，請選一個統一值。', en: 'Different efforts of this model have different saved limits. Pick one unified value.' },
    'models.conflict.keep': { 'zh-CN': '保留此值', 'zh-TW': '保留此值', en: 'Use this' },
    'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
    'models.card.efforts': { 'zh-CN': '可用档位：{val}', 'zh-TW': '可用檔位：{val}', en: 'Efforts: {val}' },
    'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
    'models.card.sessionEffort': { 'zh-CN': '当前会话：{val}', 'zh-TW': '目前工作階段：{val}', en: 'Current session: {val}' },
    'models.card.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'models.card.savedSide': { 'zh-CN': '为这个模型记下的长度', 'zh-TW': '為此模型記下的長度', en: 'Saved limit for this model' },
    'models.card.request': { 'zh-CN': '请求携带', 'zh-TW': '請求攜帶', en: 'Request Attached' },
    'models.mode.aria': { 'zh-CN': '上下文设置模式', 'zh-TW': '上下文設定模式', en: 'Context setting mode' },
    'models.mode.unifiedTitle': { 'zh-CN': '所有模型统一设置', 'zh-TW': '所有模型統一設定', en: 'Unified for All Models' },
    'models.mode.unifiedDesc': { 'zh-CN': '设置一次，所有模型使用相同的上下文长度。', 'zh-TW': '設定一次，所有模型使用相同的上下文長度。', en: 'Set once; all models use the same context length.' },
    'models.mode.perModelTitle': { 'zh-CN': '按模型分别设置', 'zh-TW': '依模型個別設定', en: 'Per-Model Separate Settings' },
    'models.mode.perModelDesc': { 'zh-CN': '每个模型分别保存，使用哪个模型，就采用它的上下文长度。', 'zh-TW': '每個模型分別儲存，使用哪個模型，就採用其上下文長度。', en: 'Each model saved separately; active model uses its own length.' },
    'models.summary.mode': { 'zh-CN': '当前模式', 'zh-TW': '目前模式', en: 'Active Mode' },
    'models.summary.model': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Active Model' },
    'models.summary.length': { 'zh-CN': '目标设置与状态', 'zh-TW': '目標設定與狀態', en: 'Target & Status' },
    'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
    'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
    'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
    'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
    'panel.ctx.currentModelUnconfirmed': { 'zh-CN': '当前会话模型待确认（请在输入框选择模型或发送消息）', 'zh-TW': '目前工作階段模型待確認（請在輸入框選擇模型或發送訊息）', en: 'Active model pending confirmation (select a model or send a message first)' },
    'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
    'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
    'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
    'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
    'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
    'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
    'models.summary.unconfirmed': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
    'models.summary.pendingRestart': { 'zh-CN': '待重启生效', 'zh-TW': '待重啟生效', en: 'Pending Restart' },
    'models.summary.modelDefault': { 'zh-CN': '使用模型默认值', 'zh-TW': '使用模型預設值', en: 'Use model default' },
    'models.summary.unifiedTarget': { 'zh-CN': '所有模型（统一生效）', 'zh-TW': '所有模型（統一生效）', en: 'All models (unified)' },
    'models.card.detailsToggle': { 'zh-CN': '详细信息（配置来源、请求参数与预算验证）', 'zh-TW': '詳細資訊（設定來源、請求參數與預算驗證）', en: 'Details (Source, request params & budget)' },
    'models.card.requestSide': { 'zh-CN': '本次请求发送给底座的参数', 'zh-TW': '本次請求發送給底座的參數', en: 'Limit sent in request' },
    'models.card.client': { 'zh-CN': '底座引擎', 'zh-TW': '底座引擎', en: 'Base Engine' },
    'models.card.clientSide': { 'zh-CN': '底座透传与门禁状态', 'zh-TW': '底座透傳與門禁狀態', en: 'Pass-through & gate status' },
    'models.card.observedBudget': { 'zh-CN': '实测预算', 'zh-TW': '實測預算', en: 'Observed Budget' },
    'models.card.observedBudgetNone': { 'zh-CN': '尚未观测', 'zh-TW': '尚未觀測', en: 'Not observed yet' },
    'models.card.observedBudgetSide': { 'zh-CN': '对话中实际分配', 'zh-TW': '對話中實際分配', en: 'Allocated in live turns' },
    'models.card.observedSpeed': { 'zh-CN': '实测速度', 'zh-TW': '實測速度', en: 'Observed Speed' },
    'models.card.observedSpeedNone': { 'zh-CN': '暂无实测数据', 'zh-TW': '暫無實測資料', en: 'No speed data yet' },
    'models.card.gotoSpeed': { 'zh-CN': '查看速度对比 ›', 'zh-TW': '檢視速度對比 ›', en: 'Compare speed ›' },
    'models.preset.aria': { 'zh-CN': '上下文长度预设', 'zh-TW': '上下文長度預設', en: 'Context length presets' },
    'models.preset.default': { 'zh-CN': '恢复客户端默认', 'zh-TW': '恢復用戶端預設', en: 'Restore Client Default' },
    'models.preset.defaultSub': { 'zh-CN': '清除请求覆盖，由当前底座策略决定', 'zh-TW': '清除請求覆寫，由目前底座策略決定', en: 'Clear request override; follow active host policy' },
    'models.preset.p128Sub': { 'zh-CN': '插件预设 · 128,000 tokens', 'zh-TW': '外掛預設 · 128,000 tokens', en: 'Plugin preset · 128,000 tokens' },
    'models.preset.p256Sub': { 'zh-CN': '插件预设 · 256,000 tokens', 'zh-TW': '外掛預設 · 256,000 tokens', en: 'Plugin preset · 256,000 tokens' },
    'models.preset.p512Sub': { 'zh-CN': '插件预设 · 512,000 tokens', 'zh-TW': '外掛預設 · 512,000 tokens', en: 'Plugin preset · 512,000 tokens' },
    'models.preset.modelMax': { 'zh-CN': '按模型最大可用', 'zh-TW': '依模型最大可用', en: 'Max Usable for Model' },
    'models.preset.modelMaxSub': { 'zh-CN': '总窗口 - 最大输出（需元数据）', 'zh-TW': '總視窗 - 最大輸出（需中繼資料）', en: 'Context window - max output (needs metadata)' },
    'models.preset.dynamic': { 'zh-CN': '动态跟随', 'zh-TW': '動態跟隨', en: 'Dynamic Follow' },
    'models.preset.dynamicSub': { 'zh-CN': '不固定数值，按底座动态计算', 'zh-TW': '不固定數值，依底座動態計算', en: 'No fixed cap; compute dynamically on host' },
    'models.cap.window': { 'zh-CN': '模型总窗口', 'zh-TW': '模型總視窗', en: 'Context Window' },
    'models.cap.output': { 'zh-CN': '最大输出', 'zh-TW': '最大輸出', en: 'Max Output' },
    'models.cap.modelMax': { 'zh-CN': '模型理论输入上限', 'zh-TW': '模型理論輸入上限', en: 'Model Theoretical Input Cap' },
    'models.cap.clientPolicy': { 'zh-CN': '当前客户端限制', 'zh-TW': '目前用戶端限制', en: 'Current Client Policy Limit' },
    'models.cap.defaultCap': { 'zh-CN': '当前策略默认预算', 'zh-TW': '目前策略預設預算', en: 'Current Strategy Default' },
    'models.cap.range': { 'zh-CN': '当前可采纳输入范围', 'zh-TW': '目前可採納輸入範圍', en: 'Adoptable Input Range' },
    'models.cap.formulaLbl': { 'zh-CN': '来源与计算说明', 'zh-TW': '來源與計算說明', en: 'Source & Formula' },
    'models.cap.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'models.cap.sent': { 'zh-CN': '最近请求携带', 'zh-TW': '最近請求攜帶', en: 'Last Request' },
    'models.cap.adopted': { 'zh-CN': '后端实际采用', 'zh-TW': '後端實際採用', en: 'Backend Adopted' },
    'models.card.tierCaps': { 'zh-CN': '档位能力', 'zh-TW': '檔位能力', en: 'Tier Capabilities' },
    'models.custom.label': { 'zh-CN': '自定义长度', 'zh-TW': '自訂長度', en: 'Custom limit' },
    'models.custom.placeholder': { 'zh-CN': '输入整数，例如 333333', 'zh-TW': '輸入整數，例如 333333', en: 'Enter integer, e.g. 333333' },
    'models.validation.defaultRange': { 'zh-CN': '可设置范围：16,384 – 2,097,152 tokens。', 'zh-TW': '可設定範圍：16,384 – 2,097,152 tokens。', en: 'Valid range: 16,384 – 2,097,152 tokens.' },
    'models.validation.empty': { 'zh-CN': '请输入 16,384 到 2,097,152 之间的整数。', 'zh-TW': '請輸入 16,384 到 2,097,152 之間的整數。', en: 'Enter an integer between 16,384 and 2,097,152.' },
    'models.validation.int': { 'zh-CN': '请输入整数（不要带小数或单位）。', 'zh-TW': '請輸入整數（不要帶小數或單位）。', en: 'Enter a whole integer without decimals or units.' },
    'models.validation.range': { 'zh-CN': '数值必须在 16,384 – 2,097,152 tokens 之间。', 'zh-TW': '數值必須在 16,384 – 2,097,152 tokens 之間。', en: 'Value must be between 16,384 and 2,097,152 tokens.' },
    'models.btn.save': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },
    'models.btn.saveApply': { 'zh-CN': '保存并应用', 'zh-TW': '儲存並套用', en: 'Save & Apply' },
    'models.btn.reset': { 'zh-CN': '恢复默认', 'zh-TW': '恢復預設', en: 'Reset to Default' },
    'models.help.line1': { 'zh-CN': '保存：记住当前模型的设置。底座引擎：一次性解除 256K 限制并启用动态跟随。', 'zh-TW': '儲存：記住目前模型的設定。底座引擎：一次性解除 256K 限制並啟用動態跟隨。', en: 'Save: record limit for this model. Engine: unlock 256K limit and enable dynamic follow.' },
    'models.help.line2': { 'zh-CN': '各模型根据保存的设置独立生效，多会话与模型切换互不干扰。', 'zh-TW': '各模型依儲存的設定獨立生效，多工作階段與模型切換互不干擾。', en: 'Each model applies its saved setting independently without crosstalk across sessions or switches.' },
    'models.details.title': { 'zh-CN': '详细说明', 'zh-TW': '詳細說明', en: 'Details & Notes' },
    'models.details.li1': { 'zh-CN': '<strong>设置存在哪里</strong>：模型设置保存在插件的本地设置文件里，按模型产品记录。「应用」会把一种设置写入客户端的语言服务，重启后由新进程读取。', 'zh-TW': '<strong>設定儲存在哪裡</strong>：模型設定儲存在外掛的本機設定檔中，依模型產品記錄。「套用」會將設定寫入用戶端語言服務，重新啟動後由新行程讀取。', en: '<strong>Where settings live</strong>: Per-model preferences are stored in local plugin settings. "Apply" writes the selected limit to the client language server for the next restart.' },
    'models.details.li2': {
      'zh-CN': '<strong>几个数字的区别</strong>：<div>已保存：你为模型记下的目标。</div><div>请求携带：本次对话请求实际发送给底座的参数。</div><div>底座引擎：底座语言服务的动态跟随状态。</div><div>实测预算：对话请求中客户端实际分配的上下文预算。</div><div>服务端报错上限：只有服务端拒绝请求时才会出现。</div>',
      'zh-TW': '<strong>幾個數字的區別</strong>：<div>已儲存：你為模型記下的目標。</div><div>請求攜帶：本次對話請求實際發送給底座的參數。</div><div>底座引擎：底座語言服務的動態跟隨狀態。</div><div>實測預算：對話請求中用戶端實際分配的上下文預算。</div><div>伺服器端報錯上限：只有伺服器端拒絕請求時才會出現。</div>',
      en: '<strong>Understanding the numbers</strong>:<div>Saved: target limit for this model.</div><div>Request Attached: parameter sent in this turn.</div><div>Base Engine: follow state of the language server.</div><div>Observed budget: actual budget allocated in live turns.</div><div>Service limit: appears only when the server rejects a request.</div>'
    },
    'models.details.li3': { 'zh-CN': '<strong>影响范围</strong>：底座引擎采用动态跟随架构，每个对话请求按当前所选模型分别携带独立上下文参数，多会话与多模型并发隔离生效。', 'zh-TW': '<strong>影響範圍</strong>：底座引擎採用動態跟隨架構，每個對話請求按目前所選模型分別攜帶獨立上下文參數，多工作階段與多模型並發隔離生效。', en: '<strong>Scope</strong>: The base engine uses a dynamic follow architecture, where each request carries independent context limits per model with full multi-session isolation.' },
    'models.details.li4': {
      'zh-CN': '<strong>验证范围</strong>：<div>已验证：客户端重启后读到了新设置，并在之后的会话中观测到对应预算。</div><div>未验证：真实超长请求能否被服务端完整接受；账号风险未知。</div>',
      'zh-TW': '<strong>驗證範圍</strong>：<div>已驗證：用戶端重啟後讀到了新設定，並在之後的對話中觀測到對應預算。</div><div>未驗證：真實超長請求能否被伺服器端完整接受；帳號風險未知。</div>',
      en: '<strong>Verification scope</strong>:<div>Verified: client read the new setting after restart and live turns showed the updated budget.</div><div>Unverified: whether the server accepts full ultra-long requests; account risk is unknown.</div>'
    },
    'models.details.li5': { 'zh-CN': '<strong>精确数值</strong>：512K = 512,000 tokens；可设置范围 16,384 – 2,097,152 tokens；跟随模型不固定数值。', 'zh-TW': '<strong>精確數值</strong>：512K = 512,000 tokens；可設定範圍 16,384 – 2,097,152 tokens；跟隨模型不固定數值。', en: '<strong>Exact values</strong>: 512K = 512,000 tokens; allowed range 16,384 – 2,097,152 tokens; Follow Model has no fixed cap.' },
    'models.btn.restoreOriginal': { 'zh-CN': '客户端恢复原始设置', 'zh-TW': '用戶端恢復原始設定', en: 'Restore Client Default' },
    'models.btn.refreshStatus': { 'zh-CN': '刷新状态', 'zh-TW': '重新整理狀態', en: 'Refresh' },
    'models.status.detecting': { 'zh-CN': '正在检测当前 Antigravity 状态…', 'zh-TW': '正在偵測目前 Antigravity 狀態…', en: 'Detecting current Antigravity status…' },
    'models.meta.mode': { 'zh-CN': '当前配置 / 实测', 'zh-TW': '目前設定 / 實測', en: 'Config / Observed' },
    'models.meta.target': { 'zh-CN': '目标进程', 'zh-TW': '目標行程', en: 'Target Binary' },
    'models.meta.arch': { 'zh-CN': '系统架构', 'zh-TW': '系統架構', en: 'Architecture' },
    'models.meta.backup': { 'zh-CN': '原版备份状态', 'zh-TW': '原版備份狀態', en: 'Original Backup' },
    'models.credit.source': { 'zh-CN': '方案来源：', 'zh-TW': '方案來源：', en: 'Source:' },
    'models.credit.author': { 'zh-CN': '原作者帖子 (Linux.do @23375) ↗', 'zh-TW': '原作者文章 (Linux.do @23375) ↗', en: 'Original Post (Linux.do @23375) ↗' },
    'models.credit.copy': { 'zh-CN': '📋 复制链接', 'zh-TW': '📋 複製連結', en: '📋 Copy Link' },
    'models.credit.adapter': { 'zh-CN': '本项目负责 Node.js 适配与集成', 'zh-TW': '本專案負責 Node.js 適配與整合', en: 'Node.js adaptation & integration by this project' },

    // 状态与反馈通用
    'status.savedDefault': { 'zh-CN': '未单独设置（使用默认）', 'zh-TW': '未單獨設定（使用預設）', en: 'Not set (Default)' },
    'status.savedShortDefault': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
    'status.badge.unavailable': { 'zh-CN': '暂时无法读取客户端状态', 'zh-TW': '暫時無法讀取用戶端狀態', en: 'Client status unavailable' },
    'status.badge.reading': { 'zh-CN': '状态读取中…', 'zh-TW': '狀態讀取中…', en: 'Reading status…' },
    'status.badge.pendingRestart': { 'zh-CN': '需要重启', 'zh-TW': '需要重新啟動', en: 'Restart Required' },
    'status.badge.notPatched': { 'zh-CN': '未修改（使用默认）', 'zh-TW': '未修改（使用預設）', en: 'Unmodified (Default)' },
    'status.badge.unconfirmed': { 'zh-CN': '状态未确认', 'zh-TW': '狀態未確認', en: 'Unconfirmed' },
    'status.badge.loaded': { 'zh-CN': '已加载', 'zh-TW': '已載入', en: 'Active' },
    'status.badge.failed': { 'zh-CN': '应用失败', 'zh-TW': '套用失敗', en: 'Apply Failed' },
    'status.client.reading': { 'zh-CN': '客户端设置：状态读取中…', 'zh-TW': '用戶端設定：狀態讀取中…', en: 'Client setting: reading…' },
    'status.client.pendingRestart': { 'zh-CN': '待重启：已设置为 {val}，重启后生效', 'zh-TW': '待重啟：已設定為 {val}，重啟後生效', en: 'Pending restart: set to {val}, restart client to apply' },
    'status.client.loadedFixed': { 'zh-CN': '当前已加载的设置：{val}', 'zh-TW': '目前已載入的設定：{val}', en: 'Active loaded setting: {val}' },
    'status.client.loadedDynamic': { 'zh-CN': '当前已加载的设置：跟随模型', 'zh-TW': '目前已載入的設定：跟隨模型', en: 'Active loaded setting: Follow Model' },
    'status.client.loadedDefault': { 'zh-CN': '当前已加载的设置：官方默认', 'zh-TW': '目前已載入的設定：官方預設', en: 'Active loaded setting: Official Default' },
    'status.client.unknown': { 'zh-CN': '当前已加载设置：未知', 'zh-TW': '目前已載入設定：未知', en: 'Active loaded setting: unknown' },
    'status.client.dynamic': { 'zh-CN': '客户端设置：跟随模型（各模型实际长度可能不同）', 'zh-TW': '用戶端設定：跟隨模型（各模型實際長度可能不同）', en: 'Client setting: Follow Model (varies by model)' },
    'status.client.fixed': { 'zh-CN': '客户端设置：{val}（所有模型同一长度）', 'zh-TW': '用戶端設定：{val}（所有模型同一長度）', en: 'Client setting: {val} (shared across models)' },
    'msg.savedUnified': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為此模型儲存統一設定。', en: 'Saved unified setting for this model.' },
    'msg.saveUnifiedFail': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save unified setting: {err}' },
    'msg.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'msg.resetDefault': { 'zh-CN': '已恢复默认设置。', 'zh-TW': '已恢復預設設定。', en: 'Reset to default.' },
    'msg.resetStillUsing': { 'zh-CN': '客户端仍在使用 {val}。需要时请在「详细说明」里点「客户端恢复原始设置」。', 'zh-TW': '用戶端仍在使用 {val}。需要時請在「詳細說明」中點擊「用戶端恢復原始設定」。', en: 'Client is still using {val}. Use "Restore Client Default" in Details if needed.' },
    'msg.clearFail': { 'zh-CN': '清除设置失败：{err}', 'zh-TW': '清除設定失敗：{err}', en: 'Failed to clear setting: {err}' },
    'msg.appliedRestart': { 'zh-CN': '已应用。重启客户端后生效。', 'zh-TW': '已套用。重新啟動用戶端後生效。', en: 'Applied. Restart the client to take effect.' },
    'msg.alreadyClient': { 'zh-CN': '客户端已经是这个设置', 'zh-TW': '用戶端已經是此設定', en: 'Client is already using this setting.' },
    'msg.applied': { 'zh-CN': '已应用当前设置。', 'zh-TW': '已套用目前設定。', en: 'Setting applied.' },
    'msg.restoredRestart': { 'zh-CN': '客户端已恢复原始设置，重启客户端后生效。', 'zh-TW': '用戶端已恢復原始設定，重新啟動用戶端後生效。', en: 'Client restored to original default. Restart to take effect.' },
    'msg.restoreFail': { 'zh-CN': '恢复原始设置失败', 'zh-TW': '恢復原始設定失敗', en: 'Failed to restore client default' },
    'msg.writeBusy': { 'zh-CN': '客户端正在占用文件，写入失败。请关闭客户端后再试。', 'zh-TW': '用戶端正在佔用檔案，寫入失敗。請關閉用戶端後再試。', en: 'File is in use by the client. Close the client and try again.' },
    'msg.writeFail': { 'zh-CN': '写入失败：{err}', 'zh-TW': '寫入失敗：{err}', en: 'Write failed: {err}' },
    'msg.unknownErr': { 'zh-CN': '未知错误', 'zh-TW': '未知錯誤', en: 'Unknown error' },

    // 分页 3: 速度对比
    'speed.range.aria': { 'zh-CN': '时间范围', 'zh-TW': '時間範圍', en: 'Time range' },
    'speed.range.7d': { 'zh-CN': '近 7 天', 'zh-TW': '近 7 天', en: '7D' },
    'speed.range.30d': { 'zh-CN': '近 30 天', 'zh-TW': '近 30 天', en: '30D' },
    'speed.range.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
    'speed.origin.aria': { 'zh-CN': '样本来源', 'zh-TW': '樣本來源', en: 'Sample origin' },
    'speed.origin.all': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All sources' },
    'speed.origin.chat': { 'zh-CN': '日常对话', 'zh-TW': '日常對話', en: 'Chat' },
    'speed.metric.aria': { 'zh-CN': '对比指标', 'zh-TW': '對比指標', en: 'Metric' },
    'speed.metric.tps': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Speed' },
    'speed.metric.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
    'speed.metric.duration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
    'speed.barTitle.tps': { 'zh-CN': '输出速度对比', 'zh-TW': '輸出速度對比', en: 'Output Speed Comparison' },
    'speed.barTitle.ttft': { 'zh-CN': '首字延迟对比', 'zh-TW': '首字延遲對比', en: 'First-Token Latency (TTFT)' },
    'speed.barTitle.duration': { 'zh-CN': '总耗时对比', 'zh-TW': '總耗時對比', en: 'Total Duration Comparison' },
    'speed.empty': { 'zh-CN': '还没有可用的速度记录。正常对话后会自动积累。', 'zh-TW': '還沒有可用的速度記錄。正常對話後會自動累積。', en: 'No speed samples yet. Samples are recorded automatically during normal chats.' },
    'speed.barNote': { 'zh-CN': '以各模型与档位的中位数统计；不足 3 条标注“样本少”。总耗时受输出长度影响，条件相近时才可比较。', 'zh-TW': '以各模型與檔位的中位數統計；不足 3 筆標註「樣本少」。總耗時受輸出長度影響，條件相近時才可比較。', en: 'Bars show median per model & effort; <3 samples are marked "Low n". Total duration depends on output length.' },
    'speed.lineTitle': { 'zh-CN': '单模型速度趋势', 'zh-TW': '單模型速度趨勢', en: 'Model Speed Trend' },
    'speed.linePickTitle': { 'zh-CN': '选择一个模型与档位查看速度变化', 'zh-TW': '選擇一個模型與檔位檢視速度變化', en: 'Select a model & effort to view speed trend' },
    'speed.lineNoModel': { 'zh-CN': '暂无模型记录', 'zh-TW': '暫無模型記錄', en: 'No model records' },
    'speed.activeTestNote': { 'zh-CN': '主动测试：未接通。目前没有可靠的指定模型调用入口，暂时只能使用日常对话的实测记录。', 'zh-TW': '主動測試：未接通。目前沒有可靠的指定模型呼叫入口，暫時只能使用日常對話的實測記錄。', en: 'Active benchmark: unavailable. No reliable per-model probe endpoint exists yet; showing live chat measurements only.' },
    'speed.lowSample': { 'zh-CN': '样本少', 'zh-TW': '樣本少', en: 'Low n' },
    'speed.samples': { 'zh-CN': '{n} 条', 'zh-TW': '{n} 筆', en: '{n} samples' },
    'speed.median': { 'zh-CN': '中位数：{val}', 'zh-TW': '中位數：{val}', en: 'Median: {val}' },
    'speed.avg': { 'zh-CN': '均值：{val}', 'zh-TW': '均值：{val}', en: 'Avg: {val}' },
    'speed.sampleCount': { 'zh-CN': '样本数：{n} 条', 'zh-TW': '樣本數：{n} 筆', en: 'Samples: {n}' },
    'speed.latestAt': { 'zh-CN': '最近：{time}', 'zh-TW': '最近：{time}', en: 'Latest: {time}' },

    // 齿轮设置页
    'settings.back': { 'zh-CN': '‹ 返回', 'zh-TW': '‹ 返回', en: '‹ Back' },
    'settings.title': { 'zh-CN': '设置（语言、网络代理与外观）', 'zh-TW': '設定（語言、網路代理與外觀）', en: 'Settings (Language, Proxy & Appearance)' },
    'settings.panelLang.title': { 'zh-CN': '🌐 插件面板语言（Context Meter）', 'zh-TW': '🌐 外掛面板語言（Context Meter）', en: '🌐 Panel Language (Context Meter)' },
    'settings.panelLang.aria': { 'zh-CN': '插件面板语言', 'zh-TW': '外掛面板語言', en: 'Panel language' },
    'settings.panelLang.desc': { 'zh-CN': '控制 Context Meter 面板、按钮、图表与提示文字。切换立即生效并保存，重启后保留；不改写上下文长度，不触发重启。', 'zh-TW': '控制 Context Meter 面板、按鈕、圖表與提示文字。切換立即生效並儲存，重啟後保留；不改寫上下文長度，不觸發重啟。', en: 'Controls Context Meter UI, charts, and messages. Applies and saves immediately without changing context limits or restarting.' },
    'settings.panelLang.saved': { 'zh-CN': '已切换并保存', 'zh-TW': '已切換並儲存', en: 'Saved' },
    'settings.panelLang.saveLocal': { 'zh-CN': '已切换（仅本地生效）', 'zh-TW': '已切換（僅本機生效）', en: 'Applied locally' },
    'settings.clientLang.title': { 'zh-CN': '🖥️ 客户端界面语言（Antigravity 本身）', 'zh-TW': '🖥️ 用戶端介面語言（Antigravity 本身）', en: '🖥️ Client UI Language (Antigravity)' },
    'settings.clientLang.aria': { 'zh-CN': '客户端界面语言', 'zh-TW': '用戶端介面語言', en: 'Client UI language' },
    'settings.clientLang.statusLabel': { 'zh-CN': '客户端当前语言与生效方式', 'zh-TW': '用戶端目前語言與生效方式', en: 'Client language status & apply behavior' },
    'settings.clientLang.licenseNote': { 'zh-CN': '说明：此设置控制 Antigravity 客户端本身，与上方插件面板语言相互独立。切换客户端语言需重新安装/重启客户端后生效。由于上游客户端繁體中文词典（qqxpee/antigravity2-cn）未声明开源许可证，暂未内置客户端繁體中文选项。', 'zh-TW': '說明：此設定控制 Antigravity 用戶端本身，與上方外掛面板語言相互獨立。切換用戶端語言需重新安裝／重新啟動用戶端後生效。由於上游用戶端繁體中文詞典（qqxpee/antigravity2-cn）未聲明開源授權，暫未內建用戶端繁體中文選項。', en: 'Note: Controls Antigravity itself, independent from Panel Language. Changing client language requires reinstalling/restarting Antigravity. Traditional Chinese client dicts (upstream qqxpee/antigravity2-cn) have no declared license and are not bundled.' },
    'settings.clientLang.sourceLabel': { 'zh-CN': '汉化方案来源：', 'zh-TW': '中文化方案來源：', en: 'Localization source:' },
    'settings.clientLang.sourceValue': { 'zh-CN': 'AntigravityChinese (开源社区贡献)', 'zh-TW': 'AntigravityChinese（開源社群貢獻）', en: 'AntigravityChinese (Community)' },
    'settings.proxy.title': { 'zh-CN': '🌐 免 TUN 网络直连（本地代理）', 'zh-TW': '🌐 免 TUN 網路直連（本機代理）', en: '🌐 TUN-free Local Proxy' },
    'settings.proxy.statusLabel': { 'zh-CN': '代理直连配置与状态', 'zh-TW': '代理直連設定與狀態', en: 'Proxy configuration & status' },
    'settings.proxy.urlLabel': { 'zh-CN': '本地代理地址 (例如 http://127.0.0.1:7897 或 socks5://...)：', 'zh-TW': '本機代理位址 (例如 http://127.0.0.1:7897 或 socks5://...)：', en: 'Local proxy URL (e.g. http://127.0.0.1:7897 or socks5://...):' },
    'settings.proxy.bypassLabel': { 'zh-CN': '绕过代理列表 (NO_PROXY)：', 'zh-TW': '略過代理清單 (NO_PROXY)：', en: 'Bypass list (NO_PROXY):' },
    'settings.proxy.testBtn': { 'zh-CN': '🔍 测试代理连通性', 'zh-TW': '🔍 測試代理連通性', en: '🔍 Test Proxy' },
    'settings.colors.title': { 'zh-CN': '🎨 指标与背景颜色自定义（默认跟随主题）', 'zh-TW': '🎨 指標與背景顏色自訂（預設跟隨主題）', en: '🎨 Metric & Background Colors (Follow Theme)' },
    'settings.colors.panelBg': { 'zh-CN': '面板与菜单统一背景色（0级跟随 / 自定义）', 'zh-TW': '面板與選單統一背景色（0 級跟隨 / 自訂）', en: 'Panel & menu background (Auto / Custom)' },
    'settings.colors.ringUsed': { 'zh-CN': '圆环已用部分', 'zh-TW': '圓環已用部分', en: 'Ring used' },
    'settings.colors.ringTrack': { 'zh-CN': '圆环轨道', 'zh-TW': '圓環軌道', en: 'Ring track' },
    'settings.colors.contextText': { 'zh-CN': '上下文用量文字', 'zh-TW': '上下文用量文字', en: 'Context text' },
    'settings.colors.speedText': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
    'settings.colors.tokenTotal': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 token 用量', en: 'Total tokens' },
    'settings.colors.tokenAccent': { 'zh-CN': '其他 token 指标', 'zh-TW': '其他 token 指標', en: 'Token accent' },
    'settings.colors.note': { 'zh-CN': '注：高占用与超限告警色独立保留，不被常态颜色覆盖。', 'zh-TW': '註：高佔用與超限告警色獨立保留，不被常態顏色覆蓋。', en: 'Note: High-usage and overflow alert colors remain independent.' },
    'settings.colors.resetAll': { 'zh-CN': '全部恢复跟随主题', 'zh-TW': '全部恢復跟隨主題', en: 'Reset all to theme' },
    'drawer.expand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
    'drawer.collapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
    'drawer.expandSettings': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
    'drawer.collapseSettings': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

    // 下拉菜单通用
    'dropdown.searchPlaceholder': { 'zh-CN': '🔍 搜索...', 'zh-TW': '🔍 搜尋...', en: '🔍 Search...' },
    'dropdown.empty': { 'zh-CN': '未找到匹配项', 'zh-TW': '找不到符合項目', en: 'No matching items' },
    'dropdown.modelSearch': { 'zh-CN': '🔍 搜索模型或厂商…', 'zh-TW': '🔍 搜尋模型或廠商…', en: '🔍 Search model or vendor…' },
    'dropdown.modelEmpty': { 'zh-CN': '未找到匹配的模型', 'zh-TW': '找不到符合的模型', en: 'No matching models' },
    'dropdown.speedSearch': { 'zh-CN': '🔍 搜索模型或档位…', 'zh-TW': '🔍 搜尋模型或檔位…', en: '🔍 Search model or effort…' },
    'dropdown.speedEmpty': { 'zh-CN': '未找到匹配的模型记录', 'zh-TW': '找不到符合的模型記錄', en: 'No matching speed records' },

    // Token 面板 & 颜色选择器 & 更新浮层
    'tokens.title': { 'zh-CN': '本机已记录用量', 'zh-TW': '本機已記錄用量', en: 'Local Recorded Usage' },
    'tokens.sourceLabel': { 'zh-CN': '来源:', 'zh-TW': '來源:', en: 'Source:' },
    'tokens.src.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
    'tokens.src.desktop': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },
    'tokens.src.cli': { 'zh-CN': 'CLI', 'zh-TW': 'CLI', en: 'CLI' },
    'tokens.view.tokens': { 'zh-CN': 'Token 统计', 'zh-TW': 'Token 統計', en: 'Token Stats' },
    'tokens.view.cost': { 'zh-CN': 'API 参考金额', 'zh-TW': 'API 參考金額', en: 'API Est. Cost' },
    'tokens.card.total': { 'zh-CN': '累计处理 Token', 'zh-TW': '累計處理 Token', en: 'Total Tokens' },
    'tokens.card.includeCache': { 'zh-CN': '含缓存读取', 'zh-TW': '含快取讀取', en: 'Incl. cache reads' },
    'tokens.card.today': { 'zh-CN': '今日使用', 'zh-TW': '今日使用', en: 'Today' },
    'tokens.card.month': { 'zh-CN': '本月使用', 'zh-TW': '本月使用', en: 'This Month' },
    'tokens.card.year': { 'zh-CN': '年度使用', 'zh-TW': '年度使用', en: 'This Year' },
    'tokens.heat.title': { 'zh-CN': 'Token 活动', 'zh-TW': 'Token 活動', en: 'Token Activity' },
    'tokens.heat.daily': { 'zh-CN': '每天', 'zh-TW': '每天', en: 'Daily' },
    'tokens.heat.weekly': { 'zh-CN': '每周', 'zh-TW': '每週', en: 'Weekly' },
    'tokens.heat.monthly': { 'zh-CN': '每月', 'zh-TW': '每月', en: 'Monthly' },
    'tokens.heat.yearly': { 'zh-CN': '今年', 'zh-TW': '今年', en: 'Year' },
    'tokens.heat.cum': { 'zh-CN': '累计总量', 'zh-TW': '累計總量', en: 'Cumulative' },
    'tokens.heat.sumTokens': { 'zh-CN': '区间合计:', 'zh-TW': '區間合計:', en: 'Range total:' },
    'tokens.heat.sumCost': { 'zh-CN': '预估费用:', 'zh-TW': '預估費用:', en: 'Est. cost:' },
    'tokens.heat.sumDailyAvg': { 'zh-CN': '折合每天:', 'zh-TW': '折合每天:', en: 'Daily avg:' },
    'tokens.heat.sumActiveAvg': { 'zh-CN': '活跃日均:', 'zh-TW': '活躍日均:', en: 'Active avg:' },
    'tokens.heat.sumSubRatio': { 'zh-CN': '订阅性价比:', 'zh-TW': '訂閱性價比:', en: 'Plan value:' },
    'tokens.heat.disclaimer': { 'zh-CN': '注：按日聚合按基础档估算，未拆分长上下文分档，结果偏下限。有逐请求记录时优先精确入账。', 'zh-TW': '註：按日彙總依基礎檔估算，未拆分長上下文分檔，結果偏下限。有逐請求記錄時優先精確入帳。', en: 'Note: Daily aggregates use base tier pricing (lower bound) unless per-request records are available.' },
    'tokens.heat.tip': { 'zh-CN': '点击或悬浮格子查看当日详细 Token 构成', 'zh-TW': '點擊或懸停格子檢視當日詳細 Token 構成', en: 'Click or hover a cell to view daily token breakdown' },
    'tokens.heat.less': { 'zh-CN': '少', 'zh-TW': '少', en: 'Less' },
    'tokens.heat.more': { 'zh-CN': '多', 'zh-TW': '多', en: 'More' },
    'tokens.colors.title': { 'zh-CN': '🎨 热力图色阶与面板外观自定义（默认跟随主题）', 'zh-TW': '🎨 熱力圖色階與面板外觀自訂（預設跟隨主題）', en: '🎨 Heatmap Palette & Panel Appearance' },
    'tokens.update.title': { 'zh-CN': '更新设置', 'zh-TW': '更新設定', en: 'Update Settings' },
    'tokens.update.auto': { 'zh-CN': '启动时自动检查更新（不自动安装）', 'zh-TW': '啟動時自動檢查更新（不自動安裝）', en: 'Check for updates on startup (manual install)' },
    'cp.title': { 'zh-CN': '🎨 颜色选取器', 'zh-TW': '🎨 顏色選取器', en: '🎨 Color Picker' },
    'cp.eyedropper': { 'zh-CN': '🖊 取色', 'zh-TW': '🖊 取色', en: '🖊 Pick' },
    'cp.moreFormats': { 'zh-CN': '更多格式 (RGB / HSL)', 'zh-TW': '更多格式 (RGB / HSL)', en: 'More formats (RGB / HSL)' },
    'cp.hint': { 'zh-CN': '支持直接输入或粘贴 HEX 色值', 'zh-TW': '支援直接輸入或貼上 HEX 色值', en: 'Type or paste a HEX color value' },
    'cp.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow Theme' },
    'colors.btn.restore': { 'zh-CN': '恢复', 'zh-TW': '恢復', en: 'Reset' },
    'colors.btn.preset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
    'colors.btn.restorePreset': { 'zh-CN': '恢复预设', 'zh-TW': '恢復預設', en: 'Reset Preset' },
    'colors.btn.restoreDefault': { 'zh-CN': '恢复默认', 'zh-TW': '恢復預設', en: 'Default' },
    'theme.light': { 'zh-CN': '浅色', 'zh-TW': '淺色', en: 'Light' },
    'theme.dark': { 'zh-CN': '深色', 'zh-TW': '深色', en: 'Dark' },
    'theme.autoTitle': { 'zh-CN': '当前主题：跟随宿主 ({mode})\n点击切换为：浅色模式', 'zh-TW': '目前主題：跟隨宿主 ({mode})\n點擊切換為：淺色模式', en: 'Theme: Follow IDE ({mode})\nClick to switch to Light' },
    'theme.lightTitle': { 'zh-CN': '当前主题：浅色模式 (固定)\n点击切换为：深色模式', 'zh-TW': '目前主題：淺色模式 (固定)\n點擊切換為：深色模式', en: 'Theme: Light (Fixed)\nClick to switch to Dark' },
    'theme.darkTitle': { 'zh-CN': '当前主题：深色模式 (固定)\n点击切换为：跟随宿主', 'zh-TW': '目前主題：深色模式 (固定)\n點擊切換為：跟隨宿主', en: 'Theme: Dark (Fixed)\nClick to switch to Follow IDE' },

    // 本轮/会话估值
    'cost.streamingEst': { 'zh-CN': '生成中暂估', 'zh-TW': '生成中暫估', en: 'Streaming est.' },
    'cost.returnedEst': { 'zh-CN': '按已返回用量估算', 'zh-TW': '依已回傳用量估算', en: 'Based on returned usage' },
    'cost.latestTurn': { 'zh-CN': '最近调用 {val} · {label}', 'zh-TW': '最近呼叫 {val} · {label}', en: 'Latest turn {val} · {label}' },
    'cost.unpriced': { 'zh-CN': '最近调用：模型费率未收录', 'zh-TW': '最近呼叫：模型費率未收錄', en: 'Latest turn: unpriced model' },
    'cost.latestDash': { 'zh-CN': '最近调用估值：—', 'zh-TW': '最近呼叫估值：—', en: 'Latest turn: —' },
    'cost.sessionTotal': { 'zh-CN': '当前会话合计约 ${val}', 'zh-TW': '目前工作階段合計約 ${val}', en: 'Session total ≈ ${val}' },
    'cost.modelTip': { 'zh-CN': '模型：{model}\n输入：{input} tok\n缓存：{cache} tok\n输出：{output} tok\n参考金额：${cost}', 'zh-TW': '模型：{model}\n輸入：{input} tok\n快取：{cache} tok\n輸出：{output} tok\n參考金額：${cost}', en: 'Model: {model}\nInput: {input} tok\nCache: {cache} tok\nOutput: {output} tok\nEst. cost: ${cost}' },
    'cost.unpricedTip': { 'zh-CN': '模型：{model}（公开费率未收录）', 'zh-TW': '模型：{model}（公開費率未收錄）', en: 'Model: {model} (public rate unavailable)' },
    'cost.missingModel': { 'zh-CN': '缺少模型信息', 'zh-TW': '缺少模型資訊', en: 'Missing model info' },

    // 模块状态（客户端语言 / 代理）
    'mod.readFail': { 'zh-CN': '⚠️ 读取失败', 'zh-TW': '⚠️ 讀取失敗', en: '⚠️ Read Failed' },
    'mod.readErr': { 'zh-CN': '⚠️ 读取异常', 'zh-TW': '⚠️ 讀取異常', en: '⚠️ Read Error' },
    'mod.processing': { 'zh-CN': '正在处理…', 'zh-TW': '正在處理…', en: 'Processing…' },
    'mod.zh.failDetect': { 'zh-CN': '检测汉化状态失败: {err}', 'zh-TW': '偵測中文化狀態失敗: {err}', en: 'Failed to detect client language status: {err}' },
    'mod.zh.errDetect': { 'zh-CN': '检测汉化状态异常: {err}', 'zh-TW': '偵測中文化狀態異常: {err}', en: 'Error detecting client language status: {err}' },
    'mod.zh.badgeRestartEn': { 'zh-CN': '⏳ 需重启恢复英文', 'zh-TW': '⏳ 需重啟恢復英文', en: '⏳ Restart for English' },
    'mod.zh.badgeOffReady': { 'zh-CN': '⚪ 已关闭 (官方英文)', 'zh-TW': '⚪ 已關閉 (官方英文)', en: '⚪ English (Active)' },
    'mod.zh.badgeNotInstalled': { 'zh-CN': '⚪ 官方英文 (未注入汉化)', 'zh-TW': '⚪ 官方英文 (未注入中文化)', en: '⚪ English (Default)' },
    'mod.zh.badgeActive': { 'zh-CN': '🟢 已翻译生效', 'zh-TW': '🟢 已翻譯生效', en: '🟢 zh-CN Active' },
    'mod.zh.badgeNotInjected': { 'zh-CN': '⚠️ 磁盘未注入', 'zh-TW': '⚠️ 磁碟未注入', en: '⚠️ Not Injected' },
    'mod.zh.badgePendingRestart': { 'zh-CN': '⏳ 待重启客户端生效', 'zh-TW': '⏳ 待重啟用戶端生效', en: '⏳ Restart Required' },
    'mod.zh.descRestartEn': { 'zh-CN': '已切换为官方英文；当前界面仍保留已加载的中文 DOM 缓存，需完全退出并重新打开 Antigravity 客户端后彻底生效。', 'zh-TW': '已切換為官方英文；目前介面仍保留已載入的中文 DOM 快取，需完全結束並重新開啟 Antigravity 用戶端後徹底生效。', en: 'Switched to English; current UI still retains loaded Chinese DOM cache. Fully quit and reopen Antigravity to apply.' },
    'mod.zh.descOffReady': { 'zh-CN': '客户端当前保持官方原生英文（磁盘已具备简体中文资源与配置门禁，切换为简体中文并重启即可生效）。', 'zh-TW': '用戶端目前保持官方原生英文（磁碟已具備簡體中文資源與設定門禁，切換為簡體中文並重啟即可生效）。', en: 'Client is running native English (zh-CN resources are staged on disk; switch to zh-CN and restart to apply).' },
    'mod.zh.descOffNotInstalled': { 'zh-CN': '客户端汉化处于未安装状态，保持官方原生英文界面。', 'zh-TW': '用戶端中文化處於未安裝狀態，保持官方原生英文介面。', en: 'Client localization is not installed; running native English.' },
    'mod.zh.descActive': { 'zh-CN': '客户端简体中文运行中：DOM 监听器正常工作，左侧边栏与核心菜单已翻译。', 'zh-TW': '用戶端簡體中文執行中：DOM 監聽器正常運作，左側邊欄與核心選單已翻譯。', en: 'Client zh-CN localization is active.' },
    'mod.zh.descNeedInject': { 'zh-CN': '配置已开启简体中文，但当前磁盘 ASAR 未注入汉化资源；需退出客户端后通过命令行运行 node cli.js chinese:enable 完成注入。', 'zh-TW': '設定已開啟簡體中文，但目前磁碟 ASAR 未注入中文化資源；需結束用戶端後執行 node cli.js chinese:enable 完成注入。', en: 'zh-CN is enabled in config, but ASAR lacks localization injection. Quit Antigravity and run: node cli.js chinese:enable' },
    'mod.zh.descPendingRestart': { 'zh-CN': '简体中文代码已注入且配置已开启；需完全退出并重新打开 Antigravity 客户端加载生效。', 'zh-TW': '簡體中文程式碼已注入且設定已開啟；需完全結束並重新開啟 Antigravity 用戶端載入生效。', en: 'zh-CN localization is injected and enabled; quit and reopen Antigravity to take effect.' },
    'mod.zh.btnDisable': { 'zh-CN': '切换为官方英文 (需重启)', 'zh-TW': '切換為官方英文 (需重啟)', en: 'Switch to English (Restart)' },
    'mod.zh.btnEnable': { 'zh-CN': '切换为简体中文 (需重启)', 'zh-TW': '切換為簡體中文 (需重啟)', en: 'Switch to 简体中文 (Restart)' },
    'mod.zh.toggleFail': { 'zh-CN': '切换客户端语言失败', 'zh-TW': '切換用戶端語言失敗', en: 'Failed to switch client language' },
    'mod.proxy.failDetect': { 'zh-CN': '检测免 TUN 代理状态失败: {err}', 'zh-TW': '偵測免 TUN 代理狀態失敗: {err}', en: 'Failed to detect proxy status: {err}' },
    'mod.proxy.errDetect': { 'zh-CN': '检测免 TUN 代理状态异常: {err}', 'zh-TW': '偵測免 TUN 代理狀態異常: {err}', en: 'Error detecting proxy status: {err}' },
    'mod.proxy.badgeOk': { 'zh-CN': '🟢 直连已配置', 'zh-TW': '🟢 直連已設定', en: '🟢 Configured' },
    'mod.proxy.badgeNotInjected': { 'zh-CN': '⚠️ 磁盘未注入', 'zh-TW': '⚠️ 磁碟未注入', en: '⚠️ Not Injected' },
    'mod.proxy.badgeOff': { 'zh-CN': '⚪ 未启用', 'zh-TW': '⚪ 未啟用', en: '⚪ Disabled' },
    'mod.proxy.descOn': { 'zh-CN': '已启用本地网络直连（代理: {url}）。注意：模型请求连通性待实际在线对话验证，未验证前不代表公网直连必定成功。', 'zh-TW': '已啟用本機網路直連（代理: {url}）。注意：模型請求連通性待實際線上對話驗證。', en: 'Local proxy enabled ({url}). Connectivity should be verified with a live chat request.' },
    'mod.proxy.descNeedInject': { 'zh-CN': '配置已开启代理，但当前磁盘 ASAR 未注入代理拦截逻辑；需退出客户端后通过命令行运行 node cli.js proxy:enable 完成注入。', 'zh-TW': '設定已開啟代理，但目前磁碟 ASAR 未注入代理攔截邏輯；需結束用戶端後執行 node cli.js proxy:enable 完成注入。', en: 'Proxy enabled in config, but ASAR lacks proxy hook. Quit Antigravity and run: node cli.js proxy:enable' },
    'mod.proxy.descOff': { 'zh-CN': '未启用本地网络直连，网络请求跟随系统默认/TUN 设置。', 'zh-TW': '未啟用本機網路直連，網路請求跟隨系統預設/TUN 設定。', en: 'Local proxy disabled; requests follow system/TUN settings.' },
    'mod.proxy.btnDisable': { 'zh-CN': '关闭免 TUN 直连', 'zh-TW': '關閉免 TUN 直連', en: 'Disable Local Proxy' },
    'mod.proxy.btnEnable': { 'zh-CN': '开启免 TUN 直连', 'zh-TW': '開啟免 TUN 直連', en: 'Enable Local Proxy' },
    'mod.proxy.testing': { 'zh-CN': '正在测试…', 'zh-TW': '正在測試…', en: 'Testing…' },
    'mod.proxy.testingDetail': { 'zh-CN': '正在发起本地与网络连通性测试…', 'zh-TW': '正在發起本機與網路連通性測試…', en: 'Testing local port and internet reachability…' },

    // 模型卡片与列表细节
    'models.list.currentTag': { 'zh-CN': '当前', 'zh-TW': '目前', en: 'Current' },
    'models.list.conflictPill': { 'zh-CN': '多档位冲突', 'zh-TW': '多檔位衝突', en: 'Conflict' },
    'models.card.savedConflict': { 'zh-CN': '多档位冲突（请统一）', 'zh-TW': '多檔位衝突（請統一）', en: 'Conflict (pick one)' },
    'models.card.savedCustom': { 'zh-CN': '自定义 {val}', 'zh-TW': '自訂 {val}', en: 'Custom {val}' },
    'models.card.savedShortCustom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
    'models.card.clientFollowing': { 'zh-CN': '跟随模型', 'zh-TW': '跟隨模型', en: 'Follow Model' },
    'models.card.clientDefault': { 'zh-CN': '默认（未修改）', 'zh-TW': '預設（未修改）', en: 'Default (Original)' },
    'models.card.preRestart': { 'zh-CN': '重启前已观测：{val}', 'zh-TW': '重啟前已觀測：{val}', en: 'Before restart: {val}' },
    'models.card.serviceLimit': { 'zh-CN': '服务端报错上限：{val}', 'zh-TW': '伺服器端報錯上限：{val}', en: 'Server error limit: {val}' },
    'models.card.hintDynamic': { 'zh-CN': '已应用跟随模型；正在使用的模型实际预算需由对话请求确认。', 'zh-TW': '已套用跟隨模型；正在使用的模型實際預算需由對話請求確認。', en: 'Follow Model is active; exact per-model budget is confirmed during live chat.' },
    'models.card.hintSavedDiff': { 'zh-CN': '已保存目标（{saved}）与客户端当前配置（{client}）不同；点击下方「保存并应用」写入客户端。', 'zh-TW': '已儲存目標（{saved}）與用戶端目前設定（{client}）不同；點擊下方「儲存並套用」寫入用戶端。', en: 'Saved target ({saved}) differs from client active ({client}); click "Save & Apply" to update.' },
    'models.card.hintRestartWait': { 'zh-CN': '新设置已写入客户端，重启后生效，目前对话仍使用旧设置。', 'zh-TW': '新設定已寫入用戶端，重啟後生效，目前對話仍使用舊設定。', en: 'New setting written to client; restart required before new chats use it.' },
    'models.card.speedLine': { 'zh-CN': '{effort}：中位 {tps} tok/s · {n} 条', 'zh-TW': '{effort}：中位 {tps} tok/s · {n} 筆', en: '{effort}: median {tps} tok/s · {n}' },
    'models.card.defaultEffort': { 'zh-CN': '标准', 'zh-TW': '標準', en: 'Standard' },
    'models.mismatch': { 'zh-CN': '客户端重启后读到的配置（{actual}）与目标不一致，请重新应用。', 'zh-TW': '用戶端重啟後讀到的設定（{actual}）與目標不一致，請重新套用。', en: 'Client loaded ({actual}) after restart, which differs from target. Please reapply.' },
    'models.meta.modeLine': { 'zh-CN': '配置 {cfg} / 实测 {obs}', 'zh-TW': '設定 {cfg} / 實測 {obs}', en: 'Config {cfg} / Observed {obs}' },
    'models.meta.unobserved': { 'zh-CN': '未观测', 'zh-TW': '未觀測', en: 'Unobserved' },
    'models.meta.backupOk': { 'zh-CN': '已备份完整', 'zh-TW': '已備份完整', en: 'Backed up' },
    'models.meta.backupNone': { 'zh-CN': '无（未修改原版）', 'zh-TW': '無（未修改原版）', en: 'None (original)' },
    'models.copyOk': { 'zh-CN': '已复制链接', 'zh-TW': '已複製連結', en: 'Link copied' },
    'models.linkOpened': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者文章', en: 'Opened original author post in default browser' },
    'models.linkCopyFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者文章連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; author post URL copied to clipboard.' },
    'models.copyFail': { 'zh-CN': '无法自动打开，请手动复制：{url}', 'zh-TW': '無法自動開啟，請手動複製：{url}', en: 'Could not open automatically. URL: {url}' },
    'models.validation.dynamicDesc': { 'zh-CN': '跟随模型：所有模型使用同一种方式，每个模型按自己支持的长度分配，实际预算可能不同。', 'zh-TW': '跟隨模型：所有模型使用同一種方式，每個模型依自身支援的長度分配，實際預算可能不同。', en: 'Follow Model: each model uses its own supported limit; active budgets may differ.' },
    'models.validation.defaultDesc': { 'zh-CN': '默认：使用客户端原本的长度。', 'zh-TW': '預設：使用用戶端原本的長度。', en: 'Default: uses the native client limit.' },
    'models.validation.outOfRange': { 'zh-CN': '超出可设置范围（{min} – {max}）', 'zh-TW': '超出可設定範圍（{min} – {max}）', en: 'Out of allowed range ({min} – {max})' },
    'models.validation.tooSmall': { 'zh-CN': '设置值 {val} 偏小，可能很快触发上下文压缩。', 'zh-TW': '設定值 {val} 偏小，可能很快觸發上下文壓縮。', en: 'Value {val} is small and may trigger early compression.' },
    'models.validation.aboveService': { 'zh-CN': '高于最近一次服务端报错上限（{val}）。', 'zh-TW': '高於最近一次伺服器端報錯上限（{val}）。', en: 'Above recent server error limit ({val}).' },
    'models.card.observedWaitRestart': { 'zh-CN': '重启后尚未观测，发一条消息后更新', 'zh-TW': '重啟後尚未觀測，發送一則訊息後更新', en: 'Not observed after restart; send a message to update' },
    'models.card.observedTitle': { 'zh-CN': '实际分配预算：{val} tokens', 'zh-TW': '實際分配預算：{val} tokens', en: 'Allocated budget: {val} tokens' },
    'models.card.preRestartTitle': { 'zh-CN': '重启前预算：{val} tokens', 'zh-TW': '重啟前預算：{val} tokens', en: 'Budget before restart: {val} tokens' },
    'models.card.serviceLimitTitle': { 'zh-CN': '服务端报错上限：{val} tokens', 'zh-TW': '伺服器端報錯上限：{val} tokens', en: 'Server error limit: {val} tokens' },
    'models.card.speedLineText': { 'zh-CN': '{prefix}{tps} tokens/秒 · 近 {count} 次中位数{low}{ts}', 'zh-TW': '{prefix}{tps} tokens/秒 · 近 {count} 次中位數{low}{ts}', en: '{prefix}{tps} tok/s · median of {count}{low}{ts}' },
    'models.card.lowSampleParen': { 'zh-CN': '（样本少）', 'zh-TW': '（樣本少）', en: ' (low n)' },
    'models.card.hintDiffClient': { 'zh-CN': '与客户端当前使用的长度不同。应用后，所有模型都会改用这个长度。', 'zh-TW': '與用戶端目前使用的長度不同。套用後，所有模型都會改用此長度。', en: 'Differs from current client setting. Applying will update all models.' },
    'models.card.hintBelowSet': { 'zh-CN': '实际分配低于设置值，可能受模型或服务端限制。', 'zh-TW': '實際分配低於設定值，可能受模型或伺服器端限制。', en: 'Allocated budget is lower than configured; may be capped by model or server.' },
    'models.conflict.useThis': { 'zh-CN': '用这个', 'zh-TW': '用這個', en: 'Use this' },
    'models.conflict.orCustom': { 'zh-CN': '或重新设定一个统一值', 'zh-TW': '或重新設定一個統一值', en: 'Or set a unified value' },
    'models.conflict.selfSet': { 'zh-CN': '自己设置', 'zh-TW': '自行設定', en: 'Set manually' },
    'models.dropdown.empty': { 'zh-CN': '暂无已知模型', 'zh-TW': '暫無已知模型', en: 'No models yet' },

    // 速度图内部与提示
    'speed.unitSec': { 'zh-CN': '{val} 秒', 'zh-TW': '{val} 秒', en: '{val} s' },
    'speed.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
    'speed.originProbe': { 'zh-CN': '主动测试', 'zh-TW': '主動測試', en: 'Probe' },
    'speed.tip.samples': { 'zh-CN': '样本数：{n}{low}', 'zh-TW': '樣本數：{n}{low}', en: 'Samples: {n}{low}' },
    'speed.tip.timeRange': { 'zh-CN': '时间范围：{range}', 'zh-TW': '時間範圍：{range}', en: 'Range: {range}' },
    'speed.tip.medOut': { 'zh-CN': '输出 tokens 中位数：{val}', 'zh-TW': '輸出 tokens 中位數：{val}', en: 'Median output tokens: {val}' },
    'speed.tip.medIn': { 'zh-CN': '输入 tokens 中位数：{val}', 'zh-TW': '輸入 tokens 中位數：{val}', en: 'Median input tokens: {val}' },
    'speed.tip.time': { 'zh-CN': '时间：{val}', 'zh-TW': '時間：{val}', en: 'Time: {val}' },
    'speed.tip.output': { 'zh-CN': '输出：{val} tokens', 'zh-TW': '輸出：{val} tokens', en: 'Output: {val} tokens' },
    'speed.tip.ttft': { 'zh-CN': '首字延迟：{val}', 'zh-TW': '首字延遲：{val}', en: 'TTFT: {val}' },
    'speed.tip.origin': { 'zh-CN': '来源：{val}', 'zh-TW': '來源：{val}', en: 'Source: {val}' },
    'speed.tip.tpsLine': { 'zh-CN': '#{idx} · {tps} tokens/秒', 'zh-TW': '#{idx} · {tps} tokens/秒', en: '#{idx} · {tps} tok/s' },

      // 悬停气泡与顶部胶囊
      'tip.title.normal': { 'zh-CN': '上下文窗口：', 'zh-TW': '上下文視窗：', en: 'Context window:' },
      'tip.title.stale': { 'zh-CN': '上下文窗口（数据过期）：', 'zh-TW': '上下文視窗（資料過期）：', en: 'Context window (stale):' },
      'tip.title.high90': { 'zh-CN': '上下文窗口（高占用告警）：', 'zh-TW': '上下文視窗（高佔用警示）：', en: 'Context window (high usage):' },
      'tip.title.high75': { 'zh-CN': '上下文窗口（占用偏高）：', 'zh-TW': '上下文視窗（佔用偏高）：', en: 'Context window (elevated):' },
      'tip.title.est': { 'zh-CN': '上下文窗口（本地估算）：', 'zh-TW': '上下文視窗（本機估算）：', en: 'Context window (local est.):' },
      'tip.pct.staleVal': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 统计延迟）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 統計延遲）', en: '{used}% used ({rem}% left · delayed)' },
      'tip.pct.staleUnknown': { 'zh-CN': '统计读取延迟（剩余未知）', 'zh-TW': '統計讀取延遲（剩餘未知）', en: 'Stats delayed (remaining unknown)' },
      'tip.pct.high90': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 接近上限）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 接近上限）', en: '{used}% used ({rem}% left · near limit)' },
      'tip.pct.high75': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 占用偏高）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 佔用偏高）', en: '{used}% used ({rem}% left · elevated)' },
      'tip.pct.normal': { 'zh-CN': '{used}% 已用（剩余 {rem}%）', 'zh-TW': '{used}% 已用（剩餘 {rem}%）', en: '{used}% used ({rem}% left)' },
      'tip.pct.noBudget': { 'zh-CN': '容量未知（未返回上限）', 'zh-TW': '容量未知（未回傳上限）', en: 'Limit unknown (not returned)' },
      'tip.pct.estOnly': { 'zh-CN': '真实占比未知（仅估算）', 'zh-TW': '真實佔比未知（僅估算）', en: 'Actual % unknown (estimate only)' },
      'tip.pct.waitStats': { 'zh-CN': '等待请求统计（仅归档估算）', 'zh-TW': '等待請求統計（僅封存估算）', en: 'Waiting for stats (archive est.)' },
      'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
      'tip.detail.usedOfBudget': { 'zh-CN': '已用 {used} token，共 {budget}{inc}', 'zh-TW': '已用 {used} token，共 {budget}{inc}', en: '{used} / {budget} tokens used{inc}' },
      'tip.detail.usedNoBudget': { 'zh-CN': '已用 {used} token，总容量未知', 'zh-TW': '已用 {used} token，總容量未知', en: '{used} tokens used, limit unknown' },
      'tip.detail.estUsed': { 'zh-CN': '已用 ≈ {used} token{budget}', 'zh-TW': '已用 ≈ {used} token{budget}', en: 'Used ≈ {used} tokens{budget}' },
      'tip.detail.estBudgetPart': { 'zh-CN': '，共 {budget}', 'zh-TW': '，共 {budget}', en: ' of {budget}' },
      'tip.detail.estNoBudgetPart': { 'zh-CN': '，总容量未知', 'zh-TW': '，總容量未知', en: ', limit unknown' },
      'tip.detail.sessionEst': { 'zh-CN': '会话估算 ≈ {low}–{high} token', 'zh-TW': '工作階段估算 ≈ {low}–{high} token', en: 'Session est. ≈ {low}–{high} tokens' },
      'tip.detail.sessionCum': { 'zh-CN': '会话累计 ≈ {low}–{high} token', 'zh-TW': '工作階段累計 ≈ {low}–{high} token', en: 'Session cumulative ≈ {low}–{high} tokens' },
      'tip.detail.waitBg': { 'zh-CN': '正在等待后台更新统计数据', 'zh-TW': '正在等待背景更新統計資料', en: 'Waiting for background stats update' },
      'tip.detail.readingSession': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前工作階段上下文用量…', en: 'Reading current session context usage…' },
      'tip.detail.incSuffix': { 'zh-CN': '（含未知附件）', 'zh-TW': '（含未知附件）', en: ' (incl. unknown files)' },
      'badge.noSession': { 'zh-CN': '未打开会话', 'zh-TW': '未開啟工作階段', en: 'No active chat' },
      'badge.clickOpenCli': { 'zh-CN': ' · 点击查看或启动 CLI', 'zh-TW': ' · 點擊檢視或啟動 CLI', en: ' · Click to view or launch CLI' },
      'badge.contexts': { 'zh-CN': 'contexts', 'zh-TW': 'contexts', en: 'contexts' },
      'badge.delayed': { 'zh-CN': '统计延迟', 'zh-TW': '統計延遲', en: 'Delayed' },
      'badge.actualUnknown': { 'zh-CN': '真实量未知', 'zh-TW': '真實量未知', en: 'Actual unknown' },
      'badge.tokensTitle': { 'zh-CN': 'Token 用量一览（点击展开详情）', 'zh-TW': 'Token 用量一覽（點擊展開詳情）', en: 'Token Usage Overview (click to open)' },
      'badge.speedCalc': { 'zh-CN': '计算中…', 'zh-TW': '計算中…', en: 'Calculating…' },
      'badge.speedHoverIdle': { 'zh-CN': ' · 待生成', 'zh-TW': ' · 待生成', en: ' · Idle' },
      'badge.speedTitleIdle': { 'zh-CN': '模型输出速度与耗时 (tok/s)', 'zh-TW': '模型輸出速度與耗時 (tok/s)', en: 'Model output speed & latency (tok/s)' },
      'badge.speedTitleWait': { 'zh-CN': '正在等待模型返回或计算生成指标…', 'zh-TW': '正在等待模型回傳或計算生成指標…', en: 'Waiting for model response or metrics…' },
      'badge.speedTitleDetail': { 'zh-CN': '最新模型输出速度：{tps} tok/s{streaming}\n总耗时：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次产出：{output} tokens', 'zh-TW': '最新模型輸出速度：{tps} tok/s{streaming}\n總耗時：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次產出：{output} tokens', en: 'Latest output speed: {tps} tok/s{streaming}\nTotal: {duration}s (TTFT {ttft}s + streaming {streamSec}s)\nOutput: {output} tokens' },
      'badge.speedStreamingPart': { 'zh-CN': ' (流式 {tps} tok/s)', 'zh-TW': ' (流式 {tps} tok/s)', en: ' (streaming {tps} tok/s)' },
      'badge.corpus.range': { 'zh-CN': '会话{range}{inc}', 'zh-TW': '工作階段{range}{inc}', en: 'Chat {range}{inc}' },
      'badge.corpus.incPlus': { 'zh-CN': '＋未知', 'zh-TW': '＋未知', en: '+unknown' },
      'badge.corpus.scanning': { 'zh-CN': '会话扫描中…', 'zh-TW': '工作階段掃描中…', en: 'Scanning chat…' },
      'badge.corpus.pending': { 'zh-CN': '会话待扫描', 'zh-TW': '工作階段待掃描', en: 'Chat scan pending' },
      'badge.status.stale': { 'zh-CN': '最近请求统计读取异常或延迟，不能判断剩余空间。', 'zh-TW': '最近請求統計讀取異常或延遲，無法判斷剩餘空間。', en: 'Latest request stats delayed or unavailable; remaining space cannot be determined.' },
      'badge.status.scanErr': { 'zh-CN': '全会话扫描未完成：{err}', 'zh-TW': '全工作階段掃描未完成：{err}', en: 'Session scan incomplete: {err}' },
      'badge.status.incomplete': { 'zh-CN': '存在 {count} 个附件含未知内容；会话总量仍未计全，不能据此保证不会超限。', 'zh-TW': '存在 {count} 個附件含未知內容；工作階段總量仍未計全，無法據此保證不會超限。', en: '{count} attachment(s) contain unreadable content; cumulative total is incomplete.' },
      'badge.status.estimated': { 'zh-CN': '只有客户端估算，附件等内容可能未计全；当前请求真实占用未知。', 'zh-TW': '僅有用戶端估算，附件等內容可能未計全；目前請求真實佔用未知。', en: 'Client estimate only; attachments may be omitted and actual usage is unknown.' },
      'badge.status.normal': { 'zh-CN': '请求用量与会话累计分别统计；会话 token 数始终为本地估算。', 'zh-TW': '請求用量與工作階段累計分別統計；工作階段 token 數始終為本機估算。', en: 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.' },
    'update.title': { 'zh-CN': '🚀 检查更新', 'zh-TW': '🚀 檢查更新', en: '🚀 Check for Updates' },
    'update.checking': { 'zh-CN': '正在检测最新版本…', 'zh-TW': '正在偵測最新版本…', en: 'Checking for the latest version…' },
    'update.viewRelease': { 'zh-CN': '查看发布页', 'zh-TW': '檢視發佈頁', en: 'Release Notes' },
    'update.later': { 'zh-CN': '稍后', 'zh-TW': '稍後', en: 'Later' },
      'update.applyNow': { 'zh-CN': '立即更新', 'zh-TW': '立即更新', en: 'Update Now' },
      'update.connecting': { 'zh-CN': '正在连接 GitHub 检测最新版本…', 'zh-TW': '正在連線 GitHub 偵測最新版本…', en: 'Connecting to GitHub to check for updates…' },
      'update.failedTitle': { 'zh-CN': '⚠️ 检查更新失败', 'zh-TW': '⚠️ 檢查更新失敗', en: '⚠️ Update Check Failed' },
      'update.failedVer': { 'zh-CN': 'v{ver} (检查失败)', 'zh-TW': 'v{ver} (檢查失敗)', en: 'v{ver} (Check failed)' },
      'update.failedFetch': { 'zh-CN': '未能获取有效的版本数据', 'zh-TW': '未能取得有效的版本資料', en: 'Failed to retrieve valid release metadata' },
      'update.failedBody': { 'zh-CN': '检查更新失败: {err}。请检查网络代理设置或前往 GitHub 查看。', 'zh-TW': '檢查更新失敗: {err}。請檢查網路代理設定或前往 GitHub 檢視。', en: 'Update check failed: {err}. Please check your proxy or visit GitHub.' },
      'update.failedNetBody': { 'zh-CN': '检查更新失败: {err}。请检查网络连接或稍后重试。', 'zh-TW': '檢查更新失敗: {err}。請檢查網路連線或稍後重試。', en: 'Update check failed: {err}. Please check your network and try again.' },
      'update.foundTitle': { 'zh-CN': '🚀 发现新版本', 'zh-TW': '🚀 發現新版本', en: '🚀 Update Available' },
      'update.foundBody': { 'zh-CN': '发现新版本 v{ver}！\n\n更新说明：\n{notes}', 'zh-TW': '發現新版本 v{ver}！\n\n更新說明：\n{notes}', en: 'Version v{ver} is available!\n\nRelease notes:\n{notes}' },
      'update.defaultNotes': { 'zh-CN': '性能优化与体验改进', 'zh-TW': '效能最佳化與體驗改進', en: 'Performance and usability improvements' },
      'update.latestTitle': { 'zh-CN': '✅ 已是最新版本', 'zh-TW': '✅ 已是最新版本', en: '✅ Up to Date' },
      'update.latestVer': { 'zh-CN': 'v{ver} (已是最新)', 'zh-TW': 'v{ver} (已是最新)', en: 'v{ver} (Latest)' },
      'update.diskPending': { 'zh-CN': '已完成磁盘安装至最新版本 (v{ver})，待重启客户端后主进程完整生效。', 'zh-TW': '已完成磁碟安裝至最新版本 (v{ver})，待重新啟動用戶端後主行程完整生效。', en: 'v{ver} has been installed on disk. Restart the client for main-process changes to take effect.' },
      'update.latestBody': { 'zh-CN': '当前已是最新版本 (v{ver})。已通过 GitHub Releases 确认。', 'zh-TW': '目前已是最新版本 (v{ver})。已透過 GitHub Releases 確認。', en: 'You are on the latest version (v{ver}), verified via GitHub Releases.' },
      'update.updatingBtn': { 'zh-CN': '正在更新...', 'zh-TW': '正在更新...', en: 'Updating…' },
      'update.downloading': { 'zh-CN': '正在下载安装包并校验 SHA-256...', 'zh-TW': '正在下載安裝套件並校驗 SHA-256...', en: 'Downloading package and verifying SHA-256…' },
      'update.noApi': { 'zh-CN': '更新接口不可用', 'zh-TW': '更新介面無法使用', en: 'Update API unavailable' },

      // CLI 启动提示
      'cli.busy': { 'zh-CN': 'CLI 正在启动中，请稍候…', 'zh-TW': 'CLI 正在啟動中，請稍候…', en: 'CLI is launching, please wait…' },
      'cli.noBridge': { 'zh-CN': '本地桥接服务未连接，请执行 node cli.js install 或重启客户端', 'zh-TW': '本機橋接服務未連線，請執行 node cli.js install 或重新啟動用戶端', en: 'Local bridge is not connected. Run `node cli.js install` or restart the client.' },
      'cli.defaultCwd': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
      'cli.launched': { 'zh-CN': '✔ 已启动 Antigravity CLI（目录：{cwd}）', 'zh-TW': '✔ 已啟動 Antigravity CLI（目錄：{cwd}）', en: '✔ Launched Antigravity CLI (cwd: {cwd})' },
      'cli.notFound': { 'zh-CN': '未检测到可用的 Antigravity CLI (agy)，请检查安装路径', 'zh-TW': '未偵測到可用的 Antigravity CLI (agy)，請檢查安裝路徑', en: 'Antigravity CLI (agy) was not found. Check your installation path.' },
      'cli.failed': { 'zh-CN': '✖ 启动 CLI 失败：{err}', 'zh-TW': '✖ 啟動 CLI 失敗：{err}', en: '✖ Failed to launch CLI: {err}' },
      'cli.exception': { 'zh-CN': '启动 CLI 发生异常', 'zh-TW': '啟動 CLI 發生異常', en: 'Unexpected error launching CLI' },

      // 折叠抽屉开关
      'drawer.colors.expand': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
      'drawer.colors.collapse': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

      // 会话关键摘要 & 技术明细
      'key.overflowUsed': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Exceeded' },
      'key.overflowRem': { 'zh-CN': '0 (已溢出)', 'zh-TW': '0 (已溢位)', en: '0 (Overflow)' },
      'key.estShort': { 'zh-CN': '约 {val} (估算)', 'zh-TW': '約 {val} (估算)', en: '~{val} (est.)' },
      'key.estPrefix': { 'zh-CN': '约 {val}', 'zh-TW': '約 {val}', en: '~{val}' },
      'key.pending': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
      'key.pill.tight': { 'zh-CN': '紧张', 'zh-TW': '緊張', en: 'Critical' },
      'key.pill.elevated': { 'zh-CN': '偏高', 'zh-TW': '偏高', en: 'High' },
      'key.pill.normal': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
      'key.pill.est': { 'zh-CN': '估算', 'zh-TW': '估算', en: 'Estimate' },
      'key.pill.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Reading' },
      'key.takeaway.90': { 'zh-CN': '⚠ 上下文已消耗 {pct}%，仅剩约 {rem} tokens，接近预算上限！建议清理冗余上下文。', 'zh-TW': '⚠ 上下文已消耗 {pct}%，僅剩約 {rem} tokens，接近預算上限！建議清理多餘上下文。', en: '⚠ Context usage is at {pct}% (~{rem} tokens left), near the limit. Consider trimming context.' },
      'key.takeaway.75': { 'zh-CN': '⚡ 已使用 {pct}%，剩余可用空间约 {rem} tokens，注意大文件或长输出。', 'zh-TW': '⚡ 已使用 {pct}%，剩餘可用空間約 {rem} tokens，注意大型檔案或長輸出。', en: '⚡ {pct}% used (~{rem} tokens left). Watch large files or long outputs.' },
      'key.takeaway.ok': { 'zh-CN': '✔ 当前用量健康（{pct}%），剩余可用空间充足（约 {rem} tokens），可正常继续对话。', 'zh-TW': '✔ 目前用量健康（{pct}%），剩餘可用空間充足（約 {rem} tokens），可正常繼續對話。', en: '✔ Healthy usage ({pct}%), plenty of room (~{rem} tokens left).' },
      'key.takeaway.est': { 'zh-CN': 'ℹ 当前主要依赖本地估算或待服务端返回实际统计，暂不计算精确剩余空间。', 'zh-TW': 'ℹ 目前主要依賴本機估算或待伺服器端回傳實際統計，暫不計算精確剩餘空間。', en: 'ℹ Relying on local estimates or awaiting server stats; exact remaining space unavailable.' },
      'speed.pill.fast': { 'zh-CN': '极速', 'zh-TW': '極速', en: 'Fast' },
      'speed.pill.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'Smooth' },
      'speed.pill.good': { 'zh-CN': '良好', 'zh-TW': '良好', en: 'Good' },
      'speed.pill.slow': { 'zh-CN': '偏慢', 'zh-TW': '偏慢', en: 'Slow' },
      'speed.pill.calc': { 'zh-CN': '计算中', 'zh-TW': '計算中', en: 'Calculating' },
      'speed.pill.idle': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
      'speed.takeaway.ok': { 'zh-CN': '✔ 输出{tone}（{tps} tok/s{stream}），总耗时 {dur}s 内生成 {tok} tokens{model}。', 'zh-TW': '✔ 輸出{tone}（{tps} tok/s{stream}），總耗時 {dur}s 內產生 {tok} tokens{model}。', en: '✔ Output {tone} ({tps} tok/s{stream}), generated {tok} tokens in {dur}s{model}.' },
      'speed.tone.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'smooth' },
      'speed.tone.steady': { 'zh-CN': '平稳', 'zh-TW': '平穩', en: 'steady' },
      'speed.streamPart': { 'zh-CN': '，纯流式传输达 {tps} tok/s', 'zh-TW': '，純串流傳輸達 {tps} tok/s', en: ', streaming {tps} tok/s' },
      'speed.takeaway.idle': { 'zh-CN': 'ℹ 等待当前或下一次模型输出完成，将自动计算精确输出速度 (tok/s)、首字延迟与总耗时。', 'zh-TW': 'ℹ 等待目前或下一次模型輸出完成，將自動計算精確輸出速度 (tok/s)、首字延遲與總耗時。', en: 'ℹ Waiting for the next model response to measure output speed (tok/s), TTFT, and duration.' },
      'tech.modelPlaceholder': { 'zh-CN': '模型标识：{id}', 'zh-TW': '模型識別：{id}', en: 'Model ID: {id}' },
      'tech.modelMissing': { 'zh-CN': '未返回模型信息', 'zh-TW': '未回傳模型資訊', en: 'No model info returned' },
      'tech.req.exceeded': { 'zh-CN': '输入超限（已失败）', 'zh-TW': '輸入超限（已失敗）', en: 'Input limit exceeded (failed)' },
      'tech.req.network': { 'zh-CN': '网络故障（非超限）', 'zh-TW': '網路故障（非超限）', en: 'Network error (not overflow)' },
      'tech.req.failed': { 'zh-CN': '已失败', 'zh-TW': '已失敗', en: 'Failed' },
      'tech.req.reported': { 'zh-CN': '已返回实际统计', 'zh-TW': '已回傳實際統計', en: 'Actual stats returned' },
      'tech.req.estimated': { 'zh-CN': '只有本地估算', 'zh-TW': '僅有本機估算', en: 'Local estimate only' },
      'tech.req.waiting': { 'zh-CN': '等待统计，未确认执行状态', 'zh-TW': '等待統計，未確認執行狀態', en: 'Awaiting stats; status unconfirmed' },
      'tech.actual.exceeded': { 'zh-CN': '>{val}（实际总数未返回）', 'zh-TW': '>{val}（實際總數未回傳）', en: '>{val} (actual total not returned)' },
      'tech.actual.exceededNoLim': { 'zh-CN': '已超限；实际数值未知', 'zh-TW': '已超限；實際數值未知', en: 'Exceeded; actual count unknown' },
      'tech.actual.unknown': { 'zh-CN': '真实用量未知', 'zh-TW': '真實用量未知', en: 'Actual usage unknown' },
      'tech.est.val': { 'zh-CN': '约 {val} · {note}', 'zh-TW': '約 {val} · {note}', en: '~{val} · {note}' },
      'tech.est.under': { 'zh-CN': '已证实低估', 'zh-TW': '已證實低估', en: 'Confirmed underestimate' },
      'tech.est.ref': { 'zh-CN': '仅供参考', 'zh-TW': '僅供參考', en: 'For reference only' },
      'tech.est.none': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
      'tech.svcLim.val': { 'zh-CN': '{val}（仅该次错误证据）', 'zh-TW': '{val}（僅該次錯誤證據）', en: '{val} (from this error)' },
      'tech.svcLim.none': { 'zh-CN': '本次没有服务端限制证据', 'zh-TW': '本次沒有伺服器端限制證據', en: 'No server limit evidence' },
      'tech.pct.val': { 'zh-CN': '{pct}%（非 1M 总容量）', 'zh-TW': '{pct}%（非 1M 總容量）', en: '{pct}% (not 1M cap)' },
      'tech.pct.none': { 'zh-CN': '不提供安全余量百分比', 'zh-TW': '不提供安全餘量百分比', en: 'Headroom % unavailable' },
      'tech.plusUnknown': { 'zh-CN': ' ＋ 未知内容', 'zh-TW': ' ＋ 未知內容', en: ' + unknown' },
      'tech.plusUnknownShort': { 'zh-CN': ' ＋ 未知', 'zh-TW': ' ＋ 未知', en: ' + unknown' },
      'tech.scanIncomplete': { 'zh-CN': '扫描未完成', 'zh-TW': '掃描未完成', en: 'Scan incomplete' },
      'tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
      'tech.stepsVal': { 'zh-CN': '{steps} 条；{user} 条用户消息／{assistant} 条回复', 'zh-TW': '{steps} 筆；{user} 則使用者訊息／{assistant} 則回覆', en: '{steps} steps; {user} user / {assistant} assistant' },
      'tech.stepsNone': { 'zh-CN': '尚未完成全量读取', 'zh-TW': '尚未完成全量讀取', en: 'Full history not loaded yet' },
      'tech.coverageVal': { 'zh-CN': '{total} 个附件条目（{user} 个上传、{assistant} 个模型/工具输出）；{read} 个已读到文本，{unknown} 个含未计内容。{rescan}{err}', 'zh-TW': '{total} 個附件項目（{user} 個上傳、{assistant} 個模型/工具輸出）；{read} 個已讀到文字，{unknown} 個含未計內容。{rescan}{err}', en: '{total} attachment(s) ({user} uploaded, {assistant} model/tool); {read} readable, {unknown} with unread content.{rescan}{err}' },
      'tech.coverageRescan': { 'zh-CN': ' 正在重新扫描…', 'zh-TW': ' 正在重新掃描…', en: ' Rescanning…' },
      'tech.coverageErr': { 'zh-CN': ' 最近重扫失败，当前为旧结果：{err}', 'zh-TW': ' 最近重掃失敗，目前為舊結果：{err}', en: ' Latest rescan failed (showing prior data): {err}' },
      'tech.coverageScanning': { 'zh-CN': '正在扫描整段归档，不依赖页面已加载的聊天条数。', 'zh-TW': '正在掃描整段封存，不依賴頁面已載入的聊天筆數。', en: 'Scanning full archive regardless of rendered chat items.' },
      'tech.updatedVal': { 'zh-CN': '请求统计 {req} · 全量扫描 {scan}', 'zh-TW': '請求統計 {req} · 全量掃描 {scan}', en: 'Request stats {req} · Full scan {scan}' },
      'tech.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
      'tech.unfinished': { 'zh-CN': '未完成', 'zh-TW': '未完成', en: 'Pending' },
      'files.reading': { 'zh-CN': '正在读取全量会话附件引用…', 'zh-TW': '正在讀取全量工作階段附件引用…', en: 'Reading session attachment references…' },
      'files.empty': { 'zh-CN': '归档中没有上传附件引用。', 'zh-TW': '封存中沒有上傳附件引用。', en: 'No attachment references in archive.' },
      'files.refs': { 'zh-CN': '（引用 {n} 次）', 'zh-TW': '（引用 {n} 次）', en: ' ({n} refs)' },
      'files.px': { 'zh-CN': '{w}×{h} 像素', 'zh-TW': '{w}×{h} 像素', en: '{w}×{h} px' },
      'files.chars': { 'zh-CN': '{n} 字符', 'zh-TW': '{n} 字元', en: '{n} chars' },
      'files.tokUnknown': { 'zh-CN': '内容 token 未知', 'zh-TW': '內容 token 未知', en: 'Token count unknown' },
      'files.assistantPrefix': { 'zh-CN': '模型输出附件 · ', 'zh-TW': '模型輸出附件 · ', en: 'Model/tool attachment · ' },
      'files.sheets': { 'zh-CN': ' · {sheets} 个工作表，{cells} 个单元格', 'zh-TW': ' · {sheets} 個工作表，{cells} 個儲存格', en: ' · {sheets} sheets, {cells} cells' },
      'files.hiddenSheets': { 'zh-CN': '（含 {n} 个隐藏表）', 'zh-TW': '（含 {n} 個隱藏工作表）', en: ' ({n} hidden)' },
      'files.unknownPrefix': { 'zh-CN': '未计全：{parts}', 'zh-TW': '未計全：{parts}', en: 'Partial: {parts}' },

      // 热力图与 Token 用量弹窗
      'heat.today': { 'zh-CN': '（今日）', 'zh-TW': '（今日）', en: ' (Today)' },
      'heat.firstUse': { 'zh-CN': '（首次使用）', 'zh-TW': '（首次使用）', en: ' (First use)' },
      'heat.future': { 'zh-CN': '未来日期（待产生记录）', 'zh-TW': '未來日期（待產生記錄）', en: 'Future date (no records yet)' },
      'heat.prompt': { 'zh-CN': '提示词', 'zh-TW': '提示詞', en: 'Prompt' },
      'heat.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
      'heat.cache': { 'zh-CN': '缓存', 'zh-TW': '快取', en: 'Cache' },
      'heat.weeklyTotal': { 'zh-CN': 'Weekly Total · 周累计 (折合日均 ${avg})', 'zh-TW': 'Weekly Total · 週累計 (折合日均 ${avg})', en: 'Weekly Total (daily avg ${avg})' },
      'heat.cumSuffix': { 'zh-CN': ' (累计)', 'zh-TW': ' (累計)', en: ' (Cumulative)' },
      'heat.cumTotal': { 'zh-CN': 'Cumulative Total · 截至当日累计 (折合日均 ${avg})', 'zh-TW': 'Cumulative Total · 截至當日累計 (折合日均 ${avg})', en: 'Cumulative Total to Date (daily avg ${avg})' },
      'heat.activeDays': { 'zh-CN': '${avg} ({days}天)', 'zh-TW': '${avg} ({days}天)', en: '${avg} ({days}d)' },
      'heat.roi': { 'zh-CN': '{ratio}x 回本', 'zh-TW': '{ratio}x 回本', en: '{ratio}x ROI' },
      'heat.peak': { 'zh-CN': '峰值', 'zh-TW': '峰值', en: 'Peak' },

      // 模型卡片折叠详情、历史分组与按钮状态补齐
      'models.card.detailsToggle': { 'zh-CN': '实测预算、速度与内部详情', 'zh-TW': '實測預算、速度與內部詳情', en: 'Observed budget, speed & details' },
      'models.list.historyGroup': { 'zh-CN': '仅历史记录 / 本地设置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / Local Only' },
      'models.list.historyTag': { 'zh-CN': '仅历史', 'zh-TW': '僅歷史', en: 'History' },
      'models.btn.partialBlocked': { 'zh-CN': '需先还原后端', 'zh-TW': '需先還原後端', en: 'Restore backend first' },
      'models.btn.retryApply': { 'zh-CN': '重新检测并应用', 'zh-TW': '重新偵測並套用', en: 'Retry detect & apply' },
      'models.btn.unsupported': { 'zh-CN': '当前环境不可应用', 'zh-TW': '目前環境無法套用', en: 'Unsupported environment' },
      'header.theme.aria': { 'zh-CN': '切换浅色/深色主题', 'zh-TW': '切換淺色/深色主題', en: 'Toggle light/dark theme' },
      'header.theme.title': { 'zh-CN': '当前：跟随IDE（点击切换：浅色 / 深色 / 自动）', 'zh-TW': '目前：跟隨IDE（點擊切換：淺色 / 深色 / 自動）', en: 'Current: Follow IDE (click to cycle Light / Dark / Auto)' },

      // 订阅详情与地区/币种选择
      'plan.detail.toggleOpen': { 'zh-CN': '详情 ▼', 'zh-TW': '詳情 ▼', en: 'Details ▼' },
      'plan.detail.toggleClose': { 'zh-CN': '详情收回 ▲', 'zh-TW': '詳情收回 ▲', en: 'Hide ▲' },
      'plan.detail.title': { 'zh-CN': '💎 AI 订阅与额度详情', 'zh-TW': '💎 AI 訂閱與額度詳情', en: '💎 AI Subscription & Credits' },
      'plan.summary.identified': { 'zh-CN': '已自动识别', 'zh-TW': '已自動識別', en: 'Auto-detected' },
      'plan.summary.custom': { 'zh-CN': '自定义生效', 'zh-TW': '自訂生效', en: 'Custom' },
      'plan.summary.unknown': { 'zh-CN': '未识别/默认', 'zh-TW': '未識別/預設', en: 'Default / Unknown' },
      'plan.summary.justNow': { 'zh-CN': '刚刚更新', 'zh-TW': '剛剛更新', en: 'Just now' },
      'plan.summary.perMonth': { 'zh-CN': '/月', 'zh-TW': '/月', en: '/mo' },
      'plan.summary.freeWithPlan': { 'zh-CN': '(随套餐免费)', 'zh-TW': '(隨方案免費)', en: '(Included)' },
      'plan.dt.plan': { 'zh-CN': '当前套餐：', 'zh-TW': '目前方案：', en: 'Plan:' },
      'plan.dt.account': { 'zh-CN': '当前账号：', 'zh-TW': '目前帳號：', en: 'Account:' },
      'plan.dt.country': { 'zh-CN': '账号所在地区：', 'zh-TW': '帳號所在地區：', en: 'Account country:' },
      'plan.dt.region': { 'zh-CN': '订阅国家：', 'zh-TW': '訂閱國家：', en: 'Billing country:' },
      'plan.dt.currency': { 'zh-CN': '订阅币种：', 'zh-TW': '訂閱幣別：', en: 'Currency:' },
      'plan.dt.acq': { 'zh-CN': '获取方式：', 'zh-TW': '取得方式：', en: 'Source:' },
      'plan.dt.price': { 'zh-CN': '计费周期与价格：', 'zh-TW': '計費週期與價格：', en: 'Billing & price:' },
      'plan.dt.validity': { 'zh-CN': '权益有效期：', 'zh-TW': '權益有效期：', en: 'Valid until:' },
      'plan.dt.note': { 'zh-CN': '补充备注：', 'zh-TW': '補充備註：', en: 'Note:' },
      'plan.dt.promptCredits': { 'zh-CN': 'Prompt 额度池：', 'zh-TW': 'Prompt 額度池：', en: 'Prompt credits:' },
      'plan.dt.flowCredits': { 'zh-CN': 'Flow 额度池：', 'zh-TW': 'Flow 額度池：', en: 'Flow credits:' },
      'plan.dt.updated': { 'zh-CN': '状态更新时间：', 'zh-TW': '狀態更新時間：', en: 'Updated:' },
      'plan.account.unknown': { 'zh-CN': '未识别当前登录邮箱', 'zh-TW': '未識別目前登入信箱', en: 'Signed-in email not detected' },
      'plan.country.auto': { 'zh-CN': '🌐 未设置 / 自动', 'zh-TW': '🌐 未設定 / 自動', en: '🌐 Unset / Auto' },
      'plan.region.unknown': { 'zh-CN': '🌏 未知 (点击选择订阅国家与币种建议)', 'zh-TW': '🌏 未知 (點擊選擇訂閱國家與幣別建議)', en: '🌏 Unknown (select billing country & currency)' },
      'plan.tag.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
      'plan.tag.custom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
      'plan.tag.promo': { 'zh-CN': '活动权益', 'zh-TW': '活動權益', en: 'Promo' },
      'plan.tag.manualFree': { 'zh-CN': '手动确认 · 免费', 'zh-TW': '手動確認 · 免費', en: 'Manual · Free' },
      'plan.tag.userPaid': { 'zh-CN': '用户实付', 'zh-TW': '用戶實付', en: 'Actual paid' },
      'plan.tag.official': { 'zh-CN': '官方定价', 'zh-TW': '官方定價', en: 'Official price' },
      'plan.tag.publicRef': { 'zh-CN': '公开参考价', 'zh-TW': '公開參考價', en: 'Public ref' },
      'plan.tag.regionRef': { 'zh-CN': '地区参考价', 'zh-TW': '地區參考價', en: 'Regional ref' },
      'plan.acq.normal': { 'zh-CN': '正常付费订阅', 'zh-TW': '正常付費訂閱', en: 'Standard Paid Plan' },
      'plan.cycle.monthly': { 'zh-CN': '月付', 'zh-TW': '月繳', en: 'Monthly' },
      'plan.cycle.yearly': { 'zh-CN': '年付', 'zh-TW': '年繳', en: 'Yearly' },
      'plan.cycle.oneTime': { 'zh-CN': '单次', 'zh-TW': '單次', en: 'One-time' },
      'plan.cny.approx': { 'zh-CN': '折合 ≈ {val}', 'zh-TW': '約 ≈ {val}', en: 'approx. {val}' },
      'models.restartConfirm.title': { 'zh-CN': '重启 Antigravity 客户端', 'zh-TW': '重新啟動 Antigravity 用戶端', en: 'Restart Antigravity Client' },
      'plan.price.modePreset': { 'zh-CN': '跟随参考价', 'zh-TW': '跟隨參考價', en: 'Use reference' },
      'plan.price.modeCustom': { 'zh-CN': '自定义实付', 'zh-TW': '自訂實付', en: 'Custom paid' },
      'plan.btn.editCustom': { 'zh-CN': '自定义订阅设置', 'zh-TW': '自訂訂閱設定', en: 'Customize plan' },
      'plan.credits.avail': { 'zh-CN': '{avail} 可用 / {monthly} 月额度', 'zh-TW': '{avail} 可用 / {monthly} 月額度', en: '{avail} left / {monthly} monthly' },
      'plan.validity.expired': { 'zh-CN': '至 {date} · ⚠️ 权益已到期', 'zh-TW': '至 {date} · ⚠️ 權益已到期', en: 'Until {date} · ⚠️ Expired' },
      'plan.validity.active': { 'zh-CN': '至 {date} · 有效期内', 'zh-TW': '至 {date} · 有效期內', en: 'Until {date} · Active' },
      'plan.form.title': { 'zh-CN': '设置当前账号订阅信息', 'zh-TW': '設定目前帳號訂閱資訊', en: 'Configure Account Subscription' },
      'plan.form.acqLabel': { 'zh-CN': '获取方式 / 活动来源', 'zh-TW': '取得方式 / 活動來源', en: 'Acquisition / Promo Source' },
      'plan.form.acqCustomLabel': { 'zh-CN': '自定义活动 / 合作方名称', 'zh-TW': '自訂活動 / 合作方名稱', en: 'Custom Promo / Partner Name' },
      'plan.form.acqCustomPh': { 'zh-CN': '选填，如 Pixel 11 Pro 赠送', 'zh-TW': '選填，如 Pixel 11 Pro 贈送', en: 'Optional, e.g. Pixel bundle' },
      'plan.form.zeroExtra': { 'zh-CN': '本权益期间无需另付订阅费', 'zh-TW': '本權益期間無需另付訂閱費', en: 'No extra subscription fee during this period' },
      'plan.form.presetLabel': { 'zh-CN': '预设订阅国家与汇率 (可选快捷套用)', 'zh-TW': '預設訂閱國家與匯率 (可選快速套用)', en: 'Region & Exchange Rate Preset (optional)' },
      'plan.form.countryLabel': { 'zh-CN': '账号所在地区 (仅本地记录)', 'zh-TW': '帳號所在地區 (僅本機記錄)', en: 'Account Country (local only)' },
      'plan.form.regionLabel': { 'zh-CN': '订阅国家 (购买/结算地区)', 'zh-TW': '訂閱國家 (購買/結算地區)', en: 'Billing Country' },
      'plan.form.currencyLabel': { 'zh-CN': '订阅币种与实付金额', 'zh-TW': '訂閱幣別與實付金額', en: 'Currency & Paid Amount' },
      'plan.form.paidPh': { 'zh-CN': '实付金额', 'zh-TW': '實付金額', en: 'Amount' },
      'plan.form.cycleLabel': { 'zh-CN': '计费周期', 'zh-TW': '計費週期', en: 'Billing Cycle' },
      'plan.form.validEndLabel': { 'zh-CN': '权益到期日', 'zh-TW': '權益到期日', en: 'Expiration Date' },
      'plan.form.noteLabel': { 'zh-CN': '补充说明备注', 'zh-TW': '補充說明備註', en: 'Notes' },
      'plan.form.notePh': { 'zh-CN': '例如：Pixel 11 Pro 赠送 6 个月 / 家庭拼车', 'zh-TW': '例如：Pixel 11 Pro 贈送 6 個月 / 家庭共享', en: 'e.g. Device promo / family sharing' },
      'plan.form.clear': { 'zh-CN': '清除自定义', 'zh-TW': '清除自訂', en: 'Clear custom' },
      'plan.form.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
      'plan.form.save': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },

      // API 参考金额与展开详情
      'cost.title': { 'zh-CN': '💰 本期 API 参考金额', 'zh-TW': '💰 本期 API 參考金額', en: '💰 Period API Reference Cost' },
      'cost.periodTag': { 'zh-CN': '本月自然月', 'zh-TW': '本月自然月', en: 'This Calendar Month' },
      'cost.nonPaidBadge': { 'zh-CN': 'API折算 · 非实付', 'zh-TW': 'API換算 · 非實付', en: 'API Est. · Not Billed' },
      'cost.subUnknown': { 'zh-CN': '订阅实付：未填写', 'zh-TW': '訂閱實付：未填寫', en: 'Plan paid: Not set' },
      'cost.btnFill': { 'zh-CN': '补充', 'zh-TW': '補充', en: 'Edit' },
      'cost.btnExpand': { 'zh-CN': '展开详情 ▼', 'zh-TW': '展開詳情 ▼', en: 'Show details ▼' },
      'cost.btnCollapse': { 'zh-CN': '收起详情 ▴', 'zh-TW': '收起詳情 ▴', en: 'Hide details ▴' },
      'cost.scopeLabel': { 'zh-CN': '统计范围:', 'zh-TW': '統計範圍:', en: 'Scope:' },
      'cost.scopePeriod': { 'zh-CN': '本期', 'zh-TW': '本期', en: 'This period' },
      'cost.scopeAll': { 'zh-CN': '全量历史', 'zh-TW': '全量歷史', en: 'All history' },
      'cost.modeLabel': { 'zh-CN': '估值模式:', 'zh-TW': '估值模式:', en: 'Pricing mode:' },
      'cost.modeRef': { 'zh-CN': '参考模型估算', 'zh-TW': '參考模型估算', en: 'Reference model' },
      'cost.modeHybrid': { 'zh-CN': '混合模式', 'zh-TW': '混合模式', en: 'Hybrid' },
      'cost.modeIdentified': { 'zh-CN': '仅已识别模型', 'zh-TW': '僅已識別模型', en: 'Identified only' },
      'cost.card.input': { 'zh-CN': '输入 Token', 'zh-TW': '輸入 Token', en: 'Input Tokens' },
      'cost.card.cache': { 'zh-CN': '缓存读取 (优惠)', 'zh-TW': '快取讀取 (優惠)', en: 'Cache Read (discounted)' },
      'cost.card.output': { 'zh-CN': '输出 Token', 'zh-TW': '輸出 Token', en: 'Output Tokens' },
      'cost.analyzing': { 'zh-CN': '正在分析请求模型与计价覆盖率…', 'zh-TW': '正在分析請求模型與計價覆蓋率…', en: 'Analyzing model calls and pricing coverage…' },
      'cost.disclaimer': {
        'zh-CN': '注：此折算反映按公开零售价调用同等资源之费用，包月订阅/活动赠送与 API 零售非同类计费模式，该差额不等于真实节省现金；缓存读取按 10% 优惠计价；不含缓存存储费与搜索落地费用。缓存可在多次请求中重复读取相同上下文，该总量不代表独立文本量或用户输入字数。',
        'zh-TW': '註：此換算反映依公開零售價呼叫同等資源之費用，包月訂閱/活動贈送與 API 零售非同類計費模式，該差額不等於真實節省現金；快取讀取依 10% 優惠計價；不含快取儲存費與搜尋落地費用。快取可在多次請求中重複讀取相同上下文，該總量不代表獨立文字量或使用者輸入字數。',
        en: 'Note: Estimates reflect public API retail rates for equivalent usage. Subscriptions/promos differ from pay-as-you-go API billing; differences do not equal cash saved. Cache reads are priced at 10%; storage and grounding fees are excluded. Repeated cache reads do not represent unique text.'
      },

      // Token 统计与热力图控制
      'tokens.titleCost': { 'zh-CN': 'API 价格折算', 'zh-TW': 'API 價格換算', en: 'API Equivalent Cost' },
      'tokens.firstUse': { 'zh-CN': '首次使用：{date}', 'zh-TW': '首次使用：{date}', en: 'First use: {date}' },
      'tokens.heat.presetLabel': { 'zh-CN': '5 档色阶预设：', 'zh-TW': '5 檔色階預設：', en: '5-step presets:' },
      'tokens.heat.presetPurple': { 'zh-CN': '紫色系', 'zh-TW': '紫色系', en: 'Purple' },
      'tokens.heat.presetYellow': { 'zh-CN': '黄色系', 'zh-TW': '黃色系', en: 'Yellow' },
      'tokens.heat.presetGreen': { 'zh-CN': '绿色系', 'zh-TW': '綠色系', en: 'Green' },
      'tokens.heat.presetBlue': { 'zh-CN': '蓝色系', 'zh-TW': '藍色系', en: 'Blue' },
      'tokens.heat.presetRed': { 'zh-CN': '红色系', 'zh-TW': '紅色系', en: 'Red' },
      'tokens.heat.customTitle': { 'zh-CN': '5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：', 'zh-TW': '5 檔逐格獨立自訂（點擊任意一格或圖例「少 ▢▢▢▢▢ 多」單獨調色，可設 5 種不同顏色）：', en: 'Customize each of the 5 steps independently:' },
      'tokens.heat.resetLvls': { 'zh-CN': '恢复 5 档预设', 'zh-TW': '恢復 5 檔預設', en: 'Reset 5 steps' },
      'tokens.heat.lvl0': { 'zh-CN': '1档 · 少/无', 'zh-TW': '1檔 · 少/無', en: 'L1 · None/Min' },
      'tokens.heat.lvl1': { 'zh-CN': '2档 · 低', 'zh-TW': '2檔 · 低', en: 'L2 · Low' },
      'tokens.heat.lvl2': { 'zh-CN': '3档 · 中', 'zh-TW': '3檔 · 中', en: 'L3 · Med' },
      'tokens.heat.lvl3': { 'zh-CN': '4档 · 高', 'zh-TW': '4檔 · 高', en: 'L4 · High' },
      'tokens.heat.lvl4': { 'zh-CN': '5档 · 多/峰', 'zh-TW': '5檔 · 多/峰', en: 'L5 · Peak' },
      'tokens.heat.btnPreset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
      'tokens.heat.lowEnd': { 'zh-CN': '色阶「少」端颜色（自动插值）', 'zh-TW': '色階「少」端顏色（自動插值）', en: 'Low end color (auto-interpolated)' },
      'tokens.heat.highEnd': { 'zh-CN': '色阶「多」端颜色（自动插值）', 'zh-TW': '色階「多」端顏色（自動插值）', en: 'High end color (auto-interpolated)' },
      'tokens.heat.panelBg': { 'zh-CN': '面板与菜单统一背景色', 'zh-TW': '面板與選單統一背景色', en: 'Unified panel background' },
      'tokens.heat.accentColors': { 'zh-CN': '累计与强调指标色', 'zh-TW': '累計與強調指標色', en: 'Total & accent colors' },
      'tokens.colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow theme' },

      // 动态费用明细与 Token 卡片补齐
      'cost.titleAll': { 'zh-CN': '💰 全量 API 参考金额', 'zh-TW': '💰 全量 API 參考金額', en: '💰 All-Time API Reference Cost' },
      'cost.allHistory': { 'zh-CN': '全历史累计', 'zh-TW': '全歷史累計', en: 'All history' },
      'cost.approx': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },
      'cost.notReady': { 'zh-CN': '数据未就绪', 'zh-TW': '資料尚未就緒', en: 'Not ready' },
      'cost.noRecords': { 'zh-CN': '暂无记录', 'zh-TW': '暫無記錄', en: 'No records' },
      'cost.unpriced': { 'zh-CN': '暂无法估值', 'zh-TW': '暫無法估值', en: 'Unpriced' },
      'cost.refSub': { 'zh-CN': '统一按 {model} 估算 (输入 ${in} / 缓存 ${ca} / 输出 ${out} 每百万 Token)', 'zh-TW': '統一依 {model} 估算 (輸入 ${in} / 快取 ${ca} / 輸出 ${out} 每百萬 Token)', en: 'Estimated via {model} (In ${in} / Cache ${ca} / Out ${out} per 1M)' },
      'cost.hybridSub': { 'zh-CN': '混合模式：已识别 ${known} + 未知折算 ${res}', 'zh-TW': '混合模式：已識別 ${known} + 未知換算 ${res}', en: 'Hybrid: Identified ${known} + Residual ${res}' },
      'cost.hybridBadge': { 'zh-CN': '混合模式折算', 'zh-TW': '混合模式換算', en: 'Hybrid mode' },
      'cost.identSub': { 'zh-CN': '仅计入 {n} 条已知真实模型调用', 'zh-TW': '僅計入 {n} 筆已知真實模型呼叫', en: 'Only {n} identified model call(s) included' },
      'cost.identSubNone': { 'zh-CN': '当前范围内请求缺少模型型号（未按 $0 计入）', 'zh-TW': '目前範圍內請求缺少模型型號（未依 $0 計入）', en: 'Requests lack model IDs (not counted as $0)' },
      'cost.covPct': { 'zh-CN': '{pct}% 计价覆盖', 'zh-TW': '{pct}% 計價覆蓋', en: '{pct}% priced' },
      'cost.tokCacheDiscount': { 'zh-CN': '{tok} tok (优惠)', 'zh-TW': '{tok} tok (優惠)', en: '{tok} tok (disc.)' },
      'cost.tokResidual': { 'zh-CN': '剩余 {tok} tok', 'zh-TW': '剩餘 {tok} tok', en: 'Rem. {tok} tok' },
      'cost.usageSummary': { 'zh-CN': '累计处理 Token: {total} (含 {cache} 缓存读取)', 'zh-TW': '累計處理 Token: {total} (含 {cache} 快取讀取)', en: 'Total tokens: {total} (incl. {cache} cache)' },
      'cost.diffAll': { 'zh-CN': '全量累计不直接与单月费用做差额比较 · 避免跨月虚高', 'zh-TW': '全量累計不直接與單月費用做差額比較 · 避免跨月虛高', en: 'All-time totals are not compared against monthly fees' },
      'cost.diffFree': { 'zh-CN': '与此 API 方案参考差额 约 +${val} (免费权益使用中 · 不计算无限倍数)', 'zh-TW': '與此 API 方案參考差額 約 +${val} (免費權益使用中 · 不計算無限倍數)', en: 'Diff vs API: ~+${val} (free promo active)' },
      'cost.diffPaid': { 'zh-CN': '与此 API 方案参考差额 {sign}${val} (API折算 - 实际支出 · 仅供参考比较)', 'zh-TW': '與此 API 方案參考差額 {sign}${val} (API換算 - 實際支出 · 僅供參考比較)', en: 'Diff vs API: {sign}${val} (API est. - paid · reference only)' },
      'cost.diffUnknown': { 'zh-CN': '跨币种或实付未知 · 并列展示不计算差额', 'zh-TW': '跨幣別或實付未知 · 並列顯示不計算差額', en: 'Cross-currency or paid amount unknown' },
      'cost.subLineFree': { 'zh-CN': '订阅额外实付：{sym}0 ({src})', 'zh-TW': '訂閱額外實付：{sym}0 ({src})', en: 'Extra plan paid: {sym}0 ({src})' },
      'cost.subLinePaid': { 'zh-CN': '订阅实付：{sym}{val}{cny} ({cycle}{exp})', 'zh-TW': '訂閱實付：{sym}{val}{cny} ({cycle}{exp})', en: 'Plan paid: {sym}{val}{cny} ({cycle}{exp})' },
      'cost.breakdownPrefix': { 'zh-CN': '已识别真实模型明细：{details}{note}。', 'zh-TW': '已識別真實模型明細：{details}{note}。', en: 'Identified models: {details}{note}.' },
      'cost.breakdownNone': { 'zh-CN': '暂无已匹配真实模型', 'zh-TW': '暫無已匹配真實模型', en: 'No matched model calls yet' },
      'tokens.dailyAvg': { 'zh-CN': ' · 日均 ${val}', 'zh-TW': ' · 日均 ${val}', en: ' · Avg ${val}/d' },
      'tokens.firstUseNone': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
      'tokens.srcAllLabel': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All Sources' },
      'tokens.srcDesktopLabel': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },

      // 模型卡片/解锁/异常状态与动态文案补齐
      'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
      'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
      'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
      'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
      'panel.ctx.currentModelUnconfirmed': { 'zh-CN': '当前会话模型待确认（请在输入框选择模型或发送消息）', 'zh-TW': '目前工作階段模型待確認（請在輸入框選擇模型或發送訊息）', en: 'Active model pending confirmation (select a model or send a message first)' },
      'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
      'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
      'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
      'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
      'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
      'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
      'models.pref.none': { 'zh-CN': '未单独设置（使用默认）', 'zh-TW': '未單獨設定（使用預設）', en: 'Not set (Default)' },
      'models.pref.noneShort': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
      'models.pref.inconsistent': { 'zh-CN': '档位设置不一致', 'zh-TW': '檔位設定不一致', en: 'Effort mismatch' },
      'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
      'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
      'models.card.effortsList': { 'zh-CN': '可用档位：{list}', 'zh-TW': '可用檔位：{list}', en: 'Efforts: {list}' },
      'models.card.effortStandard': { 'zh-CN': '可用档位：标准', 'zh-TW': '可用檔位：標準', en: 'Efforts: Standard' },
      'models.card.sessionEffort': { 'zh-CN': '当前会话：{effort}', 'zh-TW': '目前會話：{effort}', en: 'Session: {effort}' },
      'models.toast.savedUniform': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為該模型儲存統一設定。', en: 'Saved uniform setting for this model.' },
      'models.toast.saveFailed': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save uniform setting: {err}' },
      'models.input.phFollow': { 'zh-CN': '当前为跟随模型（可点 512K 或输入整数）', 'zh-TW': '目前為跟隨模型（可點 512K 或輸入整數）', en: 'Follow model (click 512K or enter integer)' },
      'models.input.phDefault': { 'zh-CN': '当前为默认（可点 512K 或输入整数）', 'zh-TW': '目前為預設（可點 512K 或輸入整數）', en: 'Default (click 512K or enter integer)' },
      'models.input.validFixed': { 'zh-CN': '将设定固定长度：{short}（{full} tokens）', 'zh-TW': '將設定固定長度：{short}（{full} tokens）', en: 'Will set fixed limit: {short} ({full} tokens)' },
      'models.err.noSettingsBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Not connected to host settings bridge' },
      'models.err.noApplyBridge': { 'zh-CN': '未连接到客户端设置桥接', 'zh-TW': '未連線到用戶端設定橋接', en: 'Not connected to client settings bridge' },
      'models.err.noModels': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list.' },
      'models.err.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
      'models.status.line': { 'zh-CN': '当前状态：{badge} · 配置：{mode}', 'zh-TW': '目前狀態：{badge} · 設定：{mode}', en: 'Status: {badge} · Mode: {mode}' },
      'status.client.unavailable': { 'zh-CN': '当前环境无法读取客户端状态', 'zh-TW': '目前環境無法讀取用戶端狀態', en: 'Unable to read client status in this environment' },
      'models.status.restartMismatch': { 'zh-CN': '重启后读到的设置与目标不同（实际：{actual}）', 'zh-TW': '重啟後讀到的設定與目標不同（實際：{actual}）', en: 'Post-restart config differs from target (actual: {actual})' },
      'models.meta.targetDesktop': { 'zh-CN': '桌面端核心服务', 'zh-TW': '桌面端核心服務', en: 'Desktop Core Service' },
      'models.meta.targetDesktopArch': { 'zh-CN': '桌面端核心服务 ({arch})', 'zh-TW': '桌面端核心服務 ({arch})', en: 'Desktop Core Service ({arch})' },
      'models.meta.archUnknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'models.meta.backupStale': { 'zh-CN': '客户端已更新，历史备份已过期', 'zh-TW': '用戶端已更新，歷史備份已過期', en: 'Client updated; legacy backup expired' },
      'models.meta.backupReady': { 'zh-CN': '已自动备份原始文件', 'zh-TW': '已自動備份原始檔案', en: 'Original binary backed up' },
      'models.meta.backupNone': { 'zh-CN': '尚未产生备份（首次修改前自动备份）', 'zh-TW': '尚未產生備份（首次修改前自動備份）', en: 'No backup yet (created before first patch)' },
      'models.credit.openedBrowser': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者貼文', en: 'Opened author thread in default browser' },
      'models.credit.openFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者貼文連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; link copied to clipboard.' },
      'models.credit.copiedLink': { 'zh-CN': '已复制原作者帖子链接', 'zh-TW': '已複製原作者貼文連結', en: 'Author thread link copied' },

      // 异常诊断态
      'diag.ctx.badge': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Limit' },
      'diag.ctx.amount': { 'zh-CN': '服务端超限', 'zh-TW': '伺服器端超限', en: 'Server Limit' },
      'diag.ctx.keyBadge': { 'zh-CN': '已超限', 'zh-TW': '已超限', en: 'Exceeded' },
      'diag.ctx.hover': { 'zh-CN': ' · 100% 已溢出', 'zh-TW': ' · 100% 已溢出', en: ' · 100% overflow' },
      'diag.ctx.tipTitle': { 'zh-CN': '上下文窗口（超限告警）：', 'zh-TW': '上下文視窗（超限警示）：', en: 'Context Window (Exceeded):' },
      'diag.ctx.tipPct': { 'zh-CN': '100% 已用（已超出上限）', 'zh-TW': '100% 已用（已超出上限）', en: '100% used (exceeded)' },
      'diag.ctx.tipDetailLim': { 'zh-CN': '已超上限，共 {lim} token', 'zh-TW': '已超上限，共 {lim} token', en: 'Exceeded {lim} tokens' },
      'diag.ctx.tipDetailDef': { 'zh-CN': '服务端已拒绝输入（超出容量上限）', 'zh-TW': '伺服器端已拒絕輸入（超出容量上限）', en: 'Input rejected by server (over limit)' },
      'diag.ctx.status': { 'zh-CN': '服务端已拒绝：输入超限{lim}。本地估算不可靠，需精简或新建会话。', 'zh-TW': '伺服器端已拒絕：輸入超限{lim}。本機估算不可靠，需精簡或新建會話。', en: 'Server rejected: input exceeded{lim}. Trim context or start a new chat.' },
      'diag.ctx.statusLim': { 'zh-CN': '（上限 {lim} tokens）', 'zh-TW': '（上限 {lim} tokens）', en: ' (limit {lim} tokens)' },
      'diag.ctx.takeaway': { 'zh-CN': '✖ 已超出服务端最大限制{lim}，当前对话已被拒绝。需精简或新建会话。', 'zh-TW': '✖ 已超出伺服器端最大限制{lim}，目前對話已被拒絕。需精簡或新建會話。', en: '✖ Exceeded server max limit{lim}; current chat rejected. Trim or start new chat.' },
      'diag.quota.badge': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Quota' },
      'diag.quota.amount': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Out of Quota' },
      'diag.quota.hover': { 'zh-CN': ' · 模型额度用尽，可切换模型', 'zh-TW': ' · 模型額度用盡，可切換模型', en: ' · Model quota exhausted' },
      'diag.quota.tipTitle': { 'zh-CN': '模型额度（额度耗尽）：', 'zh-TW': '模型額度（額度耗盡）：', en: 'Model Quota (Exhausted):' },
      'diag.quota.tipPct': { 'zh-CN': '当前模型配额已用尽', 'zh-TW': '目前模型配額已用盡', en: 'Current model quota exhausted' },
      'diag.quota.reset': { 'zh-CN': '，预计将于 {time} 重置', 'zh-TW': '，預計將於 {time} 重置', en: ', resets around {time}' },
      'diag.quota.tipDetail': { 'zh-CN': '{pool}额度已耗尽{reset}。可手动切换至其他可用模型', 'zh-TW': '{pool}額度已耗盡{reset}。可手動切換至其他可用模型', en: '{pool} quota exhausted{reset}. Switch to another model.' },
      'diag.quota.status': { 'zh-CN': '模型额度耗尽：{pool}额度已耗尽{reset}。可手动切换至其他可用模型。', 'zh-TW': '模型額度耗盡：{pool}額度已耗盡{reset}。可手動切換至其他可用模型。', en: 'Quota exhausted: {pool} quota depleted{reset}. Switch to another model.' },
      'diag.quota.takeaway': { 'zh-CN': '✖ {pool}额度已耗尽{reset}。可手动切换至其他可用模型继续对话。', 'zh-TW': '✖ {pool}額度已耗盡{reset}。可手動切換至其他可用模型繼續對話。', en: '✖ {pool} quota exhausted{reset}. Switch to another model to continue.' },
      'diag.rate.badge': { 'zh-CN': '限流', 'zh-TW': '限流', en: '429' },
      'diag.rate.amount': { 'zh-CN': '请求限流', 'zh-TW': '請求限流', en: 'Rate Limited' },
      'diag.rate.hover': { 'zh-CN': ' · 触发频率限制，请稍候', 'zh-TW': ' · 觸發頻率限制，請稍候', en: ' · Rate limited, wait a moment' },
      'diag.rate.tipTitle': { 'zh-CN': '请求限制（请求过频）：', 'zh-TW': '請求限制（請求過頻）：', en: 'Rate Limit (Too Many Requests):' },
      'diag.rate.tipPct': { 'zh-CN': '触发服务端频率限制（429）', 'zh-TW': '觸發伺服器端頻率限制（429）', en: 'Server rate limit (429)' },
      'diag.rate.retry': { 'zh-CN': '（建议等待 {sec} 秒）', 'zh-TW': '（建議等待 {sec} 秒）', en: ' (retry in {sec}s)' },
      'diag.rate.tipDetail': { 'zh-CN': '请求过于频繁{retry}，请稍候重试', 'zh-TW': '請求過於頻繁{retry}，請稍候重試', en: 'Too many requests{retry}, try again later' },
      'diag.rate.status': { 'zh-CN': '请求频率限制：请求过于频繁，触发服务端限制（429）{retry}。稍候重试即可恢复。', 'zh-TW': '請求頻率限制：請求過於頻繁，觸發伺服器端限制（429）{retry}。稍候重試即可恢復。', en: 'Rate limited (429){retry}. Wait and retry.' },
      'diag.rate.takeaway': { 'zh-CN': '⚠ 触发服务端请求频率限制（HTTP 429）{retry}，短时间内发送请求过多，稍候重试即可恢复。', 'zh-TW': '⚠ 觸發伺服器端請求頻率限制（HTTP 429）{retry}，短時間內發送請求過多，稍候重試即可恢復。', en: '⚠ HTTP 429 rate limit{retry}. Wait briefly and retry.' },
      'diag.net.defDiag': { 'zh-CN': '连接中断或超时', 'zh-TW': '連線中斷或逾時', en: 'Connection dropped or timed out' },
      'diag.net.badge': { 'zh-CN': '网络', 'zh-TW': '網路', en: 'Network' },
      'diag.net.amount': { 'zh-CN': '网络故障', 'zh-TW': '網路故障', en: 'Network Error' },
      'diag.net.hover': { 'zh-CN': ' · 连接异常，请检查网络', 'zh-TW': ' · 連線異常，請檢查網路', en: ' · Connection error, check network' },
      'diag.net.tipTitle': { 'zh-CN': '网络连接（连接故障）：', 'zh-TW': '網路連線（連線故障）：', en: 'Network (Connection Failed):' },
      'diag.net.tipPct': { 'zh-CN': '网络连接失败或超时', 'zh-TW': '網路連線失敗或逾時', en: 'Connection failed or timed out' },
      'diag.net.tipDetail': { 'zh-CN': '连接异常（{diag}）。请检查本地网络代理与连接', 'zh-TW': '連線異常（{diag}）。請檢查本機網路代理與連線', en: 'Connection error ({diag}). Check proxy & network.' },
      'diag.net.status': { 'zh-CN': '网络连接异常：{diag}。请检查本地网络代理与网络链路设置。', 'zh-TW': '網路連線異常：{diag}。請檢查本機網路代理與網路鏈路設定。', en: 'Network error: {diag}. Check local proxy and network settings.' },
      'diag.net.takeaway': { 'zh-CN': '✖ 网络连接出现异常（{diag}）。请检查本地网络代理与链路状态。', 'zh-TW': '✖ 網路連線出現異常（{diag}）。請檢查本機網路代理與鏈路狀態。', en: '✖ Network error ({diag}). Check proxy and connection.' },
      'diag.auth.badge': { 'zh-CN': '认证', 'zh-TW': '認證', en: 'Auth' },
      'diag.auth.amount': { 'zh-CN': '认证失败', 'zh-TW': '認證失敗', en: 'Auth Failed' },
      'diag.auth.keyBadge': { 'zh-CN': '认证异常', 'zh-TW': '認證異常', en: 'Auth Error' },
      'diag.auth.hover': { 'zh-CN': ' · 权限不足或登录异常', 'zh-TW': ' · 權限不足或登入異常', en: ' · Unauthorized or session expired' },
      'diag.auth.tipTitle': { 'zh-CN': '账号权限（身份异常）：', 'zh-TW': '帳號權限（身份異常）：', en: 'Account Auth (Error):' },
      'diag.auth.tipPct': { 'zh-CN': '身份认证失败或缺少权限', 'zh-TW': '身份認證失敗或缺少權限', en: 'Authentication failed or unauthorized' },
      'diag.auth.tipDetail': { 'zh-CN': '身份认证失败或无权限访问，请检查账号登录状态', 'zh-TW': '身份認證失敗或無權限存取，請檢查帳號登入狀態', en: 'Auth failed or no access. Check sign-in status.' },
      'diag.auth.status': { 'zh-CN': '身份认证失败或无访问权限，请检查账号登录状态或订阅权限。', 'zh-TW': '身份認證失敗或無存取權限，請檢查帳號登入狀態或訂閱權限。', en: 'Authentication failed or unauthorized (401/403). Check account sign-in.' },
      'diag.auth.takeaway': { 'zh-CN': '✖ 身份认证失败或无访问权限（401/403）。请检查账号登录状态或订阅权限。', 'zh-TW': '✖ 身份認證失敗或無存取權限（401/403）。請檢查帳號登入狀態或訂閱權限。', en: '✖ Auth failed or forbidden (401/403). Check account sign-in or plan.' },
      'diag.svc.badge': { 'zh-CN': '服务异常', 'zh-TW': '服務異常', en: '503' },
      'diag.svc.amount': { 'zh-CN': '服务受限', 'zh-TW': '服務受限', en: 'Unavailable' },
      'diag.svc.hover': { 'zh-CN': ' · 服务端繁忙，请稍候', 'zh-TW': ' · 伺服器端繁忙，請稍候', en: ' · Server overloaded, wait briefly' },
      'diag.svc.tipTitle': { 'zh-CN': '服务端状态（服务受限）：', 'zh-TW': '伺服器端狀態（服務受限）：', en: 'Service Status (Unavailable):' },
      'diag.svc.tipPct': { 'zh-CN': '模型服务暂不可用或过载', 'zh-TW': '模型服務暫不可用或過載', en: 'Model service overloaded or unavailable' },
      'diag.svc.tipDetail': { 'zh-CN': '服务端暂时过载或维护中，请稍后重试', 'zh-TW': '伺服器端暫時過載或維護中，請稍後重試', en: 'Server overloaded or under maintenance. Retry later.' },
      'diag.svc.status': { 'zh-CN': '模型服务暂不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '模型服務暫不可用或處於高負載（503/Overloaded），請稍後重試。', en: 'Model service unavailable or overloaded (503). Retry later.' },
      'diag.svc.takeaway': { 'zh-CN': '⚠ 服务端暂时不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '⚠ 伺服器端暫時不可用或處於高負載（503/Overloaded），請稍後重試。', en: '⚠ Service unavailable or overloaded (503). Retry later.' },
      'diag.cancel.badge': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Cancelled' },
      'diag.cancel.amount': { 'zh-CN': '请求取消', 'zh-TW': '請求取消', en: 'Cancelled' },
      'diag.cancel.hover': { 'zh-CN': ' · 请求已取消', 'zh-TW': ' · 請求已取消', en: ' · Request cancelled' },
      'diag.cancel.tipTitle': { 'zh-CN': '请求状态（已取消）：', 'zh-TW': '請求狀態（已取消）：', en: 'Request Status (Cancelled):' },
      'diag.cancel.tipPct': { 'zh-CN': '本次请求被中止或取消', 'zh-TW': '本次請求被中止或取消', en: 'Request aborted or cancelled' },
      'diag.cancel.tipDetail': { 'zh-CN': '本次生成已被用户取消或中断，可重新发送消息', 'zh-TW': '本次生成已被使用者取消或中斷，可重新發送訊息', en: 'Generation cancelled. Resend message if needed.' },
      'diag.cancel.status': { 'zh-CN': '请求已取消：当前轮次生成被中断。', 'zh-TW': '請求已取消：目前輪次生成被中斷。', en: 'Request cancelled: current generation aborted.' },
      'diag.cancel.takeaway': { 'zh-CN': 'ℹ 本轮生成已被用户取消或中断，未完整输出。', 'zh-TW': 'ℹ 本輪生成已被使用者取消或中斷，未完整輸出。', en: 'ℹ Generation cancelled before completion.' },
      'diag.quota.defPool': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Current model' },
      'diag.unknown.badge': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Error' },
      'diag.unknown.amount': { 'zh-CN': '请求异常', 'zh-TW': '請求異常', en: 'Request Error' },
      'diag.unknown.keyBadge': { 'zh-CN': '原因待确认', 'zh-TW': '原因待確認', en: 'Unconfirmed' },
      'diag.unknown.hover': { 'zh-CN': ' · 失败原因待确认', 'zh-TW': ' · 失敗原因待確認', en: ' · Reason unconfirmed' },
      'diag.unknown.tipTitle': { 'zh-CN': '请求状态（原因待确认）：', 'zh-TW': '請求狀態（原因待確認）：', en: 'Request Status (Unconfirmed):' },
      'diag.unknown.tipPct': { 'zh-CN': '最近请求失败（原因未知）', 'zh-TW': '最近請求失敗（原因未知）', en: 'Recent request failed (unknown reason)' },
      'diag.unknown.tipDetail': { 'zh-CN': '当前无法确认具体原因（{diag}）', 'zh-TW': '目前無法確認具體原因（{diag}）', en: 'Cannot confirm exact reason ({diag})' },
      'diag.unknown.status': { 'zh-CN': '最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: 'Recent request failed; cannot confirm exact reason ({diag}).' },
      'diag.unknown.takeaway': { 'zh-CN': '✖ 最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '✖ 最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: '✖ Recent request failed; cannot confirm exact reason ({diag}).' },

      // Token 统计、热力图与成本细节补齐
      'tokens.badge.today': { 'zh-CN': ' · 今日 {val}', 'zh-TW': ' · 今日 {val}', en: ' · Today {val}' },
      'common.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'common.notProvided': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
      'common.loading': { 'zh-CN': '读取中...', 'zh-TW': '讀取中...', en: 'Loading...' },
      'tokens.heat.firstUsePlaceholder': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
      'tokens.card.costPlaceholder': { 'zh-CN': '≈ $0.00 (¥0.00) · 日均 $0.00', 'zh-TW': '≈ $0.00 (¥0.00) · 日均 $0.00', en: '≈ $0.00 (¥0.00) · $0.00/d' },
      'tokens.heat.activeAvgPlaceholder': { 'zh-CN': '$0.00 (0天)', 'zh-TW': '$0.00 (0天)', en: '$0.00 (0d)' },
      'tokens.card.todaySub': { 'zh-CN': '{n} 会话实时累加', 'zh-TW': '{n} 會話即時累加', en: '{n} chat(s) live' },
      'tokens.card.monthSub': { 'zh-CN': '日均约 {val}', 'zh-TW': '日均約 {val}', en: '~{val}/day avg' },
      'tokens.card.yearSub': { 'zh-CN': '{n} 天活动记录', 'zh-TW': '{n} 天活動記錄', en: '{n} active day(s)' },
      'tokens.range.month': { 'zh-CN': '{y}年{m}月', 'zh-TW': '{y}年{m}月', en: '{y}-{m}' },
      'tokens.range.year': { 'zh-CN': '{y}年', 'zh-TW': '{y}年', en: '{y}' },
      'tokens.range.yearToToday': { 'zh-CN': '{y}年（1月1日–今天）', 'zh-TW': '{y}年（1月1日–今天）', en: '{y} (Jan 1 – Today)' },
      'heatmap.pop.inProgress': { 'zh-CN': '（进行中）', 'zh-TW': '（進行中）', en: ' (Current)' },
      'heatmap.pop.peak': { 'zh-CN': '（年度峰值）', 'zh-TW': '（年度峰值）', en: ' (Peak)' },
      'heatmap.pop.future': { 'zh-CN': '未来月份（尚未产生用量）', 'zh-TW': '未來月份（尚未產生用量）', en: 'Future month (no usage)' },
      'heatmap.pop.monthlyDet': { 'zh-CN': '月度合计 · 折合日均 ${avg} (活跃 {days} 天)', 'zh-TW': '月度合計 · 折合日均 ${avg} (活躍 {days} 天)', en: 'Monthly Total · Avg ${avg}/d ({days} active days)' },
      'cost.subSpendLabel': { 'zh-CN': '本人同期实际支出', 'zh-TW': '本人同期實際支出', en: 'Your Actual Spend' },
      'cost.freePromo': { 'zh-CN': '免费活动', 'zh-TW': '免費活動', en: 'Free promo' },
      'cost.subSpend': { 'zh-CN': '订阅支出', 'zh-TW': '訂閱支出', en: 'Plan spend' },
      'cost.paidLabel': { 'zh-CN': '实付', 'zh-TW': '實付', en: 'Paid' },
      'cost.paidUnknown': { 'zh-CN': '实付未知', 'zh-TW': '實付未知', en: 'Paid unknown' },
      'cost.publicRefMonthly': { 'zh-CN': '公开参考价 ${p}/月（实付未确认）', 'zh-TW': '公開參考價 ${p}/月（實付未確認）', en: 'Public ref ${p}/mo (paid unconfirmed)' },
      'cost.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'cost.noPlanData': { 'zh-CN': '未获取到套餐与实付数据', 'zh-TW': '未取得方案與實付資料', en: 'No plan or spend data available' },
      'cost.allNoCompare': { 'zh-CN': ' · 全量累计不直接对比单月支出', 'zh-TW': ' · 全量累計不直接對比單月支出', en: ' · All-time not compared to monthly spend' },
      'cost.expiredTag': { 'zh-CN': ' · ⚠️ 权益已到期', 'zh-TW': ' · ⚠️ 權益已到期', en: ' · ⚠️ Expired' },
      'cost.freeActive': { 'zh-CN': '{src} · 用户确认 · 免费权益使用中{extra}', 'zh-TW': '{src} · 使用者確認 · 免費權益使用中{extra}', en: '{src} · Confirmed · Free active{extra}' },
      'cost.covFull': { 'zh-CN': '100% 折算覆盖', 'zh-TW': '100% 換算覆蓋', en: '100% priced' },
      'cost.refApprox': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },

      // 调色板与下拉选择器
      'colors.resetLevel': { 'zh-CN': '恢复该档预设', 'zh-TW': '恢復該檔預設', en: 'Reset step' },
      'colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow theme' },
      'colors.lvl0': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Step 1 (None/Min)' },
      'colors.lvl1': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Step 2 (Low)' },
      'colors.lvl2': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Step 3 (Medium)' },
      'colors.lvl3': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Step 4 (High)' },
      'colors.lvl4': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/峰值用量）', en: 'Step 5 (Peak)' },
      'colors.eyedropperPicked': { 'zh-CN': '已吸取 {hex}', 'zh-TW': '已吸取 {hex}', en: 'Picked {hex}' },
      'colors.eyedropperUnsupported': { 'zh-CN': '当前环境不支持原生吸管，可直接粘贴 HEX', 'zh-TW': '目前環境不支援原生滴管，可直接貼上 HEX', en: 'Eyedropper unsupported; paste HEX directly' },
      'colors.appliedHex': { 'zh-CN': '已应用 {hex}', 'zh-TW': '已套用 {hex}', en: 'Applied {hex}' },
      'colors.copied': { 'zh-CN': '✔ 已复制 {label}: {val}', 'zh-TW': '✔ 已複製 {label}: {val}', en: '✔ Copied {label}: {val}' },
      'dropdown.countrySearch': { 'zh-CN': '🔍 搜索账号所在地区或代码 (如: 美国、TW、JP)...', 'zh-TW': '🔍 搜尋帳號所在地區或代碼 (如: 美國、TW、JP)...', en: '🔍 Search country or code (e.g. US, TW, JP)...' },
      'dropdown.countryEmpty': { 'zh-CN': '未找到匹配的账号所在地区', 'zh-TW': '未找到匹配的帳號所在地區', en: 'No matching country found' },
      'dropdown.regionSearch': { 'zh-CN': '🔍 搜索订阅国家/地区、货币或缩写 (如: 台湾、澳、USD)...', 'zh-TW': '🔍 搜尋訂閱國家/地區、貨幣或縮寫 (如: 台灣、澳、USD)...', en: '🔍 Search billing region or currency (e.g. TW, USD)...' },
      'dropdown.regionEmpty': { 'zh-CN': '未找到匹配的订阅国家/地区', 'zh-TW': '未找到匹配的訂閱國家/地區', en: 'No matching billing region found' },
      'dropdown.currencySearch': { 'zh-CN': '🔍 搜索币种名称或代码 (如: USD、NTD、人民币)...', 'zh-TW': '🔍 搜尋幣別名稱或代碼 (如: USD、NTD、台幣)...', en: '🔍 Search currency code or name (e.g. USD, CNY)...' },
      'dropdown.currencyEmpty': { 'zh-CN': '未找到匹配的币种', 'zh-TW': '未找到匹配的幣別', en: 'No matching currency found' },
      'dropdown.autoSaved': { 'zh-CN': '✔ 已自动保存', 'zh-TW': '✔ 已自動儲存', en: '✔ Auto-saved' },
      'dropdown.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
      'dropdown.saveFailedDetail': { 'zh-CN': '✖ 保存失败：{msg}', 'zh-TW': '✖ 儲存失敗：{msg}', en: '✖ Save failed: {msg}' },
      'dropdown.writeCfgFailed': { 'zh-CN': '无法写入配置文件', 'zh-TW': '無法寫入設定檔', en: 'Cannot write settings file' },
      'dropdown.noPersistBridge': { 'zh-CN': '未连接持久化服务，无法保存', 'zh-TW': '未連線持久化服務，無法儲存', en: 'Persistence bridge unavailable' },
      'dropdown.persistErr': { 'zh-CN': '持久化异常', 'zh-TW': '持久化異常', en: 'Persistence error' },
      'dropdown.perMonth': { 'zh-CN': '/月', 'zh-TW': '/月', en: '/mo' },
      'dropdown.regionUnknownShort': { 'zh-CN': '🌏 未知 (点击选择订阅地区与货币)', 'zh-TW': '🌏 未知 (點擊選擇訂閱地區與貨幣)', en: '🌏 Unknown (select region & currency)' },

      // 速度图表 Aria 与 设置/更新弹窗
      'speed.barSvg.aria': { 'zh-CN': '各模型与档位速度对比柱状图', 'zh-TW': '各模型與檔位速度對比長條圖', en: 'Model & effort speed comparison bar chart' },
      'speed.lineSvg.aria': { 'zh-CN': '所选模型与档位历史输出速度折线图', 'zh-TW': '所選模型與檔位歷史輸出速度折線圖', en: 'Selected model & effort speed trend line chart' },
      'settings.common.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
      'settings.clientLang.detecting': { 'zh-CN': '正在检测桌面端汉化运行状态…', 'zh-TW': '正在偵測桌面端漢化執行狀態…', en: 'Checking desktop localization status…' },
      'settings.clientLang.toggle': { 'zh-CN': '切换汉化状态', 'zh-TW': '切換漢化狀態', en: 'Toggle Localization' },
      'settings.proxy.checking': { 'zh-CN': '正在核对代理设置…', 'zh-TW': '正在核對代理設定…', en: 'Checking proxy settings…' },
      'settings.proxy.testBtn': { 'zh-CN': '🔍 测试代理连通性', 'zh-TW': '🔍 測試代理連通性', en: '🔍 Test Proxy Connectivity' },
      'settings.proxy.testing': { 'zh-CN': '正在测试…', 'zh-TW': '正在測試…', en: 'Testing…' },
      'settings.proxy.testingDetail': { 'zh-CN': '正在发起本地与网络连通性测试…', 'zh-TW': '正在發起本機與網路連通性測試…', en: 'Running local & network connectivity test…' },
      'settings.proxy.testFail': { 'zh-CN': '❌ 测试失败: {err}', 'zh-TW': '❌ 測試失敗: {err}', en: '❌ Test failed: {err}' },
      'settings.proxy.testErr': { 'zh-CN': '❌ 测试异常: {err}', 'zh-TW': '❌ 測試異常: {err}', en: '❌ Test error: {err}' },
      'settings.proxy.enableBtn': { 'zh-CN': '开启免 TUN 直连', 'zh-TW': '開啟免 TUN 直連', en: 'Enable No-TUN Direct' },
      'settings.proxy.resValid': { 'zh-CN': '✅ 合法', 'zh-TW': '✅ 合法', en: '✅ Valid' },
      'settings.proxy.resInvalid': { 'zh-CN': '❌ 无效', 'zh-TW': '❌ 無效', en: '❌ Invalid' },
      'settings.proxy.resReachable': { 'zh-CN': '✅ 可连接', 'zh-TW': '✅ 可連線', en: '✅ Reachable' },
      'settings.proxy.resUnreachable': { 'zh-CN': '❌ 无法连接', 'zh-TW': '❌ 無法連線', en: '❌ Unreachable' },
      'settings.proxy.resOnline': { 'zh-CN': '✅ 可访问', 'zh-TW': '✅ 可存取', en: '✅ Reachable' },
      'settings.proxy.resOffline': { 'zh-CN': '⚠️ 无法访问公网 (可能无境外连通)', 'zh-TW': '⚠️ 無法存取公網 (可能無境外連通)', en: '⚠️ Public internet unreachable' },
      'settings.proxy.resPending': { 'zh-CN': '待通过真实在线会话验证 (分层标定)', 'zh-TW': '待透過真實線上會話驗證 (分層標定)', en: 'Pending live chat verification' },
      'settings.proxy.resFmt': { 'zh-CN': '配置格式', 'zh-TW': '設定格式', en: 'Config format' },
      'settings.proxy.resPort': { 'zh-CN': '本地端口', 'zh-TW': '本機連接埠', en: 'Local port' },
      'settings.proxy.resNet': { 'zh-CN': '公网连通', 'zh-TW': '公網連通', en: 'Internet' },
      'settings.proxy.resModel': { 'zh-CN': '模型请求', 'zh-TW': '模型請求', en: 'Model request' },

      'update.unavailableTitle': { 'zh-CN': 'ℹ️ 更新不可用', 'zh-TW': 'ℹ️ 更新不可用', en: 'ℹ️ Update Unavailable' },
      'update.unavailableVer': { 'zh-CN': 'v{ver} (更新不可用)', 'zh-TW': 'v{ver} (更新不可用)', en: 'v{ver} (Unavailable)' },
      'update.unavailableBody': { 'zh-CN': '当前环境未提供更新桥接接口（如纯前端调试或免安装热挂载模式），无法在线检查更新。请前往 GitHub Releases 页面查看最新发布。', 'zh-TW': '目前環境未提供更新橋接介面（如純前端除錯或免安裝熱掛載模式），無法線上檢查更新。請前往 GitHub Releases 頁面查看最新發布。', en: 'Update bridge unavailable in this mode. Check GitHub Releases for the latest version.' },
      'update.checkingTitle': { 'zh-CN': '🔄 检查更新中', 'zh-TW': '🔄 檢查更新中', en: '🔄 Checking for Updates' },
      'update.checkingVer': { 'zh-CN': 'v{ver} (正在检查…)', 'zh-TW': 'v{ver} (正在檢查…)', en: 'v{ver} (Checking…)' },
      'update.doneTitle': { 'zh-CN': '🎉 更新已完成', 'zh-TW': '🎉 更新已完成', en: '🎉 Update Complete' },
      'update.doneVer': { 'zh-CN': 'v{ver} (已是最新)', 'zh-TW': 'v{ver} (已是最新)', en: 'v{ver} (Up to date)' },
      'update.doneHot': { 'zh-CN': '已成功在线更新至 v{ver}。界面组件已完成热注入即时生效；主进程核心常驻模块待完全重启客户端后完整生效。', 'zh-TW': '已成功線上更新至 v{ver}。介面元件已完成熱注入即時生效；主程序核心常駐模組待完全重啟用戶端後完整生效。', en: 'Updated to v{ver}. UI hot-injected immediately; restart client for main-process changes.' },
      'update.doneDisk': { 'zh-CN': '已成功完成 v{ver} 磁盘更新，需完全重启 Antigravity 后生效。', 'zh-TW': '已成功完成 v{ver} 磁碟更新，需完全重啟 Antigravity 後生效。', en: 'Disk update to v{ver} complete. Restart Antigravity to apply.' },
      'update.btnUpdated': { 'zh-CN': '已更新', 'zh-TW': '已更新', en: 'Updated' },
      'update.btnRetry': { 'zh-CN': '重试更新', 'zh-TW': '重試更新', en: 'Retry Update' },
      'update.failStatus': { 'zh-CN': '✖ 更新失败: {err}', 'zh-TW': '✖ 更新失敗: {err}', en: '✖ Update failed: {err}' },
      'update.errStatus': { 'zh-CN': '✖ 更新异常: {err}', 'zh-TW': '✖ 更新異常: {err}', en: '✖ Update error: {err}' },

      // 模型查看提示 & 状态扩展 & 重启交互
      'panel.ctx.viewModelHint': { 'zh-CN': '仅查看模型配置；在此切换不会改变发送模型', 'zh-TW': '僅檢視模型設定；在此切換不會改變發送模型', en: 'Inspect model config only; does not change active chat model' },
      'status.badge.partialMatch': { 'zh-CN': '特征未识别（部分匹配）', 'zh-TW': '特徵未識別（部分匹配）', en: 'Signature mismatch (partial)' },
      'client.restart.hostNotSupported': { 'zh-CN': '当前窗口为热注入或预览模式，不支持一键重启客户端，请手动完全退出后重新打开。', 'zh-TW': '目前視窗為熱注入或預覽模式，不支援一鍵重啟用戶端，請手動完全結束後重新開啟。', en: 'Current mode does not support one-click host restart. Fully quit and reopen Antigravity manually.' },
      'client.restart.triggering': { 'zh-CN': '正在通知客户端退出并重启…', 'zh-TW': '正在通知用戶端結束並重新啟動…', en: 'Requesting Antigravity restart…' },
      'client.restart.triggered': { 'zh-CN': '已触发客户端重启；若未自动拉起，请手动重新打开 Antigravity。', 'zh-TW': '已觸發用戶端重啟；若未自動拉起，請手動重新開啟 Antigravity。', en: 'Restart requested. Reopen Antigravity manually if it does not relaunch automatically.' },
      'client.restart.failed': { 'zh-CN': '无法自动重启：{err}，请手动完全退出后重新打开客户端。', 'zh-TW': '無法自動重啟：{err}，請手動完全結束後重新開啟用戶端。', en: 'Auto-restart failed: {err}. Please quit and reopen Antigravity manually.' },
      'client.restart.manualNote': { 'zh-CN': '请手动完全退出 Antigravity 并重新打开，然后刷新状态确认是否生效。', 'zh-TW': '請手動完全結束 Antigravity 並重新開啟，然後重新整理狀態確認是否生效。', en: 'Quit Antigravity completely and reopen it, then refresh status to verify.' },
      'msg.saveFail': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
      'msg.noHostBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
      'msg.noModelsDetected': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the model list to load.' },
      'models.btn.recheck': { 'zh-CN': '重新检测', 'zh-TW': '重新偵測', en: 'Re-detect' },
      'models.card.partialFailDetail': { 'zh-CN': '未定位到完整的上下文写入点，为保护二进制完整性已中止写入。{reason}', 'zh-TW': '未定位到完整的上下文寫入點，為保護二進位完整性已中止寫入。{reason}', en: 'Could not locate all required binary gates; aborted safely. {reason}' },

      // 推荐配置 / 提示词档位 / 品牌标题 / 增强设置
      'enhance.preset.title': { 'zh-CN': '✨ 推荐配置（按需主动应用）', 'zh-TW': '✨ 推薦設定（依需求主動套用）', en: '✨ Recommended Setup (Opt-In)' },
      'enhance.preset.desc': { 'zh-CN': '只安装插件不会暗中改写您的提示词、标题、语言或上下文。勾选需要开启的能力，点击下方按钮查看改动清单并确认后再执行。', 'zh-TW': '僅安裝外掛不會暗中改寫您的提示詞、標題、語言或上下文。勾選需要開啟的功能，點擊下方按鈕檢視變更清單並確認後再執行。', en: 'Installing never alters prompts, titles, UI language, or context secretly. Select items below and confirm the preview before applying.' },
      'enhance.preset.itemPrompt': { 'zh-CN': '精简防幻觉增强提示词 (4档)', 'zh-TW': '精簡防幻覺增強提示詞 (4檔)', en: 'Lean Anti-Hallucination Prompt (Tier 4)' },
      'enhance.preset.itemPromptSub': { 'zh-CN': '保留原生任务工具规范，注入工具契约与事实校验准则（写入验证，非保证模型不出错）', 'zh-TW': '保留原生任務工具規範，注入工具契約與事實校驗準則（寫入驗證，非保證模型不出錯）', en: 'Keeps native tools, adds verification & tool discipline (template write only; does not guarantee zero errors)' },
      'enhance.preset.itemTitle': { 'zh-CN': '自动中文会话标题', 'zh-TW': '自動中文工作階段標題', en: 'Auto Chinese Chat Titles' },
      'enhance.preset.itemTitleSub': { 'zh-CN': '让客户端为新对话生成简短简体中文标题（可单独开关恢复）', 'zh-TW': '讓用戶端為新對話產生簡短簡體中文標題（可單獨開關恢復）', en: 'Instructs the client to generate concise Chinese titles for new chats' },
      'enhance.preset.itemLang': { 'zh-CN': '客户端界面简体中文', 'zh-TW': '用戶端介面簡體中文', en: 'Client Simplified Chinese UI' },
      'enhance.preset.itemLangSub': { 'zh-CN': '切换 Antigravity 宿主本身为简体中文（可随时切回官方英文）', 'zh-TW': '切換 Antigravity 宿主本身為簡體中文（可隨時切回官方英文）', en: 'Switches Antigravity host UI to zh-CN (reversible to English)' },
      'enhance.preset.itemCtx': { 'zh-CN': '上下文跟随模型 (推荐上限释放)', 'zh-TW': '上下文跟隨模型 (推薦上限釋放)', en: 'Follow Model Context Limit' },
      'enhance.preset.itemCtxSub': { 'zh-CN': '解除前端硬编码上限，按当前模型原生能力透传真实预算', 'zh-TW': '解除前端寫死上限，依目前模型原生能力透傳真實預算', en: 'Lifts hardcoded client cap so each model uses its native limit' },
      'enhance.preset.applyBtn': { 'zh-CN': '应用所选推荐配置…', 'zh-TW': '套用所選推薦設定…', en: 'Apply Selected Preset…' },
      'enhance.restoreAll.btn': { 'zh-CN': '全部恢复官方默认…', 'zh-TW': '全部恢復官方預設…', en: 'Restore All to Stock…' },
      'enhance.confirm.go': { 'zh-CN': '确认执行', 'zh-TW': '確認執行', en: 'Confirm' },
      'enhance.confirm.presetSummary': { 'zh-CN': '即将执行以下已勾选项：{items}；未勾选项目保持不变。变更后可能需要重启语言服务或 Antigravity 客户端加载生效。', 'zh-TW': '即將執行以下已勾選項：{items}；未勾選項目維持不變。變更後可能需要重啟語言服務或 Antigravity 用戶端載入生效。', en: 'About to apply checked items: {items}; unchecked items stay untouched. A language server or client restart may be required.' },
      'enhance.confirm.restoreSummary': { 'zh-CN': '「全部恢复官方默认」将还原以下 4 项：系统提示词(0档原版)、关闭中文会话标题、客户端英文界面及品牌(Antigravity)、宿主默认上下文行为。不会清除网络代理、面板语言及已保存的模型长度偏好。是否继续？', 'zh-TW': '「全部恢復官方預設」將還原以下 4 項：系統提示詞(0檔原版)、關閉中文工作階段標題、用戶端英文介面及品牌(Antigravity)、宿主預設上下文行為。不會清除網路代理、面板語言及已儲存的模型長度偏好。是否繼續？', en: '"Restore All to Stock" resets these 4 items: Tier 0 prompt, stock English titles, English host UI & brand (Antigravity), and native context behavior. Keeps proxy, panel language, and saved model preferences. Continue?' },
      'enhance.confirm.noneSelected': { 'zh-CN': '请至少勾选一项要应用的配置。', 'zh-TW': '請至少勾選一項要套用的設定。', en: 'Select at least one option first.' },
      'enhance.btn.restartLs': { 'zh-CN': '重启语言服务', 'zh-TW': '重啟語言服務', en: 'Restart Language Server' },
      'enhance.brand.label': { 'zh-CN': '左上角品牌文字显示（仅作用于左上角品牌位，不影响 Logo、菜单或代码）：', 'zh-TW': '左上角品牌文字顯示（僅作用於左上角品牌位，不影響 Logo、選單或程式碼）：', en: 'Header Brand Text (applies only to top-left brand slot; does not alter logo, menus, or code):' },
      'enhance.brand.aria': { 'zh-CN': '品牌显示模式', 'zh-TW': '品牌顯示模式', en: 'Brand display mode' },
      'enhance.brand.english': { 'zh-CN': '保留 Antigravity', 'zh-TW': '保留 Antigravity', en: 'Keep Antigravity' },
      'enhance.brand.hidden': { 'zh-CN': '隐藏', 'zh-TW': '隱藏', en: 'Hide' },
      'enhance.brand.translated': { 'zh-CN': '反重力', 'zh-TW': '反重力', en: '反重力 (Translated)' },
      'enhance.brand.applyBtn': { 'zh-CN': '保存品牌选择并应用', 'zh-TW': '儲存品牌選擇並套用', en: 'Save & Apply Brand' },
      'enhance.brand.switched': { 'zh-CN': '品牌显示已保存为「{mode}」，重启 Antigravity 客户端后生效。', 'zh-TW': '品牌顯示已儲存為「{mode}」，重新啟動 Antigravity 用戶端後生效。', en: 'Brand display saved as "{mode}". Restart Antigravity to take effect.' },
      'enhance.prompt.title': { 'zh-CN': '🧠 回答与工具使用规则', 'zh-TW': '🧠 回答與工具使用規則', en: '🧠 Response & Tool Usage Rules' },
      'enhance.prompt.plainIntro': { 'zh-CN': '调整客户端给 AI 的工作说明，让它更重视证据：没读过的文件不猜，没运行的测试不说通过。它不会升级模型底层能力，也不能保证回答永远正确。', 'zh-TW': '調整用戶端提供給 AI 的工作指引，促使其更重視證據：未讀取的檔案不臆測，未實際執行的測試不宣稱通過。此功能調整本機範本指引，不會提升模型底層能力，亦無法確保回答絕對無誤。', en: 'Adjusts client instructions to AI to emphasize evidence: never guess unread files, never claim untested code passed. It does not upgrade model intelligence or guarantee error-free output.' },
      'enhance.stat.prompt': { 'zh-CN': '当前检测档位', 'zh-TW': '目前檢測檔位', en: 'Detected Tier' },
      'enhance.stat.title': { 'zh-CN': '自动中文标题', 'zh-TW': '自動中文標題', en: 'Auto Chinese Title' },
      'enhance.stat.evidence': { 'zh-CN': '证据检测状态', 'zh-TW': '證據檢測狀態', en: 'Evidence Status' },
      'enhance.stat.slots': { 'zh-CN': '槽位状态', 'zh-TW': '槽位狀態', en: 'Prompt/Title Slots' },
      'enhance.stat.backup': { 'zh-CN': '原版内核备份', 'zh-TW': '原版核心備份', en: 'Stock Backup' },
      'enhance.prompt.aria': { 'zh-CN': '规则档位选择', 'zh-TW': '規則檔位選擇', en: 'Rule tier selection' },
      'enhance.tier.0.short': { 'zh-CN': '0档·官方原版', 'zh-TW': '0檔·官方原版', en: 'T0 · Stock' },
      'enhance.tier.1.short': { 'zh-CN': '1档·仅去推销', 'zh-TW': '1檔·僅去推銷', en: 'T1 · Clear Ads' },
      'enhance.tier.2.short': { 'zh-CN': '2档·原版精简', 'zh-TW': '2檔·原版精簡', en: 'T2 · Bloat Cleared' },
      'enhance.tier.3.short': { 'zh-CN': '3档·核心重写', 'zh-TW': '3檔·核心重寫', en: 'T3 · Core Rewritten' },
      'enhance.tier.4.short': { 'zh-CN': '4档·精简+防幻觉', 'zh-TW': '4檔·精簡+防幻覺', en: 'T4 · Guardrails' },
      'enhance.tier.0.desc': { 'zh-CN': '从原版备份完整还原所有官方系统提示词模板，未作任何改动。', 'zh-TW': '從原版備份完整還原所有官方系統提示詞範本，未作任何更動。', en: 'Restores all official system prompt templates from original backup without modifications.' },
      'enhance.tier.1.desc': { 'zh-CN': '仅清空插件市场与斜杠命令推销模板，其余保持官方原版。', 'zh-TW': '僅清空外掛市場與斜杠命令推銷範本，其餘保持官方原版。', en: 'Clears plugin marketplace and slash-command promotion templates; keeps all other templates stock.' },
      'enhance.tier.2.desc': { 'zh-CN': '清空工件、记忆与推销等 7 份辅助指引模板；身份定义与三份核心行为规则保持官方原版未修改。', 'zh-TW': '清空工件、記憶與推銷等 7 份輔助指引範本；身分定義與三份核心行為規則保持官方原版未更動。', en: 'Clears 7 auxiliary guidance templates (artifacts, memory, promotions); keeps identity and 3 core behavior rules stock.' },
      'enhance.tier.3.desc': { 'zh-CN': '在清空 7 份辅助模板的基础上，将三份核心行为规则重写为紧凑高密度的精简工程规范。', 'zh-TW': '在清空 7 份輔助範本的基礎上，將三份核心行為規則重寫為緊湊高密度的精簡工程規範。', en: 'Clears 7 auxiliary templates and rewrites the 3 core behavior rules into high-density concise engineering specifications.' },
      'enhance.tier.4.desc': { 'zh-CN': '在 3 档精简重写基础上注入防幻觉护栏：要求未读文件不猜、未跑测试不谎报通过、仅依据真实工具结果回答。', 'zh-TW': '在 3 檔精簡重寫基礎上注入防幻覺護欄：要求未讀檔案不猜、未跑測試不虛報通過、僅依據真實工具結果回答。', en: 'Injects anti-hallucination guardrails onto Tier 3: mandates no guessing unread files, no claiming unexecuted tests pass, and anchoring strictly to tool outputs.' },
      'enhance.tier.0.keeps': { 'zh-CN': '全部官方系统提示词模板与原生工具契约（100% 原始状态）', 'zh-TW': '全部官方系統提示詞範本與原生工具契約（100% 原始狀態）', en: 'All native system prompt templates and tool contracts (100% stock)' },
      'enhance.tier.0.clears': { 'zh-CN': '无', 'zh-TW': '無', en: 'None' },
      'enhance.tier.0.replaces': { 'zh-CN': '无', 'zh-TW': '無', en: 'None' },
      'enhance.tier.0.meaning': { 'zh-CN': '完全恢复官方原生体验，包含完整的斜杠命令示例、推销及工件引导。', 'zh-TW': '完全恢復官方原生體驗，包含完整的斜杠命令範例、推銷及工件引導。', en: 'Complete native experience, including standard slash commands, promotions, and artifact instructions.' },
      'enhance.tier.1.keeps': { 'zh-CN': '身份定义、三份核心行为规则、工件与会话记录等其余全部原版模板', 'zh-TW': '身分定義、三份核心行為規則、工件與對話記錄等其餘全部原版範本', en: 'Identity, all 3 core behavior rules, artifacts, transcripts, and all other stock templates' },
      'enhance.tier.1.clears': { 'zh-CN': 'slash_commands.tmpl, plugins.tmpl（共 2 份推销与命令示例模板）', 'zh-TW': 'slash_commands.tmpl, plugins.tmpl（共 2 份推銷與命令範例範本）', en: 'slash_commands.tmpl, plugins.tmpl (2 promotional/example templates)' },
      'enhance.tier.1.replaces': { 'zh-CN': '无（不替换任何规则）', 'zh-TW': '無（不替換任何規則）', en: 'None (no rules replaced)' },
      'enhance.tier.1.meaning': { 'zh-CN': '不再主动推销插件与斜杠命令；不改变编码准则与工具契约，其余能力全部保留。', 'zh-TW': '不再主動推銷外掛與斜杠命令；不改變編碼準則與工具契約，其餘能力全部保留。', en: 'Stops unsolicited promotions for plugins and slash commands; leaves coding standards and all other capabilities stock.' },
      'enhance.tier.2.keeps': { 'zh-CN': 'identity、guidelines、function_call、communication_style（4 份核心模板 100% 官方原版未修改）', 'zh-TW': 'identity、guidelines、function_call、communication_style（4 份核心範本 100% 官方原版未更動）', en: 'identity, guidelines, function_call, communication_style (4 core templates 100% unmodified stock)' },
      'enhance.tier.2.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助指引模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助指引範本）', en: '7 auxiliary templates: artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins' },
      'enhance.tier.2.replaces': { 'zh-CN': '无（核心行为规则完全保持官方原版）', 'zh-TW': '無（核心行為規則完全保持官方原版）', en: 'None (core behavioral rules remain strictly stock)' },
      'enhance.tier.2.meaning': { 'zh-CN': '精简约 7~8KB 提示词。这是删减关于工件与记忆的工作指引，不等于删除用户文件或工件功能；核心规范仍是官方原版。', 'zh-TW': '精簡約 7~8KB 提示詞。這是刪減關於工件與記憶的工作指引，不等於刪除使用者檔案或工件功能；核心規範仍為官方原版。', en: 'Saves ~7-8KB of prompt context. Trims workflow guidance for artifacts and memory without deleting user files or artifact tools; core rules remain stock.' },
      'enhance.tier.3.keeps': { 'zh-CN': 'identity.tmpl（官方原版身份未修改）、全部原生工具定义', 'zh-TW': 'identity.tmpl（官方原版身分未更動）、全部原生工具定義', en: 'identity.tmpl (official identity kept stock), all native tool contracts' },
      'enhance.tier.3.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助範本）', en: '7 auxiliary templates (artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins)' },
      'enhance.tier.3.replaces': { 'zh-CN': '重写 guidelines、function_call、communication_style（重写为精简工程规范：直接工具调用、并行读取+顺序编辑、edit_file 唯一锚点、真实工具实测验证）', 'zh-TW': '重寫 guidelines、function_call、communication_style（重寫為精簡工程規範：直接工具呼叫、並行讀取+循序編輯、edit_file 唯一錨點、真實工具實測驗證）', en: 'Rewrites guidelines, function_call, communication_style into concise engineering specs (clean tool turns, parallel reads, unique edit_file anchor, verified tool testing)' },
      'enhance.tier.3.meaning': { 'zh-CN': '大幅缩短系统提示词；重写核心规范使 AI 回复更直奔主题并强化工具规范。工件指引被精简，是否影响工件生成需实际验证。', 'zh-TW': '大幅縮短系統提示詞；重寫核心規範使 AI 回覆更直奔主題並強化工具規範。工件指引被精簡，是否影響工件產生需實際驗證。', en: 'Significantly reduces prompt tokens; rewritten core rules make responses more direct with strict tool execution. Practical impact on artifacts requires live testing.' },
      'enhance.tier.4.keeps': { 'zh-CN': 'identity.tmpl（官方原版身份未修改）、全部原生工具定义、核心格式要求（LaTeX与文件链接规范）', 'zh-TW': 'identity.tmpl（官方原版身分未更動）、全部原生工具定義、核心格式要求（LaTeX與檔案連結規範）', en: 'identity.tmpl (official identity kept stock), all native tool contracts, core formatting standards (LaTeX & file links)' },
      'enhance.tier.4.clears': { 'zh-CN': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份辅助模板）', 'zh-TW': 'artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins（共 7 份輔助範本）', en: '7 auxiliary templates (artifacts, persistent_context, knowledge_items, planning_mode_artifacts, conversation_transcript, slash_commands, plugins)' },
      'enhance.tier.4.replaces': { 'zh-CN': '重写 guidelines、function_call、communication_style（精简规范 + 未读禁猜 + edit_file 唯一锚点 + 真实工具实测验证护栏）', 'zh-TW': '重寫 guidelines、function_call、communication_style（精簡規範 + 未讀禁猜 + edit_file 唯一錨點 + 真實工具實測驗證護欄）', en: 'Rewrites guidelines, function_call, communication_style (concise specs + evidence-first + unique edit_file anchor + verified test guardrails)' },
      'enhance.tier.4.meaning': { 'zh-CN': '最少预设干预，强化基于事实作答。注意：这只是调整给 AI 的提示词规范，不升级底层模型智能，也不能保证绝对不犯错。', 'zh-TW': '最少預設干預，強化基於事實作答。注意：這只是調整給 AI 的提示詞規範，不升級底層模型智能，也不能保證絕對不犯錯。', en: 'Minimizes unrequested bloat and enforces fact-based answers. Note: prompt adjustments guide model behavior but cannot upgrade underlying model intelligence or guarantee zero errors.' },
      'enhance.matrix.keeps': { 'zh-CN': '保留', 'zh-TW': '保留', en: 'Keeps' },
      'enhance.matrix.clears': { 'zh-CN': '清空', 'zh-TW': '清空', en: 'Clears' },
      'enhance.matrix.replaces': { 'zh-CN': '替换', 'zh-TW': '替換', en: 'Injects' },
      'enhance.matrix.meaning': { 'zh-CN': '对你的影响', 'zh-TW': '對你的影響', en: 'User Impact' },
      'enhance.hallucinationNote': { 'zh-CN': '提示：规则档位通过调整本地提示词模板来引导 AI 行为，仅代表规则文本已写入磁盘程序。它不等于模型能力升级，亦无法确保模型绝对不犯错；高档位删减提示模板中的指引，不等于删除用户文件，实际表现需结合真实对话检验。', 'zh-TW': '提示：規則檔位透過調整本機提示詞範本來引導 AI 行為，僅代表規則文字已寫入磁碟程式。它不等於模型能力升級，亦無法確保模型絕對不出錯；高檔位刪減提示範本中的指引，不等於刪除使用者檔案，實際表現需結合真實對話檢驗。', en: 'Note: Rule tiers tune local prompt templates to guide AI behavior. This modifies text on disk; it does not upgrade underlying model intelligence or guarantee zero errors. Trimming guidance does not delete user files; live validation is recommended.' },
      'enhance.titlePatch.label': { 'zh-CN': '自动生成简短中文会话标题', 'zh-TW': '自動產生簡短中文工作階段標題', en: 'Generate concise Chinese chat titles' },
      'enhance.titlePatch.sub': { 'zh-CN': '修改对话总结指令为简体中文短标题（等长槽位替换，可随时恢复）', 'zh-TW': '修改對話總結指令為簡體中文短標題（等長槽位替換，可隨時恢復）', en: 'Fixed-length prompt slot update for concise Chinese titles (reversible)' },
      'enhance.btn.applyPrompt': { 'zh-CN': '应用提示词与标题设置', 'zh-TW': '套用提示詞與標題設定', en: 'Apply Prompt & Title Settings' },
      'enhance.btn.applyPromptBusy': { 'zh-CN': '正在写入提示词…', 'zh-TW': '正在寫入提示詞…', en: 'Writing prompt settings…' },
      'enhance.btn.applyPresetBusy': { 'zh-CN': '正在应用推荐配置…', 'zh-TW': '正在套用推薦設定…', en: 'Applying preset…' },
      'enhance.btn.restoreAllBusy': { 'zh-CN': '正在恢复全部默认…', 'zh-TW': '正在恢復全部預設…', en: 'Restoring stock…' },
      'enhance.details.toggle': { 'zh-CN': '原理说明与贡献来源', 'zh-TW': '原理說明與貢獻來源', en: 'Technical Details & Credits' },
      'enhance.details.collapse': { 'zh-CN': '▲ 收起说明', 'zh-TW': '▲ 收起說明', en: '▲ Hide Details' },
      'enhance.details.body': { 'zh-CN': '所有提示词与中文标题改动均采用等长槽位替换并保留原版备份，不改变文件体积，不会静默覆盖原有上下文配置。防幻觉档位已在融合前移除与本机工具不符、固定知识截止日与强制配色规则。', 'zh-TW': '所有提示詞與中文標題變更皆採用等長槽位替換並保留原版備份，不改變檔案體積，不會靜默覆蓋原有上下文設定。防幻覺檔位已在融合前移除與本機工具不符、固定知識截止日與強制配色規則。', en: 'Prompt and title changes use fixed-length slot replacement with stock backups so file size never shifts and context settings stay separate.' },
      'enhance.details.credit': { 'zh-CN': '增强与提示词档位思路源自开源贡献 PR #4 (Jia131313)，桌面端与 CLI 解锁逻辑融合自 PR #3 (anyu0804 / Linux.do @23375)，经本仓库适配器统一持久化链路与防幻觉契约。', 'zh-TW': '增強與提示詞檔位思路源自開源貢獻 PR #4 (Jia131313)，桌面端與 CLI 解鎖邏輯融合自 PR #3 (anyu0804 / Linux.do @23375)，經本專案適配器統一持久化鏈路與防幻覺契約。', en: 'Prompt tiers & enhance ideas adapted from PR #4 (Jia131313); context unlock adapted from PR #3 (anyu0804 / Linux.do @23375), unified in this project.' },
      'enhance.status.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
      'enhance.status.pendingRestartLs': { 'zh-CN': '待重启语言服务', 'zh-TW': '待重啟語言服務', en: 'LS Restart Needed' },
      'enhance.status.patchedActive': { 'zh-CN': '已写入', 'zh-TW': '已寫入', en: 'Patched' },
      'enhance.status.stock': { 'zh-CN': '官方原版', 'zh-TW': '官方原版', en: 'Stock' },
      'enhance.status.slotsInfo': { 'zh-CN': '提示词 {p} · 标题 {t}', 'zh-TW': '提示詞 {p} · 標題 {t}', en: 'Prompt {p} · Title {t}' },
      'enhance.status.backupYes': { 'zh-CN': '已备份', 'zh-TW': '已備份', en: 'Backed up' },
      'enhance.status.backupNo': { 'zh-CN': '无（未改写）', 'zh-TW': '無（未改寫）', en: 'None (stock)' },
      'enhance.titleState.on': { 'zh-CN': '已开启', 'zh-TW': '已開啟', en: 'Enabled' },
      'enhance.titleState.onWritten': { 'zh-CN': '已写入磁盘（待重新加载）', 'zh-TW': '已寫入磁碟（待重新載入）', en: 'Written to disk (Reload needed)' },
      'enhance.titleState.off': { 'zh-CN': '原版英文', 'zh-TW': '原版英文', en: 'Stock English' },
      'enhance.titleState.conflict': { 'zh-CN': '状态不一致', 'zh-TW': '狀態不一致', en: 'Mismatch' },
      'enhance.result.appliedNeedRestartLs': { 'zh-CN': '✔ 提示词与标题配置已写入磁盘（{tier} / 中文标题：{title}）。需重启后台语言服务或重开客户端以加载新指令；标题实际效果由模型生成，不保证必定中文。', 'zh-TW': '✔ 提示詞與標題設定已寫入磁碟（{tier} / 中文標題：{title}）。需重啟後台語言服務或重開用戶端以載入新指令；標題實際效果由模型生成，不保證必定中文。', en: '✔ Prompt & title settings written ({tier} / Title: {title}). Language server or client restart required to reload. Title output depends on model.' },
      'enhance.result.presetDone': { 'zh-CN': '✔ 所选推荐配置已写入（{summary}）。请重启语言服务或客户端让全部变更加载生效。', 'zh-TW': '✔ 所選推薦設定已寫入（{summary}）。請重啟語言服務或用戶端讓全部變更載入生效。', en: '✔ Selected preset applied ({summary}). Restart language server or client to load changes.' },
      'enhance.result.restoredDone': { 'zh-CN': '✔ 已恢复为官方默认状态（0档原版、关闭中文标题、官方英文与默认上下文）。请重启客户端完整生效。', 'zh-TW': '✔ 已恢復為官方預設狀態（0檔原版、關閉中文標題、官方英文與預設上下文）。請重啟用戶端完整生效。', en: '✔ Restored to stock defaults (Tier 0, original title & English UI, native context). Restart client to take effect.' },
      'enhance.result.partialFail': { 'zh-CN': '⚠ 部分完成，未全部成功。已成功：{done}；失败：{failed}。请处理异常项后重试。', 'zh-TW': '⚠ 部分完成，未全部成功。已成功：{done}；失敗：{failed}。請處理異常項後重試。', en: '⚠ Partial completion. Succeeded: {done}; Failed: {failed}. Please retry failed items.' },
      'enhance.result.lsRestarted': { 'zh-CN': '✔ 已通知语言服务重载（终止 {killed} 个旧进程），Antigravity 将自动拉起新版后端。', 'zh-TW': '✔ 已通知語言服務重載（終止 {killed} 個舊行程），Antigravity 將自動拉起新版後端。', en: '✔ Language server signaled to reload ({killed} process(es) cycled); Antigravity will respawn it.' },
      'enhance.result.lsRestartFail': { 'zh-CN': '重启语言服务失败：{err}', 'zh-TW': '重啟語言服務失敗：{err}', en: 'Failed to restart language server: {err}' },
      'enhance.result.noBridge': { 'zh-CN': '当前预览模式未连接到语言服务增强桥接，可通过 node cli.js enhance-status 查看或执行。', 'zh-TW': '目前預覽模式未連線到語言服務增強橋接，可透過 node cli.js enhance-status 檢視或執行。', en: 'Enhance bridge unavailable in this mode. Use `node cli.js enhance-status` via CLI.' },
      'enhance.result.fail': { 'zh-CN': '操作失败：{err}', 'zh-TW': '操作失敗：{err}', en: 'Action failed: {err}' },

      // 颜色与拾色器 & 更新弹窗补充
      'colors.swatchTitle': { 'zh-CN': '点击打开调色板', 'zh-TW': '點擊開啟調色盤', en: 'Click to pick color' },
      'colors.lvl0Title': { 'zh-CN': '热力图第1档：少/无用量（点击独立调色）', 'zh-TW': '熱力圖第1檔：少/無用量（點擊獨立調色）', en: 'Heatmap Level 1: None/Low (click to edit)' },
      'colors.lvl1Title': { 'zh-CN': '热力图第2档：低用量（点击独立调色）', 'zh-TW': '熱力圖第2檔：低用量（點擊獨立調色）', en: 'Heatmap Level 2: Light (click to edit)' },
      'colors.lvl2Title': { 'zh-CN': '热力图第3档：中等用量（点击独立调色）', 'zh-TW': '熱力圖第3檔：中等用量（點擊獨立調色）', en: 'Heatmap Level 3: Medium (click to edit)' },
      'colors.lvl3Title': { 'zh-CN': '热力图第4档：高用量（点击独立调色）', 'zh-TW': '熱力圖第4檔：高用量（點擊獨立調色）', en: 'Heatmap Level 4: High (click to edit)' },
      'colors.lvl4Title': { 'zh-CN': '热力图第5档：多/峰值用量（点击独立调色）', 'zh-TW': '熱力圖第5檔：多/峰值用量（點擊獨立調色）', en: 'Heatmap Level 5: Peak (click to edit)' },
      'colors.panelBgSwatch': { 'zh-CN': '面板与菜单背景色', 'zh-TW': '面板與選單背景色', en: 'Panel & Menu Background' },
      'cp.closeAria': { 'zh-CN': '关闭调色器', 'zh-TW': '關閉調色盤', en: 'Close color picker' },
      'cp.eyedropperTitle': { 'zh-CN': '屏幕取色器 (吸管)', 'zh-TW': '螢幕取色器 (吸管)', en: 'Eyedropper' },
      'cp.hexAria': { 'zh-CN': 'HEX 色值', 'zh-TW': 'HEX 色值', en: 'HEX value' },
      'cp.copyHex': { 'zh-CN': '复制 HEX', 'zh-TW': '複製 HEX', en: 'Copy HEX' },
      'cp.rgbAria': { 'zh-CN': 'RGB 色值', 'zh-TW': 'RGB 色值', en: 'RGB value' },
      'cp.copyRgb': { 'zh-CN': '复制 RGB', 'zh-TW': '複製 RGB', en: 'Copy RGB' },
      'cp.hslAria': { 'zh-CN': 'HSL 色值', 'zh-TW': 'HSL 色值', en: 'HSL value' },
      'cp.copyHsl': { 'zh-CN': '复制 HSL', 'zh-TW': '複製 HSL', en: 'Copy HSL' },
      'update.dialogAria': { 'zh-CN': '软件更新', 'zh-TW': '軟體更新', en: 'Software Update' },

      // 订阅表单与热力图补充
      'plan.summary.priceBadgeTitle': { 'zh-CN': '当前订阅月费及人民币折合汇率参考 (点击展开/收起详情)', 'zh-TW': '目前訂閱月費及人民幣折合匯率參考 (點擊展開/收起詳情)', en: 'Current monthly fee & CNY estimate (click to toggle details)' },
      'plan.country.title': { 'zh-CN': '仅作为本地显示记录，不修改实际 Google 账号', 'zh-TW': '僅作為本機顯示記錄，不修改實際 Google 帳號', en: 'Local display record only; does not change your Google account' },
      'plan.region.title': { 'zh-CN': '实际购买或支付订阅所在的国家或地区', 'zh-TW': '實際購買或支付訂閱所在的國家或地區', en: 'Country/region where the subscription is billed' },
      'plan.currency.aria': { 'zh-CN': '选择订阅币种', 'zh-TW': '選擇訂閱幣別', en: 'Select subscription currency' },
      'plan.currency.title': { 'zh-CN': '订阅计价/结算币种', 'zh-TW': '訂閱計價/結算幣別', en: 'Subscription billing currency' },
      'plan.country.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'plan.region.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'plan.cnyApprox': { 'zh-CN': '折合 ≈ ¥{val} CNY/月', 'zh-TW': '折合 ≈ ¥{val} CNY/月', en: '≈ ¥{val} CNY/mo' },
      'plan.cnyShort': { 'zh-CN': '≈ ¥{val} CNY', 'zh-TW': '≈ ¥{val} CNY', en: '≈ ¥{val} CNY' },
      'plan.acqOpt.normal_paid': { 'zh-CN': '正常官方付费订阅', 'zh-TW': '正常官方付費訂閱', en: 'Standard paid subscription' },
      'plan.acqOpt.student_offer': { 'zh-CN': '学生教育优惠 (Google AI Pro 学生方案)', 'zh-TW': '學生教育優惠 (Google AI Pro 學生方案)', en: 'Student discount (Google AI Pro)' },
      'plan.acqOpt.pixel_bundle': { 'zh-CN': 'Pixel 手机购机赠送权益', 'zh-TW': 'Pixel 手機購機贈送權益', en: 'Pixel phone bundle perk' },
      'plan.acqOpt.chromebook_bundle': { 'zh-CN': 'Chromebook 购机赠送权益', 'zh-TW': 'Chromebook 購機贈送權益', en: 'Chromebook bundle perk' },
      'plan.acqOpt.samsung_galaxy': { 'zh-CN': 'Samsung Galaxy 手机赠送权益', 'zh-TW': 'Samsung Galaxy 手機贈送權益', en: 'Samsung Galaxy perk' },
      'plan.acqOpt.jio_offer': { 'zh-CN': 'Jio 运营商优惠活动', 'zh-TW': 'Jio 電信優惠活動', en: 'Jio carrier promotion' },
      'plan.acqOpt.partner_carrier': { 'zh-CN': '合作运营商 / 活动赠送', 'zh-TW': '合作電信商 / 活動贈送', en: 'Carrier / partner promotion' },
      'plan.acqOpt.family_sharing': { 'zh-CN': 'Google 家庭共享成员', 'zh-TW': 'Google 家庭共享成員', en: 'Google Family Sharing' },
      'plan.acqOpt.official_promo': { 'zh-CN': '官方试用 / 促销优惠', 'zh-TW': '官方試用 / 促銷優惠', en: 'Official trial / promo' },
      'plan.acqOpt.custom_source': { 'zh-CN': '其他自定义渠道', 'zh-TW': '其他自訂管道', en: 'Other custom source' },
      'plan.form.presetPlaceholder': { 'zh-CN': '-- 选择预设地区 (自动填入价格与汇率) --', 'zh-TW': '-- 選擇預設地區 (自動填入價格與匯率) --', en: '-- Choose preset region (auto-fills price & rate) --' },
      'plan.form.presetCustom': { 'zh-CN': '✎ 自定义输入地区', 'zh-TW': '✎ 自訂輸入地區', en: '✎ Custom region' },
      'plan.form.countryPh': { 'zh-CN': '例如：美国 (US)', 'zh-TW': '例如：美國 (US)', en: 'e.g. United States (US)' },
      'plan.form.regionPh': { 'zh-CN': '例如：韩国 / 澳大利亚', 'zh-TW': '例如：韓國 / 澳洲', en: 'e.g. South Korea / Australia' },
      'plan.form.presetLine': { 'zh-CN': '{flag} {name} ({id}) · {sym}{price}/月 (≈ ¥{cny})', 'zh-TW': '{flag} {name} ({id}) · {sym}{price}/月 (≈ ¥{cny})', en: '{flag} {name} ({id}) · {sym}{price}/mo (≈ ¥{cny})' },
      'plan.form.presetLineCny': { 'zh-CN': '{flag} {name} (CNY) · ¥{price}/月', 'zh-TW': '{flag} {name} (CNY) · ¥{price}/月', en: '{flag} {name} (CNY) · ¥{price}/mo' },
      'plan.cycleOpt.monthly': { 'zh-CN': '月付', 'zh-TW': '月付', en: 'Monthly' },
      'plan.cycleOpt.yearly': { 'zh-CN': '年付', 'zh-TW': '年付', en: 'Yearly' },
      'plan.cycleOpt.free': { 'zh-CN': '免费 / 促销赠送', 'zh-TW': '免費 / 促銷贈送', en: 'Free / Promo' },
      'plan.cycleOpt.included': { 'zh-CN': '随套餐包含', 'zh-TW': '隨方案包含', en: 'Included in bundle' },
      'plan.cycleOpt.other': { 'zh-CN': '其他周期', 'zh-TW': '其他週期', en: 'Other cycle' },
      'tokens.heat.prevTitle': { 'zh-CN': '上一个周期', 'zh-TW': '上一個週期', en: 'Previous period' },
      'tokens.heat.nextTitle': { 'zh-CN': '下一个周期', 'zh-TW': '下一個週期', en: 'Next period' },
      'tokens.heat.tabsAria': { 'zh-CN': '热力图时间维度', 'zh-TW': '熱力圖時間維度', en: 'Heatmap time dimension' },
      'tokens.heat.legendTitle': { 'zh-CN': '点击任意档位色块即可单独自定义该档颜色', 'zh-TW': '點擊任意檔位色塊即可單獨自訂該檔顏色', en: 'Click any legend swatch to customize its color' },
      'tokens.heat.lvl0Aria': { 'zh-CN': '热力图第1档颜色', 'zh-TW': '熱力圖第1檔顏色', en: 'Heatmap level 1 color' },
      'tokens.heat.lvl0Swatch': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Heatmap Level 1 (None/Low)' },
      'tokens.heat.lvl1Aria': { 'zh-CN': '热力图第2档颜色', 'zh-TW': '熱力圖第2檔顏色', en: 'Heatmap level 2 color' },
      'tokens.heat.lvl1Swatch': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Heatmap Level 2 (Light)' },
      'tokens.heat.lvl2Aria': { 'zh-CN': '热力图第3档颜色', 'zh-TW': '熱力圖第3檔顏色', en: 'Heatmap level 3 color' },
      'tokens.heat.lvl2Swatch': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Heatmap Level 3 (Medium)' },
      'tokens.heat.lvl3Aria': { 'zh-CN': '热力图第4档颜色', 'zh-TW': '熱力圖第4檔顏色', en: 'Heatmap level 4 color' },
      'tokens.heat.lvl3Swatch': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Heatmap Level 4 (High)' },
      'tokens.heat.lvl4Aria': { 'zh-CN': '热力图第5档颜色', 'zh-TW': '熱力圖第5檔顏色', en: 'Heatmap level 5 color' },
      'tokens.heat.lvl4Swatch': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/峰值用量）', en: 'Heatmap Level 5 (Peak)' },
      'tokens.heat.lowEndAria': { 'zh-CN': '热力图少端颜色', 'zh-TW': '熱力圖少端顏色', en: 'Heatmap low end color' },
      'tokens.heat.lowEndSwatch': { 'zh-CN': '热力图「少」端颜色', 'zh-TW': '熱力圖「少」端顏色', en: 'Heatmap Low Color' },
      'tokens.heat.highEndAria': { 'zh-CN': '热力图多端颜色', 'zh-TW': '熱力圖多端顏色', en: 'Heatmap high end color' },
      'tokens.heat.highEndSwatch': { 'zh-CN': '热力图「多」端颜色', 'zh-TW': '熱力圖「多」端顏色', en: 'Heatmap High Color' },
      'tokens.heat.totalSwatch': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 token 用量', en: 'Total Tokens Color' },
      'tokens.heat.accentSwatch': { 'zh-CN': 'Token 強調色', 'zh-TW': 'Token 強調色', en: 'Token Accent Color' },

      // 其余散落文案
      'drawer.shortExpand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
      'drawer.shortCollapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
      'scan.failPrefix': { 'zh-CN': '读取会话失败：{err}', 'zh-TW': '讀取工作階段失敗：{err}', en: 'Failed to read session: {err}' },
      'scan.notLoadedPrefix': { 'zh-CN': '无法读取全量会话：{err}', 'zh-TW': '無法讀取全量工作階段：{err}', en: 'Failed to scan session: {err}' },
      'mod.proxy.emptyErr': { 'zh-CN': '请输入有效的代理地址', 'zh-TW': '請輸入有效的代理位址', en: 'Enter a valid proxy URL' },
      'mod.proxy.toggleFail': { 'zh-CN': '切换失败', 'zh-TW': '切換失敗', en: 'Toggle failed' },
      'mod.proxy.connOk': { 'zh-CN': '✔ 本地代理正常，Google 连通 ({ms}ms)', 'zh-TW': '✔ 本機代理正常，Google 連通 ({ms}ms)', en: '✔ Proxy healthy, Google reachable ({ms}ms)' },
      'mod.proxy.connFail': { 'zh-CN': '✖ 连通性测试失败：{detail}', 'zh-TW': '✖ 連通性測試失敗：{detail}', en: '✖ Connectivity test failed: {detail}' }
  };

  function t(key, vars = null) {
    const entry = PANEL_I18N[key];
    let text = entry
      ? (entry[currentPanelLanguage] ?? entry['zh-CN'] ?? key)
      : key;
    if (vars && typeof vars === 'object') {
      text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
    }
    return text;
  }

  function applyStaticPanelTranslations(rootNode = shadow) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
    for (const node of rootNode.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (key) node.textContent = t(key);
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-html]')) {
      const key = node.getAttribute('data-i18n-html');
      if (key) node.innerHTML = t(key);
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-title]')) {
      const key = node.getAttribute('data-i18n-title');
      if (key) node.setAttribute('title', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-aria]')) {
      const key = node.getAttribute('data-i18n-aria');
      if (key) node.setAttribute('aria-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-aria-label]')) {
      const key = node.getAttribute('data-i18n-aria-label');
      if (key) node.setAttribute('aria-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-color-label]')) {
      const key = node.getAttribute('data-i18n-color-label');
      if (key) node.setAttribute('data-color-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-placeholder]')) {
      const key = node.getAttribute('data-i18n-placeholder');
      if (key) node.setAttribute('placeholder', t(key));
    }
  }

  const BACKEND_EXACT_TRANSLATIONS = {
    '未知错误': { 'zh-TW': '未知錯誤', en: 'Unknown error' },
    '无效的设置参数': { 'zh-TW': '無效的設定參數', en: 'Invalid settings payload' },
    '宿主暂不支持重启': { 'zh-TW': '宿主暫不支援重新啟動', en: 'Host restart is not supported' },
    '未检测到语言服务二进制文件': { 'zh-TW': '未偵測到語言服務二進位檔案', en: 'Language server binary not found' },
    '未检测到可用的语言服务目标文件': { 'zh-TW': '未偵測到可用的語言服務目標檔案', en: 'No language server binary target found' },
    '原版备份不存在': { 'zh-TW': '原版備份不存在', en: 'Original backup not found' },
    '当前已是原版，无需恢复': { 'zh-TW': '目前已經是原版，無需恢復', en: 'Already using the original binary' },
    '写入失败': { 'zh-TW': '寫入失敗', en: 'Write failed' },
    '未连接到宿主设置桥接': { 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
    '尚未检测到可选模型，请先开启对话或等待列表读取。': { 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list to load.' },
    '本地代理响应异常或目标不可达': { 'zh-TW': '本機代理回應異常或目標不可達', en: 'Local proxy error or target unreachable' },
    '代理状态检查失败': { 'zh-TW': '代理狀態檢查失敗', en: 'Failed to inspect proxy status' },
    '未找到可用的上下文写入模式或目标特征不完整': { 'zh-TW': '未找到可用的上下文寫入模式或目標特徵不完整', en: 'Context patch target signature is incomplete' },
    '当前架构暂不支持上下文补丁': { 'zh-TW': '目前架構暫不支援上下文修補', en: 'Context patching is unsupported on this architecture' },
    '提示词与标题槽位特征不完整': { 'zh-TW': '提示詞與標題槽位特徵不完整', en: 'Prompt/title binary slots not found or incomplete' },
    '后台尚未就绪': { 'zh-TW': '背景服務尚未就緒', en: 'Backend is not ready yet' },
    '读取超时': { 'zh-TW': '讀取逾時', en: 'Request timed out' },
    '完整重启 Antigravity 后启用附件扫描': { 'zh-TW': '完整重新啟動 Antigravity 後啟用附件掃描', en: 'Fully restart Antigravity to enable attachment scanning' },
    '扫描未返回有效结果': { 'zh-TW': '掃描未回傳有效結果', en: 'Scan returned no valid result' }
  };

  function localizeBillingCycleLabel(cycle) {
    if (!cycle) return t('plan.cycleOpt.monthly');
    const c = String(cycle).trim();
    if (c === '月付' || c === '月繳' || c === 'Monthly' || c === 'monthly') return t('plan.cycleOpt.monthly');
    if (c === '年付' || c === '年繳' || c === 'Yearly' || c === 'yearly') return t('plan.cycleOpt.yearly');
    if (c === '免费/赠送' || c === '随套餐赠送/免费' || c === 'Free / Promo' || c === 'free') {
      if (currentPanelLanguage === 'zh-CN') return '免费/赠送';
      if (currentPanelLanguage === 'zh-TW') return '免費/贈送';
      return 'Free / Promo';
    }
    if (c === '随套餐包含' || c === 'Included in bundle') return t('plan.cycleOpt.included');
    if (c === '单次' || c === '單次' || c === 'One-time' || c === 'one_time') return t('plan.cycle.oneTime');
    if (c === '其他周期' || c === 'Other cycle') return t('plan.cycleOpt.other');
    if (c === '未知' || c === 'Unknown') return t('speed.unknown');
    return c;
  }

  function localizeAcquisitionSource(val) {
    if (!val) return t('plan.acq.normal');
    const s = String(val).trim();
    const directKey = `plan.acqOpt.${s}`;
    const directHit = t(directKey);
    if (directHit && directHit !== directKey) return directHit;

    if (s.includes('学生') || s.includes('教育') || s.includes('Student')) return t('plan.acqOpt.student_offer');
    if (s.includes('Pixel')) return t('plan.acqOpt.pixel_bundle');
    if (s.includes('Chromebook')) return t('plan.acqOpt.chromebook_bundle');
    if (s.includes('Samsung') || s.includes('三星')) return t('plan.acqOpt.samsung_galaxy');
    if (s.includes('Jio')) return t('plan.acqOpt.jio_offer');
    if (s.includes('家庭') || s.includes('Family')) return t('plan.acqOpt.family_sharing');
    if (s.includes('促销') || s.includes('试用') || s.includes('Promo') || s.includes('Trial')) return t('plan.acqOpt.official_promo');
    if (s.includes('正常') || s.includes('付费') || s.includes('Standard') || s.includes('Paid')) return t('plan.acq.normal');
    if (s.includes('自定义') || s.includes('Custom')) return t('plan.acqOpt.custom_source');
    return s;
  }

  function localizeCnyFormatted(str) {
    if (!str) return '';
    const s = String(str).trim();
    const cleanVal = s.replace(/^[折合約\s≈()（）]+/, '').replace(/[()（）]/g, '').trim();
    if (!cleanVal) return '';
    return t('plan.cny.approx', { val: cleanVal });
  }

  function localizeUnknownLabel(val) {
    if (val === null || val === undefined || val === '') return t('speed.unknown');
    const s = String(val).trim();
    if (s === '未知' || s === 'Unknown' || s.includes('未在当前会话中获取')) return t('speed.unknown');
    return s;
  }

  function translateBackendText(text) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    if (currentPanelLanguage === 'zh-CN') return str;
    const hit = BACKEND_EXACT_TRANSLATIONS[str.trim()];
    if (hit && hit[currentPanelLanguage]) return hit[currentPanelLanguage];
    return str;
  }

  function formatVendorLabel(vendor) {
    if (!vendor) return currentPanelLanguage === 'en' ? 'Other' : '其他';
    if (vendor === '其他') return currentPanelLanguage === 'en' ? 'Other' : '其他';
    return vendor;
  }
(function (root) {
  'use strict';

  const DEFAULT_MIN_TOKENS = 16384;
  const DEFAULT_MAX_TOKENS = 2097152;
  const STOCK_DEFAULT_CLAMP_TOKENS = 256000;
  const DEFAULT_CONFIRM_TIMEOUT_MS = 45000;

  // 来自宿主 bundle E.Model 的已知静态枚举值（动态 PLACEHOLDER_M* 由 cascadeModelConfigs 解析）
  const STATIC_MODEL_ENUM_MAP = {
    235: 'chat_20706',
    246: 'google_gemini_2_5_pro',
    269: 'chat_23310',
    281: 'claude_4_sonnet',
    282: 'claude_4_sonnet_thinking',
    290: 'claude_4_opus',
    291: 'claude_4_opus_thinking',
    312: 'google_gemini_2_5_flash',
    313: 'google_gemini_2_5_flash_thinking',
    327: 'google_gemini_for_google_2_5_pro',
    328: 'google_gemini_nemosreef',
    329: 'google_gemini_2_5_flash_thinking_tools',
    330: 'google_gemini_2_5_flash_lite',
    331: 'google_gemini_2_5_pro_eval',
    332: 'google_gemini_2_5_flash_image_preview',
    333: 'claude_4_5_sonnet',
    334: 'claude_4_5_sonnet_thinking',
    335: 'google_gemini_computer_use_experimental',
    336: 'google_gemini_horizondawn',
    337: 'google_gemini_pureprism',
    338: 'google_gemini_gentleisland',
    339: 'google_gemini_rainsong',
    340: 'claude_4_5_haiku',
    341: 'claude_4_5_haiku_thinking',
    342: 'openai_gpt_oss_120b_medium',
    343: 'google_gemini_orionfire',
    346: 'google_jarvis_proxy',
    347: 'google_gemini_cosmicforge',
    348: 'google_gemini_riftrunner',
    349: 'google_jarvis_v4s',
    350: 'google_gemini_infinityjet',
    351: 'google_gemini_infinitybloom',
    352: 'google_gemini_riftrunner_thinking_low',
    353: 'google_gemini_riftrunner_thinking_high',
    354: 'google_gemini_example_gemax_sampler'
  };

  /**
   * 规范化 Protobuf 枚举前缀：将 "MODEL_PLACEHOLDER_M37" 与 "PLACEHOLDER_M37" 对齐
   */
  function stripModelEnumPrefix(raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw).trim();
    if (!s) return '';
    return s.replace(/^MODEL_/i, '');
  }

  /**
   * 从通用数值编号转成 E.Model 枚举名（支持 1000+ 为 PLACEHOLDER_M{n-1000}）
   */
  function modelEnumNumberToName(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (STATIC_MODEL_ENUM_MAP[n]) return STATIC_MODEL_ENUM_MAP[n].toUpperCase();
    if (n >= 1000 && n < 2000) return `PLACEHOLDER_M${n - 1000}`;
    return null;
  }

  /**
   * 判断 URL / RPC 方法是否为允许注入上下文预算的目标 RPC
   * 事实核对：StartCascadeRequest 不含 cascade_config，仅 SendUserCascadeMessage 携带
   */
  function isTargetBudgetRpc(urlOrProcedure) {
    if (!urlOrProcedure) return false;
    const s = String(urlOrProcedure);
    if (s.includes('StartCascade')) return false;
    return s.includes('SendUserCascadeMessage');
  }

  // =========================================================================
  // 1. Protobuf Binary Wire 编解码器（零依赖精准读写 SendUserCascadeMessageRequest）
  //    真实 Schema 核验结果：
  //    - SendUserCascadeMessageRequest: 1 = cascade_id (string), 5 = cascade_config (CascadeConfig)
  //    - CascadeConfig: 1 = planner_config (CascadePlannerConfig), 2 = checkpoint_config (CheckpointConfig)
  //    - CascadePlannerConfig: 1 = plan_model (enum), 15 = requested_model (ModelOrAlias: 1=model, 2=alias),
  //                            27 = custom_model_info_override (ModelInfo), 28 = model_name (string)
  //    - CheckpointConfig: 1 = token_threshold, 2 = is_sync, 5 = max_token_limit (uint32),
  //                        11 = max_output_tokens, 36 = context_window (string)
  // =========================================================================

  function readVarint(bytes, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, nextOffset: pos };
      }
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid protobuf varint overflow');
    }
    throw new Error('Truncated protobuf varint');
  }

  function writeVarint(num) {
    let v = typeof num === 'bigint' ? num : BigInt(num);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
  }

  function concatUint8Arrays(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function encodeVarintField(fieldNumber, value) {
    const tag = writeVarint((fieldNumber << 3) | 0);
    const val = writeVarint(value);
    return concatUint8Arrays([tag, val]);
  }

  function encodeLengthDelimitedField(fieldNumber, payloadBytes) {
    const tag = writeVarint((fieldNumber << 3) | 2);
    const len = writeVarint(payloadBytes.length);
    return concatUint8Arrays([tag, len, payloadBytes]);
  }

  /**
   * 严格解析单层 Protobuf 消息字段，保留每个字段的原始完整切片（tag+value）
   */
  function parseProtoFields(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const start = pos;
      const tagInfo = readVarint(bytes, pos);
      pos = tagInfo.nextOffset;
      const tagNum = Number(tagInfo.value);
      const fieldNumber = tagNum >>> 3;
      const wireType = tagNum & 0x07;
      if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`);

      let valueStart = pos;
      let valueEnd = pos;
      let varintValue = null;
      let sliceValue = null;

      if (wireType === 0) {
        const vInfo = readVarint(bytes, pos);
        varintValue = vInfo.value;
        pos = vInfo.nextOffset;
        valueEnd = pos;
      } else if (wireType === 1) {
        if (pos + 8 > bytes.length) throw new Error('Truncated 64-bit field');
        pos += 8;
        valueEnd = pos;
      } else if (wireType === 2) {
        const lenInfo = readVarint(bytes, pos);
        const len = Number(lenInfo.value);
        pos = lenInfo.nextOffset;
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > bytes.length) {
          throw new Error('Truncated length-delimited field');
        }
        valueStart = pos;
        sliceValue = bytes.subarray(pos, pos + len);
        pos += len;
        valueEnd = pos;
      } else if (wireType === 5) {
        if (pos + 4 > bytes.length) throw new Error('Truncated 32-bit field');
        pos += 4;
        valueEnd = pos;
      } else {
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
      }

      fields.push({
        fieldNumber,
        wireType,
        varintValue,
        bytesValue: sliceValue,
        rawField: bytes.subarray(start, valueEnd)
      });
    }
    return fields;
  }

  function decodeUtf8Strict(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /**
   * 从二进制 SendUserCascadeMessageRequest 提取 cascadeId、模型标识与既有 checkpointConfig
   */
  function extractProtoSendMessageMetadata(bytes) {
    const topFields = parseProtoFields(bytes);
    let cascadeId = null;
    let planModelEnum = null;
    let requestedModelEnum = null;
    let modelName = null;
    let customModelOverrideRaw = null;
    let existingMaxTokenLimit = null;
    let existingContextWindow = null;

    for (const f of topFields) {
      if (f.fieldNumber === 1 && f.wireType === 2 && f.bytesValue) {
        try { cascadeId = decodeUtf8Strict(f.bytesValue); } catch {}
      } else if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        const cfgFields = parseProtoFields(f.bytesValue);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.bytesValue) {
            const plannerFields = parseProtoFields(cf.bytesValue);
            for (const pf of plannerFields) {
              if (pf.fieldNumber === 1 && pf.wireType === 0 && pf.varintValue !== null) {
                planModelEnum = Number(pf.varintValue);
              } else if (pf.fieldNumber === 15 && pf.wireType === 2 && pf.bytesValue) {
                const moaFields = parseProtoFields(pf.bytesValue);
                for (const mf of moaFields) {
                  if (mf.fieldNumber === 1 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  } else if (mf.fieldNumber === 2 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  }
                }
              } else if (pf.fieldNumber === 27 && pf.wireType === 2 && pf.bytesValue) {
                try {
                  const overrideFields = parseProtoFields(pf.bytesValue);
                  for (const ofield of overrideFields) {
                    if (ofield.wireType === 2 && ofield.bytesValue) {
                      const s = decodeUtf8Strict(ofield.bytesValue);
                      if (s && !customModelOverrideRaw) customModelOverrideRaw = s;
                    } else if (ofield.fieldNumber === 15 && ofield.wireType === 0 && ofield.varintValue !== null) {
                      if (planModelEnum === null) planModelEnum = Number(ofield.varintValue);
                    }
                  }
                } catch {}
              } else if (pf.fieldNumber === 28 && pf.wireType === 2 && pf.bytesValue) {
                try { modelName = decodeUtf8Strict(pf.bytesValue); } catch {}
              }
            }
          } else if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            const cpFields = parseProtoFields(cf.bytesValue);
            for (const cpf of cpFields) {
              if (cpf.fieldNumber === 5 && cpf.wireType === 0 && cpf.varintValue !== null) {
                existingMaxTokenLimit = Number(cpf.varintValue);
              } else if (cpf.fieldNumber === 36 && cpf.wireType === 2 && cpf.bytesValue) {
                try { existingContextWindow = decodeUtf8Strict(cpf.bytesValue); } catch {}
              }
            }
          }
        }
      }
    }

    return {
      cascadeId,
      planModelEnum,
      requestedModelEnum,
      modelName,
      customModelOverrideRaw,
      existingMaxTokenLimit,
      existingContextWindow
    };
  }

  /**
   * 无损重写二进制 SendUserCascadeMessageRequest 中的 cascade_config(5).checkpoint_config(2).max_token_limit(5)
   * @param {Uint8Array} bytes
   * @param {{ mode: 'fixed'|'dynamic'|'default', limitTokens?: number|null }} action
   */
  function rewriteProtoSendMessageCheckpointLimit(bytes, action) {
    const topFields = parseProtoFields(bytes);
    const isFixed = action?.mode === 'fixed' && Number.isSafeInteger(action?.limitTokens) && action.limitTokens > 0;

    // 重建 CheckpointConfig bytes：保留所有非 field 5 (max_token_limit) 的字段
    const buildCheckpointBytes = (existingCpBytes) => {
      const kept = [];
      if (existingCpBytes) {
        const cpFields = parseProtoFields(existingCpBytes);
        for (const cpf of cpFields) {
          if (cpf.fieldNumber === 5) continue;
          kept.push(cpf.rawField);
        }
      }
      if (isFixed) {
        kept.push(encodeVarintField(5, action.limitTokens));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    // 重建 CascadeConfig bytes：保留所有非 field 2 (checkpoint_config) 的字段
    const buildCascadeConfigBytes = (existingCfgBytes) => {
      const kept = [];
      let mergedCp = null;
      if (existingCfgBytes) {
        const cfgFields = parseProtoFields(existingCfgBytes);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            mergedCp = mergedCp ? concatUint8Arrays([mergedCp, cf.bytesValue]) : cf.bytesValue;
            continue;
          }
          kept.push(cf.rawField);
        }
      }
      const nextCpBytes = buildCheckpointBytes(mergedCp);
      if (nextCpBytes) {
        kept.push(encodeLengthDelimitedField(2, nextCpBytes));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    const outFields = [];
    let mergedCascadeCfg = null;
    for (const f of topFields) {
      if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        mergedCascadeCfg = mergedCascadeCfg ? concatUint8Arrays([mergedCascadeCfg, f.bytesValue]) : f.bytesValue;
        continue;
      }
      outFields.push(f.rawField);
    }

    if (mergedCascadeCfg || isFixed) {
      const nextCfgBytes = buildCascadeConfigBytes(mergedCascadeCfg);
      if (nextCfgBytes) {
        outFields.push(encodeLengthDelimitedField(5, nextCfgBytes));
      }
    }

    return concatUint8Arrays(outFields);
  }

  // =========================================================================
  // 2. 多传输格式解包与回包（JSON / Lcc WebSocket JSON / 5-byte Envelope / Protobuf Binary）
  // =========================================================================

  function toUint8Array(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    return null;
  }

  function looksLikeJsonText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  /**
   * 统一解包外发请求体或 WebSocket 文本帧
   * @param {any} body
   * @param {{ channel?: string, urlOrProcedure?: string, contentType?: string }} [meta]
   */
  function unpackTransportPayload(body, meta = {}) {
    if (!body) return null;
    const channel = meta.channel || 'http';
    const contentType = String(meta.contentType || '').toLowerCase();
    const urlOrProc = String(meta.urlOrProcedure || '');

    if (typeof body === 'string') {
      if (!looksLikeJsonText(body)) return null;
      let parsed = null;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return null;
      }
      // 宿主 Lcc WebSocket JSON 封装：{ streamId, type: "start", procedure, stream, headers, payload }
      if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        return {
          format: 'ws_lcc_json',
          procedure: parsed.procedure,
          envelope: parsed,
          payload: parsed.payload
        };
      }
      return { format: 'json_string', payload: parsed };
    }

    const raw = toUint8Array(body);
    if (!raw || raw.length === 0) return null;

    // 优先判断是否为 5 字节 Connect / gRPC-Web Envelope：[flags(1B), uint32BE length(4B)] + body
    const expectsProtoContentType = contentType.includes('proto') || contentType.includes('grpc');
    if (raw.length >= 5) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const flags = view.getUint8(0);
      const declaredLen = view.getUint32(1, false);
      if (raw.length === 5 + declaredLen || (raw.length > 5 + declaredLen && (flags === 0 || flags === 1 || flags === 2))) {
        if ((flags & 1) !== 0) {
          return { format: 'compressed_unsupported', flags, uninjectableReason: 'unsupported_compressed_frame' };
        }
        const inner = raw.subarray(5, 5 + declaredLen);
        let decodedText = null;
        try {
          decodedText = new TextDecoder('utf-8', { fatal: true }).decode(inner);
        } catch {}
        if (!expectsProtoContentType && decodedText && looksLikeJsonText(decodedText)) {
          try {
            return { format: 'connect_envelope', flags, payload: JSON.parse(decodedText.trim()) };
          } catch {}
        }
        try {
          const protoMeta = extractProtoSendMessageMetadata(inner);
          return { format: 'connect_proto_envelope', flags, rawInner: inner, trailing: raw.subarray(5 + declaredLen), protoMeta };
        } catch {}
      }
    }

    // 尝试纯 UTF-8 JSON 二进制体
    if (!expectsProtoContentType) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (looksLikeJsonText(text)) {
          const parsed = JSON.parse(text.trim());
          if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload) {
            return {
              format: 'ws_lcc_json_binary',
              procedure: parsed.procedure,
              envelope: parsed,
              payload: parsed.payload
            };
          }
          return { format: 'raw_binary_json', payload: parsed };
        }
      } catch {}
    }

    // 尝试原始二进制 Protobuf（仅当 URL/类型表明是目标 Protobuf RPC，避免对任意二进制误解析）
    if (expectsProtoContentType || isTargetBudgetRpc(urlOrProc)) {
      try {
        const protoMeta = extractProtoSendMessageMetadata(raw);
        return { format: 'raw_binary_proto', rawBytes: raw, protoMeta };
      } catch {
        return { format: 'unparseable_binary', uninjectableReason: 'invalid_protobuf_wire' };
      }
    }

    return null;
  }

  function packTransportPayload(unpacked, nextData) {
    if (!unpacked) return null;
    if (unpacked.format === 'json_string') {
      return JSON.stringify(nextData);
    }
    if (unpacked.format === 'ws_lcc_json') {
      return JSON.stringify({ ...unpacked.envelope, payload: nextData });
    }
    if (unpacked.format === 'ws_lcc_json_binary') {
      return new TextEncoder().encode(JSON.stringify({ ...unpacked.envelope, payload: nextData }));
    }
    if (unpacked.format === 'raw_binary_json') {
      return new TextEncoder().encode(JSON.stringify(nextData));
    }
    if (unpacked.format === 'connect_envelope') {
      const bytes = new TextEncoder().encode(JSON.stringify(nextData));
      const out = new Uint8Array(5 + bytes.length);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, bytes.length, false);
      out.set(bytes, 5);
      return out;
    }
    if (unpacked.format === 'connect_proto_envelope' && nextData instanceof Uint8Array) {
      const tailLen = unpacked.trailing ? unpacked.trailing.length : 0;
      const out = new Uint8Array(5 + nextData.length + tailLen);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, nextData.length, false);
      out.set(nextData, 5);
      if (tailLen > 0) out.set(unpacked.trailing, 5 + nextData.length);
      return out;
    }
    if (unpacked.format === 'raw_binary_proto' && nextData instanceof Uint8Array) {
      return nextData;
    }
    return null;
  }

  // =========================================================================
  // 2.5 模型能力参考、当前客户端运行策略解析、可调范围与统一模式逐模型预测
  // =========================================================================

  /**
   * 严格解析底座解锁/运行策略状态，将“磁盘检测模式”与“当前运行态确认状态”彻底分离
   * 绝不将 null / partial / pending_restart / runtime_unconfirmed 当作已运行的 dynamic 或 256K
   */
  function resolveRuntimeUnlockPolicy(unlockStatus) {
    if (!unlockStatus || typeof unlockStatus !== 'object') {
      return {
        policyKnown: false,
        runtimeState: 'unknown',
        diskMode: 'unknown',
        diskLimitTokens: null,
        runtimeMode: 'unknown',
        runtimeLimitTokens: null,
        currentClientLimitTokens: null,
        isDynamicUnlocked: null,
        diskVsRuntimeMismatch: false,
        status: null
      };
    }

    const status = typeof unlockStatus.status === 'string' ? unlockStatus.status : null;
    const gate3a = unlockStatus.gate3a && typeof unlockStatus.gate3a === 'object' ? unlockStatus.gate3a : null;
    const runtimeEvidence = unlockStatus.runtimeEvidence && typeof unlockStatus.runtimeEvidence === 'object'
      ? unlockStatus.runtimeEvidence
      : null;

    // 1. 解析磁盘/配置态策略（读取真实 fixed 固定值，绝不一律退化为 256,000）
    let diskMode = 'unknown';
    let diskLimitTokens = null;
    const rawConfMode = unlockStatus.configuredMode;
    const rawClampState = gate3a?.clampState || null;

    if (rawConfMode === 'dynamic' || (!rawConfMode && rawClampState === 'DYN')) {
      diskMode = 'dynamic';
    } else if (rawConfMode === 'fixed' || (!rawConfMode && rawClampState === 'CONST')) {
      const rawLim = Number(unlockStatus.configuredLimitTokens ?? gate3a?.limit);
      if (Number.isSafeInteger(rawLim) && rawLim > 0) {
        diskMode = 'fixed';
        diskLimitTokens = rawLim;
      } else {
        diskMode = 'unknown';
      }
    } else if (
      rawConfMode === 'default' ||
      (!rawConfMode && rawClampState === 'ORIG') ||
      (!rawConfMode && status === 'not_patched')
    ) {
      diskMode = 'default';
      diskLimitTokens = STOCK_DEFAULT_CLAMP_TOKENS;
    } else if (rawConfMode === 'partial' || status === 'partial_match') {
      diskMode = 'partial';
    }

    // 2. 判定运行态确认级别（磁盘修改后尚未重启、进程未确认、部分匹配、未知均不可直接冒充已运行生效）
    let runtimeState = 'unknown';
    let policyKnown = false;
    let diskVsRuntimeMismatch = false;

    if (status === 'partial_match' || diskMode === 'partial') {
      runtimeState = 'partial';
    } else if (status === 'failed' || status === 'unsupported' || diskMode === 'unknown') {
      runtimeState = 'unknown';
    } else if (status === 'patched_pending_restart' || runtimeEvidence?.restartDetected === false) {
      runtimeState = 'pending_restart';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_runtime_unconfirmed') {
      runtimeState = 'runtime_unconfirmed';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_loaded' || status === 'not_patched' || !status) {
      // 无否定状态且非待重启时，若传入明确策略（patched_loaded / not_patched / 或直接传入策略对象）则认定策略已知
      runtimeState = 'confirmed';
      policyKnown = true;
    }

    const runtimeMode = policyKnown ? diskMode : 'unknown';
    const runtimeLimitTokens = policyKnown ? diskLimitTokens : null;
    const currentClientLimitTokens = policyKnown && (runtimeMode === 'default' || runtimeMode === 'fixed')
      ? runtimeLimitTokens
      : null;
    const isDynamicUnlocked = policyKnown ? (runtimeMode === 'dynamic') : null;

    return {
      policyKnown,
      runtimeState,
      diskMode,
      diskLimitTokens,
      runtimeMode,
      runtimeLimitTokens,
      currentClientLimitTokens,
      isDynamicUnlocked,
      diskVsRuntimeMismatch,
      status
    };
  }

  /**
   * 从产品及其成员（含 GetAvailableModels / Step.metadata.modelInfo）汇总真实能力元数据，
   * 并严格分离：模型理论能力上限、当前客户端限制、当前策略默认预算、当前环境可采纳范围
   * 仅采信结构化字段（maxTokens / maxOutputTokens）；不做型号名字猜测或硬编码
   */
  function deriveModelCapabilitySummary(product, unlockStatus = null, modelCapabilitiesById = null) {
    const members = Array.isArray(product?.members) ? product.members : [];
    const capById = modelCapabilitiesById && typeof modelCapabilitiesById === 'object' ? modelCapabilitiesById : null;

    const findCapForMember = (m) => {
      if (!capById || !m) return null;
      const candidates = [m.modelId, m.modelOrAlias?.model, m.label]
        .filter(Boolean)
        .map(v => stripModelEnumPrefix(v).toLowerCase());
      for (const k of candidates) {
        if (k && capById[k]) return capById[k];
      }
      return null;
    };

    const tierDetails = [];
    for (const m of members) {
      const extCap = findCapForMember(m);
      const maxTokens = Number.isSafeInteger(Number(m?.maxTokens)) && Number(m.maxTokens) > 0
        ? Number(m.maxTokens)
        : (Number.isSafeInteger(Number(extCap?.maxTokens)) && Number(extCap.maxTokens) > 0 ? Number(extCap.maxTokens) : null);
      const rawOut = m?.maxOutputTokens ?? extCap?.maxOutputTokens;
      const maxOutputTokens = rawOut !== null && rawOut !== undefined && Number.isSafeInteger(Number(rawOut)) && Number(rawOut) >= 0
        ? Number(rawOut)
        : null;
      const thinkingBudget = m?.thinkingBudget ?? extCap?.thinkingBudget ?? null;
      const thinkingLevel = m?.thinkingLevel || extCap?.thinkingLevel || null;
      const capabilitySource = m?.capabilitySource || extCap?.capabilitySource || null;
      if (maxTokens !== null || maxOutputTokens !== null || thinkingLevel || thinkingBudget !== null) {
        tierDetails.push({
          modelId: m.modelId || null,
          effort: m.effort || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget,
          thinkingLevel,
          capabilitySource
        });
      }
    }

    const withWindow = tierDetails.filter(t => t.maxTokens !== null);
    const withOutput = tierDetails.filter(t => t.maxOutputTokens !== null);
    const uniqueWindows = Array.from(new Set(withWindow.map(t => t.maxTokens)));
    const uniqueOutputs = Array.from(new Set(withOutput.map(t => t.maxOutputTokens)));

    const maxTokens = uniqueWindows.length > 0 ? Math.min(...uniqueWindows) : null;
    const maxOutputTokens = uniqueOutputs.length > 0 ? Math.max(...uniqueOutputs) : null;
    const hasTierVariance = uniqueWindows.length > 1 || uniqueOutputs.length > 1;
    const sources = Array.from(new Set(tierDetails.map(t => t.capabilitySource).filter(Boolean)));

    const runtimePolicy = resolveRuntimeUnlockPolicy(unlockStatus);
    const isDynamicUnlocked = runtimePolicy.isDynamicUnlocked;
    const currentClientLimitTokens = runtimePolicy.currentClientLimitTokens;

    // 1. 模型理论能力上限与动态基准（仅依据模型结构化元数据，不受客户端状态左右）
    let modelTheoreticalMaxTokens = null;
    let dynamicDefaultBudget = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      const reserve = Math.max(maxOutputTokens, 40000);
      dynamicDefaultBudget = maxTokens > reserve ? (maxTokens - reserve) : 0;
      modelTheoreticalMaxTokens = Math.min(DEFAULT_MAX_TOKENS, maxTokens - maxOutputTokens);
    }

    // 2. 当前策略默认预算（未携带自定义 maxTokenLimit 时的当前运行态默认结果）：
    //    依据二进制核实：
    //    - utils.GetCheckpointConfig 在 default(ORIG) 下按 min(dynamicDefault, 256000) 钳位；
    //    - 在 fixed(CONST=N) 下直接改写为 N，并经 ClampCheckpointConfigForModelInfo 钳位至 <= maxTokens - maxOutputTokens；
    //    - 在 dynamic(DYN) 下采用 dynamicDefault；
    //    - 在未知 / 部分匹配 / 待重启 / 运行未确认状态下必须保持 null（不可猜测或直接套用 983040 / 256000）
    let currentStrategyDefaultBudget = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        currentStrategyDefaultBudget = dynamicDefaultBudget;
      } else if (runtimePolicy.runtimeMode === 'default') {
        currentStrategyDefaultBudget = dynamicDefaultBudget !== null
          ? Math.min(dynamicDefaultBudget, STOCK_DEFAULT_CLAMP_TOKENS)
          : null;
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.runtimeLimitTokens !== null) {
        const fixedVal = Math.min(DEFAULT_MAX_TOKENS, runtimePolicy.runtimeLimitTokens);
        if (modelTheoreticalMaxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, modelTheoreticalMaxTokens);
        } else if (maxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, maxTokens);
        } else {
          currentStrategyDefaultBudget = fixedVal;
        }
      }
    }
    const effectiveDefaultBudget = currentStrategyDefaultBudget;

    // 3. 当前环境下可确认的安全可调上限（与参考卡、最大可用按钮、预设/校验和统一预测一致）：
    //    虽然局部合并链中请求显式 maxTokenLimit 优先级高于默认基座，但未开启 Dynamic 并经实机确认前，
    //    下游覆盖与服务端策略限制仍可能将实际预算束缚于 currentClientLimitTokens
    let maxAdjustableTokens = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        maxAdjustableTokens = modelTheoreticalMaxTokens;
      } else if ((runtimePolicy.runtimeMode === 'default' || runtimePolicy.runtimeMode === 'fixed') && currentClientLimitTokens !== null) {
        const clientCap = Math.min(DEFAULT_MAX_TOKENS, currentClientLimitTokens);
        maxAdjustableTokens = modelTheoreticalMaxTokens !== null
          ? Math.min(modelTheoreticalMaxTokens, clientCap)
          : clientCap;
      }
    }

    let formulaNote = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      formulaNote = '模型理论输入上限 = maxTokens - maxOutputTokens（动态默认按 max(maxOutputTokens, 40,000) 预留）';
    } else if (maxTokens !== null && maxOutputTokens === null) {
      formulaNote = 'IDE 仅返回总窗口但缺少 maxOutputTokens，无法推导模型理论输入上限';
    }

    let policyNote = null;
    if (runtimePolicy.runtimeState === 'pending_restart') {
      policyNote = '磁盘配置已变更但运行中的客户端尚未重启，当前运行策略与可采纳上限待确认';
    } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
      policyNote = '仅检测到磁盘配置，尚未确认运行中进程已加载该策略';
    } else if (runtimePolicy.runtimeState === 'partial') {
      policyNote = '检测到当前环境处于部分异常状态，运行策略上限未知';
    } else if (runtimePolicy.runtimeState === 'unknown') {
      policyNote = '尚未获取或无法确认当前客户端运行策略，默认预算及目标采纳范围标为未知';
    } else if (runtimePolicy.runtimeMode === 'fixed' && currentClientLimitTokens !== null) {
      policyNote = `当前客户端运行于固定限制 ${currentClientLimitTokens.toLocaleString('en-US')} tokens`;
    } else if (runtimePolicy.runtimeMode === 'default') {
      policyNote = '当前客户端运行于默认 256,000 tokens 限制';
    } else if (runtimePolicy.runtimeMode === 'dynamic') {
      policyNote = '当前客户端已开启 Dynamic 动态跟随，按模型自身上限裁剪';
    }

    const rangeMin = maxAdjustableTokens !== null
      ? Math.min(DEFAULT_MIN_TOKENS, maxAdjustableTokens)
      : DEFAULT_MIN_TOKENS;
    const rangeMax = maxAdjustableTokens;

    return {
      productKey: product?.productKey || null,
      productLabel: product?.productLabel || null,
      maxTokens,
      maxOutputTokens,
      modelTheoreticalMaxTokens,
      dynamicDefaultBudget,
      currentClientLimitTokens,
      currentStrategyDefaultBudget,
      effectiveDefaultBudget,
      maxAdjustableTokens,
      rangeMin,
      rangeMax,
      hasMetadata: maxTokens !== null && maxOutputTokens !== null,
      hasPartialMetadata: (maxTokens !== null) !== (maxOutputTokens !== null),
      hasTierVariance,
      tierDetails,
      sources,
      runtimePolicy,
      isDynamicUnlocked,
      formulaNote,
      policyNote
    };
  }

  /**
   * 评估当前输入/预设在对应模型能力与当前客户端运行策略下的合法性及可采纳值
   * 绝不静默篡改用户数值并报成功，也不混淆模型能力上限与客户端策略上限
   */
  function evaluateLimitInput(rawVal, capSummary = null, unlockStatus = null, serviceLimit = null) {
    const rawStr = typeof rawVal === 'number' ? String(rawVal) : String(rawVal ?? '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    if (num < DEFAULT_MIN_TOKENS || num > DEFAULT_MAX_TOKENS) {
      return {
        ok: false,
        reasonCode: 'out_of_engineering_range',
        limitTokens: num,
        min: DEFAULT_MIN_TOKENS,
        max: DEFAULT_MAX_TOKENS
      };
    }

    const warnings = [];
    const policy = arguments.length >= 3
      ? resolveRuntimeUnlockPolicy(unlockStatus)
      : (capSummary?.runtimePolicy || resolveRuntimeUnlockPolicy(null));
    const modelMaxAllowed = capSummary?.modelTheoreticalMaxTokens ?? null;
    const clientLimit = policy.policyKnown ? policy.currentClientLimitTokens : null;

    let exceedsModelLimit = false;
    const modelCapped = modelMaxAllowed !== null ? Math.min(num, modelMaxAllowed) : num;
    if (modelMaxAllowed !== null && num > modelMaxAllowed) {
      exceedsModelLimit = true;
      warnings.push({
        code: 'exceeds_model_limit',
        limitTokens: num,
        maxAllowed: modelMaxAllowed,
        adoptableTokens: policy.policyKnown && clientLimit !== null
          ? Math.min(modelCapped, clientLimit)
          : (policy.policyKnown ? modelCapped : null)
      });
    }

    let exceedsClientPolicy = false;
    let requiresDynamicUnlock = false;
    if (!policy.policyKnown) {
      warnings.push({
        code: 'unconfirmed_runtime_policy',
        limitTokens: num,
        runtimeState: policy.runtimeState,
        diskMode: policy.diskMode,
        diskLimitTokens: policy.diskLimitTokens
      });
    } else if (clientLimit !== null && num > clientLimit) {
      exceedsClientPolicy = true;
      if (policy.runtimeMode === 'default') {
        requiresDynamicUnlock = true;
        warnings.push({
          code: 'requires_dynamic_unlock',
          limitTokens: num,
          stockCap: clientLimit
        });
      } else if (policy.runtimeMode === 'fixed') {
        warnings.push({
          code: 'exceeds_fixed_client_limit',
          limitTokens: num,
          fixedCap: clientLimit
        });
      }
    }

    let adoptableTokens = null;
    if (policy.policyKnown) {
      if (policy.runtimeMode === 'dynamic') {
        adoptableTokens = modelCapped;
      } else if (clientLimit !== null) {
        adoptableTokens = Math.min(modelCapped, clientLimit);
      }
    }

    const sLimit = Number(serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push({
        code: 'exceeds_service_limit',
        limitTokens: num,
        serviceLimit: sLimit
      });
    }

    if (num < 65536) {
      warnings.push({
        code: 'below_recommended_floor',
        limitTokens: num
      });
    }

    return {
      ok: true,
      limitTokens: num,
      exceedsModelLimit,
      exceedsClientPolicy,
      clientPolicyLimit: clientLimit,
      runtimeState: policy.runtimeState,
      policyKnown: policy.policyKnown,
      adoptableTokens,
      requiresDynamicUnlock,
      warnings
    };
  }

  /**
   * 统一预算模式下，为每个模型预测当前运行策略下的可采纳结果
   * 严格区分“预测值”与“运行已确认”，绝不把未知/待重启/default/fixed 错判为 exact
   */
  function projectUnifiedBudgetForProducts(unifiedPref, products = [], unlockStatus = null, modelCapabilitiesById = null) {
    const mode = unifiedPref?.mode || 'default';
    const rawLimit = mode === 'fixed' && Number.isSafeInteger(Number(unifiedPref?.limitTokens))
      ? Number(unifiedPref.limitTokens)
      : null;
    const policy = resolveRuntimeUnlockPolicy(unlockStatus);
    const unresolvedOutcome = policy.runtimeState === 'pending_restart'
      ? 'pending_restart_unconfirmed'
      : (policy.runtimeState === 'partial'
        ? 'partial_policy_unconfirmed'
        : (policy.runtimeState === 'runtime_unconfirmed' ? 'runtime_unconfirmed' : 'unknown_policy'));

    return (Array.isArray(products) ? products : []).map(prod => {
      const cap = deriveModelCapabilitySummary(prod, unlockStatus, modelCapabilitiesById);
      const modelCap = cap.modelTheoreticalMaxTokens;
      const clientCap = policy.policyKnown ? policy.currentClientLimitTokens : null;

      if (mode === 'default') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'client_default',
          projectedTokens: cap.effectiveDefaultBudget
        };
      }

      if (mode === 'dynamic') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        if (policy.runtimeMode === 'default' || policy.runtimeMode === 'fixed') {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            clientLimitTokens: clientCap,
            projectedTokens: cap.effectiveDefaultBudget
          };
        }
        if (cap.dynamicDefaultBudget === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'dynamic_follow',
          projectedTokens: cap.dynamicDefaultBudget
        };
      }

      if (!rawLimit) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'invalid_target',
          projectedTokens: null
        };
      }

      if (!policy.policyKnown) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: unresolvedOutcome,
          targetTokens: rawLimit,
          exceedsModelLimit: modelCap !== null && rawLimit > modelCap,
          projectedTokens: null
        };
      }

      if (policy.runtimeMode === 'dynamic') {
        if (modelCap === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            targetTokens: rawLimit,
            projectedTokens: null
          };
        }
        if (rawLimit > modelCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_to_model_max',
            targetTokens: rawLimit,
            projectedTokens: modelCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exact',
          targetTokens: rawLimit,
          projectedTokens: rawLimit
        };
      }

      // runtimeMode === 'default' (256,000) 或 'fixed' (N)
      if (modelCap !== null && rawLimit > modelCap) {
        if (clientCap !== null && clientCap < modelCap && rawLimit > clientCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            targetTokens: rawLimit,
            clientLimitTokens: clientCap,
            modelTheoreticalMaxTokens: modelCap,
            projectedTokens: clientCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'clamped_to_model_max',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: modelCap
        };
      }

      if (clientCap !== null && rawLimit > clientCap) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exceeds_client_policy',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          modelTheoreticalMaxTokens: modelCap,
          projectedTokens: modelCap !== null ? Math.min(modelCap, clientCap) : clientCap
        };
      }

      if (modelCap === null) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'unknown_cap',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: null
        };
      }

      return {
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        capability: cap,
        outcome: 'exact',
        targetTokens: rawLimit,
        clientLimitTokens: clientCap,
        projectedTokens: rawLimit
      };
    });
  }

  // =========================================================================
  // 3. 请求模型提取（严禁回退至插件配置面板选中项或全局历史快照）
  // =========================================================================

  function matchConfigByCandidate(candidate, knownConfigs) {
    if (!Array.isArray(knownConfigs) || !knownConfigs.length || candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === 'number') {
      const byValue = knownConfigs.find(c => Number(c?.value) === candidate);
      if (byValue) return byValue;
      const enumName = modelEnumNumberToName(candidate);
      if (enumName) {
        return matchConfigByCandidate(enumName, knownConfigs);
      }
      return null;
    }
    const rawStr = String(candidate).trim();
    if (!rawStr) return null;
    const rawLower = rawStr.toLowerCase();
    const strippedLower = stripModelEnumPrefix(rawStr).toLowerCase();
    return knownConfigs.find(c => {
      const fields = [c?.modelId, c?.model, c?.modelOrAlias?.model, c?.modelOrAlias?.alias, c?.modelAlias, c?.label];
      for (const f of fields) {
        if (f === null || f === undefined) continue;
        const fl = String(f).trim().toLowerCase();
        if (!fl) continue;
        if (fl === rawLower || stripModelEnumPrefix(fl) === strippedLower) return true;
      }
      if (/^\d+$/.test(rawStr) && Number(c?.value) === Number(rawStr)) return true;
      return false;
    }) || null;
  }

  function normalizeResolvedCandidate(rawCandidate, knownConfigs, groupFn, resolveStableFn) {
    if (rawCandidate === null || rawCandidate === undefined) return null;
    const matchedCfg = matchConfigByCandidate(rawCandidate, knownConfigs);
    if (matchedCfg) {
      const mId = matchedCfg.modelId || matchedCfg.model || matchedCfg.modelOrAlias?.model || matchedCfg.label;
      const lbl = matchedCfg.label || matchedCfg.modelDisplayName || mId;
      const g = groupFn({ modelId: mId, label: lbl, modelOrAlias: matchedCfg.modelOrAlias, effort: matchedCfg.effort });
      if (g?.productKey) {
        return {
          productKey: g.productKey,
          productLabel: g.productLabel,
          modelId: (resolveStableFn ? resolveStableFn(matchedCfg, knownConfigs) : null) || String(mId || '').toLowerCase(),
          rawCandidate
        };
      }
    }

    let strVal = null;
    if (typeof rawCandidate === 'number') {
      strVal = modelEnumNumberToName(rawCandidate);
    } else if (typeof rawCandidate === 'string') {
      strVal = rawCandidate.trim();
    }
    if (!strVal) return null;

    // 去除 Protobuf enum 前缀并美化可读名称用于分组兜底
    const stripped = stripModelEnumPrefix(strVal);
    if (/^PLACEHOLDER_M\d+$/i.test(stripped)) {
      // 未能在已知目录中找到具体产品名时，按准确占位 ID 分组而不是跨模型猜测
      const g = groupFn({ modelId: stripped.toLowerCase(), label: stripped.toLowerCase() });
      return {
        productKey: g?.productKey || `product:other:${stripped.toLowerCase()}`,
        productLabel: g?.productLabel || stripped.toLowerCase(),
        modelId: stripped.toLowerCase(),
        rawCandidate
      };
    }

    const readable = stripped.includes('_') && stripped === stripped.toUpperCase()
      ? stripped.toLowerCase().replace(/_/g, '-')
      : stripped;
    const g = groupFn({ modelId: readable, label: readable });
    if (!g?.productKey) return null;
    return {
      productKey: g.productKey,
      productLabel: g.productLabel,
      modelId: (resolveStableFn ? resolveStableFn(readable, knownConfigs) : null) || readable.toLowerCase(),
      rawCandidate
    };
  }

  /**
   * 从出站请求对象 / 二进制元数据提取实际模型产品键
   * @param {object} requestOrProtoMeta
   * @param {{
   *   isProtoMeta?: boolean,
   *   knownConfigs?: Array,
   *   verifiedConversationBindings?: Record<string, { productKey: string, modelId?: string }>,
   *   groupProduct?: Function,
   *   resolveStableModelId?: Function
   * }} [options]
   */
  function resolveRequestModel(requestOrProtoMeta, options = {}) {
    if (!requestOrProtoMeta || typeof requestOrProtoMeta !== 'object') {
      return { resolved: false, reason: 'invalid_payload', cascadeId: null };
    }

    const knownConfigs = Array.isArray(options.knownConfigs) ? options.knownConfigs : [];
    const bindings = options.verifiedConversationBindings || {};
    const groupFn = typeof options.groupProduct === 'function'
      ? options.groupProduct
      : (input) => {
        const s = String(input?.label || input?.modelId || 'unknown').trim();
        const low = s.toLowerCase().replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        return { productKey: `product:other:${low || 'unknown'}`, productLabel: s, vendor: '其他', effort: null };
      };
    const resolveStableFn = typeof options.resolveStableModelId === 'function' ? options.resolveStableModelId : null;

    if (options.isProtoMeta) {
      const cascadeId = requestOrProtoMeta.cascadeId || null;
      const candidates = [
        { source: 'customModelInfoOverride', value: requestOrProtoMeta.customModelOverrideRaw },
        { source: 'modelName', value: requestOrProtoMeta.modelName },
        { source: 'requestedModel', value: requestOrProtoMeta.requestedModelEnum },
        { source: 'planModel', value: requestOrProtoMeta.planModelEnum }
      ];
      for (const c of candidates) {
        if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
        const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
        if (norm) return { resolved: true, source: `proto_${c.source}`, cascadeId, ...norm };
      }
      if (cascadeId && bindings[cascadeId]?.productKey) {
        return {
          resolved: true,
          source: 'verified_conversation_binding',
          cascadeId,
          productKey: bindings[cascadeId].productKey,
          productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
          modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
        };
      }
      return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
    }

    const payload = requestOrProtoMeta;
    const cascadeId = payload.cascadeId || payload.cascade_id || null;
    const cfg = payload.cascadeConfig || payload.cascade_config || {};
    const planner = cfg.plannerConfig || cfg.planner_config || payload.plannerConfig || payload.planner_config || {};

    const override = planner.customModelInfoOverride || planner.custom_model_info_override || {};
    const reqModelObj = planner.requestedModel || planner.requested_model || {};
    const candidates = [
      { source: 'customModelInfoOverride', value: override.model || override.modelId || override.label },
      { source: 'modelName', value: planner.modelName || planner.model_name },
      { source: 'requestedModel', value: reqModelObj.model || reqModelObj.alias || (reqModelObj.choice?.case ? reqModelObj.choice.value : null) },
      { source: 'planModel', value: planner.planModel ?? planner.plan_model }
    ];

    for (const c of candidates) {
      if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
      const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
      if (norm) return { resolved: true, source: c.source, cascadeId, ...norm };
    }

    if (cascadeId && bindings[cascadeId]?.productKey) {
      return {
        resolved: true,
        source: 'verified_conversation_binding',
        cascadeId,
        productKey: bindings[cascadeId].productKey,
        productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
        modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
      };
    }

    return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
  }

  // =========================================================================
  // 4. 预算偏好查询与请求篡改（支持对象/JSON/Protobuf、保护 $typeName 与默认清理）
  // =========================================================================

  function findPreferenceForProduct(productKey, contextPreferencesMap) {
    if (!productKey || !contextPreferencesMap || typeof contextPreferencesMap !== 'object') return null;
    if (contextPreferencesMap[productKey]) return contextPreferencesMap[productKey];
    const pSlug = String(productKey).replace(/^product:[^:]+:/, '').toLowerCase();
    for (const [k, pref] of Object.entries(contextPreferencesMap)) {
      if (!pref) continue;
      const kSlug = String(k).replace(/^product:[^:]+:/, '').toLowerCase();
      if (kSlug && kSlug === pSlug) return pref;
    }
    return null;
  }

  function resolveBudgetPolicy(options = {}) {
    const scopeMode = options.scopeMode === 'per_model' ? 'per_model' : 'unified';
    const pref = scopeMode === 'unified'
      ? (options.unifiedPreference || { mode: 'default', limitTokens: null })
      : findPreferenceForProduct(options.productKey, options.contextPreferencesMap);
    if (!pref) {
      return { mode: 'default', limitTokens: null, hasExplicitPref: false };
    }
    const mode = pref.mode === 'fixed' || pref.mode === 'dynamic' ? pref.mode : 'default';
    if (mode === 'fixed') {
      const limit = Number(pref.limitTokens);
      const minTokens = Number(options.minTokens || DEFAULT_MIN_TOKENS);
      const maxTokens = Number(options.maxTokens || DEFAULT_MAX_TOKENS);
      if (Number.isSafeInteger(limit) && limit >= minTokens && limit <= maxTokens) {
        return { mode: 'fixed', limitTokens: limit, hasExplicitPref: true };
      }
      return { mode: 'invalid_fixed', limitTokens: limit, hasExplicitPref: true };
    }
    return { mode, limitTokens: null, hasExplicitPref: true };
  }

  /**
   * 在 JS 请求对象上注入/清理 CheckpointConfig.maxTokenLimit（支持 Snake/Camel 单套与 @bufbuild/protobuf v2 $typeName）
   */
  function applyBudgetPolicyToObject(payload, policy) {
    if (!payload || typeof payload !== 'object' || !policy) {
      return { modified: false, appliedMode: 'passthrough', sentLimitTokens: null };
    }

    const usesProtoBufTypeName = Boolean(
      payload.$typeName
      || payload.cascadeConfig?.$typeName
      || payload.cascadeConfig?.plannerConfig?.$typeName
      || payload.cascadeConfig?.checkpointConfig?.$typeName
    );
    const isSnake = Boolean(payload.cascade_config && !payload.cascadeConfig);

    if (policy.mode === 'fixed' && Number.isSafeInteger(policy.limitTokens)) {
      if (isSnake) {
        payload.cascade_config = payload.cascade_config || {};
        payload.cascade_config.checkpoint_config = payload.cascade_config.checkpoint_config || {};
        payload.cascade_config.checkpoint_config.max_token_limit = policy.limitTokens;
      } else {
        if (!payload.cascadeConfig) {
          payload.cascadeConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CascadeConfig' } : {};
        }
        if (!payload.cascadeConfig.checkpointConfig) {
          payload.cascadeConfig.checkpointConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CheckpointConfig' } : {};
        } else if (usesProtoBufTypeName && !payload.cascadeConfig.checkpointConfig.$typeName) {
          payload.cascadeConfig.checkpointConfig.$typeName = 'exa.cortex_pb.CheckpointConfig';
        }
        payload.cascadeConfig.checkpointConfig.maxTokenLimit = policy.limitTokens;
      }
      return { modified: true, appliedMode: 'fixed', sentLimitTokens: policy.limitTokens };
    }

    // dynamic 或 default：必须清除任何残留固定阈值，绝不保留上一次遗留的 fixed 值
    let cleared = false;
    if (payload.cascadeConfig?.checkpointConfig && payload.cascadeConfig.checkpointConfig.maxTokenLimit !== undefined) {
      delete payload.cascadeConfig.checkpointConfig.maxTokenLimit;
      cleared = true;
    }
    if (payload.cascade_config?.checkpoint_config && payload.cascade_config.checkpoint_config.max_token_limit !== undefined) {
      delete payload.cascade_config.checkpoint_config.max_token_limit;
      cleared = true;
    }
    return {
      modified: cleared,
      appliedMode: policy.mode === 'dynamic' ? 'dynamic' : 'default',
      sentLimitTokens: null
    };
  }

  /**
   * 一体化拦截变换（支持 client_object / HTTP JSON / WebSocket Lcc / Envelope / Protobuf Binary）
   */
  function transformOutgoingSendRequest(input, context = {}) {
    const channel = context.channel || 'http';
    const urlOrProcedure = context.urlOrProcedure || '';

    // 1. 先检查 RPC 通道目标
    if (channel !== 'ws_frame' && urlOrProcedure && !isTargetBudgetRpc(urlOrProcedure)) {
      return { handled: false, passthrough: true, reason: 'non_target_rpc' };
    }

    // 2. 如果是客户端装饰器直传对象
    if (channel === 'client_object') {
      if (!input || typeof input !== 'object') {
        return { handled: false, passthrough: true, reason: 'invalid_client_request' };
      }
      const resolved = resolveRequestModel(input, context);
      const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
      if (!resolved.resolved && scopeMode !== 'unified') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: resolved.reason || 'unidentifiable_request_model',
          cascadeId: resolved.cascadeId || null,
          productKey: null
        };
      }
      const policy = resolveBudgetPolicy({
        scopeMode,
        unifiedPreference: context.unifiedPreference,
        contextPreferencesMap: context.contextPreferencesMap,
        productKey: resolved.productKey,
        minTokens: context.minTokens,
        maxTokens: context.maxTokens
      });
      if (policy.mode === 'invalid_fixed') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: 'invalid_fixed_limit',
          cascadeId: resolved.cascadeId || null,
          productKey: resolved.productKey || null
        };
      }
      const applied = applyBudgetPolicyToObject(input, policy);
      return {
        handled: true,
        passthrough: policy.mode === 'default' && !applied.modified,
        modified: applied.modified,
        uninjectable: false,
        channel,
        cascadeId: resolved.cascadeId || input.cascadeId || input.cascade_id || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: applied.appliedMode,
        sentLimitTokens: applied.sentLimitTokens,
        output: input
      };
    }

    // 3. 传输层帧/请求体（WebSocket / Fetch / XHR）
    const unpacked = unpackTransportPayload(input, { channel, urlOrProcedure, contentType: context.contentType });
    if (!unpacked) {
      return { handled: false, passthrough: true, reason: 'unrecognized_body' };
    }

    // WebSocket Lcc 帧需在解包后检验 procedure
    if (channel === 'ws_frame') {
      if (!unpacked.procedure || !isTargetBudgetRpc(unpacked.procedure)) {
        return { handled: false, passthrough: true, reason: 'non_target_ws_procedure' };
      }
    }

    if (unpacked.uninjectableReason) {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: unpacked.uninjectableReason,
        channel,
        cascadeId: null,
        productKey: null
      };
    }

    const isProto = unpacked.format === 'connect_proto_envelope' || unpacked.format === 'raw_binary_proto';
    const resolved = isProto
      ? resolveRequestModel(unpacked.protoMeta, { ...context, isProtoMeta: true })
      : resolveRequestModel(unpacked.payload, { ...context, isProtoMeta: false });

    const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
    if (!resolved.resolved && scopeMode !== 'unified') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: resolved.reason || 'unidentifiable_request_model',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: null
      };
    }

    const policy = resolveBudgetPolicy({
      scopeMode,
      unifiedPreference: context.unifiedPreference,
      contextPreferencesMap: context.contextPreferencesMap,
      productKey: resolved.productKey,
      minTokens: context.minTokens,
      maxTokens: context.maxTokens
    });
    if (policy.mode === 'invalid_fixed') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: 'invalid_fixed_limit',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || null
      };
    }

    if (isProto) {
      const srcBytes = unpacked.format === 'connect_proto_envelope' ? unpacked.rawInner : unpacked.rawBytes;
      const hadExisting = unpacked.protoMeta?.existingMaxTokenLimit !== null && unpacked.protoMeta?.existingMaxTokenLimit !== undefined;
      let nextProtoBytes = srcBytes;
      let modified = false;
      if (policy.mode === 'fixed') {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: 'fixed', limitTokens: policy.limitTokens });
        modified = true;
      } else if (hadExisting) {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: policy.mode, limitTokens: null });
        modified = true;
      }
      const packed = modified ? packTransportPayload(unpacked, nextProtoBytes) : input;
      return {
        handled: true,
        passthrough: !modified,
        modified,
        uninjectable: false,
        channel,
        format: unpacked.format,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: policy.mode === 'fixed' ? 'fixed' : (policy.mode === 'dynamic' ? 'dynamic' : 'default'),
        sentLimitTokens: policy.mode === 'fixed' ? policy.limitTokens : null,
        output: packed || input
      };
    }

    const applied = applyBudgetPolicyToObject(unpacked.payload, policy);
    const packed = applied.modified ? packTransportPayload(unpacked, unpacked.payload) : input;
    return {
      handled: true,
      passthrough: !applied.modified,
      modified: Boolean(applied.modified && packed),
      uninjectable: false,
      channel,
      format: unpacked.format,
      cascadeId: resolved.cascadeId || unpacked.payload?.cascadeId || unpacked.payload?.cascade_id || null,
      productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
      productLabel: resolved.productLabel || null,
      modelId: resolved.modelId || null,
      modelSource: resolved.source || null,
      scopeMode,
      targetMode: policy.mode,
      targetLimitTokens: policy.limitTokens,
      sentMode: applied.appliedMode,
      sentLimitTokens: applied.sentLimitTokens,
      output: packed || input
    };
  }

  // =========================================================================
  // 5. 发送追踪、因果观测与严格状态机 (杜绝时间戳造假与假确认)
  // =========================================================================

  function makeScopeKey(convoId, productKey) {
    return `${convoId || '__no_conv__'}::${productKey || '__no_product__'}`;
  }

  function createContextBudgetTracker(options = {}) {
    const confirmTimeoutMs = Number(options.confirmTimeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS);
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    let seqCounter = 0;

    // 按 (convoId, productKey) 隔离保存最近发送记录，防止并发会话/快速切换互相覆盖
    const dispatchesByScope = new Map();
    const dispatchesById = new Map();
    // 仅在无活跃会话上下文时辅助查询按产品的最近发送，不跨会话冒用确认
    const dispatchesByProduct = new Map();
    // 按 (convoId, productKey) 隔离保存真实观测快照
    const observationsByScope = new Map();
    // 已验证的会话->模型绑定（仅来自明确请求的响应或该会话真实 metadata）
    const verifiedConversationBindings = Object.create(null);

    function recordConversationBinding(convoId, binding) {
      if (!convoId || !binding?.productKey) return;
      verifiedConversationBindings[convoId] = {
        productKey: binding.productKey,
        productLabel: binding.productLabel || binding.productKey,
        modelId: binding.modelId || binding.productKey,
        updatedAt: nowFn()
      };
    }

    function getBaselineForScope(convoId, productKey) {
      const obs = observationsByScope.get(makeScopeKey(convoId, productKey));
      if (!obs) return { callId: null, stepCount: -1, obsTs: 0 };
      return {
        callId: obs.callId || null,
        stepCount: Number.isFinite(obs.stepCount) ? obs.stepCount : -1,
        obsTs: Number(obs.ts || 0)
      };
    }

    function beginDispatch(info = {}) {
      const seq = ++seqCounter;
      const timestamp = Number(info.timestamp || nowFn());
      const convoId = info.cascadeId || info.convoId || null;
      const productKey = info.productKey || null;
      const dispatchId = `disp_${seq}_${timestamp}`;

      if (convoId && productKey && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: info.productLabel,
          modelId: info.modelId
        });
      }

      const baseline = getBaselineForScope(convoId, productKey);
      // 严禁在诊断追踪中落盘任何用户对话内容或凭证信息，仅保留结构化预算追踪字段
      const sanitizedPrefSnapshot = info.prefSnapshot && typeof info.prefSnapshot === 'object'
        ? {
          mode: info.prefSnapshot.mode || 'default',
          limitTokens: info.prefSnapshot.mode === 'fixed' && Number.isSafeInteger(Number(info.prefSnapshot.limitTokens))
            ? Number(info.prefSnapshot.limitTokens)
            : null
        }
        : {
          mode: info.targetMode || 'default',
          limitTokens: info.targetLimitTokens ?? null
        };
      const record = {
        dispatchId,
        seq,
        cascadeId: convoId,
        convoId,
        productKey,
        modelId: info.modelId || null,
        scopeMode: info.scopeMode || 'per_model',
        prefSnapshot: sanitizedPrefSnapshot,
        targetMode: info.targetMode || 'default',
        targetLimitTokens: info.targetLimitTokens ?? null,
        sentMode: info.sentMode || info.targetMode || 'default',
        sentLimitTokens: info.sentLimitTokens ?? null,
        channel: info.channel || 'http',
        transport: info.channel || 'http',
        status: info.status || 'dispatched',
        errorMessage: info.errorMessage ? String(info.errorMessage).slice(0, 160) : null,
        reason: info.reason || null,
        baselineCallId: baseline.callId,
        baselineStepCount: baseline.stepCount,
        baselineObsTs: baseline.obsTs,
        timestamp
      };

      const sKey = makeScopeKey(convoId, productKey);
      dispatchesByScope.set(sKey, record);
      dispatchesById.set(dispatchId, record);
      if (dispatchesById.size > 200) {
        const oldestKey = dispatchesById.keys().next().value;
        if (oldestKey) dispatchesById.delete(oldestKey);
      }
      if (productKey && productKey !== '__unified__') {
        dispatchesByProduct.set(productKey, record);
      }
      return record;
    }

    function updateDispatchStatus(dispatchId, patch = {}) {
      const rec = dispatchesById.get(dispatchId);
      if (!rec) return null;
      Object.assign(rec, patch);
      return rec;
    }

    /**
     * 记录后端真实观测，绝不在旧快照上用 Date.now() 刷新 ts
     */
    function recordObservation(obsInput = {}) {
      const convoId = obsInput.convoId || obsInput.cascadeId || null;
      const productKey = obsInput.productKey || null;
      if (!productKey) return null;

      const sKey = makeScopeKey(convoId, productKey);
      const prev = observationsByScope.get(sKey);
      const budget = Number(obsInput.budget || 0);
      const serviceLimit = Number(obsInput.serviceLimit || 0);
      const modelHardLimit = Number(obsInput.modelHardLimit || 0);
      const callId = obsInput.callId || null;
      const stepCount = Number.isFinite(Number(obsInput.stepCount)) ? Number(obsInput.stepCount) : -1;
      const explicitTs = Number(obsInput.ts || 0);

      // 判定是否为“新步骤 / 新响应”，而非同一快照反复轮询（绝不因 poll 时间戳增加而推进旧快照 ts）
      const sameCall = callId ? prev?.callId === callId : prev?.callId === null;
      const sameStep = stepCount === prev?.stepCount;
      const downgradedMissingCall = Boolean(
        prev &&
        !callId &&
        prev.callId &&
        (stepCount < 0 || prev.stepCount < 0 || stepCount <= prev.stepCount)
      );
      const isSameSnapshot = Boolean(
        prev &&
        prev.budget === budget &&
        prev.serviceLimit === serviceLimit &&
        prev.modelHardLimit === modelHardLimit &&
        (
          (sameCall && sameStep && (!explicitTs || callId !== null || stepCount >= 0 || explicitTs <= prev.ts)) ||
          downgradedMissingCall
        )
      );

      if (isSameSnapshot) {
        return prev;
      }

      const nextTs = explicitTs > 0 ? explicitTs : nowFn();
      const next = {
        convoId,
        productKey,
        modelId: obsInput.modelId || prev?.modelId || null,
        modelLabel: obsInput.modelLabel || prev?.modelLabel || null,
        effort: obsInput.effort || prev?.effort || null,
        budget,
        serviceLimit,
        modelHardLimit,
        callId,
        stepCount,
        ts: nextTs
      };
      observationsByScope.set(sKey, next);

      if (convoId && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: next.modelLabel,
          modelId: next.modelId
        });
      }
      return next;
    }

    function getScopedObservation(convoId, productKey) {
      if (!productKey) return null;
      if (convoId) {
        return observationsByScope.get(makeScopeKey(convoId, productKey)) || null;
      }
      // 无活跃会话时不臆测，可按最新 matching scope 返回但标注 convoId
      let latest = null;
      for (const obs of observationsByScope.values()) {
        if (obs.productKey === productKey && (!latest || obs.ts > latest.ts)) {
          latest = obs;
        }
      }
      return latest;
    }

    function getScopedDispatch(convoId, productKey, scopeMode = 'per_model') {
      if (convoId) {
        const direct = dispatchesByScope.get(makeScopeKey(convoId, productKey));
        if (direct) return direct;
        if (scopeMode === 'unified') {
          const unifiedRec = dispatchesByScope.get(makeScopeKey(convoId, '__unified__'));
          if (unifiedRec) return unifiedRec;
        }
        return null;
      }
      if (productKey && dispatchesByProduct.has(productKey)) {
        return dispatchesByProduct.get(productKey);
      }
      return null;
    }

    function isPostDispatchObservation(dispatch, obs) {
      if (!dispatch || !obs) return false;
      if (dispatch.convoId && obs.convoId && dispatch.convoId !== obs.convoId) return false;
      if (obs.ts < dispatch.timestamp) return false;
      const changedCall = Boolean(obs.callId && obs.callId !== dispatch.baselineCallId);
      const advancedStep = obs.stepCount >= 0 && obs.stepCount > dispatch.baselineStepCount;
      if (changedCall || advancedStep) return true;
      // 若 callId 与发送前基线完全相同且步骤未增长，说明仍是旧快照（即便 scannedAt/ts 更新也绝非新响应）
      if (obs.callId && dispatch.baselineCallId && obs.callId === dispatch.baselineCallId) {
        return false;
      }
      // 若双方均有明确步数基线且未前进，同样禁止仅靠轮询时间戳伪确认
      if (dispatch.baselineStepCount >= 0 && obs.stepCount >= 0 && obs.stepCount <= dispatch.baselineStepCount) {
        return false;
      }
      return obs.ts > dispatch.baselineObsTs;
    }

    function evaluateStatus(params = {}) {
      const product = params.product || null;
      const scopeMode = params.scopeMode === 'per_model' ? 'per_model' : 'unified';
      const activePref = params.pref || { mode: 'default', limitTokens: null };
      const activeConvId = params.activeConvId || null;
      const now = Number(params.now || nowFn());

      if (!product) {
        return {
          status: 'unconfirmed',
          convoId: activeConvId || '—',
          targetMode: activePref?.mode || 'default',
          targetLimit: activePref?.mode === 'fixed' ? Number(activePref?.limitTokens) : null,
          dispatched: null,
          observation: null,
          diagnosisCode: 'missing_product'
        };
      }

      const targetMode = activePref?.mode || 'default';
      const targetLimit = targetMode === 'fixed' && Number.isSafeInteger(Number(activePref?.limitTokens))
        ? Number(activePref.limitTokens)
        : null;

      const rawDispatched = getScopedDispatch(activeConvId, product.productKey, scopeMode);
      const obs = getScopedObservation(activeConvId || rawDispatched?.convoId || null, product.productKey);
      const obsBudget = Number(obs?.budget || 0);
      const serviceLimit = Number(obs?.serviceLimit || 0);
      const modelHardLimit = Number(params.modelHardLimit || obs?.modelHardLimit || 0);

      // 先校验最近发送记录是否匹配“当前保存的新目标”（含从固定改默认、从失败目标改新值），不匹配则不误报旧结果
      const matchesCurrentTarget = Boolean(
        rawDispatched &&
        rawDispatched.targetMode === targetMode &&
        (targetMode !== 'fixed' || rawDispatched.targetLimitTokens === targetLimit)
      );
      const dispatched = matchesCurrentTarget ? rawDispatched : null;
      const effectiveConvoId = dispatched?.convoId || obs?.convoId || activeConvId || '—';

      if (!dispatched) {
        if (targetMode === 'default') {
          return {
            status: 'default',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit: null,
            dispatched: null,
            observation: obs,
            diagnosisCode: 'default_pending_dispatch'
          };
        }
        return {
          status: 'saved_pending_dispatch',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched: null,
          observation: obs,
          diagnosisCode: 'awaiting_next_send'
        };
      }

      if (dispatched.status === 'send_failed') {
        return {
          status: 'send_failed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_failed',
          errorMessage: dispatched.errorMessage || '请求发送失败'
        };
      }
      if (dispatched.status === 'aborted') {
        return {
          status: 'aborted',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_aborted'
        };
      }
      if (dispatched.status === 'uninjectable') {
        return {
          status: 'uninjectable',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: dispatched.reason || 'uninjectable'
        };
      }

      const hasPostObs = isPostDispatchObservation(dispatched, obs);
      if (!hasPostObs || obsBudget <= 0) {
        if (now - dispatched.timestamp > confirmTimeoutMs) {
          return {
            status: 'timeout_unconfirmed',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit,
            dispatched,
            observation: obs,
            diagnosisCode: 'confirm_timeout'
          };
        }
        return {
          status: 'dispatched_pending_confirm',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'awaiting_backend_obs'
        };
      }

      if (targetMode === 'default') {
        return {
          status: 'default',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'default_confirmed'
        };
      }

      if (targetMode === 'dynamic') {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'dynamic_observed'
        };
      }

      // 精确整数比对，不随便放宽到 ±5% 或 ±64 掩盖差值
      if (obsBudget === targetLimit) {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'exact_match'
        };
      }

      // 仅当存在明确的服务端或 ModelInfo 硬上限证据且目标超出该上限时，才判定为受模型上限限制
      const knownCap = (serviceLimit > 0 ? serviceLimit : 0) || (modelHardLimit > 0 ? modelHardLimit : 0);
      if (knownCap > 0 && targetLimit > knownCap && obsBudget <= knownCap) {
        return {
          status: 'clamped_by_model_limit',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          knownCap,
          dispatched,
          observation: obs,
          diagnosisCode: 'server_or_model_cap'
        };
      }

      return {
        status: 'mismatch',
        convoId: effectiveConvoId,
        targetMode,
        targetLimit,
        dispatched,
        observation: obs,
        diagnosisCode: 'budget_mismatch_unknown_reason'
      };
    }

    function clearConversation(convoId) {
      if (!convoId) return;
      for (const k of Array.from(dispatchesByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) dispatchesByScope.delete(k);
      }
      for (const k of Array.from(observationsByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) observationsByScope.delete(k);
      }
      delete verifiedConversationBindings[convoId];
    }

    function exportAllObservationsByProduct() {
      const out = {};
      for (const obs of observationsByScope.values()) {
        if (!obs.productKey) continue;
        const prev = out[obs.productKey];
        if (!prev || obs.ts > prev.ts) out[obs.productKey] = obs;
      }
      return out;
    }

    function exportDiagnosticTraces() {
      return Array.from(dispatchesById.values()).map(rec => {
        const obs = getScopedObservation(rec.convoId, rec.productKey);
        const postMatched = obs && isPostDispatchObservation(rec, obs);
        return {
          dispatchSeq: rec.seq,
          dispatchId: rec.dispatchId,
          convoId: rec.convoId || null,
          productKey: rec.productKey || null,
          modelId: rec.modelId || null,
          scopeMode: rec.scopeMode,
          prefSnapshot: rec.prefSnapshot || null,
          sentMode: rec.sentMode,
          sentLimitTokens: rec.sentLimitTokens,
          transport: rec.transport || rec.channel || null,
          status: rec.status,
          observedBudget: postMatched ? (obs.budget || null) : null,
          observedAt: postMatched ? (obs.ts || null) : null,
          timestamp: rec.timestamp
        };
      });
    }

    return {
      beginDispatch,
      updateDispatchStatus,
      recordObservation,
      recordConversationBinding,
      getScopedDispatch,
      getScopedObservation,
      evaluateStatus,
      clearConversation,
      exportAllObservationsByProduct,
      exportDiagnosticTraces,
      verifiedConversationBindings
    };
  }

  const api = {
    DEFAULT_MIN_TOKENS,
    DEFAULT_MAX_TOKENS,
    STOCK_DEFAULT_CLAMP_TOKENS,
    DEFAULT_CONFIRM_TIMEOUT_MS,
    STATIC_MODEL_ENUM_MAP,
    stripModelEnumPrefix,
    modelEnumNumberToName,
    isTargetBudgetRpc,
    readVarint,
    writeVarint,
    encodeVarintField,
    encodeLengthDelimitedField,
    parseProtoFields,
    extractProtoSendMessageMetadata,
    rewriteProtoSendMessageCheckpointLimit,
    unpackTransportPayload,
    packTransportPayload,
    resolveRuntimeUnlockPolicy,
    deriveModelCapabilitySummary,
    evaluateLimitInput,
    projectUnifiedBudgetForProducts,
    resolveRequestModel,
    findPreferenceForProduct,
    resolveBudgetPolicy,
    applyBudgetPolicyToObject,
    transformOutgoingSendRequest,
    createContextBudgetTracker
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.__AGContextBudgetEngine = api;
  }
})(globalThis);
  const budgetEngine = globalThis.__AGContextBudgetEngine || {};
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => {
    if (v == null) return '—';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}K`;
    return fmt(v);
  };
  // 悬停信息气泡专用紧凑计数格式（如 37k、475k、1.05M）
  const fmtBubbleToken = v => {
    if (v == null) return t('common.unknown');
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? t('common.notProvided') : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    reportedFinalCallIds: new Set(), reportedFinalCallOutputs: new Map()
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;
  let activeCostModel = 'gemini-3.8-flash';
  let activeCostMode = 'ref';
  let autoCheckUpdate = true;
  let cachedLatestRelease = null;

// =========================================================================
  // 模块 1: 0 级主题跟随、面板与菜单统一背景色、热力图 5 档色阶与自定义颜色选取器
  // =========================================================================
  const COLOR_SLOTS = {
    panelBg: '--ag-custom-panel-bg',
    ringUsed: '--ag-custom-ring-used',
    ringTrack: '--ag-custom-ring-track',
    contextText: '--ag-custom-context-text',
    speedText: '--ag-custom-speed',
    tokenTotal: '--ag-custom-token-total',
    tokenAccent: '--ag-custom-token-accent',
    heatLow: '--ag-custom-heat-low',
    heatHigh: '--ag-custom-heat-high',
    heatLvl0: '--ag-custom-heat-lvl-0',
    heatLvl1: '--ag-custom-heat-lvl-1',
    heatLvl2: '--ag-custom-heat-lvl-2',
    heatLvl3: '--ag-custom-heat-lvl-3',
    heatLvl4: '--ag-custom-heat-lvl-4'
  };
  const COLOR_STORAGE_KEY = 'ag_custom_colors_v1';
  const HEAT_PRESET_STORAGE_KEY = 'ag_heat_preset_v1';
  const customColors = {
    panelBg: '',
    ringUsed: '',
    ringTrack: '',
    contextText: '',
    speedText: '',
    tokenTotal: '',
    tokenAccent: '',
    heatLow: '',
    heatHigh: '',
    heatLvl0: '',
    heatLvl1: '',
    heatLvl2: '',
    heatLvl3: '',
    heatLvl4: ''
  };
  let heatPreset = 'purple';

  const HEAT_PRESETS = {
    purple: {
      dark: ['#27272a', '#3f1e6b', '#652ab7', '#9053f8', '#c084fc'],
      light: ['#e4e4e7', '#e9d5ff', '#c084fc', '#9333ea', '#6b21a8']
    },
    yellow: {
      dark: ['#27272a', '#713f12', '#a16207', '#eab308', '#fde047'],
      light: ['#e4e4e7', '#fef08a', '#facc15', '#ca8a04', '#854d0e']
    },
    green: {
      dark: ['#27272a', '#14532d', '#15803d', '#22c55e', '#86efac'],
      light: ['#e4e4e7', '#bbf7d0', '#4ade80', '#16a34a', '#14532d']
    },
    blue: {
      dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
      light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a']
    },
    red: {
      dark: ['#27272a', '#7f1d1d', '#b91c1c', '#ef4444', '#fca5a5'],
      light: ['#e4e4e7', '#fecaca', '#f87171', '#dc2626', '#7f1d1d']
    }
  };

  try {
    const rawColors = typeof localStorage !== 'undefined' && localStorage.getItem(COLOR_STORAGE_KEY);
    if (rawColors) {
      const parsed = JSON.parse(rawColors);
      for (const k of Object.keys(COLOR_SLOTS)) {
        if (typeof parsed?.[k] === 'string') customColors[k] = parsed[k];
      }
      if (typeof parsed?.heatPreset === 'string' && HEAT_PRESETS[parsed.heatPreset]) {
        heatPreset = parsed.heatPreset;
      }
    }
    const savedPreset = typeof localStorage !== 'undefined' && localStorage.getItem(HEAT_PRESET_STORAGE_KEY);
    if (savedPreset && HEAT_PRESETS[savedPreset]) heatPreset = savedPreset;
  } catch {}

  function saveCustomColors() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify({ ...customColors, heatPreset }));
        localStorage.setItem(HEAT_PRESET_STORAGE_KEY, heatPreset);
      }
    } catch {}
  }

  // 色彩空间转换与格式化工具（HEX <-> RGB <-> HSV <-> HSL）
  function clampNum(n, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  function rgbToHex(r, g, b) {
    const to2 = v => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  }

  function hexToRgb(hexStr) {
    if (!hexStr || typeof hexStr !== 'string') return null;
    const clean = hexStr.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(clean)) return null;
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return null;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hslToRgb(h, s, l) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = clampNum(Number(s), 0, 100) / 100;
    const ln = clampNum(Number(l), 0, 100) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = ln - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function normalizeHex(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    const direct = hexToRgb(s);
    if (direct) return rgbToHex(direct.r, direct.g, direct.b);
    const mRgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (mRgb) return rgbToHex(Number(mRgb[1]), Number(mRgb[2]), Number(mRgb[3]));
    const mHsl = s.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?/i);
    if (mHsl) {
      const rgb = hslToRgb(Number(mHsl[1]), Number(mHsl[2]), Number(mHsl[3]));
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }
    return null;
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) h = ((bn - rn) / d + 2) * 60;
      else h = ((rn - gn) / d + 4) * 60;
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    const v = max * 100;
    return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
  }

  function hsvToRgb(h, s, v) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = clampNum(Number(s), 0, 100) / 100;
    const vn = clampNum(Number(v), 0, 100) / 100;
    const c = vn * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = vn - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) h = ((bn - rn) / d + 2) * 60;
      else h = ((rn - gn) / d + 4) * 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function interpolateHex(hexA, hexB, t) {
    const a = hexToRgb(hexA) || { r: 39, g: 39, b: 42 };
    const b = hexToRgb(hexB) || { r: 192, g: 132, b: 252 };
    const ratio = clampNum(t, 0, 1);
    return rgbToHex(
      a.r + (b.r - a.r) * ratio,
      a.g + (b.g - a.g) * ratio,
      a.b + (b.b - a.b) * ratio
    );
  }

  let currentThemeMode = 'auto';
  try {
    currentThemeMode = (typeof localStorage !== 'undefined' && localStorage.getItem('ag_theme_mode')) || 'auto';
  } catch {}

  function parseRgbLuminance(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const rgb = hexToRgb(normalizeHex(colorStr));
    if (rgb) return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return null;
  }

  function getHostZeroLevelBg(isLight) {
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const rootEl = document.body || document.documentElement;
        if (rootEl) {
          const cs = window.getComputedStyle(rootEl);
          const raw = cs.getPropertyValue('--background')?.trim() || cs.backgroundColor?.trim();
          const norm = normalizeHex(raw);
          if (norm) return norm;
        }
      }
    } catch {}
    return isLight ? '#ffffff' : '#181818';
  }

  function getSystemTheme() {
    try {
      const body = document.body;
      const doc = document.documentElement;
      if (body?.classList?.contains('theme-light') || body?.classList?.contains('light') || doc?.classList?.contains('light') || body?.classList?.contains('vscode-light')) return 'light';
      if (body?.classList?.contains('theme-dark') || body?.classList?.contains('dark') || doc?.classList?.contains('dark') || body?.classList?.contains('vscode-dark')) return 'dark';
      if (doc?.style?.colorScheme === 'light') return 'light';
      if (doc?.style?.colorScheme === 'dark') return 'dark';
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && (body || doc)) {
        const cs = window.getComputedStyle(body || doc);
        const bgVar = cs.getPropertyValue('--background') || cs.backgroundColor;
        const lum = parseRgbLuminance(bgVar);
        if (lum != null) return lum > 0.55 ? 'light' : 'dark';
      }
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      }
    } catch {}
    return 'dark';
  }

  function resolveTheme() {
    if (currentThemeMode === 'light') return 'light';
    if (currentThemeMode === 'dark') return 'dark';
    return getSystemTheme();
  }

  function getPresetHeatmapScale() {
    const isLight = resolveTheme() === 'light';
    const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.purple;
    return (isLight ? presetObj.light : presetObj.dark).slice();
  }

  function getBaseHeatmapScale() {
    const base = getPresetHeatmapScale();
    const lowCustom = normalizeHex(customColors.heatLow);
    const highCustom = normalizeHex(customColors.heatHigh);
    if (lowCustom || highCustom) {
      const c0 = lowCustom || base[0];
      const c4 = highCustom || base[4];
      return [
        c0,
        interpolateHex(c0, c4, 0.25),
        interpolateHex(c0, c4, 0.5),
        interpolateHex(c0, c4, 0.75),
        c4
      ];
    }
    return base;
  }

  function getEffectiveHeatmapScale() {
    const scale = getBaseHeatmapScale();
    for (let i = 0; i < 5; i++) {
      const lvlCustom = normalizeHex(customColors[`heatLvl${i}`]);
      if (lvlCustom) scale[i] = lvlCustom;
    }
    return scale;
  }

  function getDefaultSlotColor(slotKey) {
    const isLight = resolveTheme() === 'light';
    const presetScale = getPresetHeatmapScale();
    const baseScale = getBaseHeatmapScale();
    switch (slotKey) {
      case 'panelBg': return getHostZeroLevelBg(isLight);
      case 'ringUsed': return isLight ? '#18181b' : '#e6e6eb';
      case 'ringTrack': return isLight ? '#b8b8c2' : '#52525b';
      case 'contextText': return isLight ? '#18181b' : '#ececef';
      case 'speedText': return isLight ? '#0284c7' : '#38bdf8';
      case 'tokenTotal': return isLight ? '#7c3aed' : '#c084fc';
      case 'tokenAccent': return isLight ? '#7c3aed' : '#a78bfa';
      case 'heatLow': return presetScale[0];
      case 'heatHigh': return presetScale[4];
      case 'heatLvl0': return baseScale[0];
      case 'heatLvl1': return baseScale[1];
      case 'heatLvl2': return baseScale[2];
      case 'heatLvl3': return baseScale[3];
      case 'heatLvl4': return baseScale[4];
      default: return '#7748cf';
    }
  }

  function getEffectiveSlotColor(slotKey) {
    return normalizeHex(customColors[slotKey]) || getDefaultSlotColor(slotKey);
  }

  function applyHeatmapPalette() {
    const scale = getEffectiveHeatmapScale();
    for (let i = 0; i < 5; i++) {
      host.style.setProperty(`--ag-heat-lvl-${i}`, scale[i]);
      const legEl = el(`heat-leg-${i}`);
      if (legEl) {
        legEl.style.background = scale[i];
        legEl.style.setProperty('--swatch-color', scale[i]);
        legEl.setAttribute('data-custom', String(Boolean(customColors[`heatLvl${i}`])));
      }
    }
    const hasCustomHeat = Boolean(
      customColors.heatLow || customColors.heatHigh ||
      customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4
    );
    try {
      const group = el('heat-preset-group');
      if (group?.querySelectorAll) {
        const btns = group.querySelectorAll('[data-heat-preset]');
        for (const btn of btns) {
          const pName = btn.getAttribute('data-heat-preset');
          btn.setAttribute('data-active', String(!hasCustomHeat && pName === heatPreset));
        }
      }
    } catch {}
  }

  function syncSwatchAndResetButtons() {
    for (const key of Object.keys(COLOR_SLOTS)) {
      const val = customColors[key];
      const eff = getEffectiveSlotColor(key);
      const inputEl = el(`color-${key}`);
      if (inputEl) inputEl.value = eff;
      const swatchEl = el(`swatch-${key}`);
      if (swatchEl) {
        swatchEl.style.setProperty('--swatch-color', eff);
        swatchEl.style.background = eff;
      }
      const resetBtn = el(`reset-${key}`);
      if (resetBtn) {
        resetBtn.setAttribute('data-mode', val ? 'custom' : 'auto');
        if (key.startsWith('heatLvl')) {
          resetBtn.textContent = val ? t('colors.btn.restore') : t('colors.btn.preset');
        } else if (key === 'heatLow' || key === 'heatHigh') {
          resetBtn.textContent = val ? t('colors.btn.restorePreset') : t('colors.btn.preset');
        } else {
          resetBtn.textContent = val ? t('colors.btn.restoreDefault') : t('cp.followTheme');
        }
      }
    }
    const resetHeatLvlsBtn = el('reset-heat-lvls');
    if (resetHeatLvlsBtn) {
      const anyHeatLvl = Boolean(
        customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4 ||
        customColors.heatLow || customColors.heatHigh
      );
      resetHeatLvlsBtn.setAttribute('data-mode', anyHeatLvl ? 'custom' : 'auto');
    }
    // 面板 A 中的镜像色块按钮同步
    const mirrorMap = {
      'swatch-panelBg-tokens': 'panelBg',
      'swatch-tokenTotal-tokens': 'tokenTotal',
      'swatch-tokenAccent-tokens': 'tokenAccent'
    };
    for (const [id, slot] of Object.entries(mirrorMap)) {
      const sw = el(id);
      if (sw) {
        const eff = getEffectiveSlotColor(slot);
        sw.style.setProperty('--swatch-color', eff);
        sw.style.background = eff;
      }
    }
    const resetBgTokens = el('reset-panelBg-tokens');
    if (resetBgTokens) {
      const hasBg = Boolean(customColors.panelBg);
      resetBgTokens.setAttribute('data-mode', hasBg ? 'custom' : 'auto');
      resetBgTokens.textContent = hasBg ? t('colors.btn.restoreDefault') : t('cp.followTheme');
    }
  }

  function applyCustomColors() {
    for (const [key, cssVar] of Object.entries(COLOR_SLOTS)) {
      const val = customColors[key];
      if (val) {
        host.style.setProperty(cssVar, val);
      } else if (host.style.removeProperty) {
        host.style.removeProperty(cssVar);
      } else {
        host.style.setProperty(cssVar, '');
      }
    }
    if (customColors.panelBg) {
      const lum = parseRgbLuminance(customColors.panelBg);
      if (lum != null) {
        host.setAttribute('data-panel-tone', lum > 0.55 ? 'light' : 'dark');
      }
    } else {
      host.removeAttribute('data-panel-tone');
    }
    applyHeatmapPalette();
    syncSwatchAndResetButtons();
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
  }

  function setCustomColor(key, value) {
    if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, key)) return;
    const raw = value ? String(value).trim() : '';
    const norm = raw ? (normalizeHex(raw) || raw) : '';
    customColors[key] = norm;
    if (key === 'heatLow' && norm) customColors.heatLvl0 = '';
    if (key === 'heatHigh' && norm) customColors.heatLvl4 = '';
    saveCustomColors();
    applyCustomColors();
  }

  function setHeatPreset(presetName) {
    if (!HEAT_PRESETS[presetName]) return;
    heatPreset = presetName;
    customColors.heatLow = '';
    customColors.heatHigh = '';
    for (let i = 0; i < 5; i++) {
      customColors[`heatLvl${i}`] = '';
    }
    saveCustomColors();
    applyCustomColors();
  }

  function resetHeatmapLevels() {
    customColors.heatLow = '';
    customColors.heatHigh = '';
    for (let i = 0; i < 5; i++) {
      customColors[`heatLvl${i}`] = '';
    }
    saveCustomColors();
    applyCustomColors();
  }

  function resetCustomColors() {
    for (const key of Object.keys(COLOR_SLOTS)) customColors[key] = '';
    heatPreset = 'purple';
    saveCustomColors();
    applyCustomColors();
  }

  function applyTheme() {
    const activeTheme = resolveTheme();
    host.setAttribute('data-theme', activeTheme);
    const hostBg = getHostZeroLevelBg(activeTheme === 'light');
    host.style.setProperty('--ag-host-bg', hostBg);
    const btns = [el('theme-toggle'), el('theme-toggle-tokens')].filter(Boolean);
    btns.forEach(btn => {
      if (currentThemeMode === 'auto') {
        btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
        btn.title = t('theme.autoTitle', { mode: activeTheme === 'light' ? t('theme.light') : t('theme.dark') });
      } else if (currentThemeMode === 'light') {
        btn.textContent = '☀️';
        btn.title = t('theme.lightTitle');
      } else {
        btn.textContent = '🌙';
        btn.title = t('theme.darkTitle');
      }
    });
    applyHeatmapPalette();
    syncSwatchAndResetButtons();
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
    syncNativeOverlayTheme();
  }

  let lastSyncedOverlayKey = '';
  function syncNativeOverlayTheme() {
    try {
      if (typeof window === 'undefined') return;
      const isLight = resolveTheme() === 'light';
      const rootEl = document.body || document.documentElement;
      const cs = (rootEl && typeof window.getComputedStyle === 'function') ? window.getComputedStyle(rootEl) : null;
      const bg = cs?.getPropertyValue?.('--background')?.trim() || (isLight ? '#FAFAFA' : '#131313');
      const fg = cs?.getPropertyValue?.('--foreground')?.trim() || (isLight ? '#383A42' : '#FAFAFA');
      const overlayKey = `${bg}|${fg}|40`;
      if (overlayKey === lastSyncedOverlayKey) return;
      lastSyncedOverlayKey = overlayKey;
      if (typeof window.contextMeterAPI?.syncOverlay === 'function') {
        void window.contextMeterAPI.syncOverlay({ color: bg, symbolColor: fg, height: 40, heightCssPx: 40 });
      } else if (typeof window.electronNative?.setTitleBarOverlay === 'function') {
        void window.electronNative.setTitleBarOverlay({ color: bg, symbolColor: fg });
      }
    } catch {}
  }

  function cycleTheme() {
    if (currentThemeMode === 'auto') currentThemeMode = 'light';
    else if (currentThemeMode === 'light') currentThemeMode = 'dark';
    else currentThemeMode = 'auto';
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ag_theme_mode', currentThemeMode);
    } catch {}
    applyTheme();
  }

  let themeObserver = null;
  try {
    if (typeof MutationObserver !== 'undefined' && document.body) {
      themeObserver = new MutationObserver(() => {
        if (currentThemeMode === 'auto') applyTheme();
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      }
    }
  } catch {}

  applyTheme();
  applyCustomColors();

  // =========================================================================
  // 自定义「颜色选取器」面板交互逻辑（吸管 + 预设圆点 + SV主色区 + 色相条 + HEX/RGB/HSL）
  // =========================================================================
  let activePickerSlot = null;
  let activePickerAnchor = null;
  let cpHsv = { h: 265, s: 77, v: 72 };

  function syncPickerUiFromHsv(skipInputId = '', exactRgb = null) {
    const rgb = exactRgb || hsvToRgb(cpHsv.h, cpHsv.s, cpHsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

    const svArea = el('cp-sv-area');
    const svThumb = el('cp-sv-thumb');
    const hueThumb = el('cp-hue-thumb');
    const sidePreview = el('cp-side-preview');
    if (svArea) svArea.style.backgroundColor = `hsl(${cpHsv.h}, 100%, 50%)`;
    if (svThumb) {
      svThumb.style.left = `${cpHsv.s}%`;
      svThumb.style.top = `${100 - cpHsv.v}%`;
    }
    if (hueThumb) {
      hueThumb.style.left = `${(cpHsv.h / 360) * 100}%`;
    }
    if (sidePreview) {
      sidePreview.style.background = hex;
    }

    const inHex = el('cp-input-hex');
    const inRgb = el('cp-input-rgb');
    const inHsl = el('cp-input-hsl');
    if (inHex && skipInputId !== 'cp-input-hex') inHex.value = hex;
    if (inRgb && skipInputId !== 'cp-input-rgb') inRgb.value = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    if (inHsl && skipInputId !== 'cp-input-hsl') inHsl.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    return hex;
  }

  function applyPickerHex(hexStr, skipInputId = '') {
    const norm = normalizeHex(hexStr);
    if (!norm) return false;
    const rgb = hexToRgb(norm);
    if (!rgb) return false;
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const appliedHex = syncPickerUiFromHsv(skipInputId, rgb);
    if (activePickerSlot) {
      setCustomColor(activePickerSlot, appliedHex);
    }
    return true;
  }

  let pickerOpVersion = 0;

  function positionColorPickerPopover() {
    const pop = el('color-picker-popover');
    if (!pop || pop.hidden) return;
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const popW = 304;
      const popH = pop.offsetHeight > 0 ? pop.offsetHeight : 340;
      let minLeft = 12;
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right < vw - 320) {
            minLeft = Math.ceil(nr.right + 12);
          }
        }
      }
      let left = Math.round((vw - popW) / 2);
      let top = 90;
      if (activePickerAnchor?.getBoundingClientRect) {
        const ar = activePickerAnchor.getBoundingClientRect();
        if (ar.width > 0 || ar.height > 0) {
          left = Math.round(ar.right - popW);
          top = Math.round(ar.bottom + 6);
          if (top + popH > vh - 12 && ar.top > popH + 12) {
            top = Math.round(ar.top - popH - 6);
          }
        }
      }
      left = Math.max(minLeft, Math.min(vw - popW - 12, left));
      top = Math.max(42, Math.min(vh - popH - 12, top));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    } catch {}
  }

  function openColorPicker(slotKey, anchorEl = null, labelText = '') {
    if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, slotKey)) return;
    const pop = el('color-picker-popover');
    if (!pop) return;

    const op = ++pickerOpVersion;
    activePickerSlot = slotKey;
    activePickerAnchor = anchorEl;

    const lbl = el('cp-target-name');
    if (lbl) lbl.textContent = labelText ? `· ${labelText}` : `· ${slotKey}`;
    const cpResetBtn = el('cp-reset-slot');
    if (cpResetBtn) {
      cpResetBtn.textContent = slotKey.startsWith('heat') ? t('colors.resetLevel') : t('colors.followTheme');
    }
    const startHex = getEffectiveSlotColor(slotKey);
    const rgb = hexToRgb(startHex) || { r: 101, g: 42, b: 183 };
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    syncPickerUiFromHsv();

    pop.setAttribute?.('data-closing', 'false');
    pop.classList?.remove?.('is-closing');
    pop.classList?.add?.('is-opening');
    pop.hidden = false;
    positionColorPickerPopover();

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (pickerOpVersion === op) {
          pop.classList?.remove?.('is-opening');
        }
      });
    } else {
      pop.classList?.remove?.('is-opening');
    }
  }

  function closeColorPicker(immediate = false) {
    const pop = el('color-picker-popover');
    const isMock = !pop?.classList || typeof pop.classList.add !== 'function' || typeof pop.animate !== 'function';
    const isClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (!pop || pop.hidden || isClosing) {
      activePickerSlot = null;
      activePickerAnchor = null;
      return;
    }
    const op = ++pickerOpVersion;
    activePickerSlot = null;
    activePickerAnchor = null;

    const isImmediate = typeof immediate === 'boolean' ? immediate : false;
    if (isImmediate || isMock || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) {
      pop.setAttribute?.('data-closing', 'false');
      pop.classList?.remove?.('is-opening', 'is-closing');
      pop.hidden = true;
      return;
    }

    pop.setAttribute?.('data-closing', 'true');
    pop.classList?.add?.('is-closing');
    setTimeout(() => {
      if (pickerOpVersion === op) {
        pop.setAttribute?.('data-closing', 'false');
        pop.classList?.remove?.('is-opening', 'is-closing');
        pop.hidden = true;
      }
    }, 130);
  }

  const getHeatLvlLabel = (idx) => t(`colors.lvl${idx}`);

  // 绑定所有颜色色块与恢复按钮事件
  for (const key of Object.keys(COLOR_SLOTS)) {
    const inputEl = el(`color-${key}`);
    const resetBtn = el(`reset-${key}`);
    const swatchBtn = el(`swatch-${key}`);
    inputEl?.addEventListener('input', e => setCustomColor(key, e.target?.value || ''));
    inputEl?.addEventListener('change', e => setCustomColor(key, e.target?.value || ''));
    resetBtn?.addEventListener('click', () => {
      setCustomColor(key, '');
      if (activePickerSlot === key) {
        const eff = getEffectiveSlotColor(key);
        const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
        cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        syncPickerUiFromHsv();
      }
    });
    swatchBtn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      openColorPicker(key, swatchBtn, swatchBtn.getAttribute('data-color-label') || key);
    });
  }

  // 热力图右下角「少 ▢▢▢▢▢ 多」5 个小色块图例直接点击弹出颜色选取器单独调色
  for (let i = 0; i < 5; i++) {
    const legBtn = el(`heat-leg-${i}`);
    const slotKey = `heatLvl${i}`;
    legBtn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      toggleTokenColorsDrawer(true);
      const swatchBtn = el(`swatch-${slotKey}`) || legBtn;
      openColorPicker(slotKey, swatchBtn, getHeatLvlLabel(i));
    });
  }
  el('reset-heat-lvls')?.addEventListener('click', () => {
    resetHeatmapLevels();
    if (activePickerSlot?.startsWith('heat')) {
      const eff = getEffectiveSlotColor(activePickerSlot);
      const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
      cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncPickerUiFromHsv();
    }
  });

  // 面板 A 镜像色块与预设按钮事件
  ['swatch-panelBg-tokens', 'swatch-tokenTotal-tokens', 'swatch-tokenAccent-tokens'].forEach(id => {
    const btn = el(id);
    btn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      const slot = btn.getAttribute('data-color-slot');
      if (slot) openColorPicker(slot, btn, btn.getAttribute('data-color-label') || slot);
    });
  });
  el('reset-panelBg-tokens')?.addEventListener('click', () => setCustomColor('panelBg', ''));
  el('reset-all-colors')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });
  el('reset-all-colors-tokens')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });

  try {
    const presetGroup = el('heat-preset-group');
    if (presetGroup?.querySelectorAll) {
      for (const btn of presetGroup.querySelectorAll('[data-heat-preset]')) {
        btn.addEventListener('click', () => {
          const p = btn.getAttribute('data-heat-preset');
          if (p) setHeatPreset(p);
        });
      }
    }
  } catch {}

  // 颜色选取器内部控件绑定（SV 拖拽、Hue 拖拽、预设圆点、吸管、HEX/RGB/HSL 输入与复制）
  el('cp-close')?.addEventListener('click', () => closeColorPicker(false));
  el('cp-reset-slot')?.addEventListener('click', () => {
    if (activePickerSlot) {
      setCustomColor(activePickerSlot, '');
      const eff = getEffectiveSlotColor(activePickerSlot);
      const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
      cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncPickerUiFromHsv();
    }
  });

  try {
    const presetsWrap = el('cp-presets');
    if (presetsWrap?.querySelectorAll) {
      for (const dot of presetsWrap.querySelectorAll('[data-cp-hex]')) {
        dot.addEventListener('click', () => {
          const hex = dot.getAttribute('data-cp-hex');
          if (hex) applyPickerHex(hex);
        });
      }
    }
  } catch {}

  el('cp-eyedropper')?.addEventListener('click', async () => {
    const statusEl = el('cp-status-msg');
    try {
      if (typeof window !== 'undefined' && typeof window.EyeDropper === 'function') {
        const dropper = new window.EyeDropper();
        const res = await dropper.open();
        if (res?.sRGBHex) {
          applyPickerHex(res.sRGBHex);
          if (statusEl) statusEl.textContent = t('colors.eyedropperPicked', { hex: res.sRGBHex.toUpperCase() });
        }
      } else {
        el('cp-input-hex')?.focus?.();
        if (statusEl) statusEl.textContent = t('colors.eyedropperUnsupported');
      }
    } catch {}
  });

  el('cp-input-hex')?.addEventListener('input', e => {
    const raw = e.target?.value || '';
    const norm = normalizeHex(raw);
    if (norm) {
      applyPickerHex(norm, 'cp-input-hex');
      const statusEl = el('cp-status-msg');
      if (statusEl) statusEl.textContent = t('colors.appliedHex', { hex: norm.toUpperCase() });
    }
  });
  el('cp-input-hex')?.addEventListener('change', e => {
    const raw = e.target?.value || '';
    const norm = normalizeHex(raw);
    if (norm) applyPickerHex(norm);
  });

  el('cp-input-rgb')?.addEventListener('input', e => {
    const norm = normalizeHex(e.target?.value || '');
    if (norm) applyPickerHex(norm, 'cp-input-rgb');
  });
  el('cp-input-hsl')?.addEventListener('input', e => {
    const norm = normalizeHex(e.target?.value || '');
    if (norm) applyPickerHex(norm, 'cp-input-hsl');
  });

  function copyPickerText(inputId, label) {
    const input = el(inputId);
    const val = input?.value || '';
    if (!val) return;
    try {
      navigator?.clipboard?.writeText?.(val);
    } catch {}
    const statusEl = el('cp-status-msg');
    if (statusEl) statusEl.textContent = t('colors.copied', { label, val });
  }
  el('cp-copy-hex')?.addEventListener('click', () => copyPickerText('cp-input-hex', 'HEX'));
  el('cp-copy-rgb')?.addEventListener('click', () => copyPickerText('cp-input-rgb', 'RGB'));
  el('cp-copy-hsl')?.addEventListener('click', () => copyPickerText('cp-input-hsl', 'HSL'));

  const svAreaEl = el('cp-sv-area');
  const hueWrapEl = el('cp-hue-wrap');
  let draggingSv = false;
  let draggingHue = false;

  function updateSvFromPointer(e) {
    if (!svAreaEl?.getBoundingClientRect) return;
    const r = svAreaEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = clampNum(((e.clientX - r.left) / r.width) * 100, 0, 100);
    const v = clampNum(100 - ((e.clientY - r.top) / r.height) * 100, 0, 100);
    cpHsv.s = Math.round(s);
    cpHsv.v = Math.round(v);
    const hex = syncPickerUiFromHsv();
    if (activePickerSlot) setCustomColor(activePickerSlot, hex);
  }

  function updateHueFromPointer(e) {
    if (!hueWrapEl?.getBoundingClientRect) return;
    const r = hueWrapEl.getBoundingClientRect();
    if (!r.width) return;
    const h = clampNum(((e.clientX - r.left) / r.width) * 360, 0, 360);
    cpHsv.h = Math.round(h);
    const hex = syncPickerUiFromHsv();
    if (activePickerSlot) setCustomColor(activePickerSlot, hex);
  }

  svAreaEl?.addEventListener('mousedown', e => {
    draggingSv = true;
    updateSvFromPointer(e);
  });
  hueWrapEl?.addEventListener('mousedown', e => {
    draggingHue = true;
    updateHueFromPointer(e);
  });
  const onPointerMove = e => {
    if (draggingSv) updateSvFromPointer(e);
    else if (draggingHue) updateHueFromPointer(e);
  };
  const onPointerUp = () => {
    draggingSv = false;
    draggingHue = false;
  };
  try {
    window.addEventListener?.('mousemove', onPointerMove);
    window.addEventListener?.('mouseup', onPointerUp);
  } catch {}
  // =========================================================================
  // 模块 2: 宿主布局挂载、右上角原生窗口控制区预留、渐进式宽度收缩与悬浮层定位
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;

  function findHostTitlebar() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function isTopRightToolbarCluster(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    const classList = typeof el.classList?.contains === 'function'
      ? el.classList
      : { contains: c => cls.split(/\s+/).includes(c) };
    if (!classList.contains('absolute') || !classList.contains('right-0')) return false;

    const styleTop = el.style?.top || el.getAttribute('style') || '';
    const hasTopClass = classList.contains('top-0');
    const hasTopStyle = /(?:^|;)\s*top:\s*0(?:px)?(?:\s*;|$)/i.test(styleTop);
    const rectTop = el.getBoundingClientRect ? el.getBoundingClientRect().top : 0;
    if (el.getBoundingClientRect && rectTop >= 20) return false;
    const isAtTop = hasTopClass || hasTopStyle || (rectTop <= 10 && rectTop >= 0);
    if (!isAtTop) return false;

    // 排除明显非顶栏容器（右侧全高抽屉、全屏浮层或带有明确非零高度下沉定位的浮层）
    if (classList.contains('bottom-0') || classList.contains('h-screen') || classList.contains('h-full')) {
      return false;
    }

    // 排除右侧滚动条滑槽（特征：包含 top-0.5 / bottom-0.5 / w-3 等滚动条特征）
    if (classList.contains('w-3') || classList.contains('right-0.5')) {
      return false;
    }

    // 必须符合顶栏控制按钮容器特征：
    // a) 包含右侧栏切换按钮
    // b) 或包含 z-50 并具有 flex / items-center 水平布局
    const hasAuxToggle = Boolean(el.querySelector && el.querySelector('[data-testid="toggle-aux-sidebar"]'));
    const hasToolbarLayout = classList.contains('z-50') && (classList.contains('items-center') || classList.contains('flex'));

    return hasAuxToggle || hasToolbarLayout;
  }

  function findTopRightCluster() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      // 1. 优先从右侧栏切换按钮向上寻找最近的顶栏容器
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        // 先尝试带 top-0 的经典结构（Antigravity 1.x）
        let cluster = auxToggle.closest('div.absolute.right-0.top-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
        // 兼容 Antigravity 2.x（top: 0px 写在内联 style，class 无 top-0）
        cluster = auxToggle.closest('div.absolute.right-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
      }

      // 2. 备用安全探测：当 auxToggle 尚未挂载或被动态卸载时，精确匹配顶栏容器
      // 严格检查顶部坐标与容器特征，绝不误伤滚动条、侧栏抽屉或模态弹窗
      const selectors = [
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.top-0.z-50',
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50',
        'div.absolute.right-0.z-50'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isTopRightToolbarCluster(el)) return el;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 动态计算右上角原生窗口控制区（Minimize / Maximize / Close）独占宽度（CSS px）
  function computeWindowControlsWidth(topRight) {
    if (!topRight) return 0;
    try {
      const plat = (typeof navigator !== 'undefined' && navigator.platform) || '';
      if (/^Mac|iPhone|iPad/i.test(plat)) return 0;
      if (topRight?.getBoundingClientRect) {
        const tr = topRight.getBoundingClientRect();
        // 若顶部已单独渲染菜单栏（top >= 20），则 40px 工具栏不在窗口顶边，无需重复留白
        if (tr.height > 0 && tr.top >= 20) return 0;
      }
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      // 优先 1: 标准 WCO 接口 navigator.windowControlsOverlay
      const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
      if (wco?.visible && typeof wco.getTitlebarAreaRect === 'function') {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.width > 0 && vw > 0 && rect.width < vw) {
          return Math.max(0, Math.ceil(vw - rect.right));
        }
      }
      // 优先 2: 根据 Electron titleBarOverlay 几何规格（Windows 3 颗原生控制按钮共 138 OS DIP）与实时缩放比动态换算
      let zoomFactor = 1;
      if (typeof window !== 'undefined') {
        const nativeZoom = window.electronNative?.getZoomLevel?.();
        if (typeof nativeZoom === 'number' && nativeZoom >= 0.25 && nativeZoom <= 5) {
          zoomFactor = nativeZoom;
        } else if (window.outerWidth > 0 && window.innerWidth > 0) {
          const ratio = window.outerWidth / window.innerWidth;
          if (ratio >= 0.25 && ratio <= 5) zoomFactor = ratio;
        }
      }
      const rawCssWidth = Math.ceil(138 / zoomFactor);
      let existingSpacerWidth = 0;
      if (topRight?.querySelectorAll) {
        const spacers = topRight.querySelectorAll('div[aria-hidden="true"]');
        for (const sp of spacers) {
          if (sp.id !== 'ag-wco-spacer' && sp.getBoundingClientRect) {
            existingSpacerWidth += Math.round(sp.getBoundingClientRect().width || parseFloat(sp.style?.width) || 0);
          }
        }
      }
      return Math.max(0, rawCssWidth - existingSpacerWidth);
    } catch {
      return 98;
    }
  }

  function syncWindowControlsOverlay() {
    if (state.disposed) return;
    try {
      const topRight = findTopRightCluster();
      const wcoWidth = computeWindowControlsWidth(topRight);
      const spacer = typeof document.getElementById === 'function' ? document.getElementById('ag-wco-spacer') : null;
      if (topRight && typeof document.createElement === 'function' && wcoWidth > 0) {
        let activeSpacer = spacer;
        if (!activeSpacer || activeSpacer.parentElement !== topRight) {
          activeSpacer?.remove?.();
          activeSpacer = document.createElement('div');
          activeSpacer.id = 'ag-wco-spacer';
          activeSpacer.setAttribute('aria-hidden', 'true');
          topRight.appendChild(activeSpacer);
        }
        const targetCss = `width:${wcoWidth}px;height:100%;flex-shrink:0;pointer-events:none;`;
        if (activeSpacer.style.cssText !== targetCss) {
          activeSpacer.style.cssText = targetCss;
        }
      } else {
        if (spacer) {
          spacer.remove();
        }
        if (topRight?.querySelectorAll) {
          const oldSpacers = topRight.querySelectorAll('#ag-wco-spacer');
          for (const s of oldSpacers) {
            s.remove?.();
          }
        }
      }

      if (typeof document.head !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = typeof document.getElementById === 'function' ? document.getElementById('ag-topbar-host-fix') : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ag-topbar-host-fix';
          document.head.appendChild(styleEl);
        }
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          wcoWidth > 0 ? [
            '[class*="@container/titlebar"],',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child {',
            '  -webkit-app-region: drag;',
            '}',
            '[class*="@container/titlebar"] button,',
            '[class*="@container/titlebar"] a,',
            '[class*="@container/titlebar"] input,',
            '[class*="@container/titlebar"] [role="button"],',
            '[data-testid="pane-titlebar-toolbar"] > *,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] button,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] [data-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child button,',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child a,',
            '#ag-context-meter {',
            '  -webkit-app-region: no-drag;',
            '}'
          ].join('\n') : ''
        ].join('\n');
        if (styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
      }
      syncNativeOverlayTheme();
    } catch {}
  }

  function ensureHostDocked() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      // 自愈保护：若主对话区（div.flex[style*="min-width"]）的 inline flex-grow 被意外清空，立即恢复为 1，绝不覆写其他分栏属性
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch {}

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch {}

      if (host.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {}
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
      updateFixedFallbackPosition();
    }
    updateResponsiveLayout();
  }

  function findNativeTopRightAnchor() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const openIdeBtn = buttons.find(b => {
        const text = (b.textContent || '').trim();
        return (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) && b.getBoundingClientRect?.().top < 50;
      });
      if (openIdeBtn) {
        const parentGroup = openIdeBtn.closest('div.flex.items-center, div.absolute.right-0') || openIdeBtn;
        return parentGroup;
      }
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
      }
      return document.querySelector('div.absolute.right-0.top-0');
    } catch {
      return null;
    }
  }

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      host.style.top = '6px';
      host.style.right = `${rightOffset}px`;
    } catch {}
  }

  // 带迟滞区间（Hysteresis）的四阶段渐进收缩计算，防止临界宽度抖动
  function computeNextLayoutMode(availWidth, currentMode) {
    // 阈值设计：
    // wide <-> compact: 收缩 < 195px, 恢复 >= 210px
    // compact <-> minimal: 收缩 < 135px, 恢复 >= 150px
    // minimal <-> ring-only: 收缩 < 68px, 恢复 >= 82px
    if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
    if (currentMode === 'wide') {
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      if (availWidth < 195) return 'compact';
      return 'wide';
    }
    if (currentMode === 'compact') {
      if (availWidth >= 210) return 'wide';
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      return 'compact';
    }
    if (currentMode === 'minimal') {
      if (availWidth >= 210) return 'wide';
      if (availWidth >= 150) return 'compact';
      if (availWidth < 68) return 'ring-only';
      return 'minimal';
    }
    // currentMode === 'ring-only'
    if (availWidth >= 210) return 'wide';
    if (availWidth >= 150) return 'compact';
    if (availWidth >= 82) return 'minimal';
    return 'ring-only';
  }

  function measureAvailableWidth() {
    try {
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (tbRect.left < 168 ? (168 - tbRect.left) : 12);
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = Math.max(150, titleRealW);
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== host && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) nativeButtonsWidth = sum + 6;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - nativeButtonsWidth;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {}
    return 400;
  }

  function renderSessionCost() {
    const roundCostBar = el('round-cost-bar');
    const roundCostText = el('round-cost-text');
    const sessionCostText = el('session-cost-text');
    if (!roundCostText || !sessionCostText) return;
    const activeCalls = state.sessionCalls || [];
    const latestCall = activeCalls[activeCalls.length - 1];
    const sessTotal = state.sessionCostTotal || 0;
    if (latestCall && latestCall.isPriced) {
      const roundCost = latestCall.costUSD || 0;
      const roundCostStr = roundCost < 0.01 ? '<$0.01' : `≈$${roundCost.toFixed(4)}`;
      const estLabel = latestCall.status === 'streaming' ? t('cost.streamingEst') : t('cost.returnedEst');
      roundCostText.textContent = t('cost.latestTurn', { val: roundCostStr, label: estLabel });
      roundCostText.title = t('cost.modelTip', {
        model: latestCall.model,
        input: fmt(latestCall.inputTokens),
        cache: fmt(latestCall.cacheTokens),
        output: fmt(latestCall.outputTokens),
        cost: roundCost.toFixed(6)
      });
    } else if (latestCall) {
      roundCostText.textContent = t('cost.unpriced');
      roundCostText.title = latestCall.model ? t('cost.unpricedTip', { model: latestCall.model }) : t('cost.missingModel');
    } else {
      roundCostText.textContent = t('cost.latestDash');
      roundCostText.title = '';
    }
    sessionCostText.textContent = sessTotal > 0 ? t('cost.sessionTotal', { val: sessTotal.toFixed(4) }) : t('session.sessionCost.dash');
  }

  function applyLayoutMode(nextMode) {
    if (!nextMode) return;
    const prev = state.layoutMode;
    state.layoutMode = nextMode;
    host.setAttribute('data-layout', nextMode);
    if (prev !== nextMode) {
      if (nextMode !== 'minimal') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
    }
    renderSessionCost();
  }

  function updateResponsiveLayout() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth();
    const nextMode = computeNextLayoutMode(avail, state.layoutMode);
    applyLayoutMode(nextMode);
    if (state.tooltipOpen) positionContextTooltip();
    if (isAnyPanelOpen() || !el('overflow-menu')?.hidden) positionFloatingPanels();
  }

  function scheduleLayoutSync() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        ensureHostDocked();
      });
    } else {
      ensureHostDocked();
    }
  }

  // 定位上下文悬停气泡：空间足够时优先在圆环上方，顶部空间不足时自动翻转至下方，左右防裁切
  function positionContextTooltip() {
    const tip = el('context-tooltip');
    const badge = el('badge');
    if (!tip || !badge || !badge.getBoundingClientRect) return;
    try {
      const bRect = badge.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 190, height: 66 };
      const tipW = tRect.width || 190;
      const tipH = tRect.height || 66;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = Math.max(6, Math.min(vh - tipH - 6, Math.round(top)));

      let left = Math.round(bRect.left + bRect.width / 2 - tipW / 2);
      left = Math.max(8, Math.min(vw - tipW - 8, left));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch {}
  }

  function showContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip || !el('panel')?.hidden) return;
    state.tooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionContextTooltip();
  }

  function hideContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip) return;
    state.tooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  let elevatedStackAncestor = null;

  function syncHostStackingElevation(elevate) {
    try {
      if (elevate) {
        const z0 = host.closest?.('div.relative.z-0');
        if (z0?.style) {
          elevatedStackAncestor = z0;
          z0.style.zIndex = '40';
        }
      } else if (elevatedStackAncestor?.style) {
        elevatedStackAncestor.style.zIndex = '';
        elevatedStackAncestor = null;
      }
    } catch {}
  }

  function getLeftProjectSidebarRight(vw) {
    try {
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 260) {
            return Math.ceil(nr.right);
          }
        }
      }
    } catch {}
    return 0;
  }

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const navRight = getLeftProjectSidebarRight(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;

      const placePanel = (panelEl, targetW, anchorBtn) => {
        if (!panelEl) return;
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const top = Math.max(36, Math.min(vh - 120, Math.round((bRect.bottom || hRect.bottom) + 6)));
        const isCompact = panelEl.classList?.contains?.('cost-compact-view') || panelEl.getAttribute?.('class')?.includes?.('cost-compact-view');
        const effW = isCompact ? 400 : targetW;
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(effW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，确保任何视口宽度下右边缘绝不溢出
        let left = Math.round(bRect.right - finalW);
        left = Math.min(left, vw - finalW - 12);
        left = Math.max(minLeft, left);

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${Math.max(260, vw - left - 12)}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      placePanel(el('panel'), 472, el('badge'));
      placePanel(el('panel-tokens'), 730, el('badge-tokens'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
      positionColorPickerPopover();
    } catch {}
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (!host.isConnected || host.getAttribute('data-dock') !== 'flow' || !findHostTitlebar()?.contains?.(host)) {
          scheduleLayoutSync();
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {}

  const onWindowResize = () => updateResponsiveLayout();
  const onWindowFocus = () => host.setAttribute('data-window-active', 'true');
  const onWindowBlur = () => host.setAttribute('data-window-active', 'false');
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
  } catch {}

  ensureHostDocked();

  // =========================================================================
  // 模块 3: 面板、气泡与溢出菜单交互
  // =========================================================================
  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } }, {
      currentModel: value?.model || state.latest?.model || '',
      cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      previousValidContext: value
    });
    return {
      ...(value || {}),
      error: failure.error,
      errorClassification: failure.errorClassification,
      exceeded: failure.exceeded,
      network: failure.network,
      serviceLimit: failure.serviceLimit || value?.serviceLimit || null,
      status: failure.status,
      // 解耦：保留已有有效上下文数据，不归零、不清空
      used: value?.used ?? failure?.used ?? null,
      actual: failure.exceeded ? null : (value?.actual ?? null),
      estimate: value?.estimate ?? failure?.estimate ?? null,
      budget: value?.budget ?? failure?.budget ?? null,
      percent: failure.exceeded ? 100 : (value?.percent ?? null),
      estimated: value?.actual == null
    };
  }

  function isAnyPanelOpen() {
    return !el('panel').hidden || !el('panel-tokens').hidden;
  }

  function showPanel(target) {
    const pContext = el('panel');
    const pTokens = el('panel-tokens');
    const pOverflow = el('overflow-menu');
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bTokens = el('badge-tokens');
    const bOverflow = el('badge-overflow');

    hideUpdatePopover();
    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');

    if (target === 'tokens') {
      hideContextTooltip();
      closeColorPicker();
      pContext.hidden = true;
      pTokens.hidden = false;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      void syncTokenHistoryFromHost(false);
      renderActiveHeatView(true);
    } else if (target === 'context') {
      hideContextTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pTokens.hidden = true;
      pContext.hidden = false;
      bContext.setAttribute('aria-expanded', 'true');
      bSpeed?.setAttribute('aria-expanded', 'true');
      bTokens.setAttribute('aria-expanded', 'false');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      applyContextViewVisibility?.();
      if (activeContextTab === 'models' && !isContextSettingsView) {
        void refreshUnlockStatus();
      } else if (activeContextTab === 'speed' && !isContextSettingsView) {
        renderSpeedComparisonTab?.();
      }
      if (isContextSettingsView) {
        void refreshModulesDisplay();
      }
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      closeColorPicker();
      hidePopover();
      syncHostStackingElevation(false);
    }
  }

  function toggle(open, tab = 'context') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'tokens' ? 'tokens' : 'context');
    }
  }

  function toggleContext() {
    if (!el('panel').hidden) showPanel('none');
    else showPanel('context');
  }

  function toggleTokens() {
    if (!el('panel-tokens').hidden) showPanel('none');
    else showPanel('tokens');
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    hideContextTooltip();
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
    if (willOpen) positionFloatingPanels();
  }

  // 外观调色按钮进入设置视图并直接展开颜色自定义抽屉
  el('btn-panel-palette')?.addEventListener('click', () => {
    openContextSettings?.({ openColors: true });
  });
  el('btn-panel-tokens-palette')?.addEventListener('click', () => toggleTokenColorsDrawer());

  // =========================================================================
  // 统一定制下拉组件控制器 (国家 / 订阅地区 / 币种 / 增强 Select)
  // =========================================================================
  const COUNTRY_OPTIONS = [
    { value: '未知', label: '🌐 未设置 / 自动', labelTw: '🌐 未設定 / 自動', labelEn: '🌐 Auto / Unset', code: 'AUTO', aliases: ['自动', '未知', 'none', 'auto'] },
    { value: '美国 (US)', label: '🇺🇸 美国 (US)', labelTw: '🇺🇸 美國 (US)', labelEn: '🇺🇸 United States (US)', code: 'US', aliases: ['美国', 'united states', 'usa'] },
    { value: '日本 (JP)', label: '🇯🇵 日本 (JP)', labelTw: '🇯🇵 日本 (JP)', labelEn: '🇯🇵 Japan (JP)', code: 'JP', aliases: ['日本', 'japan'] },
    { value: '韩国 (KR)', label: '🇰🇷 韩国 (KR)', labelTw: '🇰🇷 韓國 (KR)', labelEn: '🇰🇷 South Korea (KR)', code: 'KR', aliases: ['韩国', 'korea', 'south korea'] },
    { value: '中国台湾 (TW)', label: '🇹🇼 中国台湾 (TW)', labelTw: '🇹🇼 中國台灣 (TW)', labelEn: '🇹🇼 Taiwan (TW)', code: 'TW', aliases: ['台湾', 'taiwan', 'tw'] },
    { value: '中国香港 (HK)', label: '🇭🇰 中国香港 (HK)', labelTw: '🇭🇰 中國香港 (HK)', labelEn: '🇭🇰 Hong Kong (HK)', code: 'HK', aliases: ['香港', 'hong kong', 'hk'] },
    { value: '澳大利亚 (AU)', label: '🇦🇺 澳大利亚 (AU)', labelTw: '🇦🇺 澳洲 (AU)', labelEn: '🇦🇺 Australia (AU)', code: 'AU', aliases: ['澳大利亚', '澳洲', 'australia', 'au'] },
    { value: '新加坡 (SG)', label: '🇸🇬 新加坡 (SG)', labelTw: '🇸🇬 新加坡 (SG)', labelEn: '🇸🇬 Singapore (SG)', code: 'SG', aliases: ['新加坡', 'singapore', 'sg'] },
    { value: '英国 (UK)', label: '🇬🇧 英国 (UK)', labelTw: '🇬🇧 英國 (UK)', labelEn: '🇬🇧 United Kingdom (UK)', code: 'UK', aliases: ['英国', 'united kingdom', 'uk', 'gb', 'britain'] },
    { value: '德国 (DE)', label: '🇩🇪 德国 (DE)', labelTw: '🇩🇪 德國 (DE)', labelEn: '🇩🇪 Germany (DE)', code: 'DE', aliases: ['德国', 'germany', 'de'] },
    { value: '加拿大 (CA)', label: '🇨🇦 加拿大 (CA)', labelTw: '🇨🇦 加拿大 (CA)', labelEn: '🇨🇦 Canada (CA)', code: 'CA', aliases: ['加拿大', 'canada', 'ca'] },
    { value: '土耳其 (TR)', label: '🇹🇷 土耳其 (TR)', labelTw: '🇹🇷 土耳其 (TR)', labelEn: '🇹🇷 Turkey (TR)', code: 'TR', aliases: ['土耳其', 'turkey', 'tr'] },
    { value: '尼日利亚 (NG)', label: '🇳🇬 尼日利亚 (NG)', labelTw: '🇳🇬 奈及利亞 (NG)', labelEn: '🇳🇬 Nigeria (NG)', code: 'NG', aliases: ['尼日利亚', 'nigeria', 'ng'] },
    { value: '菲律宾 (PH)', label: '🇵🇭 菲律宾 (PH)', labelTw: '🇵🇭 菲律賓 (PH)', labelEn: '🇵🇭 Philippines (PH)', code: 'PH', aliases: ['菲律宾', 'philippines', 'ph'] },
    { value: '印度 (IN)', label: '🇮🇳 印度 (IN)', labelTw: '🇮🇳 印度 (IN)', labelEn: '🇮🇳 India (IN)', code: 'IN', aliases: ['印度', 'india', 'in'] },
    { value: '马来西亚 (MY)', label: '🇲🇾 马来西亚 (MY)', labelTw: '🇲🇾 馬來西亞 (MY)', labelEn: '🇲🇾 Malaysia (MY)', code: 'MY', aliases: ['马来西亚', 'malaysia', 'my'] },
    { value: '巴西 (BR)', label: '🇧🇷 巴西 (BR)', labelTw: '🇧🇷 巴西 (BR)', labelEn: '🇧🇷 Brazil (BR)', code: 'BR', aliases: ['巴西', 'brazil', 'br'] },
    { value: '中国大陆 (CN)', label: '🇨🇳 中国大陆 (CN)', labelTw: '🇨🇳 中國大陸 (CN)', labelEn: '🇨🇳 China Mainland (CN)', code: 'CN', aliases: ['中国大陆', '中国', 'china', 'cn'] }
  ];

  const CURRENCY_OPTIONS = [
    { value: 'USD', code: 'USD', symbol: '$', name: '美元', nameEn: 'US Dollar', label: 'USD ($ 美元)', labelTw: 'USD ($ 美元)', labelEn: 'USD ($ US Dollar)', aliases: ['美元', 'usd', '$', 'dollar'] },
    { value: 'KRW', code: 'KRW', symbol: '₩', name: '韩元', nameEn: 'Korean Won', label: 'KRW (₩ 韩元)', labelTw: 'KRW (₩ 韓元)', labelEn: 'KRW (₩ Won)', aliases: ['韩元', 'krw', '₩', 'won'] },
    { value: 'AUD', code: 'AUD', symbol: 'AU$', name: '澳元', nameEn: 'Australian Dollar', label: 'AUD (AU$ 澳元)', labelTw: 'AUD (AU$ 澳元)', labelEn: 'AUD (AU$ AUD)', aliases: ['澳元', '澳洲', 'aud', 'au$', 'australian'] },
    { value: 'JPY', code: 'JPY', symbol: '¥', name: '日元', nameEn: 'Japanese Yen', label: 'JPY (¥ 日元)', labelTw: 'JPY (¥ 日圓)', labelEn: 'JPY (¥ Yen)', aliases: ['日元', '日本', 'jpy', '¥', 'yen'] },
    { value: 'HKD', code: 'HKD', symbol: 'HK$', name: '港币', nameEn: 'Hong Kong Dollar', label: 'HKD (HK$ 港币)', labelTw: 'HKD (HK$ 港幣)', labelEn: 'HKD (HK$ HKD)', aliases: ['港币', '香港', 'hkd', 'hk$'] },
    { value: 'TWD', code: 'TWD', symbol: 'NT$', name: '台币', nameEn: 'New Taiwan Dollar', label: 'TWD (NT$ 台币)', labelTw: 'TWD (NT$ 新台幣)', labelEn: 'TWD (NT$ TWD)', aliases: ['台币', '台湾', 'twd', 'ntd', 'nt$'] },
    { value: 'TRY', code: 'TRY', symbol: '₺', name: '里拉', nameEn: 'Turkish Lira', label: 'TRY (₺ 里拉)', labelTw: 'TRY (₺ 里拉)', labelEn: 'TRY (₺ Lira)', aliases: ['里拉', '土耳其', 'try', '₺', 'lira'] },
    { value: 'NGN', code: 'NGN', symbol: '₦', name: '奈拉', nameEn: 'Nigerian Naira', label: 'NGN (₦ 奈拉)', labelTw: 'NGN (₦ 奈拉)', labelEn: 'NGN (₦ Naira)', aliases: ['奈拉', '尼日利亚', 'ngn', '₦', 'naira'] },
    { value: 'CNY', code: 'CNY', symbol: '¥', name: '人民币', nameEn: 'Chinese Yuan', label: 'CNY (¥ 人民币)', labelTw: 'CNY (¥ 人民幣)', labelEn: 'CNY (¥ CNY)', aliases: ['人民币', '中国', 'cny', 'rmb', '¥', 'yuan'] },
    { value: 'EUR', code: 'EUR', symbol: '€', name: '欧元', nameEn: 'Euro', label: 'EUR (€ 欧元)', labelTw: 'EUR (€ 歐元)', labelEn: 'EUR (€ Euro)', aliases: ['欧元', '欧洲', 'eur', '€', 'euro'] },
    { value: 'GBP', code: 'GBP', symbol: '£', name: '英镑', nameEn: 'British Pound', label: 'GBP (£ 英镑)', labelTw: 'GBP (£ 英鎊)', labelEn: 'GBP (£ Pound)', aliases: ['英镑', '英国', 'gbp', '£', 'pound'] },
    { value: 'SGD', code: 'SGD', symbol: 'S$', name: '新元', nameEn: 'Singapore Dollar', label: 'SGD (S$ 新元)', labelTw: 'SGD (S$ 新幣)', labelEn: 'SGD (S$ SGD)', aliases: ['新元', '新加坡', 'sgd', 's$'] },
    { value: 'CAD', code: 'CAD', symbol: 'CA$', name: '加元', nameEn: 'Canadian Dollar', label: 'CAD (CA$ 加元)', labelTw: 'CAD (CA$ 加幣)', labelEn: 'CAD (CA$ CAD)', aliases: ['加元', '加拿大', 'cad', 'ca$'] },
    { value: 'PHP', code: 'PHP', symbol: '₱', name: '比索', nameEn: 'Philippine Peso', label: 'PHP (₱ 比索)', labelTw: 'PHP (₱ 披索)', labelEn: 'PHP (₱ Peso)', aliases: ['比索', '菲律宾', 'php', '₱', 'peso'] },
    { value: 'INR', code: 'INR', symbol: '₹', name: '卢比', nameEn: 'Indian Rupee', label: 'INR (₹ 卢比)', labelTw: 'INR (₹ 盧比)', labelEn: 'INR (₹ Rupee)', aliases: ['卢比', '印度', 'inr', '₹', 'rupee'] },
    { value: 'MYR', code: 'MYR', symbol: 'RM', name: '令吉', nameEn: 'Malaysian Ringgit', label: 'MYR (RM 令吉)', labelTw: 'MYR (RM 令吉)', labelEn: 'MYR (RM Ringgit)', aliases: ['令吉', '马来西亚', 'myr', 'rm', 'ringgit'] },
    { value: 'BRL', code: 'BRL', symbol: 'R$', name: '雷亚尔', nameEn: 'Brazilian Real', label: 'BRL (R$ 雷亚尔)', labelTw: 'BRL (R$ 雷亞爾)', labelEn: 'BRL (R$ Real)', aliases: ['雷亚尔', '巴西', 'brl', 'r$', 'real'] }
  ];

  function refreshRegionPresetSelectOptions() {
    const sel = el('select-custom-region-preset');
    if (!sel || !sel.options) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      if (!opt || opt.value === '' || opt.value === 'custom') continue;
      const p = presets.find(item => item.id === opt.value);
      if (!p) continue;
      const dispName = getPanelLanguage() === 'en' ? (p.nameEn || p.id || p.name) : p.name;
      if (p.currency === 'CNY') {
        opt.textContent = t('plan.form.presetLineCny', { flag: p.flag || '🌏', name: dispName, price: p.monthlyPrice });
      } else {
        const cny = core?.convertToCNY ? core.convertToCNY(p.monthlyPrice, p.currency, p.name) : (p.monthlyPrice * p.rateToCNY);
        opt.textContent = t('plan.form.presetLine', {
          flag: p.flag || '🌏',
          name: dispName,
          id: p.id,
          sym: p.symbol,
          price: p.monthlyPrice,
          cny: Number(cny).toFixed(1)
        });
      }
    }
  }

  function hasClass(node, cls) {
    if (!node) return false;
    if (node.classList?.contains) return node.classList.contains(cls);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  function addClass(node, cls) {
    if (!node) return;
    if (node.classList?.add) { node.classList.add(cls); return; }
    const cur = String(node.className || '').trim();
    if (!cur.split(/\s+/).includes(cls)) node.className = cur ? `${cur} ${cls}` : cls;
  }
  function removeClass(node, cls) {
    if (!node) return;
    if (node.classList?.remove) { node.classList.remove(cls); return; }
    const parts = String(node.className || '').split(/\s+/).filter(c => c !== cls);
    node.className = parts.join(' ');
  }

  // 纯同步 UI 控件回填防护守卫（仅在纯同步赋值代码块内开启，严禁跨越 await）
  let isHydratingUiControls = false;
  function runWithUiHydration(fn) {
    const prev = isHydratingUiControls;
    isHydratingUiControls = true;
    try {
      return fn();
    } finally {
      isHydratingUiControls = prev;
    }
  }

  // 兼容老调用声明
  let isRestoringSettings = false;

  // 异步时序保护：用户主动修改序列号与恢复请求版本号
  let userActionSeq = 0;
  let restoreRequestSeq = 0;

function closeAllDropdowns(exceptWrap = null) {
    const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : (typeof document !== 'undefined' ? document : null);
    try {
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => {
        if (w !== exceptWrap) removeClass(w, 'is-open');
      });
    } catch {}
  }

  function initDropdownController(cfg) {
    const wrap = el(cfg.wrapId);
    const trigger = el(cfg.triggerId);
    const label = el(cfg.labelId);
    const menu = el(cfg.menuId);
    const linkedSelect = cfg.selectId ? el(cfg.selectId) : null;
    if (!wrap || !trigger || !label || !menu) return null;
    if (trigger._bound) return wrap._controller || null;
    trigger._bound = true;

    let keyboardFocusIndex = -1;

    function renderMenu(kw = '') {
      menu.innerHTML = '';
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      keyboardFocusIndex = -1;

      // 1. 搜索框
      const searchWrap = document.createElement('div');
      searchWrap.className = 'ag-dropdown-search-wrap';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'ag-dropdown-search-input';
      searchInput.placeholder = (typeof cfg.searchPlaceholder === 'function' ? cfg.searchPlaceholder() : cfg.searchPlaceholder) || t('dropdown.searchPlaceholder');
      searchInput.value = kw;
      searchWrap.appendChild(searchInput);
      menu.appendChild(searchWrap);

      searchInput.addEventListener('click', (e) => e?.stopPropagation?.());
      searchInput.addEventListener('input', (e) => {
        renderList(e.target.value.trim().toLowerCase());
      });

      // 2. 列表容器
      const listContainer = document.createElement('div');
      listContainer.className = 'ag-dropdown-list-container';
      menu.appendChild(listContainer);

      let visibleItems = [];

      function updateKeyboardHighlight(newIdx) {
        const itemEls = listContainer.querySelectorAll ? listContainer.querySelectorAll('.ag-dropdown-item') : (listContainer.children || []);
        if (!itemEls.length) return;
        keyboardFocusIndex = Math.max(0, Math.min(newIdx, itemEls.length - 1));
        Array.from(itemEls).forEach((elNode, idx) => {
          if (idx === keyboardFocusIndex) {
            addClass(elNode, 'is-keyboard-focus');
            elNode.scrollIntoView?.({ block: 'nearest' });
          } else {
            removeClass(elNode, 'is-keyboard-focus');
          }
        });
      }

      function renderList(searchKey = '') {
        if (typeof listContainer.replaceChildren === 'function') listContainer.replaceChildren();
        listContainer.innerHTML = '';
        const allItems = cfg.getOptions();
        const selectedVal = cfg.getSelectedValue();

        const matchesItem = it => {
          if (!searchKey) return true;
          if (cfg.filterItem) return cfg.filterItem(it, searchKey);
          const t1 = String(it.label || '').toLowerCase();
          const t2 = String(it.value || '').toLowerCase();
          const t3 = String(it.code || '').toLowerCase();
          const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
          return t1.includes(searchKey) || t2.includes(searchKey) || t3.includes(searchKey) || aliases.some(a => a.includes(searchKey));
        };

        // 过滤可选项；组标题仅在后续存在命中项时显示且不可选
        const renderEntries = [];
        let pendingHeader = null;
        visibleItems = [];
        for (const it of allItems) {
          if (it && it.isGroupHeader) {
            pendingHeader = it;
            continue;
          }
          if (matchesItem(it)) {
            if (pendingHeader) {
              renderEntries.push(pendingHeader);
              pendingHeader = null;
            }
            renderEntries.push(it);
            visibleItems.push(it);
          }
        }

        if (!visibleItems.length) {
          const emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'padding:10px;text-align:center;color:var(--ag-text-muted);font-size:11px';
          emptyDiv.textContent = (typeof cfg.emptyText === 'function' ? cfg.emptyText() : cfg.emptyText) || t('dropdown.empty');
          listContainer.appendChild(emptyDiv);
          return;
        }

        let selectableIdx = 0;
        renderEntries.forEach((opt) => {
          if (opt && opt.isGroupHeader) {
            const groupEl = document.createElement('div');
            groupEl.className = 'ag-dropdown-group-title';
            groupEl.setAttribute?.('role', 'presentation');
            if (opt.dotColor) {
              const dot = document.createElement('span');
              dot.className = 'ag-vendor-dot';
              dot.style.backgroundColor = opt.dotColor;
              groupEl.appendChild(dot);
            }
            const lbl = document.createElement('span');
            lbl.textContent = opt.label || '';
            groupEl.appendChild(lbl);
            listContainer.appendChild(groupEl);
            return;
          }

          const idx = selectableIdx++;
          const itemEl = document.createElement('div');
          const isSelected = cfg.isItemSelected ? cfg.isItemSelected(opt, selectedVal) : (opt.value === selectedVal);
          itemEl.className = 'ag-dropdown-item' + (isSelected ? ' is-selected' : '');
          itemEl.setAttribute?.('data-index', String(idx));

          const leftSpan = document.createElement('span');
          leftSpan.textContent = opt.displayLeft || opt.label;
          itemEl.appendChild(leftSpan);

          if (opt.badgeText) {
            const b = document.createElement('span');
            b.className = 'ag-dropdown-badge';
            b.textContent = opt.badgeText;
            itemEl.appendChild(b);
          }

          const rightSpan = document.createElement('span');
          rightSpan.className = 'ag-dropdown-item-sub';
          if (opt.displayRight) {
            rightSpan.textContent = opt.displayRight;
          }

          const check = document.createElement('span');
          check.className = 'ag-dropdown-item-check';
          check.textContent = '✓';

          if (opt.displayRight) itemEl.appendChild(rightSpan);
          itemEl.appendChild(check);

          itemEl.addEventListener('click', (e) => {
            e?.stopPropagation?.();
            selectOption(opt);
          });

          listContainer.appendChild(itemEl);
        });

        // 滚入可视区
        setTimeout(() => {
          const selNode = listContainer.querySelector ? listContainer.querySelector('.ag-dropdown-item.is-selected') : null;
          selNode?.scrollIntoView?.({ block: 'nearest' });
        }, 30);
      }

      function selectOption(opt) {
        removeClass(wrap, 'is-open');
        const text = cfg.getLabelText ? cfg.getLabelText(opt) : (opt.label || opt.value);
        label.textContent = text;
        if (linkedSelect) {
          runWithUiHydration(() => {
            linkedSelect.value = opt.value;
          });
        }
        if (cfg.onSelect) cfg.onSelect(opt);
        trigger.focus?.();
      }

      renderList(kw);

      // 键盘导航
      const keyHandler = (e) => {
        if (!hasClass(wrap, 'is-open')) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex <= 0 ? 0 : keyboardFocusIndex - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault?.();
          if (keyboardFocusIndex >= 0 && visibleItems[keyboardFocusIndex]) {
            selectOption(visibleItems[keyboardFocusIndex]);
          } else if (visibleItems.length === 1) {
            selectOption(visibleItems[0]);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault?.();
          removeClass(wrap, 'is-open');
          trigger.focus?.();
        }
      };

      searchInput.addEventListener('keydown', keyHandler);
      menu.addEventListener('keydown', keyHandler);
    }

    // 立即预渲染一次菜单内容，避免初次点击或测试环境遇到空白
    renderMenu();

    function toggleOpen() {
      const isOpen = hasClass(wrap, 'is-open');
      if (!isOpen) {
        closeAllDropdowns(wrap);

        // 空间不足检测，自适应展开方向
        try {
          const rect = trigger.getBoundingClientRect?.() || { bottom: 0, top: 0 };
          const spaceBelow = (typeof window !== 'undefined' ? (window.innerHeight || 800) : 800) - rect.bottom;
          if (spaceBelow < 240 && rect.top > 240) {
            addClass(wrap, 'open-up');
          } else {
            removeClass(wrap, 'open-up');
          }
        } catch {
          removeClass(wrap, 'open-up');
        }

        renderMenu();
        addClass(wrap, 'is-open');
        setTimeout(() => {
          const input = menu.querySelector ? menu.querySelector('.ag-dropdown-search-input') : null;
          input?.focus?.();
        }, 50);
      } else {
        removeClass(wrap, 'is-open');
      }
    }

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      toggleOpen();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault?.();
        toggleOpen();
      } else if (e.key === 'Escape') {
        removeClass(wrap, 'is-open');
      }
    });

    const controller = {
      refresh: () => {
        const val = cfg.getSelectedValue();
        const opts = cfg.getOptions();
        const found = opts.find(o => !o.isGroupHeader && o.value === val);
        if (found) {
          label.textContent = cfg.getLabelText ? cfg.getLabelText(found) : (found.label || found.value);
        } else if (cfg.emptyLabel) {
          label.textContent = cfg.emptyLabel;
        }
      },
      close: () => removeClass(wrap, 'is-open'),
      open: () => toggleOpen()
    };
    wrap._controller = controller;
    return controller;
  }

  function formatOptionLabelByLang(opt) {
    if (!opt) return '';
    if (currentPanelLanguage === 'en') {
      if (opt.labelEn) return opt.labelEn;
      if (opt.code && opt.symbol) return `${opt.code} (${opt.symbol}${opt.nameEn ? ' ' + opt.nameEn : ''})`;
      if (opt.value && opt.value !== '未知') {
        const flagMatch = String(opt.label || '').match(/^([\u{1F1E6}-\u{1F1FF}]{2}|🌐|🌏)\s*/u);
        const flag = flagMatch ? flagMatch[1] + ' ' : '';
        return `${flag}${opt.code || opt.value}`;
      }
      return t('plan.country.auto');
    }
    if (currentPanelLanguage === 'zh-TW') {
      if (opt.labelTw) return opt.labelTw;
    }
    return opt.label;
  }

  // 刷新国家直接选择器显示
  function refreshDirectCountryDisplay(currentCountryVal) {
    const label = el('direct-country-label');
    if (!label) return;
    const val = currentCountryVal || ANTIGRAVITY_TOKEN_DATA.planStatus?.country || '未知';
    const matched = COUNTRY_OPTIONS.find(o => o.value === val);
    label.textContent = matched ? formatOptionLabelByLang(matched) : (val !== '未知' ? `🌐 ${val}` : t('plan.country.auto'));
  }

  // 刷新订阅地区直接选择器显示
  function refreshDirectRegionDisplay(currentRegionText) {
    const directLabel = el('direct-region-label');
    if (!directLabel) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    const reg = currentRegionText || ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知';
    const matched = core?.findRegionPreset ? core.findRegionPreset(reg) : presets.find(p => p.id === reg || p.name === reg);
    if (matched) {
      const curCode = matched.currency === 'TWD' ? 'NTD' : matched.currency;
      const cny = core?.convertToCNY ? core.convertToCNY(matched.monthlyPrice, matched.currency, matched.name) : (matched.monthlyPrice * matched.rateToCNY);
      const dispName = currentPanelLanguage === 'en' ? (matched.nameEn || matched.id || matched.name) : matched.name;
      if (matched.currency === 'CNY') {
        directLabel.textContent = (matched.flag || '🌏') + ' ' + dispName + ' (' + curCode + ') · ¥' + matched.monthlyPrice + t('dropdown.perMonth');
      } else {
        directLabel.textContent = (matched.flag || '🌏') + ' ' + dispName + ' (' + curCode + ') · ' + matched.symbol + matched.monthlyPrice + ' (' + t('plan.cnyShort', { val: Number(cny).toFixed(1) }) + ')';
      }
    } else if (reg && reg !== '未知') {
      directLabel.textContent = '🌏 ' + reg;
    } else {
      directLabel.textContent = t('dropdown.regionUnknownShort');
    }
  }

  // 刷新币种直接选择器显示
  function refreshDirectCurrencyDisplay(currentCurrencyVal) {
    const label = el('direct-currency-label');
    if (!label) return;
    let val = currentCurrencyVal || ANTIGRAVITY_TOKEN_DATA.planStatus?.currency || 'USD';
    if (val === 'NTD') val = 'TWD';
    const matched = CURRENCY_OPTIONS.find(o => o.value === val);
    label.textContent = matched ? formatOptionLabelByLang(matched) : val;
  }

  function renderDirectRegionMenu(filterText = '') {
    const directWrap = el('direct-region-wrap');
    if (directWrap?._controller) {
      directWrap._controller.open();
    }
  }

  // =========================================================================
  // 插件栏设置持久化（币种、国家、订阅地区）与详情面板生命周期管理
  // =========================================================================
  let planDetailExpanded = false;
  let lastSavedCustomPlan = null;
  let lastSaveResult = { ok: true, error: '' };
  let saveFeedbackTimer = null;

  function showPlanSaveFeedback(ok, message) {
    lastSaveResult = { ok: Boolean(ok), error: ok ? '' : (message || t('dropdown.saveFailed')) };
    const fb = el('plan-save-feedback');
    if (!fb) return;
    if (saveFeedbackTimer) {
      clearTimeout(saveFeedbackTimer);
      saveFeedbackTimer = null;
    }
    fb.style.display = 'inline-block';
    fb.style.color = ok ? '#22c55e' : '#ef4444';
    fb.textContent = ok ? (message || t('dropdown.autoSaved')) : t('dropdown.saveFailedDetail', { msg: message || t('dropdown.writeCfgFailed') });
    if (ok) {
      saveFeedbackTimer = setTimeout(() => {
        if (fb) fb.style.display = 'none';
        saveFeedbackTimer = null;
      }, 2800);
    }
  }

  function closeOpenRegionDropdowns() {
    try {
      const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : document;
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => w.classList.remove('is-open'));
    } catch {}
  }

  // 统一控制 AI Pro 详情面板展开与收回（手动按钮、切换预估费用、关闭面板共用同一套清理逻辑）
  function setPlanDetailExpanded(expanded, options = {}) {
    const next = Boolean(expanded) && activeTokenView === 'tokens';
    planDetailExpanded = next;
    const card = el('plan-detail-card');
    const btn = el('btn-plan-detail-toggle');
    const form = el('plan-custom-form');

    if (card) {
      card.style.display = next ? 'block' : 'none';
      card.classList?.toggle?.('is-expanded', next);
      card.setAttribute?.('data-expanded', String(next));
      if (!next) {
        try { card.scrollTop = 0; } catch {}
      }
    }
    if (btn) {
      btn.textContent = next ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      btn.setAttribute?.('aria-expanded', String(next));
    }
    if (!next) {
      if (form) form.style.display = 'none';
      closeOpenRegionDropdowns();
    }
    if (!options.skipReposition) {
      positionFloatingPanels();
    }
    return planDetailExpanded;
  }

  let currentSaveSeq = 0;

  function getStoredCustomPlanSnapshot(email = 'default') {
    if (lastSavedCustomPlan && typeof lastSavedCustomPlan === 'object') {
      return { ...lastSavedCustomPlan };
    }
    try {
      const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
      const raw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const hasExplicitCustomPaid = Boolean(ps.isZeroExtraCost || (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined && ps.actualPricePaid !== ''));
    const pm = (ps.priceMode === 'custom' || ps.priceMode === 'preset')
      ? ps.priceMode
      : (ps.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');
    return {
      accountRegion: (ps.accountRegion && !ps.accountRegion.includes('未知')) ? ps.accountRegion : ((ps.country && !ps.country.includes('未知')) ? ps.country : undefined),
      country: (ps.country && !ps.country.includes('未知')) ? ps.country : undefined,
      subscriptionCountry: (ps.subscriptionCountry && !ps.subscriptionCountry.includes('未知')) ? ps.subscriptionCountry : ((ps.subscriptionRegion && !ps.subscriptionRegion.includes('未知')) ? ps.subscriptionRegion : ((ps.region && !ps.region.includes('未知')) ? ps.region : undefined)),
      subscriptionRegion: (ps.subscriptionRegion && !ps.subscriptionRegion.includes('未知')) ? ps.subscriptionRegion : ((ps.region && !ps.region.includes('未知')) ? ps.region : undefined),
      region: (ps.region && !ps.region.includes('未知')) ? ps.region : undefined,
      subscriptionCurrency: ps.subscriptionCurrency || ps.currency || 'USD',
      currency: ps.currency || 'USD',
      currencySource: ps.currencySource || 'default',
      currencySymbol: ps.currencySymbol || '$',
      actualPricePaid: ps.actualPricePaid ?? null,
      customActualPrice: (pm === 'custom' && ps.actualPricePaid !== null) ? ps.actualPricePaid : (lastSavedCustomPlan?.customActualPrice ?? null),
      priceMode: pm,
      billingCycle: (ps.billingCycle && !ps.billingCycle.includes('未知')) ? ps.billingCycle : '月付',
      acquisitionSource: ps.acquisitionSource || 'normal_paid',
      acquisitionSourceName: ps.acquisitionSourceName || undefined,
      isZeroExtraCost: Boolean(ps.isZeroExtraCost),
      validEndDate: ps.validEndDate || null,
      customNote: ps.customNote || '',
      priceSource: ps.priceSource || (pm === 'preset' ? 'preset_region' : 'custom')
    };
  }

  async function persistSettingsToHost(payload = {}) {
    const thisSeq = ++currentSaveSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = payload.email || ps.email || 'default';
    const customObj = payload.customPlan || null;

    // 保存前检查通信桥接，缺失时返回失败
    const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function';
    const hasLive = typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port);
    if (!hasIpc && !hasLive) {
      showPlanSaveFeedback(false, t('dropdown.noPersistBridge'));
      return { ok: false, error: 'NO_HOST_BRIDGE' };
    }

    try {
      let res = null;
      if (hasIpc) {
        res = await window.contextMeterAPI.saveSettings({ ...payload, email, saveSeq: thisSeq });
      } else if (hasLive) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ ...payload, email, saveSeq: thisSeq })
        });
        if (!resp.ok) {
          showPlanSaveFeedback(false, `HTTP ${resp.status}`);
          return { ok: false, error: `HTTP ${resp.status}` };
        }
        res = await resp.json().catch(() => null);
      }

      // 请求序列检查：若在此保存期间发生更新的操作，丢弃旧回包，避免旧响应乱序覆盖
      if (thisSeq < currentSaveSeq) {
        return { ok: true, superseded: true };
      }

      if (!res || res.ok === false) {
        const errMsg = translateBackendText(res?.error) || t('dropdown.writeCfgFailed');
        showPlanSaveFeedback(false, errMsg);
        return { ok: false, error: errMsg };
      }

      // 宿主落盘确认成功后，才更新内存已保存缓存与全局快照
      if (payload.clearPlan) {
        lastSavedCustomPlan = null;
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = { ok: true, customPlan: null };
        }
        try {
          if (email && email !== 'default') localStorage?.removeItem('ag_custom_plan_' + String(email).toLowerCase());
          localStorage?.removeItem('ag_custom_plan_default');
        } catch {}
      } else {
        const savedPlan = res.customPlan || customObj;
        lastSavedCustomPlan = { ...savedPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = { ok: true, customPlan: { ...savedPlan } };
        }
        try {
          const jsonStr = JSON.stringify(savedPlan);
          if (email && email !== 'default') {
            localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          }
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch {}
      }

      showPlanSaveFeedback(true, t('dropdown.autoSaved'));
      return res;
    } catch (err) {
      if (thisSeq >= currentSaveSeq) {
        showPlanSaveFeedback(false, err?.message || t('dropdown.persistErr'));
      }
      return { ok: false, error: err?.message || t('dropdown.persistErr') };
    }
  }

  function applyCustomPlanObjectLocally(customObj, email = 'default') {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    const cleanLive = rawLive
      ? { ...rawLive, region: '未知', subscriptionRegion: '未知', country: '未知', actualPricePaid: null, regionSource: 'unknown', priceSource: 'unknown' }
      : null;

    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(cleanLive, customObj, { currentEmail: email });
    } else if (customObj) {
      const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      const sym = (core?.CURRENCY_SYMBOLS && customObj.currency) ? (core.CURRENCY_SYMBOLS[customObj.currency] || customObj.currencySymbol || '$') : (customObj.currencySymbol || '$');
      ANTIGRAVITY_TOKEN_DATA.planStatus = {
        ...ps,
        country: customObj.country || ps.country || '未知',
        countrySource: customObj.country ? 'custom' : (ps.countrySource || 'unknown'),
        region: customObj.subscriptionRegion || customObj.region || ps.region || '未知',
        subscriptionRegion: customObj.subscriptionRegion || customObj.region || ps.subscriptionRegion || '未知',
        regionSource: (customObj.subscriptionRegion || customObj.region) ? 'custom' : (ps.regionSource || 'unknown'),
        currency: customObj.currency || ps.currency || 'USD',
        currencySource: customObj.currency ? 'custom' : (ps.currencySource || 'default'),
        currencySymbol: sym,
        actualPricePaid: customObj.actualPricePaid !== undefined ? customObj.actualPricePaid : ps.actualPricePaid,
        priceSource: customObj.priceSource || 'custom'
      };
    }
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
  }

  // 明确切换价格模式：'preset' (跟随订阅国家参考价) 与 'custom' (自定义实付金额)
  function switchPlanPriceMode(newMode) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const targetMode = newMode === 'custom' ? 'custom' : 'preset';

    let customObj = null;
    if (targetMode === 'preset') {
      // 切换为「跟随订阅国家参考价」：实时根据当前订阅国家派生官方参考价与币种
      const currentReg = prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || ps.region || '';
      const matched = core?.findRegionPreset ? core.findRegionPreset(currentReg) : core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.id === currentReg || p.name === currentReg);
      const curCode = matched ? matched.currency : (prevCustom.subscriptionCurrency || prevCustom.currency || 'USD');
      const curSymbol = matched ? matched.symbol : (core?.CURRENCY_SYMBOLS?.[curCode] || '$');
      const paid = matched ? matched.monthlyPrice : null;

      customObj = {
        ...prevCustom,
        priceMode: 'preset',
        priceSource: 'preset_region',
        actualPricePaid: paid,
        subscriptionCurrency: curCode,
        currency: curCode,
        currencySource: 'preset_region',
        currencySymbol: curSymbol,
        billingCycle: '月付',
        isZeroExtraCost: false,
        updatedAt: new Date().toISOString()
      };
      applyCustomPlanObjectLocally(customObj, email);
      void persistSettingsToHost({ email, customPlan: customObj });
    } else {
      // 切换为「自定义实付金额」：开启自定义模式并展开行内编辑表单
      const isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);
      const paid = isZero ? 0 : (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined ? prevCustom.actualPricePaid : (prevCustom.customActualPrice ?? null));

      customObj = {
        ...prevCustom,
        priceMode: 'custom',
        priceSource: 'custom',
        actualPricePaid: paid,
        customActualPrice: paid,
        updatedAt: new Date().toISOString()
      };
      applyCustomPlanObjectLocally(customObj, email);
      togglePlanCustomForm(true);
      void persistSettingsToHost({ email, customPlan: customObj });
    }
  }

  // 用户点选「订阅国家」：在参考价模式下实时派生价格与币种，在自定义模式下保持用户实付金额与币种
  function applyDirectRegionSelection(regionItem) {
    if (!regionItem) return;
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const regionName = regionItem.name + ' (' + (regionItem.currency === 'TWD' ? 'NTD' : regionItem.currency) + ')';
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;

    const hasExplicitCustomPaid = Boolean(prevCustom.isZeroExtraCost || (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined && prevCustom.actualPricePaid !== ''));
    const currentPriceMode = (prevCustom.priceMode === 'custom' || prevCustom.priceMode === 'preset')
      ? prevCustom.priceMode
      : (prevCustom.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');

    let curCode = regionItem.currency;
    let curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || regionItem.symbol || '$';
    let paid = null;
    let priceSource = 'preset_region';
    let isZero = false;
    let cycle = '月付';

    if (currentPriceMode === 'custom') {
      // 自定义实付模式：切换国家严格保留用户此前设置的实付金额与币种，绝不静默覆盖！
      isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);
      curCode = prevCustom.subscriptionCurrency || prevCustom.currency || regionItem.currency;
      curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || '$';
      paid = isZero ? 0 : (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined ? prevCustom.actualPricePaid : null);
      priceSource = 'custom';
      cycle = isZero ? '随套餐赠送/免费' : (prevCustom.billingCycle || '月付');
    } else {
      // 跟随订阅国家参考价模式：实时从预设派生定价、币种与周期
      curCode = regionItem.currency;
      curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || regionItem.symbol || '$';
      paid = regionItem.monthlyPrice;
      priceSource = 'preset_region';
      isZero = false;
      cycle = '月付';
    }

    const customObj = {
      ...prevCustom,
      accountRegion: prevCustom.accountRegion || prevCustom.country || undefined,
      country: prevCustom.country || prevCustom.accountRegion || undefined,
      subscriptionCountry: regionName,
      subscriptionRegion: regionName,
      region: regionName,
      acquisitionSource: prevCustom.acquisitionSource || ps.acquisitionSource || 'normal_paid',
      acquisitionSourceName: prevCustom.acquisitionSourceName || ps.acquisitionSourceName || undefined,
      isZeroExtraCost: isZero,
      actualPricePaid: paid,
      customActualPrice: currentPriceMode === 'custom' ? paid : (prevCustom.customActualPrice ?? null),
      priceMode: currentPriceMode,
      subscriptionCurrency: curCode,
      currency: curCode,
      currencySource: currentPriceMode === 'custom' ? 'custom' : 'preset_region',
      currencySymbol: curSymbol,
      billingCycle: isZero ? '随套餐赠送/免费' : cycle,
      priceSource,
      updatedAt: new Date().toISOString()
    };

    refreshDirectRegionDisplay(regionName);
    refreshDirectCurrencyDisplay(curCode);
    applyCustomPlanObjectLocally(customObj, email);

    // 双向同步：更新订阅国家表单及币种（使用纯同步防护守卫，防级联循环）
    runWithUiHydration(() => {
      const directCurSel = el('direct-currency-select');
      if (directCurSel) directCurSel.value = curCode === 'TWD' ? 'TWD' : curCode;
      const form = el('plan-custom-form');
      if (form) {
        const regInput = el('input-custom-region');
        const curSelect = el('select-custom-currency');
        const paidInput = el('input-custom-paid');
        const zeroCheck = el('check-zero-extra');
        if (regInput) regInput.value = regionName;
        if (curSelect) {
          curSelect.value = curCode;
          enhancedDropdowns.get('select-custom-currency')?.refresh?.();
        }
        if (paidInput && !zeroCheck?.checked) {
          paidInput.value = (paid !== null && paid !== undefined) ? paid : '';
        }
        const prevEl = el('region-cny-preview');
        if (prevEl && paid !== null && regionItem.rateToCNY) {
          const cny = (paid * regionItem.rateToCNY).toFixed(1);
          prevEl.textContent = t('plan.cnyApprox', { val: cny });
        }
      }
    });

    void persistSettingsToHost({ email, customPlan: customObj });
  }

  // 用户单独修改「账号所在地区」：仅修改本地记录，绝不影响订阅国家、订阅币种或订阅金额
  function applyDirectCountrySelection(newCountryVal) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const cleanCountry = (newCountryVal && newCountryVal !== '未知') ? String(newCountryVal).trim() : '';

    const customObj = {
      ...prevCustom,
      accountRegion: cleanCountry || undefined,
      country: cleanCountry || undefined,
      updatedAt: new Date().toISOString()
    };
    if (!cleanCountry) {
      delete customObj.accountRegion;
      delete customObj.country;
    }

    refreshDirectCountryDisplay(cleanCountry || '未知');

    runWithUiHydration(() => {
      const countryInput = el('input-custom-country');
      if (countryInput) countryInput.value = cleanCountry;
      const directCountrySel = el('direct-country-select');
      if (directCountrySel) directCountrySel.value = cleanCountry || '未知';
    });

    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
  }

  // 用户单独修改「订阅币种」：独立更新结算币种与符号，严格保持账号所在地区和订阅国家不变
  function applyDirectCurrencySelection(newCurrencyVal) {
    if (!newCurrencyVal) return;
    ++userActionSeq;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    let curCode = String(newCurrencyVal).trim().toUpperCase();
    if (curCode === 'NTD') curCode = 'TWD';
    const curSymbol = core?.CURRENCY_SYMBOLS?.[curCode] || '$';

    refreshDirectCurrencyDisplay(curCode);

    const hasExplicitCustomPaid = Boolean(prevCustom.isZeroExtraCost || (prevCustom.actualPricePaid !== null && prevCustom.actualPricePaid !== undefined && prevCustom.actualPricePaid !== ''));
    const currentPriceMode = (prevCustom.priceMode === 'custom' || prevCustom.priceMode === 'preset')
      ? prevCustom.priceMode
      : (prevCustom.priceSource === 'custom' && hasExplicitCustomPaid ? 'custom' : 'preset');
    let paid = prevCustom.actualPricePaid;
    let priceSource = currentPriceMode === 'custom' ? 'custom' : 'preset_region';
    const isZero = Boolean(prevCustom.isZeroExtraCost || prevCustom.actualPricePaid === 0);

    if (isZero) {
      paid = 0;
      priceSource = 'custom';
    } else if (currentPriceMode === 'preset') {
      // 检查新币种在预设库中是否有基准定价
      const matchedNewPreset = core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.currency === curCode);
      if (matchedNewPreset) {
        paid = matchedNewPreset.monthlyPrice;
        priceSource = 'preset_region';
      } else {
        paid = prevCustom.actualPricePaid;
      }
    } else {
      paid = prevCustom.actualPricePaid;
      priceSource = 'custom';
    }

    const customObj = {
      ...prevCustom,
      accountRegion: prevCustom.accountRegion || prevCustom.country || undefined,
      country: prevCustom.country || prevCustom.accountRegion || undefined,
      subscriptionCountry: prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || undefined,
      subscriptionRegion: prevCustom.subscriptionRegion || prevCustom.region || undefined,
      region: prevCustom.subscriptionRegion || prevCustom.region || undefined,
      subscriptionCurrency: curCode,
      currency: curCode,
      currencySource: 'custom',
      currencySymbol: curSymbol,
      actualPricePaid: paid,
      customActualPrice: currentPriceMode === 'custom' ? paid : (prevCustom.customActualPrice ?? null),
      priceMode: currentPriceMode,
      priceSource,
      updatedAt: new Date().toISOString()
    };

    runWithUiHydration(() => {
      const formCurSel = el('select-custom-currency');
      if (formCurSel) {
        formCurSel.value = curCode;
        enhancedDropdowns.get('select-custom-currency')?.refresh?.();
      }
      const directCurSel = el('direct-currency-select');
      if (directCurSel) directCurSel.value = curCode;
      const paidInput = el('input-custom-paid');
      if (paidInput && !isZero) {
        paidInput.value = (paid !== null && paid !== undefined) ? paid : '';
      }
    });

    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
  }

  el('direct-country-select')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    applyDirectCountrySelection(e.target?.value || '');
  });

  el('direct-currency-select')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    applyDirectCurrencySelection(e.target?.value || 'USD');
  });

  // 绑定统一定制「账号所在地区」、「订阅国家」与「订阅币种」下拉组件
  function initDirectCountryDropdown() {
    return initDropdownController({
      wrapId: 'direct-country-wrap',
      triggerId: 'direct-country-trigger',
      labelId: 'direct-country-label',
      menuId: 'direct-country-menu',
      selectId: 'direct-country-select',
      searchPlaceholder: () => t('dropdown.countrySearch'),
      getOptions: () => COUNTRY_OPTIONS.map(o => ({ ...o, label: formatOptionLabelByLang(o) })),
      getSelectedValue: () => {
        const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
        return (ps.country && !String(ps.country).includes('未知')) ? String(ps.country).trim() : '未知';
      },
      getLabelText: (opt) => formatOptionLabelByLang(opt),
      onSelect: (opt) => {
        applyDirectCountrySelection(opt.value);
      },
      emptyText: () => t('dropdown.countryEmpty')
    });
  }

  function initDirectRegionDropdown() {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    return initDropdownController({
      wrapId: 'direct-region-wrap',
      triggerId: 'direct-region-trigger',
      labelId: 'direct-region-label',
      menuId: 'direct-region-menu',
      searchPlaceholder: () => t('dropdown.regionSearch'),
      getOptions: () => {
        return presets.map(p => {
          const curCode = p.currency === 'TWD' ? 'NTD' : p.currency;
          const dispName = currentPanelLanguage === 'en' ? (p.id || p.name) : p.name;
          let displayRight = '';
          if (p.currency === 'CNY') {
            displayRight = p.symbol + p.monthlyPrice + t('dropdown.perMonth');
          } else {
            const cny = core?.convertToCNY ? core.convertToCNY(p.monthlyPrice, p.currency, p.name) : (p.monthlyPrice * p.rateToCNY);
            displayRight = p.symbol + p.monthlyPrice + t('dropdown.perMonth') + ' · ≈ ¥' + Number(cny).toFixed(1) + ' CNY';
          }
          return {
            value: p.id,
            rawItem: p,
            label: (p.flag || '🌏') + ' ' + dispName + ' (' + curCode + ')',
            displayLeft: (p.flag || '🌏') + ' ' + dispName + ' (' + curCode + ')',
            displayRight,
            code: p.id,
            currency: curCode,
            aliases: p.aliases || []
          };
        });
      },
      getSelectedValue: () => {
        const currentReg = ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '';
        const matched = core?.findRegionPreset ? core.findRegionPreset(currentReg) : presets.find(p => p.id === currentReg || p.name === currentReg);
        return matched ? matched.id : '';
      },
      filterItem: (it, kw) => {
        const curCode = String(it.currency || '').toLowerCase();
        const name = String(it.label || '').toLowerCase();
        const id = String(it.code || '').toLowerCase();
        const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
        return name.includes(kw) || id.includes(kw) || curCode.includes(kw) || aliases.some(a => a.includes(kw));
      },
      getLabelText: (opt) => {
        const p = opt.rawItem;
        if (!p) return opt.label;
        const curCode = p.currency === 'TWD' ? 'NTD' : p.currency;
        const dispName = currentPanelLanguage === 'en' ? (p.id || p.name) : p.name;
        if (p.currency === 'CNY') {
          return (p.flag || '🌏') + ' ' + dispName + ' (' + curCode + ') · ¥' + p.monthlyPrice + t('dropdown.perMonth');
        }
        const cny = core?.convertToCNY ? core.convertToCNY(p.monthlyPrice, p.currency, p.name) : (p.monthlyPrice * p.rateToCNY);
        return (p.flag || '🌏') + ' ' + dispName + ' (' + curCode + ') · ' + p.symbol + p.monthlyPrice + ' (≈ ¥' + Number(cny).toFixed(1) + ' CNY)';
      },
      onSelect: (opt) => {
        if (opt.rawItem) applyDirectRegionSelection(opt.rawItem);
      },
      emptyText: () => t('dropdown.regionEmpty')
    });
  }

  function initDirectCurrencyDropdown() {
    return initDropdownController({
      wrapId: 'direct-currency-wrap',
      triggerId: 'direct-currency-trigger',
      labelId: 'direct-currency-label',
      menuId: 'direct-currency-menu',
      selectId: 'direct-currency-select',
      searchPlaceholder: () => t('dropdown.currencySearch'),
      getOptions: () => CURRENCY_OPTIONS.map(o => ({ ...o, label: formatOptionLabelByLang(o) })),
      getSelectedValue: () => {
        const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
        let cur = ps.currency || 'USD';
        if (cur === 'NTD') cur = 'TWD';
        return cur;
      },
      filterItem: (it, kw) => {
        const name = String(it.name || '').toLowerCase();
        const code = String(it.code || '').toLowerCase();
        const sym = String(it.symbol || '').toLowerCase();
        const label = String(it.label || '').toLowerCase();
        const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
        return name.includes(kw) || code.includes(kw) || sym.includes(kw) || label.includes(kw) || aliases.some(a => a.includes(kw));
      },
      getLabelText: (opt) => formatOptionLabelByLang(opt),
      onSelect: (opt) => {
        applyDirectCurrencySelection(opt.value);
      },
      emptyText: () => t('dropdown.currencyEmpty')
    });
  }

  // 立即触发初始化三大原生定制下拉
  initDirectCountryDropdown();
  initDirectRegionDropdown();
  initDirectCurrencyDropdown();

  // 全局点击外部关闭所有下拉
  if (typeof shadow !== 'undefined' && shadow && shadow.addEventListener) {
    shadow.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }

  // 套餐详情卡片展开与收回（统一走 setPlanDetailExpanded）
  el('plan-summary-price-badge')?.addEventListener('click', () => {
    setPlanDetailExpanded(!planDetailExpanded);
  });
  el('btn-plan-detail-toggle')?.addEventListener('click', () => {
    const card = el('plan-detail-card');
    const currentlyHidden = !card || card.style.display === 'none' || !card.style.display;
    setPlanDetailExpanded(currentlyHidden);
  });
  el('btn-plan-detail-collapse-top')?.addEventListener('click', () => {
    setPlanDetailExpanded(false);
  });
  el('btn-plan-detail-collapse')?.addEventListener('click', () => {
    setPlanDetailExpanded(false);
  });

  // 原生质感自定义下拉选择增强器
  const enhancedDropdowns = new Map();
  function enhanceCustomSelect(selectId) {
    const sel = el(selectId);
    if (!sel || !sel.parentNode) return null;
    if (enhancedDropdowns.has(selectId)) {
      const existing = enhancedDropdowns.get(selectId);
      existing.refresh();
      return existing;
    }

    sel.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'ag-dropdown-wrapper';
    wrap.setAttribute('data-target-select', selectId);

    const trigger = document.createElement('div');
    trigger.className = 'ag-dropdown-trigger';
    trigger.setAttribute('tabindex', '0');

    const label = document.createElement('span');
    label.className = 'ag-dropdown-label';
    label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1';

    const arrow = document.createElement('div');
    arrow.className = 'ag-dropdown-arrow';
    arrow.innerHTML = '<svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>';

    trigger.appendChild(label);
    trigger.appendChild(arrow);
    wrap.appendChild(trigger);

    const menu = document.createElement('div');
    menu.className = 'ag-dropdown-menu';
    wrap.appendChild(menu);

    const renderOptions = () => {
      menu.innerHTML = '';
      const selectedVal = sel.value;
      const opts = Array.from(sel.options);
      let activeText = '';

      opts.forEach((opt) => {
        const item = document.createElement('div');
        item.className = 'ag-dropdown-item' + (opt.value === selectedVal ? ' is-selected' : '');

        const textSpan = document.createElement('span');
        if (opt.text.includes(' · ')) {
          const parts = opt.text.split(' · ');
          textSpan.textContent = parts[0];
          const subSpan = document.createElement('span');
          subSpan.className = 'ag-dropdown-item-sub';
          subSpan.textContent = parts.slice(1).join(' · ');
          item.appendChild(textSpan);
          item.appendChild(subSpan);
        } else {
          textSpan.textContent = opt.text;
          item.appendChild(textSpan);
        }

        const check = document.createElement('span');
        check.className = 'ag-dropdown-item-check';
        check.textContent = '✓';
        item.appendChild(check);

        if (opt.value === selectedVal) {
          activeText = opt.text;
        }

        item.addEventListener('click', (e) => {
          e?.stopPropagation?.();
          sel.value = opt.value;
          renderOptions();
          wrap?.classList?.remove?.('is-open');
          if (typeof Event !== 'undefined') sel.dispatchEvent(new Event('change', { bubbles: true })); else sel.dispatchEvent?.({ type: 'change' });
        });

        menu.appendChild(item);
      });

      label.textContent = activeText || sel.selectedOptions[0]?.text || sel.options[0]?.text || '';
    };

    renderOptions();

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const isOpen = Boolean(wrap?.classList?.contains?.('is-open'));
      const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : (typeof document !== 'undefined' ? document : null);
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => {
        if (w !== wrap) w.classList.remove('is-open');
      });
      if (!isOpen) {
        renderOptions();
        wrap?.classList?.add?.('is-open');
      } else {
        wrap?.classList?.remove?.('is-open');
      }
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        trigger.click();
      } else if (e.key === 'Escape') {
        wrap?.classList?.remove?.('is-open');
      }
    });

    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    sel.addEventListener('change', () => {
      renderOptions();
    });

    const handler = {
      wrap,
      refresh: renderOptions
    };
    enhancedDropdowns.set(selectId, handler);
    return handler;
  }

  // 点击外部自动收起下拉浮层
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      try {
        if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
          const root = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : document;
          root.querySelectorAll('.ag-dropdown-wrapper.is-open').forEach(w => w.classList.remove('is-open'));
        }
      } catch {}
    });
  }

  // 就地行内自定义订阅表单交互（实际读取优先于手填，支持官方依据活动来源）
  function togglePlanCustomForm(forceOpen) {
    const form = el('plan-custom-form');
    if (!form) return;
    const curHidden = form.style.display === 'none' || !form.style.display;
    const next = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    form.style.display = next ? 'block' : 'none';
    if (next) {
      const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      const acqSelect = el('select-custom-acq');
      const acqNameInput = el('input-custom-acq-name');
      const zeroCheck = el('check-zero-extra');
      const countryInput = el('input-custom-country');
      const regInput = el('input-custom-region');
      const paidInput = el('input-custom-paid');
      const curSelect = el('select-custom-currency');
      const cycleSelect = el('select-custom-cycle');
      const validEndInput = el('input-valid-end');
      const noteInput = el('input-custom-note');

      runWithUiHydration(() => {
        if (acqSelect && ps.acquisitionSource) acqSelect.value = ps.acquisitionSource;
        if (acqNameInput) acqNameInput.value = (ps.acquisitionSourceName && ps.acquisitionSourceName !== '正常付费订阅') ? ps.acquisitionSourceName : '';
        if (zeroCheck) zeroCheck.checked = Boolean(ps.isZeroExtraCost || ps.actualPricePaid === 0);
        if (countryInput) countryInput.value = (ps.country && !ps.country.includes('未知')) ? ps.country : '';
        if (regInput) regInput.value = (ps.region && !ps.region.includes('未知')) ? ps.region : '';
        if (paidInput) {
          paidInput.value = (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) ? ps.actualPricePaid : (zeroCheck?.checked ? '0' : '');
          paidInput.disabled = Boolean(zeroCheck?.checked);
        }
        if (curSelect && ps.currency) curSelect.value = ps.currency;
        if (cycleSelect && ps.billingCycle && !ps.billingCycle.includes('未知')) cycleSelect.value = ps.billingCycle.replace(/（.*）/, '').trim();
        if (validEndInput) validEndInput.value = ps.validEndDate || '';
        if (noteInput) noteInput.value = ps.customNote || '';
        ['select-custom-acq', 'select-custom-region-preset', 'select-custom-currency', 'select-custom-cycle'].forEach(id => enhanceCustomSelect(id));
      });
      regInput?.focus?.();
    }
    positionFloatingPanels();
  }

  el('select-custom-region-preset')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const presetId = e.target?.value || '';
    if (!presetId || presetId === 'custom') return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const matched = core?.SUBSCRIPTION_REGIONS_PRESET?.find(p => p.id === presetId);
    if (matched) {
      applyDirectRegionSelection(matched);
    }
  });

  el('check-zero-extra')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const paidInput = el('input-custom-paid');
    if (e.target.checked) {
      if (paidInput) {
        paidInput.value = '0';
        paidInput.disabled = true;
      }
    } else {
      if (paidInput) {
        paidInput.disabled = false;
        if (paidInput.value === '0') paidInput.value = '';
      }
    }
  });

  el('select-custom-acq')?.addEventListener('change', (e) => {
    if (isHydratingUiControls) return;
    const val = e.target.value;
    const zeroCheck = el('check-zero-extra');
    const paidInput = el('input-custom-paid');
    const cycleSelect = el('select-custom-cycle');
    const freeBundlePresets = ['student_offer', 'pixel_bundle', 'chromebook_bundle', 'samsung_galaxy', 'jio_offer', 'official_promo'];
    if (freeBundlePresets.includes(val)) {
      if (zeroCheck) zeroCheck.checked = true;
      if (paidInput) {
        paidInput.value = '0';
        paidInput.disabled = true;
      }
      if (cycleSelect) cycleSelect.value = '免费/赠送';
    } else if (val === 'normal_paid') {
      if (zeroCheck) zeroCheck.checked = false;
      if (paidInput) {
        paidInput.disabled = false;
        if (!paidInput.value || paidInput.value === '0') paidInput.value = '19.99';
      }
      if (cycleSelect) cycleSelect.value = '月付';
    }
  });

  el('btn-mode-preset')?.addEventListener('click', () => switchPlanPriceMode('preset'));
  el('btn-mode-custom')?.addEventListener('click', () => switchPlanPriceMode('custom'));
  el('btn-edit-plan-custom')?.addEventListener('click', () => togglePlanCustomForm());
  el('btn-custom-plan-cancel')?.addEventListener('click', () => togglePlanCustomForm(false));

  el('btn-custom-plan-save')?.addEventListener('click', () => {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const prevCustom = getStoredCustomPlanSnapshot(email);
    const acq = el('select-custom-acq')?.value || 'normal_paid';
    const acqName = el('input-custom-acq-name')?.value?.trim() || '';
    const isZero = Boolean(el('check-zero-extra')?.checked);
    const countryInputEl = el('input-custom-country');
    const countryVal = countryInputEl ? countryInputEl.value.trim() : (prevCustom.accountRegion || prevCustom.country || '');
    const regInputEl = el('input-custom-region');
    const reg = regInputEl ? regInputEl.value.trim() : (prevCustom.subscriptionCountry || prevCustom.subscriptionRegion || prevCustom.region || '');
    const rawPaid = el('input-custom-paid')?.value?.trim();
    const paid = isZero ? 0 : (rawPaid !== '' && !Number.isNaN(Number(rawPaid)) ? Number(rawPaid) : null);
    const cur = el('select-custom-currency')?.value || prevCustom.subscriptionCurrency || prevCustom.currency || 'USD';
    const cycle = el('select-custom-cycle')?.value || (isZero ? '随套餐赠送/免费' : '月付');
    const validEnd = el('input-valid-end')?.value?.trim() || '';
    const note = el('input-custom-note')?.value?.trim() || '';

    const customObj = {
      ...prevCustom,
      accountRegion: countryVal || undefined,
      country: countryVal || undefined,
      subscriptionCountry: reg || undefined,
      subscriptionRegion: reg || undefined,
      region: reg || undefined,
      acquisitionSource: acq,
      acquisitionSourceName: acqName || undefined,
      isZeroExtraCost: isZero,
      actualPricePaid: paid,
      customActualPrice: paid,
      priceMode: 'custom',
      subscriptionCurrency: cur,
      currency: cur,
      currencySource: 'custom',
      billingCycle: cycle,
      validEndDate: validEnd || null,
      customNote: note,
      priceSource: 'custom',
      updatedAt: new Date().toISOString()
    };
    if (!countryVal) {
      delete customObj.accountRegion;
      delete customObj.country;
    }
    if (!reg) {
      delete customObj.subscriptionCountry;
      delete customObj.subscriptionRegion;
      delete customObj.region;
    }

    applyCustomPlanObjectLocally(customObj, email);
    togglePlanCustomForm(false);
    void persistSettingsToHost({ email, customPlan: customObj });
  });

  el('btn-custom-plan-clear')?.addEventListener('click', () => {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(rawLive, { priceMode: 'preset' }, { currentEmail: email });
    }
    togglePlanCustomForm(false);
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
    void persistSettingsToHost({ email, clearPlan: true });
  });

  let lastBadgePriceState = null;
  let activeBadgeRafId = null;
  let activeBadgeTimerId = null;
  let activeCnyTimerId = null;
  function renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCnyText, options = {}) {
    const priceValEl = el('plan-summary-price-val');
    const priceCnyEl = el('plan-summary-price-cny');
    const badgeEl = el('plan-summary-price-badge');
    if (!priceValEl) return;

    if (activeBadgeTimerId) {
      clearTimeout(activeBadgeTimerId);
      activeBadgeTimerId = null;
    }
    if (activeCnyTimerId) {
      clearTimeout(activeCnyTimerId);
      activeCnyTimerId = null;
    }
    if (activeBadgeRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(activeBadgeRafId);
      activeBadgeRafId = null;
    }

    const formattedFinalNum = targetNum !== null && targetNum !== undefined
      ? (Number(targetNum) % 1 === 0 ? String(Number(targetNum)) : Number(targetNum).toFixed(2))
      : '';

    // 轻量模拟环境安全兼容
    if (typeof priceValEl.querySelector !== 'function') {
      priceValEl.textContent = `${targetSymbol}${formattedFinalNum}${targetCycle}`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const hasRaf = typeof requestAnimationFrame === 'function';
    const forceDirect = options.forceDirect || !hasRaf || !lastBadgePriceState;

    if (forceDirect) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${targetSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const startNum = (lastBadgePriceState && Number.isFinite(lastBadgePriceState.num))
      ? lastBadgePriceState.num
      : (Number(targetNum) || 0);
    const endNum = targetNum !== null ? Number(targetNum) : 0;
    const startSymbol = lastBadgePriceState?.symbol || targetSymbol;
    const endSymbol = targetSymbol;

    // 确保内部 DOM 结构完整
    let symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
    let numEl = priceValEl.querySelector?.('.badge-num-anim');
    let cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');

    if (!symbolEl || !numEl || !cycleEl) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${startSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
      numEl = priceValEl.querySelector?.('.badge-num-anim');
      cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');
    }

    if (cycleEl) cycleEl.textContent = targetCycle;

    // 1. 货币符号消散再切换动画 (Symbol Dissolve & Crossfade)
    if (startSymbol !== endSymbol && symbolEl && symbolEl.classList) {
      symbolEl.classList.remove('is-entering');
      symbolEl.classList.add('is-dissolving');

      activeBadgeTimerId = setTimeout(() => {
        symbolEl.textContent = endSymbol;
        symbolEl.classList.remove('is-dissolving');
        symbolEl.classList.add('is-entering');
        try { void symbolEl.offsetWidth; } catch {}
        setTimeout(() => {
          symbolEl.classList?.remove?.('is-entering');
        }, 180);
        activeBadgeTimerId = null;
      }, 160);
    } else if (symbolEl) {
      symbolEl.textContent = endSymbol;
    }

    // 2. CNY 折合平滑渐变
    if (priceCnyEl && priceCnyEl.textContent !== targetCnyText) {
      try {
        priceCnyEl.style.transition = 'opacity 0.18s ease';
        priceCnyEl.style.opacity = '0.2';
        activeCnyTimerId = setTimeout(() => {
          priceCnyEl.textContent = targetCnyText;
          priceCnyEl.style.opacity = '0.85';
          activeCnyTimerId = null;
        }, 140);
      } catch {
        priceCnyEl.textContent = targetCnyText;
      }
    }

    // 3. 数字滚动/递减递增动画 (Rolling Numeric Count Tween)
    if (startNum !== endNum && numEl) {
      if (badgeEl && badgeEl.classList) badgeEl.classList.add('is-animating');

      const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const duration = 500;
      const easeOut = t => 1 - Math.pow(1 - t, 4);

      const step = now => {
        const elapsed = Math.max(0, now - startTime);
        const progress = Math.min(1, elapsed / duration);
        const eased = easeOut(progress);
        const currentVal = startNum + (endNum - startNum) * eased;

        if (progress < 1) {
          if (endNum % 1 !== 0) {
            numEl.textContent = currentVal >= 100 ? String(Math.round(currentVal)) : currentVal.toFixed(2);
          } else {
            numEl.textContent = String(Math.round(currentVal));
          }
          activeBadgeRafId = requestAnimationFrame(step);
        } else {
          numEl.textContent = formattedFinalNum;
          if (badgeEl && badgeEl.classList) badgeEl.classList.remove('is-animating');
          activeBadgeRafId = null;
        }
      };

      activeBadgeRafId = requestAnimationFrame(step);
    } else if (numEl) {
      numEl.textContent = formattedFinalNum;
    }

    lastBadgePriceState = {
      symbol: targetSymbol,
      num: endNum,
      cycle: targetCycle,
      cnyText: targetCnyText
    };
  }

  function renderPlanDetail(ps) {
    if (!ps) return;
    const sumTxt = el('plan-summary-text');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : ps.hasCustomSettings
          ? t('plan.summary.custom')
          : t('plan.summary.unknown');
      sumTxt.textContent = `${ps.tierName || 'Pro'} · ${modeTxt} · ${t('plan.summary.justNow')}`;
    }
    // 实时联动更新黄框位置的订阅费与汇率胶囊 (支持动效与符号消散)
    const curSymbol = ps.currencySymbol || '$';
    let targetSymbol = '$';
    let targetNum = 19.99;
    let targetCycle = t('plan.summary.perMonth');
    let targetCny = '(≈ ¥134.3 CNY)';

    if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
      targetSymbol = curSymbol;
      targetNum = 0;
      targetCycle = t('plan.summary.perMonth');
      targetCny = t('plan.summary.freeWithPlan');
    } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
      targetSymbol = curSymbol;
      targetNum = Number(ps.actualPricePaid);
      targetCycle = t('plan.summary.perMonth');
      if (ps.currency === 'CNY') {
        targetCny = '';
      } else if (ps.cnyFormatted) {
        const cnyClean = String(ps.cnyFormatted).replace(/^[折合約\s≈()（）]+/, '').replace(/[()（）]/g, '').trim();
        const prefix = currentPanelLanguage === 'en' ? 'approx. ' : '≈ ';
        targetCny = cnyClean ? `(${prefix}${cnyClean})` : '';
      } else {
        targetCny = '';
      }
    } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
      targetSymbol = '$';
      targetNum = Number(ps.officialPriceMonthly);
      targetCycle = t('plan.summary.perMonth');
      targetCny = '(≈ ¥134.3 CNY)';
    } else {
      targetSymbol = '$';
      targetNum = 19.99;
      targetCycle = t('plan.summary.perMonth');
      targetCny = '(≈ ¥134.3 CNY)';
    }

    renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCny);

    const detName = el('p-det-name');
    if (detName) detName.textContent = ps.tierName || 'Google AI Pro';
    const detAcc = el('p-det-account');
    if (detAcc) detAcc.textContent = ps.email || t('plan.account.unknown');

    // 守卫：若当前不在 Token 统计视图或详情处于收起状态，严禁异步返回时撑开详情面板
    const cardEl = el('plan-detail-card');
    if (cardEl && (activeTokenView !== 'tokens' || !planDetailExpanded)) {
      cardEl.style.display = 'none';
      cardEl.classList?.remove?.('is-expanded');
    }

    const detCountry = el('p-det-country');
    const tagCountry = el('p-det-country-tag');
    const directCountrySel = el('direct-country-select');
    const countryText = (ps.country && !String(ps.country).includes('未知')) ? String(ps.country).trim() : '未知';
    if (detCountry) detCountry.textContent = countryText === '未知' ? t('plan.country.unknown') : countryText;
    if (tagCountry) {
      tagCountry.style.display = ps.countrySource === 'custom' ? 'inline-block' : 'none';
      tagCountry.textContent = ps.countrySource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detReg = el('p-det-region');
    const tagReg = el('p-det-region-tag');
    let regText = ps.subscriptionRegion || ps.region || '未知';
    if (regText.includes('未在当前会话中获取') || regText.trim() === '未知') regText = '未知';
    if (detReg) detReg.textContent = regText === '未知' ? t('plan.region.unknown') : regText;
    if (tagReg) {
      tagReg.style.display = ps.regionSource === 'custom' ? 'inline-block' : 'none';
      tagReg.textContent = ps.regionSource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detCur = el('p-det-currency');
    const tagCur = el('p-det-currency-tag');
    const directCurSel = el('direct-currency-select');
    const curText = ps.currency || 'USD';
    if (detCur) detCur.textContent = curText;
    if (tagCur) {
      tagCur.style.display = ps.currencySource === 'custom' ? 'inline-block' : 'none';
      tagCur.textContent = ps.currencySource === 'custom' ? t('plan.tag.custom') : '';
    }

    // 使用纯同步回填守卫同步更新详情面板内的下拉控件值
    runWithUiHydration(() => {
      if (directCountrySel) {
        if (countryText !== '未知' && directCountrySel.options) {
          const exists = Array.from(directCountrySel.options).some(o => o.value === countryText);
          if (!exists && typeof document.createElement === 'function') {
            const opt = document.createElement('option');
            opt.value = countryText;
            opt.textContent = '🌐 ' + countryText;
            directCountrySel.appendChild?.(opt);
          }
        }
        directCountrySel.value = countryText;
      }
      if (directCurSel) {
        directCurSel.value = curText === 'NTD' ? 'TWD' : curText;
      }
    });

    // 刷新国家、订阅地区与币种直接选择器标签与选中高亮
    if (typeof refreshDirectCountryDisplay === 'function') {
      refreshDirectCountryDisplay(countryText);
    }
    if (typeof refreshDirectRegionDisplay === 'function') {
      refreshDirectRegionDisplay(regText);
    }
    if (typeof refreshDirectCurrencyDisplay === 'function') {
      refreshDirectCurrencyDisplay(curText);
    }

    const detAcq = el('p-det-acq');
    const tagAcq = el('p-det-acq-tag');
    if (detAcq) detAcq.textContent = localizeAcquisitionSource(ps.acquisitionSource || ps.acquisitionSourceName);
    if (tagAcq) {
      const isPromo = ps.acquisitionSource && ps.acquisitionSource !== 'normal_paid';
      tagAcq.style.display = isPromo ? 'inline-block' : 'none';
      tagAcq.textContent = isPromo ? t('plan.tag.promo') : '';
    }

    const detPrice = el('p-det-price');
    const tagPrice = el('p-det-price-tag');
    const isPresetMode = ps.priceMode === 'preset';
    const btnModePreset = el('btn-mode-preset');
    const btnModeCustom = el('btn-mode-custom');
    if (btnModePreset) setPillActive(btnModePreset, isPresetMode);
    if (btnModeCustom) setPillActive(btnModeCustom, !isPresetMode);

    if (detPrice) {
      const cycleText = localizeBillingCycleLabel(ps.billingCycle);
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        detPrice.textContent = `${curSymbol}0 · ${cycleText}`;
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        let cnyPart = '';
        if (ps.currency !== 'CNY' && ps.cnyFormatted) {
          const locCny = localizeCnyFormatted(ps.cnyFormatted);
          cnyPart = locCny ? ` (${locCny})` : '';
        }
        const paidFormatted = Number(ps.actualPricePaid) % 1 === 0 ? Number(ps.actualPricePaid) : Number(ps.actualPricePaid).toFixed(2);
        detPrice.textContent = `${curSymbol}${paidFormatted} · ${cycleText}${cnyPart}`;
      } else if (ps.priceRangeNote && ps.priceRangeNote !== '未知') {
        detPrice.textContent = ps.priceRangeNote.replace(/[（\(][^）\)]*[）\)]/g, '').trim();
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        detPrice.textContent = `${t('plan.tag.publicRef')} $${ps.officialPriceMonthly}${t('plan.summary.perMonth')}`;
      } else {
        detPrice.textContent = '—';
      }
    }
    if (tagPrice) {
      tagPrice.style.display = 'inline-block';
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        tagPrice.textContent = t('plan.tag.manualFree');
      } else if (ps.priceMode === 'custom' || ps.priceSource === 'custom') {
        tagPrice.textContent = t('plan.tag.userPaid');
      } else if (ps.priceSource === 'preset_region' || isPresetMode) {
        tagPrice.textContent = t('plan.tag.official');
      } else {
        tagPrice.textContent = t('plan.tag.publicRef');
      }
    }

    const dtVal = el('p-dt-validity');
    const ddVal = el('p-det-validity');
    if (dtVal && ddVal) {
      if (ps.validEndDate) {
        dtVal.style.display = 'block';
        ddVal.style.display = 'block';
        ddVal.textContent = ps.isExpired
          ? t('plan.validity.expired', { date: ps.validEndDate })
          : t('plan.validity.active', { date: ps.validEndDate });
        ddVal.style.color = ps.isExpired ? '#ef4444' : 'var(--ag-text-secondary)';
      } else {
        dtVal.style.display = 'none';
        ddVal.style.display = 'none';
      }
    }

    const dtNote = el('p-dt-note');
    const ddNote = el('p-det-note');
    if (dtNote && ddNote) {
      if (ps.customNote) {
        dtNote.style.display = 'block';
        ddNote.style.display = 'block';
        ddNote.textContent = String(ps.customNote);
      } else {
        dtNote.style.display = 'none';
        ddNote.style.display = 'none';
      }
    }

    const pPrompt = el('p-det-prompt-credits');
    const pFlow = el('p-det-flow-credits');
    if (pPrompt && ps.promptCredits) {
      const promptTxt = `Prompt Credits: ${t('plan.credits.avail', { avail: ps.promptCredits.available ?? '—', monthly: ps.promptCredits.monthly ?? '—' })}`;
      pPrompt.textContent = promptTxt;
      const pLegacy = el('p-det-credits');
      if (pLegacy) pLegacy.textContent = promptTxt;
    }
    if (pFlow && ps.flowCredits) {
      pFlow.textContent = t('plan.credits.avail', { avail: ps.flowCredits?.available ?? '—', monthly: ps.flowCredits?.monthly ?? '—' });
    }
    const detTime = el('p-det-time');
    if (detTime) {
      const timeStr = ps.updatedAt ? new Date(ps.updatedAt).toLocaleString() : '—';
      const verifyStr = ps.pricingTableVerifiedDate ? ` · ${ps.pricingTableVerifiedDate}` : '';
      detTime.textContent = `${timeStr}${verifyStr}`;
    }
  }

  function setPillActive(node, active) {
    if (!node) return;
    node.classList?.toggle?.('active', active);
    const cur = node.getAttribute('class') || 'switch-pill-btn';
    if (active) {
      if (!cur.includes('active')) node.setAttribute('class', (cur + ' active').trim());
    } else {
      node.setAttribute('class', cur.replace(/\bactive\b/g, '').trim());
    }
  }

  // 数据源切换（全部 / 桌面 / CLI）
  let activeTokenSource = 'all';
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch {}
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = bySrc[src] || bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      renderActiveHeatView(true);
      renderActiveCostEstimateView();
    }
  }
  el('src-tab-all')?.addEventListener('click', () => switchTokenSource('all'));
  el('src-tab-desktop')?.addEventListener('click', () => switchTokenSource('desktop'));
  el('src-tab-cli')?.addEventListener('click', () => switchTokenSource('cli'));

  // 视图切换（Token 统计 / API 等值估算）
  let activeTokenView = 'tokens';

  // 费用面板紧凑摘要与展开详情切换
  let costDetailsExpanded = false;
  function toggleCostDetails(expand) {
    if (expand === undefined) costDetailsExpanded = !costDetailsExpanded;
    else costDetailsExpanded = Boolean(expand);

    const pane = el('cost-details-pane');
    const btn = el('btn-cost-details-toggle');
    const pTokens = el('panel-tokens');

    if (pane) {
      pane.style.display = costDetailsExpanded ? 'block' : 'none';
      if (costDetailsExpanded) pane.style.animation = 'agFadeIn .2s cubic-bezier(0.16,1,0.3,1)';
    }
    if (btn) btn.textContent = costDetailsExpanded ? t('cost.btnCollapse') : t('cost.btnExpand');
    if (pTokens) {
      const isCompact = activeTokenView === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('cost-details-pane');
  el('cost-non-paid-badge');
  el('cost-scope-desc');
  el('tokens-main-view');
  el('btn-cost-details-toggle')?.addEventListener('click', () => toggleCostDetails());
  el('btn-cost-details-collapse')?.addEventListener('click', () => toggleCostDetails(false));
  el('btn-cost-fill-sub')?.addEventListener('click', () => {
    switchTokenView('tokens');
    setPlanDetailExpanded(true);
    togglePlanCustomForm(true);
  });
  toggleCostDetails(false);

  function switchTokenView(v) {
    activeTokenView = v;
    // 离开 Token 统计视图时关闭订阅详情与表单
    if (v !== 'tokens') {
      setPlanDetailExpanded(false, { skipReposition: true });
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
    }
    setPillActive(el('tok-view-tokens'), v === 'tokens');
    setPillActive(el('tok-view-cost'), v === 'cost');
    const costCard = el('cost-estimate-card');
    const tokensMain = el('tokens-main-view');
    const statCards = el('token-stat-cards');
    const planBar = el('plan-summary-bar');
    const titleTokens = el('panel-tokens-title');
    const pTokens = el('panel-tokens');

    if (costCard) {
      costCard.style.display = v === 'cost' ? 'block' : 'none';
      if (v === 'cost') costCard.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (tokensMain) {
      tokensMain.style.display = v === 'tokens' ? 'block' : 'none';
      if (v === 'tokens') tokensMain.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (statCards) statCards.style.display = v === 'tokens' ? 'grid' : 'none';
    if (planBar) planBar.style.display = v === 'tokens' ? 'flex' : 'none';
    if (titleTokens) titleTokens.textContent = v === 'cost' ? t('tokens.titleCost') : t('tokens.title');

    if (pTokens) {
      const isCompact = v === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('tok-view-tokens')?.addEventListener('click', () => switchTokenView('tokens'));
  el('tok-view-cost')?.addEventListener('click', () => switchTokenView('cost'));

  // =========================================================================
  // 一键启动 CLI 模式（当前项目目录绑定 + 中文/空格路径兼容 + 错误提示）
  // =========================================================================
  let cliLaunchBusy = false;
  let cliToastTimer = null;
  let lastCliLaunchResult = null;

  function showCliToast(message, isError = false) {
    const toast = el('cli-launch-toast');
    if (!toast) return;
    if (cliToastTimer) {
      clearTimeout(cliToastTimer);
      cliToastTimer = null;
    }
    toast.hidden = false;
    toast.setAttribute('data-tone', isError ? 'error' : 'info');
    toast.textContent = message;
    cliToastTimer = setTimeout(() => {
      toast.hidden = true;
      cliToastTimer = null;
    }, isError ? 5200 : 3200);
  }

  async function triggerLaunchCli(customOpts = {}) {
    if (cliLaunchBusy) {
      showCliToast(t('cli.busy'), false);
      return { ok: false, error: t('cli.busy') };
    }
    cliLaunchBusy = true;
    const btn = el('badge-cli');
    const label = el('cli-label');
    btn?.setAttribute('data-busy', 'true');
    if (label) label.textContent = '…';
    try {
      if (typeof document !== 'undefined' && document.activeElement?.blur) {
        document.activeElement.blur();
      }
    } catch {}

    const hostBounds = {
      x: typeof window !== 'undefined' ? (window.screenX || 0) : 0,
      y: typeof window !== 'undefined' ? (window.screenY || 0) : 0,
      width: typeof window !== 'undefined' ? (window.outerWidth || window.innerWidth || 1200) : 1200,
      height: typeof window !== 'undefined' ? (window.outerHeight || window.innerHeight || 800) : 800
    };

    const reqOpts = {
      cascadeId: state.route || undefined,
      cwd: customOpts.cwd !== undefined ? customOpts.cwd : (state.scan?.workspacePath || undefined),
      hostBounds,
      ...customOpts
    };
    try {
      let res = null;
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.launchCli === 'function') {
        res = await window.contextMeterAPI.launchCli(reqOpts);
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/launch-cli`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(reqOpts)
        });
        res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      } else {
        res = { ok: false, code: 'NO_BRIDGE', error: t('cli.noBridge') };
      }

      lastCliLaunchResult = res;
      if (res && res.ok) {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        showCliToast(t('cli.launched', { cwd: res.cwd || t('cli.defaultCwd') }), false);
        return res;
      } else {
        const errMsg = res?.error ? translateBackendText(res.error) : t('cli.notFound');
        showCliToast(t('cli.failed', { err: errMsg }), true);
        return res || { ok: false, error: errMsg };
      }
    } catch (err) {
      const errMsg = err?.message ? translateBackendText(err.message) : t('cli.exception');
      lastCliLaunchResult = { ok: false, error: errMsg };
      showCliToast(t('cli.failed', { err: errMsg }), true);
      return lastCliLaunchResult;
    } finally {
      cliLaunchBusy = false;
      btn?.removeAttribute('data-busy');
      btn?.removeAttribute('data-pressed');
      if (label) label.textContent = 'CLI';
    }
  }

  const badgeCliEl = el('badge-cli');
  if (badgeCliEl) {
    const releasePress = () => {
      badgeCliEl.removeAttribute('data-pressed');
    };
    badgeCliEl.addEventListener('pointerdown', () => {
      badgeCliEl.setAttribute('data-pressed', 'true');
    });
    badgeCliEl.addEventListener('pointerup', releasePress);
    badgeCliEl.addEventListener('pointercancel', releasePress);
    badgeCliEl.addEventListener('mouseleave', releasePress);
    badgeCliEl.addEventListener('blur', releasePress);
    badgeCliEl.addEventListener('click', () => {
      releasePress();
      void triggerLaunchCli();
    });
  }
  el('overflow-cli-btn')?.addEventListener('click', () => { void triggerLaunchCli(); });

  el('badge').addEventListener('click', toggleContext);
  el('badge-speed')?.addEventListener('click', toggleContext);
  el('badge-tokens').addEventListener('click', toggleTokens);
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-speed-btn')?.addEventListener('click', () => showPanel('context'));
  el('overflow-tokens-btn')?.addEventListener('click', () => showPanel('tokens'));
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));

  // 上下文圆环悬停与键盘聚焦气泡（面板打开时不通过悬停误切，必须通过显式左键点击切换）
  el('badge').addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showContextTooltip();
    }
  });
  el('badge').addEventListener('mouseleave', () => {
    hideContextTooltip();
  });
  el('badge').addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showContextTooltip();
  });
  el('badge').addEventListener('blur', () => {
    hideContextTooltip();
  });

  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('theme-toggle-tokens')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // =========================================================================
  // 模块 3: 上下文面板分页、设置视图、模型产品偏好、重启验证与速度对比
  // =========================================================================
  const btnTabSession = el('tab-ctx-session');
  const btnTabModels = el('tab-ctx-models');
  const btnTabSpeed = el('tab-ctx-speed');
  const btnTabSettings = el('tab-ctx-settings');
  const paneSession = el('pane-ctx-session');
  const paneModels = el('pane-ctx-models');
  const paneSpeed = el('pane-ctx-speed');
  const paneSettings = el('pane-ctx-settings');
  const ctxTabsBar = el('ctx-tabs-bar');
  const btnCtxSettings = el('btn-ctx-settings');
  const btnCtxSettingsBack = el('btn-ctx-settings-back');
  const btnGotoModelSettings = el('btn-goto-model-settings');
  const btnCardGotoSpeed = el('btn-card-goto-speed');
  const btnCtxBackCurrent = el('btn-ctx-back-current');
  const ctxCompactSavedEl = el('ctx-compact-saved');
  const ctxCompactClientEl = el('ctx-compact-client');

  const btnToggleUnlockDetails = el('btn-toggle-unlock-details');
  const unlockDrawerBody = el('unlock-drawer-body');
  const unlockDrawerArrow = el('unlock-drawer-arrow');
  const unlockBadge = el('unlock-badge');
  const unlockStatusDesc = el('unlock-status-desc');
  const ctxClientStatusText = el('ctx-client-status-text');
  const ctxRestartMismatchNote = el('ctx-restart-mismatch-note');
  const btnRestartHost = el('btn-restart-host');
  const ctxManualRestartNote = el('ctx-manual-restart-note');
  const ctxRestartConfirm = el('ctx-restart-confirm');
  const btnRestartCancel = el('btn-restart-cancel');
  const btnRestartConfirmGo = el('btn-restart-confirm-go');
  const ctxRestartFeedback = el('ctx-restart-feedback');
  const globalRestartModal = el('global-restart-modal');
  const modalRestartTitle = el('modal-restart-title');
  const modalRestartText = el('modal-restart-text');
  const modalRestartFeedback = el('modal-restart-feedback');
  const btnModalRestartCancel = el('btn-modal-restart-cancel');
  const btnModalRestartConfirm = el('btn-modal-restart-confirm');

  const btnApplyUnlock = el('btn-apply-unlock');
  const btnRestoreUnlock = el('btn-restore-unlock');
  const btnRefreshUnlock = el('btn-refresh-unlock');
  const unlockResultBox = el('unlock-result-box');
  const unlockResultText = el('unlock-result-text');
  const unlockResultActions = el('unlock-result-actions');
  const btnUnlockResultRestart = el('btn-unlock-result-restart');
  const btnUnlockResultRetry = el('btn-unlock-result-retry');
  const unlockResultManual = el('unlock-result-manual');
  const unlockMetaMode = el('unlock-meta-mode');
  const unlockMetaTarget = el('unlock-meta-target');
  const unlockMetaArch = el('unlock-meta-arch');
  const unlockMetaBackup = el('unlock-meta-backup');
  const linkUnlockAuthor = el('link-unlock-author');
  const btnCopyUnlockLink = el('btn-copy-unlock-link');
  const unlockLinkToast = el('unlock-link-toast');

  const ctxModelSelect = el('ctx-model-select');
  const ctxModelSelectorRoleEl = el('ctx-model-selector-role');
  const ctxModelDropdownLabelEl = el('ctx-model-dropdown-label');
  const ctxModelListEl = el('ctx-model-list');
  const ctxConflictBanner = el('ctx-conflict-banner');
  const ctxConflictRows = el('ctx-conflict-rows');
  const ctxCardVendorDot = el('ctx-card-vendor-dot');
  const ctxCardVendorName = el('ctx-card-vendor-name');
  const ctxCardProductName = el('ctx-card-product-name');
  const ctxCardEffortsList = el('ctx-card-efforts-list');
  const ctxCardSessionEffort = el('ctx-card-session-effort');
  const ctxCardSavedEl = el('ctx-card-saved');
  const ctxCardRequestEl = el('ctx-card-request');
  const ctxCardClientEl = el('ctx-card-client');
  const ctxCardClientTagEl = el('ctx-card-client-tag');
  const ctxCardObservedBudgetEl = el('ctx-card-observed-budget');
  const ctxCardPreRestartBudgetEl = el('ctx-card-pre-restart-budget');
  const ctxCardServiceLimitEl = el('ctx-card-service-limit');
  const ctxCardConvoEl = el('ctx-card-convo');
  const ctxCardDiagnosisEl = el('ctx-card-diagnosis');
  const ctxCardObservedSpeedEl = el('ctx-card-observed-speed');
  const ctxCardHintsEl = el('ctx-card-hints');
  const ctxCapWindowEl = el('ctx-cap-window');
  const ctxCapOutputEl = el('ctx-cap-output');
  const ctxCapModelMaxEl = el('ctx-cap-model-max');
  const ctxCapClientPolicyEl = el('ctx-cap-client-policy');
  const ctxCapDefaultEl = el('ctx-cap-default');
  const ctxCapRangeEl = el('ctx-cap-range');
  const ctxCapFormulaEl = el('ctx-cap-formula');
  const ctxRefSavedEl = el('ctx-ref-saved');
  const ctxRefSentEl = el('ctx-ref-sent');
  const ctxRefAdoptedEl = el('ctx-ref-adopted');
  const ctxUnifiedProjEl = el('ctx-unified-projection');
  const ctxCardTierCapsRowEl = el('ctx-card-tier-caps-row');
  const ctxCardTierCapsEl = el('ctx-card-tier-caps');
  const ctxPresetModelMaxSubEl = el('ctx-preset-modelmax-sub');

  const ctxPresetGrid = el('ctx-preset-grid');
  const ctxCustomInput = el('ctx-custom-limit-input');
  const ctxValidationEl = el('ctx-limit-validation');
  const btnSaveModelCtx = el('btn-save-model-ctx');
  const btnResetModelCtx = el('btn-reset-model-ctx');
  const ctxResetNoticeEl = el('ctx-reset-notice');

  // 双模式控件与精简展示元素
  const btnModeUnified = el('btn-ctx-mode-unified');
  const btnModePerModel = el('btn-ctx-mode-per-model');
  const ctxModelsToolbar = el('ctx-models-toolbar');
  const ctxSummaryModeEl = el('ctx-summary-mode');
  const ctxSummaryModelEl = el('ctx-summary-model');
  const ctxSummaryLengthEl = el('ctx-summary-length');
  const ctxSummaryStatusPillEl = el('ctx-summary-status-pill');

  const CTX_DEFAULT_TOKENS = 256000;
  const CTX_MIN_ENGINEERING_TOKENS = 16384;
  const CTX_MAX_ENGINEERING_TOKENS = 2097152;
  const CTX_ACTIVE_TAB_KEY = 'ag_ctx_active_tab';
  const CTX_PRE_RESTART_OBS_KEY = 'ag_ctx_pre_restart_obs_v1';

  const VENDOR_ORDER = ['Google', 'Anthropic', 'OpenAI', '其他'];
  const VENDOR_DOT_COLORS = {
    Google: 'var(--ag-custom-speed, var(--ag-speed-default, #38bdf8))',
    Anthropic: 'var(--ag-ring-warn, #f59e0b)',
    OpenAI: 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))',
    '其他': 'var(--ag-text-muted, #8a8a94)'
  };

  let activeContextTab = 'session';
  try {
    const savedTab = localStorage?.getItem(CTX_ACTIVE_TAB_KEY);
    if (savedTab === 'session' || savedTab === 'models' || savedTab === 'speed') {
      activeContextTab = savedTab;
    }
  } catch {}
  let isContextSettingsView = false;

  let currentUnlockStatus = null;
  let unlockStatusFetchError = false;
  let isUnlocking = false;
  let lastPartialReason = '';
  let unlockReqSeq = 0;
  let contextPrefSaveSeq = 0;
  let contextPreferencesMap = {};
  let contextScopeMode = 'unified'; // 'unified' | 'per_model'
  let contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  try {
    if (typeof window !== 'undefined' && window.__AGContextPreferences && typeof window.__AGContextPreferences === 'object') {
      contextPreferencesMap = { ...window.__AGContextPreferences };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawPrefs = localStorage.getItem('ag-context-preferences');
      if (rawPrefs) contextPreferencesMap = JSON.parse(rawPrefs) || {};
    }
    const initMode = (typeof window !== 'undefined' && window.__AGContextScopeMode)
      || (typeof localStorage !== 'undefined' && localStorage?.getItem?.('ag-context-scope-mode'))
      || '';
    if (initMode === 'unified' || initMode === 'per_model') {
      contextScopeMode = initMode;
    }
    if (typeof window !== 'undefined' && window.__AGContextUnifiedPreference && typeof window.__AGContextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...window.__AGContextUnifiedPreference };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawUni = localStorage.getItem('ag-context-unified-preference');
      if (rawUni) contextUnifiedPreference = JSON.parse(rawUni) || contextUnifiedPreference;
    }
  } catch {}

  function getContextScopeMode() {
    return contextScopeMode || 'unified';
  }

  function getContextUnifiedPreference() {
    return contextUnifiedPreference || { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  }

  function syncContextPreferencesCache(map) {
    try {
      if (typeof window !== 'undefined') {
        window.__AGContextPreferences = { ...(map || {}) };
        window.__AGContextScopeMode = contextScopeMode;
        window.__AGContextUnifiedPreference = { ...(contextUnifiedPreference || {}) };
        localStorage?.setItem('ag-context-preferences', JSON.stringify(map || {}));
        localStorage?.setItem('ag-context-scope-mode', contextScopeMode);
        localStorage?.setItem('ag-context-unified-preference', JSON.stringify(contextUnifiedPreference || {}));
      }
    } catch {}
  }
  let activeSessionModelKey = null;
  let activeSessionProductKey = null;
  let activeSessionEffort = null;
  let activeSessionModelConfirmed = false;
  let selectedEditModelKey = null;
  let selectedProductKey = null;
  let manualModelSelection = false;
  let ctxDraft = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  let ctxDraftDirty = false;
  let lastAutoObservedBudget = 0;
  let needsRestartAfterApply = false;
  let pendingRestartVerification = null;
  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;
  let restartMismatchNotice = '';

  const observedByModelId = new Map();
  let preRestartSnapshot = null;
  try {
    const rawPre = localStorage?.getItem(CTX_PRE_RESTART_OBS_KEY);
    if (rawPre) preRestartSnapshot = JSON.parse(rawPre);
  } catch {}

  let speedRangeDays = '7';
  let speedOriginFilter = 'all';
  let speedMetric = 'tps';
  let selectedSpeedExactModelId = null;
  let ctxHeaderDropdownCtrl = null;
  let speedModelDropdownCtrl = null;

  function formatKShort(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (typeof formatTokensK === 'function') return formatTokensK(n);
    return short(n);
  }

  function formatMonthDayTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatEffortZh(effort) {
    if (!effort) return '';
    const lang = typeof getPanelLanguage === 'function' ? getPanelLanguage() : 'zh-CN';
    if (typeof formatEffortLabel === 'function') return formatEffortLabel(effort, lang);
    return String(effort);
  }

  function groupProductSafe(input) {
    if (typeof groupModelProduct === 'function') return groupModelProduct(input || {});
    const rawId = String(input?.modelId || input?.label || 'unknown').trim();
    const low = rawId.toLowerCase();
    const vendor = low.includes('claude') ? 'Anthropic' : (low.includes('gpt') || low.includes('o1') || low.includes('o3')) ? 'OpenAI' : (low.includes('gemini') ? 'Google' : '其他');
    return { productKey: low, productLabel: input?.label || rawId, vendor, effort: input?.effort || null };
  }

  function resolveStableModelKeyClient(rawOrLatest) {
    if (!rawOrLatest) return null;
    if (typeof resolveStableModelId === 'function') {
      const resolved = resolveStableModelId(rawOrLatest, state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);
      if (resolved) return resolved;
    }
    if (typeof rawOrLatest === 'string') {
      const s = rawOrLatest.trim().toLowerCase();
      return s || null;
    }
    const str = String(rawOrLatest.modelId || rawOrLatest.modelRaw || rawOrLatest.model || '').trim().toLowerCase();
    return str || null;
  }

  // =========================================================================
  // ELV-41 / ELV-43: 官方模型选择器识别与多通道请求拦截注入器
  // 支持：主世界 LS 客户端装饰器、WebSocket (Lcc JSON)、Fetch/XHR (JSON / Envelope / Protobuf)
  // 严格过滤 StartCascade，仅拦截 SendUserCascadeMessage；不从面板配置卡猜测模型
  // =========================================================================
  const CTX_CONFIRM_TIMEOUT_MS = budgetEngine.DEFAULT_CONFIRM_TIMEOUT_MS || 45000;
  const budgetTracker = typeof budgetEngine.createContextBudgetTracker === 'function'
    ? budgetEngine.createContextBudgetTracker({ confirmTimeoutMs: CTX_CONFIRM_TIMEOUT_MS })
    : null;
  let lastDecoratorDispatchHint = null;
  const pendingConfirmTimers = new Set();

  function scheduleConfirmTimeoutCheck(delayMs = CTX_CONFIRM_TIMEOUT_MS + 100) {
    if (typeof setTimeout !== 'function' || state.disposed) return;
    const tId = setTimeout(() => {
      pendingConfirmTimers.delete(tId);
      if (state.disposed) return;
      try {
        renderCompactSessionCard();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
        }
      } catch {}
    }, delayMs);
    pendingConfirmTimers.add(tId);
  }

  function refreshBudgetUiAfterDispatch() {
    try {
      renderCompactSessionCard();
      const prod = getSelectedProductObj();
      if (prod) renderModelDetailCard(prod);
    } catch {}
  }

  /**
   * 仅从宿主真实输入框选择器读取当前选中模型（严格排除插件自身 #ag-context-meter DOM）
   */
  function extractHostSelectedModel() {
    if (typeof document === 'undefined') return null;
    const triggers = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]'))
      : (typeof document.querySelector === 'function' ? [document.querySelector('[data-testid="model-selector-trigger"]')].filter(Boolean) : []);
    if (!triggers.length) return null;

    let trigger = null;
    for (const candidate of triggers) {
      if (!candidate) continue;
      if (host && typeof host.contains === 'function' && host.contains(candidate)) continue;
      if (typeof candidate.closest === 'function' && candidate.closest('#ag-context-meter')) continue;
      if (typeof candidate.getBoundingClientRect === 'function') {
        const rect = candidate.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      trigger = candidate;
      break;
    }
    if (!trigger) return null;

    let effort = null;
    const effortEl = trigger.querySelector?.('[data-testid="model-selector-effort-option"]')
      || trigger.querySelector?.('[data-effort]');
    if (effortEl) {
      effort = effortEl.getAttribute?.('data-effort') || effortEl.textContent?.trim() || null;
    }

    const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
    const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
    if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
    const rawText = (clone.textContent || '').trim();
    if (!rawText) return null;

    if (!effort) {
      const mEffort = rawText.match(/\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)/i);
      if (mEffort) effort = mEffort[1];
    }

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const stableId = resolveStableModelKeyClient(rawText) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(rawText, configs) : null);
    const g = groupProductSafe({
      modelId: stableId || rawText,
      label: rawText,
      effort
    });

    return {
      rawText,
      modelId: stableId || rawText,
      productKey: g.productKey,
      productLabel: g.productLabel || rawText,
      effort: effort || g.effort || null,
      source: 'dom_trigger'
    };
  }

  function buildInterceptorContext(channel, urlOrProcedure = '', contentType = '') {
    return {
      channel,
      urlOrProcedure,
      contentType,
      scopeMode: getContextScopeMode(),
      unifiedPreference: getContextUnifiedPreference(),
      contextPreferencesMap: contextPreferencesMap || (typeof window !== 'undefined' ? window.__AGContextPreferences : null) || {},
      knownConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      verifiedConversationBindings: budgetTracker?.verifiedConversationBindings || {},
      groupProduct: groupProductSafe,
      resolveStableModelId: resolveStableModelKeyClient,
      minTokens: CTX_MIN_ENGINEERING_TOKENS,
      maxTokens: CTX_MAX_ENGINEERING_TOKENS
    };
  }

  function recordBudgetTransformDispatch(txResult) {
    if (!txResult || !txResult.handled || !budgetTracker) return null;
    if (txResult.uninjectable) {
      const rec = budgetTracker.beginDispatch({
        cascadeId: txResult.cascadeId || null,
        productKey: txResult.productKey || null,
        modelId: txResult.modelId || null,
        scopeMode: txResult.scopeMode,
        targetMode: txResult.targetMode || 'default',
        targetLimitTokens: txResult.targetLimitTokens ?? null,
        sentMode: 'passthrough',
        sentLimitTokens: null,
        channel: txResult.channel || 'http',
        status: 'uninjectable',
        reason: txResult.reason || 'uninjectable'
      });
      refreshBudgetUiAfterDispatch();
      return rec;
    }

    const rec = budgetTracker.beginDispatch({
      cascadeId: txResult.cascadeId || null,
      productKey: txResult.productKey || null,
      productLabel: txResult.productLabel || null,
      modelId: txResult.modelId || null,
      scopeMode: txResult.scopeMode,
      prefSnapshot: {
        mode: txResult.targetMode || 'default',
        limitTokens: txResult.targetLimitTokens ?? null
      },
      targetMode: txResult.targetMode,
      targetLimitTokens: txResult.targetLimitTokens,
      sentMode: txResult.sentMode,
      sentLimitTokens: txResult.sentLimitTokens,
      channel: txResult.channel || 'http',
      status: 'dispatched'
    });
    if (txResult.targetMode === 'fixed' || txResult.targetMode === 'dynamic' || txResult.targetMode === 'default') {
      scheduleConfirmTimeoutCheck();
    }
    refreshBudgetUiAfterDispatch();
    return rec;
  }

  function finishDispatchOutcome(dispatchId, ok, err) {
    if (!dispatchId || !budgetTracker) return;
    if (!ok) {
      const errMsg = String(err?.message || err || '');
      const isAbort = err?.name === 'AbortError' || /abort|cancel/i.test(errMsg);
      budgetTracker.updateDispatchStatus(dispatchId, {
        status: isAbort ? 'aborted' : 'send_failed',
        errorMessage: errMsg || (isAbort ? '请求已取消' : '发送失败')
      });
      refreshBudgetUiAfterDispatch();
    }
  }

  function installRequestInterceptor() {
    if (typeof window === 'undefined') return;
    if (window.__agRequestInterceptorInstalled) return;

    // 0. 绑定主世界冷启动客户端装饰器回调（序列化前修改真实请求对象）
    globalThis.__AG_METER_ON_SEND_MESSAGE__ = function(req, channel = 'client_object') {
      try {
        if (!req || typeof req !== 'object' || typeof budgetEngine.transformOutgoingSendRequest !== 'function') return null;
        const tx = budgetEngine.transformOutgoingSendRequest(req, buildInterceptorContext(channel, 'SendUserCascadeMessage'));
        if (!tx || !tx.handled) return null;
        const rec = recordBudgetTransformDispatch(tx);
        lastDecoratorDispatchHint = {
          ts: Date.now(),
          cascadeId: tx.cascadeId || null,
          productKey: tx.productKey || null,
          sentMode: tx.sentMode,
          sentLimitTokens: tx.sentLimitTokens ?? null,
          dispatchId: rec?.dispatchId || null
        };
        return rec ? { dispatchId: rec.dispatchId } : null;
      } catch (err) {
        console.warn('[ContextMeter] Client decorator hook error:', err);
        return null;
      }
    };
    globalThis.__AG_METER_ON_SEND_RESULT__ = function(dispatchId, ok, err) {
      finishDispatchOutcome(dispatchId, ok, err);
    };

    const isCoveredByRecentDecorator = (tx) => {
      if (!lastDecoratorDispatchHint) return false;
      const age = Date.now() - lastDecoratorDispatchHint.ts;
      if (age < 0 || age > 400) return false;
      const sameConv = (lastDecoratorDispatchHint.cascadeId || null) === (tx.cascadeId || null);
      const sameMode = lastDecoratorDispatchHint.sentMode === tx.sentMode
        && (lastDecoratorDispatchHint.sentLimitTokens ?? null) === (tx.sentLimitTokens ?? null);
      return sameConv && sameMode;
    };

    // 1. WebSocket.prototype.send interceptor (覆盖 Lcc ws://<host>/connect-websocket JSON 帧)
    if (typeof window.WebSocket === 'function' && window.WebSocket.prototype && typeof window.WebSocket.prototype.send === 'function') {
      const origWsSend = window.WebSocket.prototype.send;
      window.__agOrigWsSend = origWsSend;
      window.WebSocket.prototype.send = function(data) {
        let nextData = data;
        let rec = null;
        try {
          if (typeof budgetEngine.transformOutgoingSendRequest === 'function') {
            const tx = budgetEngine.transformOutgoingSendRequest(data, buildInterceptorContext('ws_frame', this?.url || ''));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                nextData = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] WebSocket interceptor error:', err);
        }
        try {
          return origWsSend.call(this, nextData);
        } catch (wsErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, wsErr);
          throw wsErr;
        }
      };
    }

    // 2. window.fetch interceptor (仅处理 SendUserCascadeMessage；严禁猜测 StartCascade)
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.__agOrigFetch = origFetch;
      window.fetch = async function(resource, init) {
        let rec = null;
        try {
          const urlStr = typeof resource === 'string'
            ? resource
            : (resource && resource.url ? resource.url : String(resource || ''));
          if (typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr) && init?.body) {
            const headersObj = init?.headers;
            let contentType = '';
            if (headersObj) {
              if (typeof headersObj.get === 'function') {
                contentType = headersObj.get('content-type') || headersObj.get('Content-Type') || '';
              } else if (typeof headersObj === 'object') {
                contentType = headersObj['content-type'] || headersObj['Content-Type'] || '';
              }
            }
            const tx = budgetEngine.transformOutgoingSendRequest(init.body, buildInterceptorContext('fetch', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                init = { ...init, body: tx.output };
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] Fetch request interceptor error:', err);
        }
        try {
          const response = await origFetch.call(this, resource, init);
          if (rec && response && response.ok === false) {
            finishDispatchOutcome(rec.dispatchId, false, new Error(`HTTP ${response.status || 'error'}`));
          }
          return response;
        } catch (fetchErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, fetchErr);
          throw fetchErr;
        }
      };
    }

    // 3. window.XMLHttpRequest interceptor
    if (typeof window.XMLHttpRequest === 'function') {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSetHdr = window.XMLHttpRequest.prototype.setRequestHeader;
      const origSend = window.XMLHttpRequest.prototype.send;
      window.__agOrigXhrOpen = origOpen;
      window.__agOrigXhrSetHdr = origSetHdr;
      window.__agOrigXhrSend = origSend;

      window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          this.__agRequestUrl = typeof url === 'string' ? url : String(url || '');
          this.__agRequestHeaders = {};
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      if (typeof origSetHdr === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          try {
            if (this.__agRequestHeaders && typeof name === 'string') {
              this.__agRequestHeaders[name.toLowerCase()] = String(value || '');
            }
          } catch {}
          return origSetHdr.call(this, name, value);
        };
      }

      window.XMLHttpRequest.prototype.send = function(body) {
        let rec = null;
        try {
          const urlStr = this.__agRequestUrl || '';
          if (body && typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr)) {
            const contentType = this.__agRequestHeaders?.['content-type'] || '';
            const tx = budgetEngine.transformOutgoingSendRequest(body, buildInterceptorContext('xhr', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                body = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] XHR request interceptor error:', err);
        }
        if (rec && typeof this.addEventListener === 'function') {
          const dId = rec.dispatchId;
          this.addEventListener('error', () => finishDispatchOutcome(dId, false, new Error('XHR network error')), { once: true });
          this.addEventListener('abort', () => finishDispatchOutcome(dId, false, Object.assign(new Error('XHR aborted'), { name: 'AbortError' })), { once: true });
          this.addEventListener('load', () => {
            if (typeof this.status === 'number' && this.status >= 400) {
              finishDispatchOutcome(dId, false, new Error(`HTTP ${this.status}`));
            }
          }, { once: true });
        }
        try {
          return origSend.call(this, body);
        } catch (xhrErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, xhrErr);
          throw xhrErr;
        }
      };
    }

    window.__agRequestInterceptorInstalled = true;
  }

  function uninstallRequestInterceptor() {
    if (typeof window === 'undefined') return;
    delete globalThis.__AG_METER_ON_SEND_MESSAGE__;
    delete globalThis.__AG_METER_ON_SEND_RESULT__;
    for (const tId of pendingConfirmTimers) clearTimeout(tId);
    pendingConfirmTimers.clear();
    if (window.__agOrigWsSend && window.WebSocket?.prototype) {
      window.WebSocket.prototype.send = window.__agOrigWsSend;
      delete window.__agOrigWsSend;
    }
    if (window.__agOrigFetch) {
      window.fetch = window.__agOrigFetch;
      delete window.__agOrigFetch;
    }
    if (window.__agOrigXhrOpen && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.open = window.__agOrigXhrOpen;
      delete window.__agOrigXhrOpen;
    }
    if (window.__agOrigXhrSetHdr && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.setRequestHeader = window.__agOrigXhrSetHdr;
      delete window.__agOrigXhrSetHdr;
    }
    if (window.__agOrigXhrSend && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.send = window.__agOrigXhrSend;
      delete window.__agOrigXhrSend;
    }
    window.__agRequestInterceptorInstalled = false;
  }

  function resolveRuntimeUnlockPolicyClient() {
    if (typeof budgetEngine.resolveRuntimeUnlockPolicy === 'function') {
      return budgetEngine.resolveRuntimeUnlockPolicy(currentUnlockStatus);
    }
    return null;
  }

  function formatDiskPolicyText(policy) {
    if (!policy) return '未知';
    if (policy.diskMode === 'dynamic') return 'Dynamic 动态跟随';
    if (policy.diskMode === 'fixed' && policy.diskLimitTokens) return `固定 ${fmt(policy.diskLimitTokens)} tokens`;
    if (policy.diskMode === 'default') return '默认 256,000 tokens';
    if (policy.diskMode === 'partial') return '部分异常';
    return '未知';
  }

  function getProductCapabilitySummary(product) {
    if (!product) return null;
    if (typeof budgetEngine.deriveModelCapabilitySummary === 'function') {
      return budgetEngine.deriveModelCapabilitySummary(product, currentUnlockStatus, state.modelCapabilitiesById || null);
    }
    return null;
  }

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
    }
  }

  function validateCustomLimitClient(rawInput, modeOverride = ctxDraft.mode, productOverride = null) {
    if (modeOverride === 'dynamic') {
      return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
    }
    if (modeOverride === 'default') {
      return { ok: true, mode: 'default', limitTokens: CTX_DEFAULT_TOKENS, warnings: [] };
    }
    const targetProd = productOverride || (contextScopeMode === 'per_model' ? getSelectedProductObj() : null);
    const capSummary = targetProd ? getProductCapabilitySummary(targetProd) : null;
    if (modeOverride === 'model_max') {
      if (contextScopeMode === 'unified') {
        return { ok: false, error: '统一模式下各模型容量不同，请改为具体整数或切回“按模型分别设置”后选择最大可用。' };
      }
      if (!capSummary || capSummary.modelTheoreticalMaxTokens == null) {
        return { ok: false, error: '尚未获取到当前模型的上下文窗口与最大输出元数据，暂无法自动计算最大可用预算。' };
      }
      if (!capSummary.runtimePolicy?.policyKnown || capSummary.maxAdjustableTokens == null) {
        return {
          ok: false,
          error: `当前客户端运行策略未知或待重启确认，暂无法计算当前环境最大可用上限（模型理论输入上限 ${fmt(capSummary.modelTheoreticalMaxTokens)} tokens）。`
        };
      }
      rawInput = capSummary.maxAdjustableTokens;
    }

    if (typeof budgetEngine.evaluateLimitInput === 'function') {
      const ev = budgetEngine.evaluateLimitInput(rawInput, capSummary, currentUnlockStatus, state.latest?.serviceLimit);
      if (!ev.ok) {
        if (ev.reasonCode === 'out_of_engineering_range') {
          return {
            ok: false,
            error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
          };
        }
        return { ok: false, error: t('models.custom.placeholder') };
      }
      const warnings = [];
      for (const w of ev.warnings) {
        if (w.code === 'exceeds_model_limit') {
          if (w.adoptableTokens != null) {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；若仍保存 ${fmt(w.limitTokens)}，当前环境预计最高仅可采用 ${fmt(w.adoptableTokens)} tokens。`);
          } else {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；当前客户端运行策略未确认，实际可采用上限未知。`);
          }
        } else if (w.code === 'requires_dynamic_unlock') {
          const cap = w.stockCap || 256000;
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前默认限制 ${fmt(cap)}：未开启 Dynamic 动态模式且未实机证实前，语言服务仍可能将其限制在 ${fmt(cap)} tokens（请点击“保存并应用”）。`);
        } else if (w.code === 'exceeds_fixed_client_limit') {
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前客户端固定限制 ${fmt(w.fixedCap)} tokens：未调整为更高固定值或启用 Dynamic 动态模式前，预计仍将被限制在 ${fmt(w.fixedCap)} tokens。`);
        } else if (w.code === 'unconfirmed_runtime_policy') {
          if (w.runtimeState === 'pending_restart') {
            warnings.push(`磁盘配置（${formatDiskPolicyText({ diskMode: w.diskMode, diskLimitTokens: w.diskLimitTokens })}）已变更但客户端尚未重启，运行中实际策略待确认，无法预测 ${fmt(w.limitTokens)} 是否会被采用。`);
          } else if (w.runtimeState === 'runtime_unconfirmed') {
            warnings.push(`仅读取到磁盘配置，尚未确认运行中进程已加载该策略；${fmt(w.limitTokens)} 实际能否采用需等待进程验证或实机请求确认。`);
          } else if (w.runtimeState === 'partial') {
            warnings.push(`检测到客户端处于部分异常状态，运行限制未知，无法预测 ${fmt(w.limitTokens)} 的实际采用结果。`);
          } else {
            warnings.push(`当前客户端运行策略未知，暂无法预测 ${fmt(w.limitTokens)} 在本机的实际采用上限（需先读取运行策略或实机发送验证）。`);
          }
        } else if (w.code === 'exceeds_service_limit') {
          warnings.push(t('models.validation.aboveService', { val: formatKShort(w.serviceLimit) }));
        } else if (w.code === 'below_recommended_floor') {
          warnings.push(t('models.validation.tooSmall', { val: fmt(w.limitTokens) }));
        }
      }
      return {
        ok: true,
        mode: 'fixed',
        limitTokens: ev.limitTokens,
        exceedsModelLimit: ev.exceedsModelLimit,
        exceedsClientPolicy: ev.exceedsClientPolicy,
        clientPolicyLimit: ev.clientPolicyLimit,
        runtimeState: ev.runtimeState,
        policyKnown: ev.policyKnown,
        adoptableTokens: ev.adoptableTokens,
        requiresDynamicUnlock: ev.requiresDynamicUnlock,
        warnings
      };
    }

    const rawStr = typeof rawInput === 'number' ? String(rawInput) : String(rawInput || '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    if (num < CTX_MIN_ENGINEERING_TOKENS || num > CTX_MAX_ENGINEERING_TOKENS) {
      return {
        ok: false,
        error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
      };
    }
    const warnings = [];
    if (num < 65536) {
      warnings.push(t('models.validation.tooSmall', { val: fmt(num) }));
    }
    const sLimit = Number(state.latest?.serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push(t('models.validation.aboveService', { val: formatKShort(sLimit) }));
    }
    return { ok: true, mode: 'fixed', limitTokens: num, warnings };
  }

  /** 将所有已知模型、当前会话和历史调用按产品维度分组 */
  function getKnownModelProducts() {
    const productMap = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];

    const slugToKey = new Map();
    const ensureProduct = (meta, fromAccountCatalog = false) => {
      const g = groupProductSafe(meta);
      if (!g.productKey) return null;
      const keyParts = g.productKey.split(':');
      const keySlug = keyParts.length >= 3 ? keyParts.slice(2).join(':') : '';
      let targetKey = g.productKey;
      // 若同一产品 slug 在列表里既有明确厂商又有"其他"厂商，合并到明确厂商条目下（不合并不同前缀或代际）
      if (keySlug && !productMap.has(targetKey) && slugToKey.has(keySlug)) {
        const existingKey = slugToKey.get(keySlug);
        const existingProd = productMap.get(existingKey);
        if (existingProd && (g.vendor === '其他' || existingProd.vendor === '其他')) {
          if (existingProd.vendor === '其他' && g.vendor !== '其他') {
            productMap.delete(existingKey);
            existingProd.productKey = targetKey;
            existingProd.vendor = g.vendor;
            productMap.set(targetKey, existingProd);
            slugToKey.set(keySlug, targetKey);
          } else {
            targetKey = existingKey;
          }
        }
      }
      let prod = productMap.get(targetKey);
      if (!prod) {
        prod = {
          productKey: targetKey,
          productLabel: g.productLabel,
          vendor: g.vendor || '其他',
          inAccountCatalog: Boolean(fromAccountCatalog),
          unavailable: Boolean(meta.unavailable),
          unavailabilityReason: meta.unavailabilityReason || null,
          notice: meta.notice || null,
          isHistorical: Boolean(meta.isHistorical),
          members: new Map()
        };
        productMap.set(targetKey, prod);
        if (keySlug && (!slugToKey.has(keySlug) || g.vendor !== '其他')) {
          slugToKey.set(keySlug, targetKey);
        }
      } else if (fromAccountCatalog) {
        prod.inAccountCatalog = true;
        if (meta.notice && !prod.notice) prod.notice = meta.notice;
        if (meta.isHistorical !== undefined) prod.isHistorical = prod.isHistorical && Boolean(meta.isHistorical);
      }
      if (meta.modelId) {
        const mid = String(meta.modelId).trim().toLowerCase();
        const prev = prod.members.get(mid);
        const capEntry = state.modelCapabilitiesById?.[mid.replace(/^model_/, '')]
          || state.modelCapabilitiesById?.[String(meta.modelOrAlias?.model || '').trim().toLowerCase().replace(/^model_/, '')]
          || null;
        prod.members.set(mid, {
          modelId: mid,
          label: meta.label || prev?.label || mid,
          effort: g.effort || prev?.effort || null,
          maxTokens: meta.maxTokens ?? capEntry?.maxTokens ?? prev?.maxTokens ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? capEntry?.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
          thinkingBudget: meta.thinkingBudget ?? capEntry?.thinkingBudget ?? prev?.thinkingBudget ?? null,
          minThinkingBudget: meta.minThinkingBudget ?? capEntry?.minThinkingBudget ?? prev?.minThinkingBudget ?? null,
          thinkingLevel: meta.thinkingLevel || capEntry?.thinkingLevel || prev?.thinkingLevel || null,
          supportsModelInfoOverride: meta.supportsModelInfoOverride ?? capEntry?.supportsModelInfoOverride ?? prev?.supportsModelInfoOverride ?? null,
          capabilitySource: meta.capabilitySource || capEntry?.capabilitySource || prev?.capabilitySource || null,
          unavailable: meta.unavailable !== undefined ? Boolean(meta.unavailable) : (prev?.unavailable || false),
          unavailabilityReason: meta.unavailabilityReason || prev?.unavailabilityReason || null,
          notice: meta.notice || prev?.notice || null,
          isHistorical: meta.isHistorical !== undefined ? Boolean(meta.isHistorical) : (prev?.isHistorical || false)
        });
      }
      return prod;
    };

    if (Array.isArray(configs)) {
      for (const c of configs) {
        const stableId = resolveStableModelKeyClient(c) || c?.modelId || c?.modelOrAlias?.model;
        ensureProduct({
          modelId: stableId,
          label: c?.label || c?.modelId || stableId,
          modelOrAlias: c?.modelOrAlias,
          effort: c?.effort,
          maxTokens: c?.maxTokens,
          maxOutputTokens: c?.maxOutputTokens,
          thinkingBudget: c?.thinkingBudget,
          minThinkingBudget: c?.minThinkingBudget,
          thinkingLevel: c?.thinkingLevel,
          supportsModelInfoOverride: c?.supportsModelInfoOverride,
          capabilitySource: c?.capabilitySource,
          unavailable: c?.unavailable,
          unavailabilityReason: c?.unavailabilityReason,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (state.latest?.modelId || state.latest?.modelRaw || state.latest?.model) {
      const stableId = resolveStableModelKeyClient(state.latest);
      ensureProduct({
        modelId: stableId,
        label: state.latest.model || stableId,
        modelOrAlias: state.latest.modelOrAlias,
        effort: state.latest.effort
      }, false);
    }

    const calls = [...(ANTIGRAVITY_TOKEN_DATA.speedRecords || []), ...(state.sessionCalls || [])];
    for (const c of calls) {
      if (!c) continue;
      const mid = c.modelExactId || c.modelId || c.model;
      if (!mid) continue;
      ensureProduct({
        modelId: mid,
        label: c.modelLabel || c.model || mid,
        effort: c.effort
      }, false);
    }

    for (const [k, pref] of Object.entries(contextPreferencesMap || {})) {
      if (!pref) continue;
      const g = groupProductSafe({
        modelId: pref.productKey || k,
        label: pref.label || k
      });
      if (pref.scope === 'product' || k === g.productKey) {
        ensureProduct({
          modelId: pref.productKey || k,
          label: pref.label || g.productLabel
        }, false);
      } else {
        ensureProduct({
          modelId: k,
          label: pref.label || k
        }, false);
      }
    }

    const rankEffort = { Minimal: 1, Low: 2, Medium: 3, High: 4, XHigh: 5, Extra: 6, 'Extra High': 7, Max: 8 };
    const result = Array.from(productMap.values()).map(p => {
      const members = Array.from(p.members.values()).sort((a, b) => (rankEffort[a.effort] || 99) - (rankEffort[b.effort] || 99));
      const allUnavailable = members.length > 0 && members.every(m => m.unavailable);
      const partialUnavailable = members.length > 0 && !allUnavailable && members.some(m => m.unavailable);
      const isUnavailable = members.length > 0 ? allUnavailable : Boolean(p.unavailable);
      const isHistorical = members.length > 0 ? (members.every(m => m.isHistorical) || !p.inAccountCatalog) : (p.isHistorical || (!p.inAccountCatalog));
      const notice = p.notice || members.find(m => m.notice)?.notice || null;
      const reason = isUnavailable
        ? (p.unavailabilityReason || members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null)
        : (partialUnavailable ? (members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null) : null);
      return {
        productKey: p.productKey,
        productLabel: p.productLabel,
        vendor: p.vendor,
        inAccountCatalog: p.inAccountCatalog,
        unavailable: isUnavailable,
        partialUnavailable,
        unavailabilityReason: reason,
        notice,
        isHistorical,
        members
      };
    });
    result.sort((a, b) => {
      const va = VENDOR_ORDER.indexOf(a.vendor);
      const vb = VENDOR_ORDER.indexOf(b.vendor);
      if (va !== vb) return (va === -1 ? 99 : va) - (vb === -1 ? 99 : vb);
      return a.productLabel.localeCompare(b.productLabel);
    });
    return result;
  }

  function formatSavedPrefLabel(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) {
      const num = Number(pref.limitTokens);
      if (num === 512000) return '512K';
      return t('models.card.savedCustom', { val: `${formatKShort(num)}（${fmt(num)}）` });
    }
    return t('status.savedDefault');
  }

  function formatPrefShortPill(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedShortDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) return formatKShort(pref.limitTokens);
    return t('status.savedShortDefault');
  }

  /** 解析当前产品的设置状态与旧档位迁移/冲突检测 */
  function resolveProductPreferenceState(product) {
    if (!product) {
      return { status: 'none', pref: null, displayText: t('status.savedDefault'), shortText: t('status.savedShortDefault'), legacyKeys: [], conflictEntries: [] };
    }
    const pKey = product.productKey;
    const direct = contextPreferencesMap?.[pKey];
    if (direct && (direct.scope === 'product' || (direct.productKey && direct.productKey === pKey))) {
      return {
        status: 'product',
        pref: direct,
        displayText: formatSavedPrefLabel(direct),
        shortText: formatPrefShortPill(direct),
        legacyKeys: [],
        conflictEntries: []
      };
    }

    const legacyEntries = [];
    const seenKeys = new Set();
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    for (const [k, rawPref] of Object.entries(contextPreferencesMap || {})) {
      if (!rawPref) continue;
      if (k === pKey && rawPref.scope === 'product') continue;
      const belonged = memberIds.has(k) || groupProductSafe({ modelId: k, label: rawPref.label || k }).productKey === pKey;
      if (!belonged) continue;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      const memberMeta = (product.members || []).find(m => m.modelId === k);
      const effortName = memberMeta?.effort || groupProductSafe({ modelId: k, label: rawPref.label || k }).effort;
      legacyEntries.push({
        legacyKey: k,
        effort: effortName,
        effortLabel: effortName ? formatEffortZh(effortName) : (rawPref.label || k),
        mode: rawPref.mode || 'default',
        limitTokens: rawPref.mode === 'fixed' ? Number(rawPref.limitTokens) : null,
        updatedAt: rawPref.updatedAt || null,
        label: rawPref.label || product.productLabel
      });
    }

    if (legacyEntries.length === 0) {
      if (direct) {
        return {
          status: 'product',
          pref: direct,
          displayText: formatSavedPrefLabel(direct),
          shortText: formatPrefShortPill(direct),
          legacyKeys: [],
          conflictEntries: []
        };
      }
      return { status: 'none', pref: null, displayText: t('models.pref.none'), shortText: t('models.pref.noneShort'), legacyKeys: [], conflictEntries: [] };
    }

    const sigs = new Map();
    for (const entry of legacyEntries) {
      const sig = `${entry.mode}:${entry.mode === 'fixed' ? (entry.limitTokens || 0) : ''}`;
      if (!sigs.has(sig)) sigs.set(sig, entry);
    }

    if (sigs.size === 1) {
      const unified = legacyEntries[0];
      const syntheticPref = {
        scope: 'product',
        productKey: pKey,
        modelId: pKey,
        label: product.productLabel,
        mode: unified.mode,
        limitTokens: unified.limitTokens,
        updatedAt: unified.updatedAt
      };
      return {
        status: 'legacy_uniform',
        pref: syntheticPref,
        displayText: formatSavedPrefLabel(syntheticPref),
        shortText: formatPrefShortPill(syntheticPref),
        legacyKeys: legacyEntries.map(e => e.legacyKey),
        conflictEntries: []
      };
    }

    return {
      status: 'conflict',
      pref: null,
      displayText: t('models.pref.inconsistent'),
      shortText: t('models.pref.inconsistent'),
      legacyKeys: legacyEntries.map(e => e.legacyKey),
      conflictEntries: legacyEntries
    };
  }

  function describeClientModeValue(data) {
    if (!data) return t('models.preset.default');
    if (data.configuredMode === 'dynamic') return t('models.preset.dynamic');
    if (data.configuredMode === 'fixed' && data.configuredLimitTokens) {
      return formatKShort(data.configuredLimitTokens);
    }
    return t('models.preset.default');
  }

  function doesClientMatchVerification(data, ver) {
    if (!data || !ver) return false;
    const mode = data.configuredMode || 'unknown';
    if (ver.mode === 'dynamic') return mode === 'dynamic';
    if (ver.mode === 'default') return mode === 'default' || data.status === 'not_patched';
    if (ver.mode === 'fixed') return mode === 'fixed' && Number(data.configuredLimitTokens) === Number(ver.limitTokens);
    return false;
  }

  /** 将状态 strictly 映射为规定的 5 个普通视图标签之一 */
  function mapUnlockDisplayStatus(data) {
    if (unlockStatusFetchError) {
      return { badge: t('status.badge.unavailable'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    if (!data) {
      return { badge: t('status.badge.reading'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    const raw = data.status;
    const restarted = data.runtimeEvidence?.restartDetected === true;

    if (raw === 'patched_pending_restart') {
      return { badge: t('status.badge.pendingRestart'), pillClass: 'pill-warn', effectiveLoaded: false };
    }
    if (raw === 'not_patched') {
      return { badge: t('status.badge.notPatched'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    if (raw === 'patched_loaded') {
      if (!restarted) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
      }
      if ((pendingRestartVerification && !doesClientMatchVerification(data, pendingRestartVerification)) || restartMismatchNotice) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-warn', effectiveLoaded: false };
      }
      return { badge: t('status.badge.loaded'), pillClass: 'pill-ok', effectiveLoaded: true };
    }
    if (raw === 'patched_runtime_unconfirmed') {
      return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
    }
    if (raw === 'partial_match') {
      return { badge: t('status.badge.partialMatch'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    return { badge: t('status.badge.failed'), pillClass: 'pill-danger', effectiveLoaded: false };
  }

  function buildFriendlyWriteError(rawErr) {
    const msg = String(rawErr || '');
    if (/EBUSY|EPERM|EACCES|占用|lock|locked|in use/i.test(msg)) {
      return t('msg.writeBusy');
    }
    return t('msg.writeFail', { err: translateBackendText(msg) || t('msg.unknownErr') });
  }

  function applyContextViewVisibility() {
    if (ctxTabsBar) ctxTabsBar.hidden = false;
    if (paneSettings) paneSettings.hidden = activeContextTab !== 'settings';
    if (paneSession) paneSession.hidden = activeContextTab !== 'session';
    if (paneModels) paneModels.hidden = activeContextTab !== 'models';
    if (paneSpeed) paneSpeed.hidden = activeContextTab !== 'speed';

    setPillActive(btnTabSession, activeContextTab === 'session');
    setPillActive(btnTabModels, activeContextTab === 'models');
    setPillActive(btnTabSpeed, activeContextTab === 'speed');
    setPillActive(btnTabSettings, activeContextTab === 'settings');
    btnTabSession?.setAttribute('aria-selected', String(activeContextTab === 'session'));
    btnTabModels?.setAttribute('aria-selected', String(activeContextTab === 'models'));
    btnTabSpeed?.setAttribute('aria-selected', String(activeContextTab === 'speed'));
    btnTabSettings?.setAttribute('aria-selected', String(activeContextTab === 'settings'));
  }

  let prevTabBeforeSettings = 'models';

  function switchContextTab(tabName) {
    if (tabName !== 'session' && tabName !== 'models' && tabName !== 'speed' && tabName !== 'settings') return;
    if (activeContextTab !== 'settings') {
      prevTabBeforeSettings = activeContextTab;
    }
    activeContextTab = tabName;
    isContextSettingsView = tabName === 'settings';
    try { localStorage?.setItem(CTX_ACTIVE_TAB_KEY, tabName); } catch {}
    applyContextViewVisibility();
    if (tabName === 'models') {
      renderModelSettingsTab();
      if (!currentUnlockStatus && !unlockStatusFetchError) {
        void refreshUnlockStatus();
      }
    } else if (tabName === 'speed') {
      // 速度对比页只读取已有本地记录，绝不发起任何请求或 IPC
      renderSpeedComparisonTab();
    } else if (tabName === 'settings') {
      void refreshModulesDisplay();
      if (typeof refreshEnhanceStatus === 'function') void refreshEnhanceStatus();
    }
    positionFloatingPanels();
  }

  function openContextSettings(opts = {}) {
    if (el('panel')?.hidden) showPanel('context');
    switchContextTab('settings');
    if (opts.openColors) {
      toggleColorsDrawer(true);
    }
    positionFloatingPanels();
  }

  function closeContextSettings() {
    switchContextTab(prevTabBeforeSettings || 'models');
    positionFloatingPanels();
  }

  btnTabSession?.addEventListener('click', () => switchContextTab('session'));
  btnTabModels?.addEventListener('click', () => switchContextTab('models'));
  btnTabSpeed?.addEventListener('click', () => switchContextTab('speed'));
  btnTabSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettingsBack?.addEventListener('click', () => closeContextSettings());

  btnGotoModelSettings?.addEventListener('click', () => {
    if (activeSessionProductKey) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
      manualModelSelection = false;
      ctxDraftDirty = false;
    }
    switchContextTab('models');
  });

  btnCardGotoSpeed?.addEventListener('click', () => {
    const products = getKnownModelProducts();
    const curProd = products.find(p => p.productKey === selectedProductKey) || products[0];
    if (curProd) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const targetMember = curProd.members.find(m => m.modelId === activeSessionModelKey)
        || curProd.members.find(m => mergedCalls.some(c => c.modelExactId === m.modelId && isValidSpeedSampleSafe(c)))
        || curProd.members[0];
      if (targetMember) selectedSpeedExactModelId = targetMember.modelId;
    }
    switchContextTab('speed');
  });

  btnCtxBackCurrent?.addEventListener('click', () => {
    const hostSelected = extractHostSelectedModel();
    if (hostSelected && hostSelected.productKey) {
      activeSessionModelKey = hostSelected.modelId;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
      }
    }
    if (!activeSessionModelConfirmed || !activeSessionProductKey) {
      if (typeof showToastNotification === 'function') {
        showToastNotification(t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      } else {
        showUnlockResultBox(false, t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      }
      return;
    }
    manualModelSelection = false;
    selectedProductKey = activeSessionProductKey;
    selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function toggleUnlockDrawer(forceOpen) {
    if (!unlockDrawerBody) return;
    const isHidden = unlockDrawerBody.style.display === 'none' || !unlockDrawerBody.style.display;
    const nextOpen = forceOpen === undefined ? isHidden : Boolean(forceOpen);
    unlockDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (unlockDrawerArrow) unlockDrawerArrow.textContent = nextOpen ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleUnlockDetails?.setAttribute('aria-expanded', String(nextOpen));
    if (nextOpen && !currentUnlockStatus) void refreshUnlockStatus();
  }

  btnToggleUnlockDetails?.addEventListener('click', () => toggleUnlockDrawer());

  function getSelectedProductObj() {
    const products = getKnownModelProducts();
    if (!products.length) return null;
    if (selectedProductKey) {
      const found = products.find(p => p.productKey === selectedProductKey);
      if (found) return found;
    }
    if (activeSessionProductKey) {
      const activeFound = products.find(p => p.productKey === activeSessionProductKey);
      if (activeFound) return activeFound;
    }
    return products[0];
  }

  function renderHeaderModelDropdown() {
    const products = getKnownModelProducts();
    if (!selectedProductKey && products.length) {
      selectedProductKey = activeSessionProductKey || products[0].productKey;
    }
    const currentProd = products.find(p => p.productKey === selectedProductKey) || products[0] || null;
    if (currentProd) {
      selectedProductKey = currentProd.productKey;
      selectedEditModelKey = (activeSessionProductKey === currentProd.productKey && activeSessionModelKey)
        ? activeSessionModelKey
        : (currentProd.members[0]?.modelId || currentProd.productKey);
    }

    if (ctxModelSelectorRoleEl) {
      ctxModelSelectorRoleEl.textContent = t('panel.ctx.viewModel');
    }
    if (btnCtxBackCurrent) {
      btnCtxBackCurrent.hidden = !(manualModelSelection && activeSessionModelConfirmed && activeSessionProductKey && selectedProductKey && selectedProductKey !== activeSessionProductKey);
    }

    if (ctxModelSelect && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      if (typeof ctxModelSelect.replaceChildren === 'function') {
        const opts = [];
        for (const p of products) {
          const opt = document.createElement('option');
          opt.value = p.productKey;
          const pState = resolveProductPreferenceState(p);
          opt.textContent = `${p.productLabel} (${pState.shortText})${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          opts.push(opt);
        }
        ctxModelSelect.replaceChildren(...opts);
        if (selectedProductKey) ctxModelSelect.value = selectedProductKey;
      }
    }

    if (ctxModelDropdownLabelEl) {
      ctxModelDropdownLabelEl.textContent = currentProd ? currentProd.productLabel : t('models.dropdown.empty');
    }

    if (!ctxHeaderDropdownCtrl && typeof initDropdownController === 'function' && el('ctx-model-dropdown-wrap')) {
      ctxHeaderDropdownCtrl = initDropdownController({
        wrapId: 'ctx-model-dropdown-wrap',
        triggerId: 'ctx-model-dropdown-trigger',
        labelId: 'ctx-model-dropdown-label',
        menuId: 'ctx-model-dropdown-menu',
        selectId: 'ctx-model-select',
        emptyLabel: () => t('models.dropdown.empty'),
        searchPlaceholder: () => t('dropdown.modelSearch'),
        emptyText: () => t('dropdown.modelEmpty'),
        getSelectedValue: () => selectedProductKey || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
          selectedProductKey = val;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        },
        getOptions: () => {
          const list = getKnownModelProducts();
          const items = [];
          const activeList = list.filter(p => p.inAccountCatalog);
          const historyList = list.filter(p => !p.inAccountCatalog);
          let lastVendor = '';
          for (const p of activeList) {
            if (p.vendor !== lastVendor) {
              lastVendor = p.vendor;
              items.push({
                value: `__group_${p.vendor}`,
                label: formatVendorLabel(p.vendor),
                isGroupHeader: true,
                dotColor: VENDOR_DOT_COLORS[p.vendor] || VENDOR_DOT_COLORS['其他']
              });
            }
            const pState = resolveProductPreferenceState(p);
            items.push({
              value: p.productKey,
              label: p.productLabel,
              displayRight: pState.shortText,
              badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : '',
              aliases: [p.vendor, p.productKey]
            });
          }
          if (historyList.length) {
            items.push({
              value: '__group_history',
              label: t('models.list.historyGroup'),
              isGroupHeader: true,
              dotColor: VENDOR_DOT_COLORS['其他']
            });
            for (const p of historyList) {
              const pState = resolveProductPreferenceState(p);
              items.push({
                value: p.productKey,
                label: p.productLabel,
                displayRight: pState.shortText,
                badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : t('models.list.historyTag'),
                aliases: [p.vendor, p.productKey]
              });
            }
          }
          return items;
        }
      });
    } else if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.refresh === 'function') {
      ctxHeaderDropdownCtrl.refresh();
    }
  }

  ctxModelSelect?.addEventListener('change', (e) => {
    const val = e?.target?.value || '';
    if (!val) return;
    manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
    selectedProductKey = val;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function renderCompactSessionCard() {
    const scopeMode = getContextScopeMode();
    if (ctxCompactSavedEl) {
      if (scopeMode === 'unified') {
        ctxCompactSavedEl.textContent = formatSavedPrefLabel(contextUnifiedPreference);
      } else if (!activeSessionModelConfirmed || !activeSessionProductKey) {
        ctxCompactSavedEl.textContent = t('panel.ctx.currentModelUnconfirmed') || '当前模型待确认';
      } else {
        const products = getKnownModelProducts();
        const targetProd = products.find(p => p.productKey === activeSessionProductKey) || null;
        const pState = resolveProductPreferenceState(targetProd);
        ctxCompactSavedEl.textContent = pState.pref == null && pState.status === 'none' ? t('status.savedDefault') : pState.displayText;
      }
    }
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCompactClientEl) {
      if (unlockStatusFetchError) {
        ctxCompactClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCompactClientEl.textContent = t('status.badge.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${t('models.status.pendingRestart') || statusInfo.badge}）`;
      } else {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${statusInfo.badge}）`;
      }
    }
  }

  function renderClientStatusBar() {
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (unlockBadge) {
      unlockBadge.textContent = statusInfo.badge;
      unlockBadge.className = `key-pill ${statusInfo.pillClass}`;
    }

    if (ctxClientStatusText) {
      if (unlockStatusFetchError) {
        ctxClientStatusText.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxClientStatusText.textContent = t('status.client.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxClientStatusText.textContent = t('status.client.pendingRestart', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'dynamic') {
        ctxClientStatusText.textContent = t('status.client.loadedDynamic');
      } else if (currentUnlockStatus.configuredMode === 'fixed' || currentUnlockStatus.limitTokens) {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'default' || currentUnlockStatus.status === 'unpatched_official') {
        ctxClientStatusText.textContent = t('status.client.loadedDefault');
      } else {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      }
    }

    if (ctxRestartMismatchNote) {
      if (restartMismatchNotice) {
        ctxRestartMismatchNote.textContent = restartMismatchNotice;
        ctxRestartMismatchNote.hidden = false;
      } else {
        ctxRestartMismatchNote.hidden = true;
      }
    }

    const showRestart = needsRestartAfterApply || currentUnlockStatus?.status === 'patched_pending_restart';
    const isErrorStatus = currentUnlockStatus?.status === 'partial_match' || currentUnlockStatus?.status === 'failed';
    if (btnRestartHost) {
      btnRestartHost.hidden = !showRestart || !hostSupportsRestart;
    }
    if (ctxManualRestartNote) {
      ctxManualRestartNote.hidden = hostSupportsRestart || !showRestart;
    }
    if (btnUnlockResultRestart) {
      btnUnlockResultRestart.hidden = !showRestart || !hostSupportsRestart;
    }
    if (btnUnlockResultRetry) {
      btnUnlockResultRetry.hidden = !isErrorStatus;
    }
    if (unlockResultManual) {
      unlockResultManual.hidden = !(showRestart && !hostSupportsRestart);
    }
    if (unlockResultActions) {
      const hasAction = (showRestart && hostSupportsRestart) || isErrorStatus;
      unlockResultActions.hidden = !hasAction;
    }
    const btnEnhanceRestart = el('btn-enhance-restart-host');
    if (btnEnhanceRestart) {
      btnEnhanceRestart.hidden = !(showRestart && hostSupportsRestart);
    }
  }

  function renderModelListGroup(products) {
    if (!ctxModelListEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (!products.length) {
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const accountProducts = hasAccountCatalog ? products.filter(p => p.inAccountCatalog) : products;
    const historyProducts = hasAccountCatalog ? products.filter(p => !p.inAccountCatalog) : [];

    const appendGroupRows = (fragNodes, vendor, list, isHistoryGroup = false) => {
      const grp = document.createElement('div');
      grp.className = 'ctx-model-group';

      const hdr = document.createElement('div');
      hdr.className = isHistoryGroup ? 'ctx-model-group-hdr is-history-hdr' : 'ctx-model-group-hdr';
      const dot = document.createElement('span');
      dot.className = 'ag-vendor-dot';
      if (dot.style) dot.style.background = VENDOR_DOT_COLORS[vendor] || VENDOR_DOT_COLORS['其他'];
      const vTxt = document.createElement('span');
      vTxt.textContent = isHistoryGroup ? t('models.list.historyGroup') : formatVendorLabel(vendor);
      hdr.appendChild(dot);
      hdr.appendChild(vTxt);
      grp.appendChild(hdr);

      for (const prod of list) {
        const pState = resolveProductPreferenceState(prod);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `ctx-product-row${prod.productKey === selectedProductKey ? ' is-active' : ''}${prod.unavailable ? ' is-unavailable' : ''}`;
        row.setAttribute('data-product-key', prod.productKey);

        const left = document.createElement('span');
        left.className = 'ctx-product-row-left';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ctx-product-row-name';
        nameSpan.textContent = prod.productLabel;
        left.appendChild(nameSpan);

        if (prod.unavailable) {
          const unavailTag = document.createElement('span');
          unavailTag.className = 'ctx-product-row-unavailable-tag';
          unavailTag.textContent = t('models.card.modelUnavailable') || '不可用';
          if (prod.unavailabilityReason) unavailTag.title = prod.unavailabilityReason;
          left.appendChild(unavailTag);
        } else if (prod.notice) {
          const noticeTag = document.createElement('span');
          noticeTag.className = 'ctx-product-row-notice-tag';
          noticeTag.textContent = 'Notice';
          noticeTag.title = typeof prod.notice === 'string' ? prod.notice : JSON.stringify(prod.notice);
          left.appendChild(noticeTag);
        }

        if (prod.productKey === activeSessionProductKey) {
          const curTag = document.createElement('span');
          curTag.className = 'ag-dropdown-badge';
          curTag.textContent = t('models.list.currentTag');
          left.appendChild(curTag);
        } else if (isHistoryGroup || prod.isHistorical) {
          const histTag = document.createElement('span');
          histTag.className = 'ctx-product-row-history-tag';
          histTag.textContent = t('models.list.historyTag');
          left.appendChild(histTag);
        }

        const right = document.createElement('span');
        right.className = 'ctx-product-row-right';
        const valSpan = document.createElement('span');
        valSpan.className = `ctx-product-row-val${pState.status === 'conflict' ? ' is-conflict' : ''}`;
        valSpan.textContent = pState.shortText;
        right.appendChild(valSpan);

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => {
          manualModelSelection = Boolean(activeSessionProductKey && prod.productKey !== activeSessionProductKey);
          selectedProductKey = prod.productKey;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        });
        grp.appendChild(row);
      }
      fragNodes.push(grp);
    };

    const groups = new Map();
    for (const p of accountProducts) {
      if (!groups.has(p.vendor)) groups.set(p.vendor, []);
      groups.get(p.vendor).push(p);
    }
    const fragNodes = [];
    for (const [vendor, list] of groups.entries()) {
      appendGroupRows(fragNodes, vendor, list, false);
    }
    if (historyProducts.length > 0) {
      appendGroupRows(fragNodes, '其他', historyProducts, true);
    }
    if (typeof ctxModelListEl.replaceChildren === 'function') {
      ctxModelListEl.replaceChildren(...fragNodes);
    }
  }

  function findLatestProductObservation(product, activeConvId = null) {
    if (!product) return { latestBudgetObs: null, latestServiceLimitObs: null };
    const scoped = budgetTracker ? budgetTracker.getScopedObservation(activeConvId, product.productKey) : null;
    if (scoped) {
      return {
        latestBudgetObs: scoped.budget > 0 ? scoped : null,
        latestServiceLimitObs: scoped.serviceLimit > 0 ? scoped : null
      };
    }
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let latestBudgetObs = null;
    let latestServiceLimitObs = null;

    for (const mid of memberIds) {
      const obs = observedByModelId.get(mid);
      if (!obs) continue;
      if (activeConvId && obs.convoId && obs.convoId !== activeConvId) continue;
      if (obs.budget > 0 && (!latestBudgetObs || obs.ts > latestBudgetObs.ts)) {
        latestBudgetObs = obs;
      }
      if (obs.serviceLimit > 0 && (!latestServiceLimitObs || obs.ts > latestServiceLimitObs.ts)) {
        latestServiceLimitObs = obs;
      }
    }
    return { latestBudgetObs, latestServiceLimitObs };
  }

  function findPreRestartBudgetForProduct(product) {
    if (!product || !preRestartSnapshot?.observations) return null;
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let best = null;
    for (const mid of memberIds) {
      const obs = preRestartSnapshot.observations[mid];
      if (obs && obs.budget > 0 && (!best || obs.ts > best.ts)) best = obs;
    }
    return best;
  }

  async function resolveProductConflict(product, chosenEntry) {
    if (!product || !chosenEntry) return;
    const legacyKeys = resolveProductPreferenceState(product).legacyKeys;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('models.toast.saveFailed', { err: translateBackendText(res?.error) || t('models.err.saveFailed') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[product.productKey] = {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    showUnlockResultBox(true, t('models.toast.savedUniform'));
  }

  function evaluateModelContextStatus(product) {
    if (!product) {
      return {
        status: 'unconfirmed',
        badge: t('panel.ctx.currentModelUnconfirmed') || '待确认',
        pillClass: 'pill-muted',
        diagnosis: '未获取到模型信息',
        targetText: '—',
        requestText: '—',
        observedText: '—',
        convoId: '—'
      };
    }

    const pState = resolveProductPreferenceState(product);
    const scopeMode = getContextScopeMode();
    const activePref = (scopeMode === 'unified') ? contextUnifiedPreference : pState.pref;
    const targetMode = activePref?.mode || 'default';
    const targetLimit = (targetMode === 'fixed') ? Number(activePref?.limitTokens) : null;
    const capSummary = getProductCapabilitySummary(product);

    let targetText = t('status.savedDefault') || '恢复客户端默认';
    if (targetMode === 'dynamic') {
      targetText = t('models.preset.dynamic') || '动态跟随';
    } else if (targetMode === 'fixed' && targetLimit) {
      targetText = (targetLimit === 512000) ? '512K（512,000 tokens）' : `${formatKShort(targetLimit)}（${fmt(targetLimit)} tokens）`;
    }

    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;
    const evalCore = budgetTracker
      ? budgetTracker.evaluateStatus({
        product,
        scopeMode,
        pref: activePref,
        activeConvId,
        modelHardLimit: capSummary?.modelTheoreticalMaxTokens || null
      })
      : {
        status: 'saved_pending_dispatch',
        convoId: activeConvId || '—',
        targetMode,
        targetLimit,
        dispatched: null,
        observation: findLatestProductObservation(product, activeConvId).latestBudgetObs
      };

    const dispatched = evalCore.dispatched;
    const obs = evalCore.observation;
    const obsBudget = Number(obs?.budget || 0);

    let requestText = dispatched ? '默认透传（未附加自定义参数）' : '尚无本次验证';
    if (dispatched) {
      if (dispatched.status === 'send_failed') {
        requestText = `发送失败（${dispatched.errorMessage || '请求未完成'}）`;
      } else if (dispatched.status === 'aborted') {
        requestText = '已取消发送';
      } else if (dispatched.status === 'uninjectable') {
        requestText = '透传未注入（缺少可靠模型/不支持帧）';
      } else if (dispatched.sentMode === 'fixed' && dispatched.sentLimitTokens) {
        requestText = `${formatKShort(dispatched.sentLimitTokens)}（${fmt(dispatched.sentLimitTokens)} tokens）`;
      } else if (dispatched.sentMode === 'dynamic') {
        requestText = '动态跟随（已清除固定数值）';
      }
      if (dispatched.timestamp) {
        requestText += ` · ${formatMonthDayTime(dispatched.timestamp)}`;
      }
    }

    function statusUsesExistingObs(st, diagCode) {
      return st === 'confirmed'
        || st === 'clamped_by_model_limit'
        || st === 'mismatch'
        || (st === 'default' && diagCode === 'default_confirmed');
    }

    let observedText = '尚无本次验证';
    if (obsBudget > 0 && statusUsesExistingObs(evalCore.status, evalCore.diagnosisCode)) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      const tTxt = obs.ts ? ` · ${formatMonthDayTime(obs.ts)}` : '';
      observedText = `${formatKShort(obsBudget)}（${fmt(obsBudget)} tokens）${effTxt}${tTxt}`;
    } else if (obsBudget > 0) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      observedText = `仅见历史观测 ${fmt(obsBudget)} tokens${effTxt}（当前设置尚无本次验证）`;
    }

    const convoId = evalCore.convoId || activeConvId || '—';

    let status = evalCore.status;
    let badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
    let pillClass = 'pill-muted';
    let diagnosis = '已保存目标参数，将在下次发起请求时自动注入并发送。';

    if (status === 'default') {
      if (evalCore.diagnosisCode === 'default_confirmed') {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-good';
        diagnosis = `本次请求已按客户端默认透传（未附加自定义覆盖），收到新回复确认实际采用 ${fmt(obsBudget)} tokens。`;
      } else {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-muted';
        diagnosis = '已恢复/保持客户端默认（不附加覆盖参数），将在下一次发送时生效并验证实际采用值。';
      }
    } else if (status === 'send_failed') {
      badge = '发送失败（未确认）';
      pillClass = 'pill-bad';
      diagnosis = `本次请求发送失败（${evalCore.errorMessage || '网络或传输错误'}），因此无法确认实际预算。`;
    } else if (status === 'aborted') {
      badge = '已取消（未确认）';
      pillClass = 'pill-muted';
      diagnosis = '本次请求在完成前被取消，未收到新回复。';
    } else if (status === 'uninjectable') {
      badge = '本次未注入（已透传）';
      pillClass = 'pill-warn';
      diagnosis = `未能向本次请求自动注入参数（${evalCore.diagnosisCode || '缺少可靠模型身份或协议格式不支持'}），已保持原样透传。`;
    } else if (status === 'confirmed') {
      badge = t('models.status.confirmed') || '实际预算已确认';
      pillClass = 'pill-good';
      diagnosis = targetMode === 'dynamic'
        ? `已启用动态跟随模式，本次发送后实测返回预算 ${fmt(obsBudget)} tokens。`
        : `请求实际携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次发送后服务端返回预算 ${fmt(obsBudget)} tokens，完全吻合。`;
    } else if (status === 'clamped_by_model_limit') {
      badge = '受模型上限限制';
      pillClass = 'pill-warn';
      diagnosis = `请求携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/服务端上限（${fmt(evalCore.knownCap)} tokens）限制，实际采用 ${fmt(obsBudget)} tokens。`;
    } else if (status === 'mismatch') {
      badge = t('models.status.mismatch') || '未生效：目标值与观测值不一致';
      pillClass = 'pill-bad';
      let detail = `目标设置（${fmt(targetLimit)} tokens）与发送后实际观测预算（${fmt(obsBudget)} tokens）不一致，原因待确认。`;
      if (product.unavailable && product.unavailabilityReason) {
        detail += `（模型可用性说明：${product.unavailabilityReason}）`;
      }
      diagnosis = detail;
    } else if (status === 'timeout_unconfirmed') {
      badge = '确认超时（未观测到新回复）';
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? `已按客户端默认透传发送请求，但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`
        : `已在请求中携带设置（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`;
    } else if (status === 'dispatched_pending_confirm') {
      badge = targetMode === 'default' ? '已默认透传，等待确认' : (t('models.status.dispatchedPendingConfirm') || '已发送设置，等待确认');
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? '已按客户端默认透传发出请求（未附加覆盖参数），等待收到新回复以确认服务端实际预算。'
        : `已在本次请求中成功注入参数（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），等待收到新回复以确认实际分配预算。`;
    } else {
      status = 'saved_pending_dispatch';
      badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
      pillClass = 'pill-muted';
      diagnosis = `已保存目标设置（${targetText}），下一次在对应模型发起发送时将自动注入。`;
    }

    return {
      status,
      badge,
      pillClass,
      diagnosis,
      targetText,
      requestText,
      observedText,
      convoId
    };
  }

  function renderModelDetailCard(product) {
    if (!product) {
      if (ctxCardProductName) ctxCardProductName.textContent = t('models.card.waiting');
      if (ctxCardVendorName) ctxCardVendorName.textContent = '—';
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      if (ctxConflictBanner) ctxConflictBanner.hidden = true;
      if (ctxSummaryModelEl) ctxSummaryModelEl.textContent = '待确认';
      if (ctxSummaryLengthEl) ctxSummaryLengthEl.textContent = '—';
      if (ctxSummaryStatusPillEl) ctxSummaryStatusPillEl.hidden = true;
      return;
    }

    const evalResult = evaluateModelContextStatus(product);
    const pState = resolveProductPreferenceState(product);
    if (ctxCardVendorDot?.style) {
      ctxCardVendorDot.style.background = VENDOR_DOT_COLORS[product.vendor] || VENDOR_DOT_COLORS['其他'];
    }
    if (ctxCardVendorName) ctxCardVendorName.textContent = formatVendorLabel(product.vendor);
    if (ctxCardProductName) {
      if (product.unavailable) {
        ctxCardProductName.textContent = `${product.productLabel} [${t('models.card.modelUnavailable') || '不可用'}]`;
      } else {
        ctxCardProductName.textContent = product.productLabel;
      }
    }

    const efforts = product.members.map(m => m.effort).filter(Boolean);
    if (ctxCardEffortsList) {
      ctxCardEffortsList.textContent = efforts.length
        ? t('models.card.effortsList', { list: efforts.map(formatEffortZh).join(' · ') })
        : t('models.card.effortStandard');
    }
    if (ctxCardSessionEffort) {
      if (activeSessionProductKey === product.productKey && activeSessionEffort) {
        ctxCardSessionEffort.textContent = t('models.card.sessionEffort', { effort: formatEffortZh(activeSessionEffort) });
        ctxCardSessionEffort.hidden = false;
      } else {
        ctxCardSessionEffort.hidden = true;
      }
    }

    // 旧档位冲突横幅
    if (ctxConflictBanner && ctxConflictRows) {
      if (pState.status === 'conflict' && pState.conflictEntries.length > 0) {
        ctxConflictBanner.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxConflictRows.replaceChildren === 'function') {
          const rows = [];
          for (const ce of pState.conflictEntries) {
            const r = document.createElement('div');
            r.className = 'ctx-conflict-row';
            const lbl = document.createElement('span');
            lbl.textContent = `${ce.effortLabel} · ${formatSavedPrefLabel(ce)}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ctx-conflict-btn';
            btn.textContent = t('models.conflict.useThis');
            btn.addEventListener('click', () => { void resolveProductConflict(product, ce); });
            r.appendChild(lbl);
            r.appendChild(btn);
            rows.push(r);
          }
          const selfRow = document.createElement('div');
          selfRow.className = 'ctx-conflict-row';
          const selfHint = document.createElement('span');
          selfHint.textContent = t('models.conflict.orCustom');
          const selfBtn = document.createElement('button');
          selfBtn.type = 'button';
          selfBtn.className = 'ctx-conflict-btn';
          selfBtn.textContent = t('models.conflict.selfSet');
          selfBtn.addEventListener('click', () => {
            ctxCustomInput?.focus?.();
          });
          selfRow.appendChild(selfHint);
          selfRow.appendChild(selfBtn);
          rows.push(selfRow);
          ctxConflictRows.replaceChildren(...rows);
        }
      } else {
        ctxConflictBanner.hidden = true;
      }
    }

    // 0. 模型能力参考卡片渲染（紧邻预算设置区，不隐藏；严格区分模型上限 / 客户端限制 / 运行策略默认预算 / 可采纳范围）
    const capSummary = getProductCapabilitySummary(product);
    const runtimePolicy = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    if (ctxCapWindowEl) {
      ctxCapWindowEl.textContent = capSummary?.maxTokens ? `${fmt(capSummary.maxTokens)} tokens` : '未知（待获取元数据）';
    }
    if (ctxCapOutputEl) {
      ctxCapOutputEl.textContent = capSummary?.maxOutputTokens != null ? `${fmt(capSummary.maxOutputTokens)} tokens` : '未知';
    }
    if (ctxCapModelMaxEl) {
      ctxCapModelMaxEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
        ? `${fmt(capSummary.modelTheoreticalMaxTokens)} tokens`
        : '未知（待获取元数据）';
    }
    if (ctxCapClientPolicyEl) {
      if (!runtimePolicy || runtimePolicy.runtimeState === 'unknown') {
        ctxCapClientPolicyEl.textContent = '未知（待读取运行策略）';
      } else if (runtimePolicy.runtimeState === 'pending_restart') {
        ctxCapClientPolicyEl.textContent = `待重启（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
        ctxCapClientPolicyEl.textContent = `进程未确认（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'partial') {
        ctxCapClientPolicyEl.textContent = '部分异常（运行限制未知）';
      } else if (runtimePolicy.runtimeMode === 'dynamic') {
        ctxCapClientPolicyEl.textContent = 'Dynamic 动态跟随（按模型上限）';
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCapClientPolicyEl.textContent = `固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} tokens`;
      } else {
        ctxCapClientPolicyEl.textContent = '默认限制 256,000 tokens';
      }
    }
    if (ctxCapDefaultEl) {
      if (capSummary?.currentStrategyDefaultBudget != null && runtimePolicy?.policyKnown) {
        let stratNote = '';
        if (runtimePolicy.runtimeMode === 'dynamic') {
          stratNote = '（Dynamic 默认）';
        } else if (runtimePolicy.runtimeMode === 'fixed') {
          stratNote = `（受固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} 约束）`;
        } else {
          stratNote = '（受默认 256,000 约束）';
        }
        ctxCapDefaultEl.textContent = `${fmt(capSummary.currentStrategyDefaultBudget)} tokens${stratNote}`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapDefaultEl.textContent = '未知（运行策略待确认）';
      } else {
        ctxCapDefaultEl.textContent = '未知';
      }
    }
    if (ctxCapRangeEl) {
      if (capSummary?.maxAdjustableTokens != null) {
        ctxCapRangeEl.textContent = `${fmt(capSummary.rangeMin || CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(capSummary.maxAdjustableTokens)} tokens`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapRangeEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
          ? `运行策略未知（模型理论上限 ${fmt(capSummary.modelTheoreticalMaxTokens)}）`
          : `运行策略未知（工程范围 ${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}）`;
      } else {
        ctxCapRangeEl.textContent = `${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}（模型上限未知）`;
      }
    }
    if (ctxCapFormulaEl) {
      const parts = [];
      if (capSummary?.sources?.length) {
        const srcText = capSummary.sources.map(s => (s === 'get_available_models' ? 'GetAvailableModels 目录' : (s === 'step_model_info' ? '会话 Step ModelInfo' : s))).join(' + ');
        parts.push(`来源：${srcText}`);
      }
      if (capSummary?.formulaNote) {
        parts.push(capSummary.formulaNote);
      } else {
        parts.push('尚未获取到当前账号/步骤的模型窗口与最大输出元数据（不按模型名称推测上限）。');
      }
      if (capSummary?.policyNote) {
        parts.push(capSummary.policyNote);
      }
      if (capSummary?.hasTierVariance) {
        parts.push('注意：该模型不同力度档位报告了不同容量/最大输出，可调上限取安全交集，详情见下方「档位能力」。');
      }
      if (runtimePolicy?.diskVsRuntimeMismatch) {
        parts.push('磁盘配置与运行中进程尚未确认一致：以下预测与默认预算均按未确认处理，请勿当作已实机生效。');
      }
      ctxCapFormulaEl.textContent = parts.join('；');
    }
    if (ctxRefSavedEl) {
      const targetSavedLabel = getContextScopeMode() === 'unified'
        ? formatSavedPrefLabel(contextUnifiedPreference)
        : pState.displayText;
      ctxRefSavedEl.textContent = targetSavedLabel;
    }
    if (ctxRefSentEl) {
      ctxRefSentEl.textContent = evalResult.requestText || '尚无本次验证';
    }
    if (ctxRefAdoptedEl) {
      ctxRefAdoptedEl.textContent = evalResult.observedText || '尚无本次验证';
    }

    if (ctxUnifiedProjEl) {
      if (getContextScopeMode() === 'unified' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const allProducts = getKnownModelProducts().filter(p => p.inAccountCatalog);
        const projections = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, allProducts, currentUnlockStatus, state.modelCapabilitiesById || null);
        if (projections.length > 0 && typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxUnifiedProjEl.replaceChildren === 'function') {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'ctx-unified-proj-title';
          titleDiv.textContent = '统一模式各模型预计采用预算（预测值，非实机已确认）：';
          const rowNodes = [titleDiv];
          for (const pr of projections.slice(0, 8)) {
            const row = document.createElement('div');
            const isWarnRow = pr.outcome === 'clamped_to_model_max' || pr.outcome === 'exceeds_client_policy' || pr.outcome === 'clamped_by_client_policy' || pr.outcome === 'pending_restart_unconfirmed' || pr.outcome === 'partial_policy_unconfirmed' || pr.outcome === 'runtime_unconfirmed';
            row.className = `ctx-unified-proj-row${isWarnRow ? ' is-clamped' : ''}`;
            const lbl = document.createElement('span');
            lbl.textContent = pr.productLabel;
            const val = document.createElement('strong');
            if (pr.outcome === 'clamped_to_model_max') {
              val.textContent = `受模型上限限制 -> 预计 ${fmt(pr.projectedTokens)}（最大可用）`;
            } else if (pr.outcome === 'exceeds_client_policy') {
              val.textContent = `超出当前客户端限制 -> 预计仅保底 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'clamped_by_client_policy') {
              val.textContent = `受当前客户端限制 -> 预计 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'pending_restart_unconfirmed') {
              val.textContent = '待验证（磁盘已改，客户端未重启）';
            } else if (pr.outcome === 'runtime_unconfirmed') {
              val.textContent = '待验证（运行中进程未确认）';
            } else if (pr.outcome === 'partial_policy_unconfirmed') {
              val.textContent = '未知（客户端处于部分异常状态）';
            } else if (pr.outcome === 'unknown_policy') {
              val.textContent = '未知（运行策略待读取）';
            } else if (pr.outcome === 'unknown_cap') {
              val.textContent = '模型上限未知';
            } else if (pr.outcome === 'client_default' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（当前策略默认）`;
            } else if (pr.outcome === 'dynamic_follow' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（Dynamic 默认）`;
            } else if (pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens`;
            } else {
              val.textContent = '待验证';
            }
            row.appendChild(lbl);
            row.appendChild(val);
            rowNodes.push(row);
          }
          ctxUnifiedProjEl.replaceChildren(...rowNodes);
          ctxUnifiedProjEl.hidden = false;
        } else {
          ctxUnifiedProjEl.hidden = true;
        }
      } else {
        ctxUnifiedProjEl.hidden = true;
      }
    }

    if (ctxCardTierCapsRowEl && ctxCardTierCapsEl) {
      if (capSummary?.tierDetails?.length) {
        ctxCardTierCapsRowEl.hidden = false;
        const lines = capSummary.tierDetails.map(td => {
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || '标准');
          const winTxt = td.maxTokens ? `窗口 ${fmt(td.maxTokens)}` : '窗口未知';
          const outTxt = td.maxOutputTokens != null ? `最大输出 ${fmt(td.maxOutputTokens)}` : '输出未知';
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? `可调上限 ${fmt(td.maxTokens - td.maxOutputTokens)}`
            : '上限未知';
          return `${tierName}：${winTxt} / ${outTxt} / ${maxInTxt}`;
        });
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardTierCapsEl.replaceChildren === 'function') {
          ctxCardTierCapsEl.replaceChildren(...lines.map(l => {
            const d = document.createElement('div');
            d.textContent = l;
            return d;
          }));
        } else {
          ctxCardTierCapsEl.textContent = lines.join(' | ');
        }
      } else {
        ctxCardTierCapsRowEl.hidden = true;
      }
    }

    // 1. 目标值（已保存）
    if (ctxCardSavedEl) {
      ctxCardSavedEl.textContent = pState.displayText;
      ctxCardSavedEl.title = (pState.pref?.mode === 'fixed' && pState.pref.limitTokens)
        ? `${fmt(pState.pref.limitTokens)} tokens`
        : '';
    }

    // 2. 本次请求携带值
    if (ctxCardRequestEl) {
      ctxCardRequestEl.textContent = evalResult.requestText;
      ctxCardRequestEl.title = evalResult.requestText;
    }

    // 3. 对应会话
    if (ctxCardConvoEl) {
      ctxCardConvoEl.textContent = evalResult.convoId;
      ctxCardConvoEl.title = evalResult.convoId;
    }

    // 4. 生效诊断
    if (ctxCardDiagnosisEl) {
      ctxCardDiagnosisEl.textContent = evalResult.diagnosis;
      ctxCardDiagnosisEl.title = evalResult.diagnosis;
      ctxCardDiagnosisEl.className = `ctx-metric-value ctx-metric-diagnosis-val is-${evalResult.status}`;
    }

    // 5. 底座引擎（严格区分磁盘配置与当前运行进程已加载状态）
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCardClientEl) {
      if (unlockStatusFetchError) {
        ctxCardClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCardClientEl.textContent = t('status.badge.reading');
      } else if (runtimePolicy?.runtimeState === 'pending_restart') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（待重启生效）`;
      } else if (runtimePolicy?.runtimeState === 'runtime_unconfirmed') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（运行态未确认）`;
      } else if (runtimePolicy?.runtimeState === 'partial') {
        ctxCardClientEl.textContent = '部分异常（请核对客户端状态）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'dynamic') {
        ctxCardClientEl.textContent = '动态跟随已确认运行（各模型独立）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCardClientEl.textContent = `固定单一上限模式 (${formatKShort(runtimePolicy.currentClientLimitTokens)}，建议升级为动态跟随)`;
      } else {
        ctxCardClientEl.textContent = describeClientModeValue(currentUnlockStatus);
      }
    }
    if (ctxCardClientTagEl) {
      if (unlockStatusFetchError || !currentUnlockStatus) {
        ctxCardClientTagEl.hidden = true;
      } else {
        ctxCardClientTagEl.hidden = false;
        ctxCardClientTagEl.textContent = statusInfo.badge;
        ctxCardClientTagEl.className = `key-pill ${statusInfo.pillClass}`;
      }
    }

    // 6. 实测预算 + 独立 serviceLimit
    const { latestBudgetObs, latestServiceLimitObs } = findLatestProductObservation(product);
    const preObs = findPreRestartBudgetForProduct(product);
    if (ctxCardObservedBudgetEl) {
      if (pendingRestartVerification && !latestBudgetObs && preObs) {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedWaitRestart');
        ctxCardObservedBudgetEl.title = '';
      } else if (latestBudgetObs?.budget > 0) {
        const effTxt = latestBudgetObs.effort ? ` · ${formatEffortZh(latestBudgetObs.effort)}` : '';
        const tTxt = latestBudgetObs.ts ? ` · ${formatMonthDayTime(latestBudgetObs.ts)}` : '';
        ctxCardObservedBudgetEl.textContent = `${formatKShort(latestBudgetObs.budget)}${effTxt}${tTxt}`;
        ctxCardObservedBudgetEl.title = t('models.card.observedTitle', { val: fmt(latestBudgetObs.budget) });
      } else {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedBudgetNone');
        ctxCardObservedBudgetEl.title = '';
      }
    }
    if (ctxCardPreRestartBudgetEl) {
      if (!latestBudgetObs && preObs?.budget > 0) {
        const effTxt = preObs.effort ? ` · ${formatEffortZh(preObs.effort)}` : '';
        const tTxt = preObs.ts ? ` · ${formatMonthDayTime(preObs.ts)}` : '';
        ctxCardPreRestartBudgetEl.textContent = `${t('models.card.preRestartTitle', { val: formatKShort(preObs.budget) }).replace(/ tokens$/, '')}${effTxt}${tTxt}`;
        ctxCardPreRestartBudgetEl.title = t('models.card.preRestartTitle', { val: fmt(preObs.budget) });
        ctxCardPreRestartBudgetEl.hidden = false;
      } else {
        ctxCardPreRestartBudgetEl.title = '';
        ctxCardPreRestartBudgetEl.hidden = true;
      }
    }
    if (ctxCardServiceLimitEl) {
      if (latestServiceLimitObs?.serviceLimit > 0) {
        const tTxt = latestServiceLimitObs.ts ? `（${formatMonthDayTime(latestServiceLimitObs.ts)}）` : '';
        ctxCardServiceLimitEl.textContent = `${t('models.card.serviceLimit', { val: formatKShort(latestServiceLimitObs.serviceLimit) })}${tTxt}`;
        ctxCardServiceLimitEl.title = t('models.card.serviceLimitTitle', { val: fmt(latestServiceLimitObs.serviceLimit) });
        ctxCardServiceLimitEl.hidden = false;
      } else {
        ctxCardServiceLimitEl.title = '';
        ctxCardServiceLimitEl.hidden = true;
      }
    }

    // 7. 实测速度（按档位逐行显示中位数、样本数、时间，不跨档位借用）
    if (ctxCardObservedSpeedEl) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const summaryRows = typeof summarizeSpeedByModel === 'function'
        ? summarizeSpeedByModel(mergedCalls, { days: 'all', cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] })
        : [];
      const summaryByExact = new Map(summaryRows.map(r => [r.modelExactId, r]));
      const members = product.members?.length ? product.members : [{ modelId: product.productKey, label: product.productLabel, effort: null }];
      const lines = [];
      for (const m of members) {
        const stat = summaryByExact.get(m.modelId);
        const prefix = m.effort ? `${formatEffortZh(m.effort)} ` : '';
        if (stat && stat.medianTps != null) {
          const tStr = stat.maxTs ? ` · ${formatMonthDayTime(stat.maxTs)}` : '';
          const lowNote = stat.lowSample ? t('models.card.lowSampleParen') : '';
          lines.push(t('models.card.speedLineText', { prefix, tps: stat.medianTps, count: stat.count, low: lowNote, ts: tStr }));
        } else {
          lines.push(`${prefix}${t('models.card.observedSpeedNone')}`);
        }
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardObservedSpeedEl.replaceChildren === 'function') {
        const lineNodes = lines.map(txt => {
          const d = document.createElement('div');
          d.textContent = txt;
          return d;
        });
        ctxCardObservedSpeedEl.replaceChildren(...lineNodes);
      } else {
        ctxCardObservedSpeedEl.textContent = lines.join(' | ');
      }
    }

    // 8. 提示规则与 Notice 说明
    if (ctxCardHintsEl) {
      const hints = [];
      if (product.notice) {
        const nText = typeof product.notice === 'string' ? product.notice : (product.notice.message || JSON.stringify(product.notice));
        hints.push(`模型提示：${nText}`);
      }
      if (product.unavailable && product.unavailabilityReason) {
        hints.push(`不可用原因：${product.unavailabilityReason}`);
      } else if (product.partialUnavailable && product.unavailabilityReason) {
        hints.push(`部分档位受限：${product.unavailabilityReason}`);
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens &&
        pState.pref &&
        !(pState.pref.mode === 'fixed' && Number(pState.pref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      ) {
        hints.push(t('models.card.hintDiffClient'));
      }
      if (pState.pref?.mode === 'dynamic') {
        hints.push(t('models.validation.dynamicDesc'));
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens > 0 &&
        latestBudgetObs?.budget > 0 &&
        latestBudgetObs.budget < currentUnlockStatus.configuredLimitTokens
      ) {
        hints.push(t('models.card.hintBelowSet'));
      }
      if (hints.length > 0) {
        ctxCardHintsEl.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardHintsEl.replaceChildren === 'function') {
          const nodes = hints.map(h => {
            const div = document.createElement('div');
            div.className = 'ctx-card-hint-item';
            div.textContent = h;
            return div;
          });
          ctxCardHintsEl.replaceChildren(...nodes);
        } else {
          ctxCardHintsEl.textContent = hints.join(' ');
        }
      } else {
        ctxCardHintsEl.hidden = true;
      }
    }

    // 9. 精简主界面展示：当前模式、当前模型、目标设置与状态
    if (ctxSummaryModeEl) {
      ctxSummaryModeEl.textContent = contextScopeMode === 'unified'
        ? (t('models.mode.unifiedTitle') || '所有模型统一设置')
        : (t('models.mode.perModelTitle') || '按模型分别设置');
    }
    if (ctxSummaryModelEl) {
      if (contextScopeMode === 'unified') {
        ctxSummaryModelEl.textContent = t('models.summary.unifiedTarget') || '所有模型（统一生效）';
      } else if (activeSessionModelConfirmed && activeSessionProductKey === product.productKey) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else if (activeSessionModelConfirmed && activeSessionProductKey) {
        const cur = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
        ctxSummaryModelEl.textContent = cur ? cur.productLabel : product.productLabel;
      } else if (product) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else {
        ctxSummaryModelEl.textContent = '待确认';
      }
    }
    if (ctxSummaryLengthEl) {
      ctxSummaryLengthEl.textContent = evalResult.targetText;
    }
    if (ctxSummaryStatusPillEl) {
      if (needsRestartAfterApply) {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = t('models.summary.pendingRestart') || '待重启生效';
        ctxSummaryStatusPillEl.className = 'key-pill pill-warn';
      } else {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = evalResult.badge;
        ctxSummaryStatusPillEl.className = `key-pill ${evalResult.pillClass}`;
      }
    }

    if (btnSaveModelCtx) btnSaveModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
    if (btnResetModelCtx) btnResetModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
  }

  function renderPresetSelectionUI() {
    const targetMode = ctxDraft.mode;
    const targetLimit = ctxDraft.limitTokens;
    const isUnified = contextScopeMode === 'unified';
    const currentProd = isUnified ? null : getSelectedProductObj();
    const capSummary = currentProd ? getProductCapabilitySummary(currentProd) : null;
    const knownEnvMax = (!isUnified && capSummary?.maxAdjustableTokens != null) ? capSummary.maxAdjustableTokens : null;
    const knownModelMax = (!isUnified && capSummary?.modelTheoreticalMaxTokens != null) ? capSummary.modelTheoreticalMaxTokens : null;
    const rp = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const policyKnown = Boolean(rp?.policyKnown);

    if (ctxPresetModelMaxSubEl) {
      if (isUnified) {
        ctxPresetModelMaxSubEl.textContent = '统一模式下各模型不同（已禁用）';
      } else if (knownEnvMax != null) {
        ctxPresetModelMaxSubEl.textContent = `当前环境最大可采纳：${fmt(knownEnvMax)} tokens`;
      } else if (!policyKnown && knownModelMax != null) {
        ctxPresetModelMaxSubEl.textContent = `运行策略未确认（模型理论上限 ${fmt(knownModelMax)}，暂不可用）`;
      } else {
        ctxPresetModelMaxSubEl.textContent = '模型元数据待获取（暂不可用）';
      }
    }

    const btns = ctxPresetGrid?.children || [];
    const applyPresetState = btn => {
      if (!btn) return;
      const bMode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode;
      const bLimRaw = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
      const bLim = bLimRaw ? Number(bLimRaw) : null;

      let disabled = false;
      let disableReason = '';
      if (bMode === 'model_max') {
        if (isUnified) {
          disabled = true;
          disableReason = '统一模式下各模型最大可用上限不同，请切换到按模型分别设置或填写具体数值。';
        } else if (knownModelMax == null) {
          disabled = true;
          disableReason = '尚未获取到该模型的上下文窗口与最大输出元数据，无法计算最大可用值。';
        } else if (!policyKnown || knownEnvMax == null) {
          disabled = true;
          disableReason = '当前客户端运行策略未知或待重启确认，暂无法确定当前环境最大可用上限。';
        }
      } else if (bMode === 'fixed' && bLim && knownModelMax != null && bLim > knownModelMax) {
        disabled = true;
        disableReason = `预设 ${fmt(bLim)} 超出当前模型理论输入上限 ${fmt(knownModelMax)}（总窗口 - 最大输出）。`;
      }

      if ('disabled' in btn) btn.disabled = disabled;
      if (btn.classList) {
        if (disabled) btn.classList.add('is-disabled');
        else btn.classList.remove('is-disabled');
      }
      if ('title' in btn) btn.title = disableReason;

      const matched = !disabled && (
        (bMode === 'model_max' && targetMode === 'fixed' && knownEnvMax != null && targetLimit === knownEnvMax) ||
        (bMode === targetMode && (targetMode !== 'fixed' || bLim === targetLimit))
      );
      if (btn.classList) {
        if (matched) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      btn.setAttribute?.('aria-pressed', String(Boolean(matched)));
    };
    if (typeof ctxPresetGrid?.querySelectorAll === 'function') {
      const list = ctxPresetGrid.querySelectorAll('.ctx-preset-btn');
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) applyPresetState(list[i]);
      }
    } else if (Array.isArray(btns)) {
      for (const b of btns) applyPresetState(b);
    }

    if (ctxCustomInput && 'value' in ctxCustomInput) {
      if (targetMode === 'dynamic') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phFollow');
      } else if (targetMode === 'default') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phDefault');
      } else if (targetLimit != null) {
        const cleanVal = String(targetLimit);
        if (ctxCustomInput.value !== cleanVal && !ctxDraftDirty) {
          ctxCustomInput.value = cleanVal;
        }
      }
    }
    updateValidationMessageUI();
  }

  function updateValidationMessageUI() {
    if (!ctxValidationEl) return;
    if (ctxDraft.mode === 'dynamic') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = t('models.validation.dynamicDesc');
      return;
    }
    if (ctxDraft.mode === 'default') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = '恢复客户端默认：请求将清除 maxTokenLimit 覆盖，由当前语言服务全局模式决定（若已开 Dynamic 则按动态默认）。';
      return;
    }
    const rawVal = ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== ''
      ? ctxCustomInput.value
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawVal, 'fixed');
    if (!val.ok) {
      ctxValidationEl.className = 'ctx-validation-msg is-error';
      ctxValidationEl.textContent = val.error;
      return;
    }
    if (val.warnings && val.warnings.length > 0) {
      ctxValidationEl.className = 'ctx-validation-msg is-warn';
      ctxValidationEl.textContent = val.warnings.join(' ');
      return;
    }
    ctxValidationEl.className = 'ctx-validation-msg';
    ctxValidationEl.textContent = t('models.input.validFixed', { short: formatKShort(val.limitTokens), full: fmt(val.limitTokens) });
  }

  function loadDraftFromSelectedModel(forceResetDraft = false) {
    if (!ctxDraftDirty || forceResetDraft) {
      if (contextScopeMode === 'unified') {
        const pref = contextUnifiedPreference;
        if (pref && pref.mode) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          ctxDraft = { mode: 'default', limitTokens: null };
        }
      } else {
        const prod = getSelectedProductObj();
        const pState = resolveProductPreferenceState(prod);
        const pref = pState.pref;
        if (pref) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          const rp = resolveRuntimeUnlockPolicyClient();
          if (rp?.policyKnown && rp.runtimeMode !== 'unknown' && rp.runtimeMode !== 'partial') {
            ctxDraft = {
              mode: rp.runtimeMode,
              limitTokens: rp.runtimeMode === 'fixed' ? (rp.currentClientLimitTokens ?? null) : null
            };
          } else {
            ctxDraft = { mode: 'default', limitTokens: null };
          }
        }
      }
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) {
        ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
      }
    }
    renderModelSettingsTab();
    renderPresetSelectionUI();
  }

  function renderModelSettingsTab() {
    const products = getKnownModelProducts();
    const currentProd = getSelectedProductObj();
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    renderCompactSessionCard();
    renderClientStatusBar();
    renderModelListGroup(products);
    renderModelDetailCard(currentProd);
    renderPresetSelectionUI();
  }

  function recordObservationFromSummary(summary, convoId, opts = {}) {
    if (!summary) return;
    const rawId = resolveStableModelKeyClient(summary);
    if (!rawId && !summary.model) return;
    const g = groupProductSafe({
      modelId: rawId || summary.model,
      label: summary.model || rawId,
      modelOrAlias: summary.modelOrAlias,
      effort: summary.effort
    });
    if (!g?.productKey) return;

    if (budgetTracker && (summary.budget > 0 || summary.serviceLimit > 0 || opts.callId)) {
      budgetTracker.recordObservation({
        convoId: convoId || state.activeConversationId || state.route || null,
        productKey: g.productKey,
        modelId: rawId || g.productKey,
        modelLabel: summary.model || g.productLabel,
        effort: g.effort || summary.effort || null,
        budget: Number(summary.budget || 0),
        serviceLimit: Number(summary.serviceLimit || 0),
        callId: opts.callId || null,
        stepCount: Number.isFinite(opts.stepCount) ? opts.stepCount : -1,
        ts: opts.ts || 0
      });
    }
  }

  function syncContextModelSelectionFromState() {
    const prevProd = activeSessionProductKey;
    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;

    // 1. 最高优先级：宿主输入框旁真实选中的模型（排除插件自身 DOM）
    const hostSelected = extractHostSelectedModel();
    let exactId = null;
    let detectedProduct = null;
    let detectedEffort = null;
    let isConfirmed = false;

    if (hostSelected && hostSelected.productKey) {
      exactId = hostSelected.modelId;
      detectedProduct = hostSelected.productKey;
      detectedEffort = hostSelected.effort;
      isConfirmed = true;
    } else if (state.latest && activeConvId) {
      // 2. 次优先级：检查 state.latest 是否属于当前活跃会话且非历史归档模型
      const candidateId = resolveStableModelKeyClient(state.latest);
      if (candidateId) {
        const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
        const matchedCfg = Array.isArray(configs) && configs.length > 0
          ? configs.find(c => (resolveStableModelKeyClient(c) || c.modelId) === candidateId)
          : null;
        const isAllowedInCatalog = Array.isArray(configs) && configs.length > 0
          ? Boolean(matchedCfg && !matchedCfg.isHistorical)
          : true;
        if (isAllowedInCatalog) {
          const g = groupProductSafe({
            modelId: candidateId,
            label: state.latest?.model || candidateId,
            modelOrAlias: state.latest?.modelOrAlias,
            effort: state.latest?.effort
          });
          exactId = candidateId;
          detectedProduct = g.productKey;
          detectedEffort = g.effort || state.latest?.effort || null;
          isConfirmed = true;
        }
      }
    }

    if (isConfirmed && exactId && detectedProduct) {
      activeSessionModelKey = exactId;
      activeSessionProductKey = detectedProduct;
      activeSessionEffort = detectedEffort;
      activeSessionModelConfirmed = true;
      // 严禁在此处用 Date.now() 伪造观测时间戳；仅当无观测记录且有明确后端快照时保留已有真实观测
    } else {
      activeSessionModelConfirmed = false;
      activeSessionModelKey = null;
      activeSessionProductKey = null;
      activeSessionEffort = null;
    }

    if (activeSessionModelConfirmed && activeSessionProductKey && (!manualModelSelection || !selectedProductKey)) {
      const switched = prevProd !== activeSessionProductKey || selectedProductKey !== activeSessionProductKey;
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey;
      if (switched) {
        ctxDraftDirty = false;
        loadDraftFromSelectedModel(true);
      }
    }
    renderHeaderModelDropdown();
    renderCompactSessionCard();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  ctxPresetGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.ctx-preset-btn');
    if (!btn || btn.disabled) return;
    const mode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode || 'default';
    const rawLim = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
    ctxDraftDirty = true;
    if (mode === 'dynamic') {
      ctxDraft = { mode: 'dynamic', limitTokens: null };
    } else if (mode === 'default') {
      ctxDraft = { mode: 'default', limitTokens: null };
    } else if (mode === 'model_max') {
      const prod = contextScopeMode === 'unified' ? null : getSelectedProductObj();
      const cap = prod ? getProductCapabilitySummary(prod) : null;
      if (!cap || !cap.runtimePolicy?.policyKnown || cap.maxAdjustableTokens == null) {
        updateValidationMessageUI();
        return;
      }
      ctxDraft = { mode: 'fixed', limitTokens: cap.maxAdjustableTokens };
    } else {
      const lim = Number(rawLim || 512000);
      ctxDraft = { mode: 'fixed', limitTokens: lim };
    }
    if (ctxCustomInput && 'value' in ctxCustomInput) {
      ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
    }
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    renderPresetSelectionUI();
  });

  ctxCustomInput?.addEventListener('input', () => {
    const rawStr = String(ctxCustomInput.value || '').trim();
    ctxDraftDirty = true;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    if (!rawStr) {
      ctxDraft = { mode: 'fixed', limitTokens: null };
      renderPresetSelectionUI();
      return;
    }
    const val = validateCustomLimitClient(rawStr, 'fixed');
    ctxDraft = {
      mode: 'fixed',
      limitTokens: val.ok ? val.limitTokens : null
    };
    renderPresetSelectionUI();
  });

  async function saveSettingsPayloadBridge(payload = {}) {
    if (window.contextMeterAPI?.saveSettings) {
      return await window.contextMeterAPI.saveSettings(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge') };
  }

  function showUnlockResultBox(isSuccess, html, opts = {}) {
    if (!unlockResultBox || !unlockResultText) return;
    unlockResultBox.style.display = 'block';
    unlockResultBox.className = `unlock-result-box ${isSuccess ? 'result-success' : 'result-error'}`;
    unlockResultText.innerHTML = html;
    const canRestartHost = Boolean(hostSupportsRestart);
    const needRestart = Boolean(opts.needsRestart);
    const showRetry = Boolean(opts.showRetry);
    if (btnUnlockResultRestart) btnUnlockResultRestart.hidden = !(needRestart && canRestartHost);
    if (btnUnlockResultRetry) btnUnlockResultRetry.hidden = !showRetry;
    if (unlockResultManual) unlockResultManual.hidden = !(needRestart && !canRestartHost);
    if (unlockResultActions) unlockResultActions.hidden = !((needRestart && canRestartHost) || showRetry);
  }

  async function saveCurrentProductDraft() {
    if (contextScopeMode === 'unified') {
      const rawLimit = ctxDraft.mode === 'fixed'
        ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
        : ctxDraft.limitTokens;
      const val = validateCustomLimitClient(rawLimit, ctxDraft.mode);
      if (!val.ok) {
        updateValidationMessageUI();
        return { ok: false, error: val.error };
      }
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference,
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraftDirty = false;
      renderModelSettingsTab();
      let notice = null;
      if (val.mode === 'fixed' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const projs = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, getKnownModelProducts().filter(p => p.inAccountCatalog), currentUnlockStatus, state.modelCapabilitiesById || null);
        const clampedModel = projs.filter(p => p.outcome === 'clamped_to_model_max');
        const clampedClient = projs.filter(p => p.outcome === 'exceeds_client_policy' || p.outcome === 'clamped_by_client_policy');
        const unconfirmed = projs.filter(p => p.outcome === 'pending_restart_unconfirmed' || p.outcome === 'runtime_unconfirmed' || p.outcome === 'partial_policy_unconfirmed' || p.outcome === 'unknown_policy');
        const msgParts = [];
        if (clampedModel.length > 0) {
          msgParts.push(`部分模型低于统一值：${clampedModel.map(c => `${c.productLabel}(上限 ${fmt(c.projectedTokens)})`).join('、')} 预计仅采用各自最大可用上限`);
        }
        if (clampedClient.length > 0) {
          msgParts.push(`当前客户端限制为 ${fmt(clampedClient[0].clientLimitTokens)} tokens，超限模型预计仅保底 ${clampedClient.map(c => `${c.productLabel}(${fmt(c.projectedTokens)})`).join('、')}`);
        }
        if (unconfirmed.length > 0) {
          msgParts.push('当前客户端运行策略尚未确认/待重启，统一值能否实机采用需后续发送请求验证');
        }
        if (msgParts.length > 0) {
          notice = `已保存统一目标 ${fmt(val.limitTokens)} tokens。注意：${msgParts.join('；')}。`;
        }
      }
      return { ok: true, prod: null, val, notice };
    }

    const prod = getSelectedProductObj();
    if (!prod) {
      return { ok: false, error: t('msg.noModelsDetected') };
    }
    const rawLimit = ctxDraft.mode === 'fixed'
      ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawLimit, ctxDraft.mode, prod);
    if (!val.ok) {
      updateValidationMessageUI();
      return { ok: false, error: val.error };
    }
    if (val.exceedsModelLimit) {
      updateValidationMessageUI();
      const capSummary = getProductCapabilitySummary(prod);
      const modelMaxCap = capSummary?.modelTheoreticalMaxTokens ?? val.adoptableTokens;
      const capText = modelMaxCap != null ? `${fmt(modelMaxCap)} tokens` : '已知模型理论上限';
      return {
        ok: false,
        error: `输入 ${fmt(val.limitTokens)} 超出 ${prod.productLabel} 模型理论输入上限 ${capText}（依据元数据：总窗口 - 最大输出）。请修改为 <= ${capText} 或重新选择合法档位，系统不会静默改写数值。`
      };
    }
    const legacyKeys = resolveProductPreferenceState(prod).legacyKeys;
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return { ok: false, stale: true };
    if (!res || !res.ok) {
      return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[prod.productKey] = {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    return { ok: true, prod, val };
  }

  btnSaveModelCtx?.addEventListener('click', async () => {
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const res = await saveCurrentProductDraft();
    if (res.stale) return;
    if (!res.ok) {
      showUnlockResultBox(false, res.error);
      return;
    }
    showUnlockResultBox(true, res.notice || t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用');
  });

  btnResetModelCtx?.addEventListener('click', async () => {
    if (contextScopeMode === 'unified') {
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: 'default',
        limitTokens: null,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference: { mode: 'default' },
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraft = { mode: 'default', limitTokens: null };
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
      renderModelSettingsTab();
      renderPresetSelectionUI();
      showUnlockResultBox(true, t('models.summary.modelDefault') || '已恢复默认值');
      return;
    }

    const prod = getSelectedProductObj();
    if (!prod) return;
    const pState = resolveProductPreferenceState(prod);
    const oldSavedPref = pState.pref;
    const clearAll = [prod.productKey, ...pState.legacyKeys];
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      clearContextPreferences: clearAll
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return;
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const k of clearAll) delete contextPreferencesMap[k];
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraft = { mode: 'default', limitTokens: null };
    ctxDraftDirty = false;
    if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    renderPresetSelectionUI();

    if (ctxResetNoticeEl) {
      const clientUsingSame = oldSavedPref && currentUnlockStatus && (
        (oldSavedPref.mode === 'dynamic' && currentUnlockStatus.configuredMode === 'dynamic') ||
        (oldSavedPref.mode === 'fixed' && currentUnlockStatus.configuredMode === 'fixed' && Number(oldSavedPref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      );
      if (clientUsingSame) {
        const curVal = describeClientModeValue(currentUnlockStatus);
        ctxResetNoticeEl.textContent = t('msg.resetStillUsing', { val: curVal });
        ctxResetNoticeEl.hidden = false;
      } else {
        ctxResetNoticeEl.hidden = true;
      }
    }
    showUnlockResultBox(true, t('msg.resetDefault'));
  });

  function setScopeMode(newMode) {
    contextScopeMode = newMode === 'per_model' ? 'per_model' : 'unified';
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    syncContextPreferencesCache(contextPreferencesMap);
    void saveSettingsPayloadBridge({ contextScopeMode });
    loadDraftFromSelectedModel(true);
    const prod = getSelectedProductObj();
    if (prod) renderModelDetailCard(prod);
  }

  btnModeUnified?.addEventListener('click', () => setScopeMode('unified'));
  btnModePerModel?.addEventListener('click', () => setScopeMode('per_model'));

  async function invokeUnlockApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getContextUnlockStatus) {
      return await window.contextMeterAPI.getContextUnlockStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyContextUnlock) {
      return await window.contextMeterAPI.applyContextUnlock(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreContextUnlock) {
      return await window.contextMeterAPI.restoreContextUnlock(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/context-unlock-${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('models.err.noApplyBridge') };
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/restart-host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: '{}'
      });
      return await r.json().catch(() => ({ ok: true, supported: false }));
    }
    return { ok: true, supported: false };
  }

  async function invokeEnhanceApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getEnhanceStatus) {
      return await window.contextMeterAPI.getEnhanceStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyEnhancePatch) {
      return await window.contextMeterAPI.applyEnhancePatch(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreAllEnhance) {
      return await window.contextMeterAPI.restoreAllEnhance(payload);
    }
    if (endpoint === 'restart-ls' && window.contextMeterAPI?.restartLanguageServers) {
      return await window.contextMeterAPI.restartLanguageServers(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const routeMap = {
        status: '/enhance-status',
        apply: '/enhance-apply',
        restore: '/enhance-restore',
        'restart-ls': '/restart-language-servers'
      };
      const path = routeMap[endpoint];
      if (path) {
        const r = await fetch(`http://127.0.0.1:${live.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(payload)
        });
        return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      }
    }
    return { ok: false, error: t('enhance.result.noBridge'), unavailable: true };
  }

  async function invokeModulesApi(action, name, enable, opts = {}) {
    if (action === 'status' && window.contextMeterAPI?.getModulesStatus) {
      return await window.contextMeterAPI.getModulesStatus();
    }
    if (action === 'toggle' && window.contextMeterAPI?.toggleModule) {
      return await window.contextMeterAPI.toggleModule(name, enable, opts);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const route = action === 'status' ? '/modules-status' : '/toggle-module';
      const body = action === 'status' ? {} : { name, enable, opts };
      const r = await fetch(`http://127.0.0.1:${live.port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(body)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
  }

  async function refreshUnlockStatus() {
    const thisSeq = ++unlockReqSeq;
    try {
      const currentObservedBudget = (state.latest?.budget && state.latest.budget > 0)
        ? state.latest.budget
        : undefined;
      const res = await invokeUnlockApi('status', { currentBudget: currentObservedBudget });
      if (thisSeq !== unlockReqSeq) return;

      if (!res || !res.ok || !res.data) {
        unlockStatusFetchError = true;
        currentUnlockStatus = null;
        if (unlockStatusDesc) unlockStatusDesc.textContent = t('status.client.unavailable');
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
        return;
      }

      unlockStatusFetchError = false;
      const data = res.data;
      currentUnlockStatus = data;
      lastPartialReason = data.partialMatchReason || data.error || '';
      if (typeof data.hostSupportsRestart === 'boolean') {
        hostSupportsRestart = data.hostSupportsRestart;
      }
      if (data.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
      } else if (data.status === 'patched_loaded' || data.status === 'not_patched') {
        needsRestartAfterApply = false;
      }

      // 重启后校验核对
      if (pendingRestartVerification) {
        if (data.runtimeEvidence?.restartDetected === true) {
          if (data.status === 'patched_loaded' && doesClientMatchVerification(data, pendingRestartVerification)) {
            restartMismatchNotice = '';
          } else {
            restartMismatchNotice = t('models.status.restartMismatch', { actual: describeClientModeValue(data) });
          }
          pendingRestartVerification = null;
          void saveSettingsPayloadBridge({ uiPreferences: { restartVerification: null } });
        }
      }

      const statusInfo = mapUnlockDisplayStatus(data);
      if (unlockStatusDesc) {
        unlockStatusDesc.textContent = t('models.status.line', { badge: statusInfo.badge, mode: describeClientModeValue(data) });
      }
      if (unlockMetaMode) {
        unlockMetaMode.textContent = `${describeClientModeValue(data)}（${statusInfo.badge}）`;
      }
      if (unlockMetaTarget) {
        unlockMetaTarget.textContent = data.arch ? t('models.meta.targetDesktopArch', { arch: data.arch }) : t('models.meta.targetDesktop');
      }
      if (unlockMetaArch) unlockMetaArch.textContent = data.arch || t('models.meta.archUnknown');
      if (unlockMetaBackup) {
        unlockMetaBackup.textContent = data.hasBackup
          ? (data.backupStaleReason ? t('models.meta.backupStale') : t('models.meta.backupReady'))
          : t('models.meta.backupNone');
      }

      if (btnApplyUnlock) {
        const writableStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
        if (writableStatuses.has(data.status) && (!data.arch || data.arch === 'x86-64')) {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.saveApply');
        } else if (data.status === 'partial_match') {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.partialBlocked');
        } else if (data.status === 'failed') {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.retryApply');
        } else {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.unsupported');
        }
      }

      if (btnRestoreUnlock) {
        btnRestoreUnlock.disabled = !(
          (data.hasBackup && data.backupValidForCurrentBinary !== false) ||
          data.hasMatchingGate3BSidecar ||
          (data.status && data.status !== 'not_patched' && data.status !== 'unsupported')
        );
      }

      if (data.status === 'partial_match' && unlockResultBox && (!unlockResultBox.style.display || unlockResultBox.style.display === 'none')) {
        showUnlockResultBox(
          false,
          t('models.card.partialFailDetail', { reason: translateBackendText(lastPartialReason) || '' }),
          { showRetry: true }
        );
      }

      if (!ctxDraftDirty && !resolveProductPreferenceState(getSelectedProductObj()).pref) {
        loadDraftFromSelectedModel(false);
      } else {
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    } catch {
      if (thisSeq !== unlockReqSeq) return;
      unlockStatusFetchError = true;
      currentUnlockStatus = null;
      renderCompactSessionCard();
      renderClientStatusBar();
    }
  }

  btnRefreshUnlock?.addEventListener('click', () => {
    void refreshUnlockStatus();
  });

  btnApplyUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const saved = await saveCurrentProductDraft();
    if (saved.stale) return;
    if (!saved.ok) {
      showUnlockResultBox(false, saved.error);
      return;
    }

    isUnlocking = true;
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    needsRestartAfterApply = false;
    restartMismatchNotice = '';

    try {
      // ELV-41: 底座统一应用为动态透传模式 (mov esi, edx)，使各模型设置能够独立生效，绝不把单一模型的数值固化进二进制
      const res = await invokeUnlockApi('apply', {
        mode: 'dynamic',
        limitTokens: null,
        serviceLimit: state.latest?.serviceLimit || undefined
      });
      if (!res || !res.ok) {
        needsRestartAfterApply = false;
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error), { showRetry: true });
        return;
      }
      if (res.needsRestart === true) {
        needsRestartAfterApply = true;
        showUnlockResultBox(true, t('msg.appliedRestart'), { needsRestart: true });
      } else if (res.alreadyMatched) {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '底座引擎已处于动态跟随状态。当前模型设置已保存，下一次发送时尝试应用。');
      } else {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '已应用底座配置。当前模型设置已保存，下一次发送时尝试应用。');
      }
    } catch (e) {
      needsRestartAfterApply = false;
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
      if (!needsRestartAfterApply && currentUnlockStatus?.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
    }
  });

  let isRestartInProgress = false;

  async function executeClientRestart(fromModal = false) {
    if (isRestartInProgress) return;
    isRestartInProgress = true;
    if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = true;
    if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = true;

    // 记录重启前的观测快照（不保存草稿）
    try {
      const obsObj = budgetTracker ? { ...budgetTracker.exportAllObservationsByProduct() } : {};
      for (const [mid, val] of observedByModelId.entries()) obsObj[mid] = val;
      preRestartSnapshot = { requestedAt: new Date().toISOString(), observations: obsObj };
      localStorage?.setItem(CTX_PRE_RESTART_OBS_KEY, JSON.stringify(preRestartSnapshot));
    } catch {}

    const feedbackEl = fromModal ? modalRestartFeedback : (modalRestartFeedback || ctxRestartFeedback);
    if (feedbackEl) {
      feedbackEl.textContent = t('client.restart.triggering');
      feedbackEl.hidden = false;
    }

    const res = await invokeRestartHostApi();
    if (!res || res.supported === false) {
      hostSupportsRestart = false;
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.hostNotSupported');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      renderClientStatusBar();
      return;
    }
    if (res.ok === false) {
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.failed', { err: translateBackendText(res.error) || t('msg.unknownErr') });
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      return;
    }

    if (feedbackEl) {
      feedbackEl.textContent = t('models.restart.restarting');
      feedbackEl.hidden = false;
    }
    if (restartTimeoutTimer) clearTimeout(restartTimeoutTimer);
    restartTimeoutTimer = setTimeout(() => {
      if (!state.disposed && feedbackEl) {
        feedbackEl.textContent = t('models.restart.notExited');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
    }, 15000);
  }

  function openClientRestartConfirmFlow() {
    if (!hostSupportsRestart) {
      showUnlockResultBox(true, t('client.restart.hostNotSupported'), { needsRestart: true });
      return;
    }
    if (globalRestartModal) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = '';
        modalRestartFeedback.hidden = true;
      }
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      isRestartInProgress = false;
      globalRestartModal.hidden = false;
      return;
    }
    if (ctxRestartConfirm) {
      ctxRestartConfirm.hidden = false;
      if (ctxRestartFeedback) ctxRestartFeedback.hidden = true;
    }
  }

  btnRestartHost?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRestart?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRetry?.addEventListener('click', () => {
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    void refreshUnlockStatus();
  });

  btnModalRestartCancel?.addEventListener('click', () => {
    if (globalRestartModal) globalRestartModal.hidden = true;
  });
  globalRestartModal?.addEventListener('click', (e) => {
    if (e.target === globalRestartModal) {
      globalRestartModal.hidden = true;
    }
  });

  btnModalRestartConfirm?.addEventListener('click', () => executeClientRestart(true));

  btnRestartCancel?.addEventListener('click', () => {
    if (ctxRestartConfirm) ctxRestartConfirm.hidden = true;
  });

  btnRestartConfirmGo?.addEventListener('click', () => executeClientRestart(false));

  btnRestoreUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    isUnlocking = true;
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';

    try {
      const res = await invokeUnlockApi('restore');
      if (!res || !res.ok) {
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error || t('msg.restoreFail')), { showRetry: true });
        return;
      }
      needsRestartAfterApply = true;
      showUnlockResultBox(true, t('msg.restoredRestart'), { needsRestart: true });
    } catch (e) {
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
    }
  });

  // -----------------------------------------------------------------------
  // 速度对比分页与纯 SVG 图表渲染
  // -----------------------------------------------------------------------
  function isValidSpeedSampleSafe(c) {
    if (typeof isValidSpeedSample === 'function') return isValidSpeedSample(c);
    return Boolean(c && c.status === 'final' && !c.estimated && Number(c.outputTokens) > 0 && Number(c.durationSec) > 0 && Number(c.tps) > 0);
  }

  function mergeAvailableSpeedCalls() {
    const byId = new Map();
    const hist = Array.isArray(ANTIGRAVITY_TOKEN_DATA.speedRecords) ? ANTIGRAVITY_TOKEN_DATA.speedRecords : [];
    for (const r of hist) {
      if (r && r.callId) byId.set(r.callId, r);
    }
    const cur = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    for (const r of cur) {
      if (!r || !r.callId) continue;
      const prev = byId.get(r.callId);
      if (!prev || (!isValidSpeedSampleSafe(prev) && isValidSpeedSampleSafe(r)) || Number(r.outputTokens || 0) > Number(prev.outputTokens || 0)) {
        byId.set(r.callId, r);
      }
    }
    return Array.from(byId.values());
  }

  function createSvgEl(tag, attrs = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    const node = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
      : (typeof doc.createElement === 'function' ? doc.createElement(tag) : null);
    if (!node) return null;
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && typeof node.setAttribute === 'function') node.setAttribute(k, String(v));
    }
    return node;
  }

  function renderSpeedBarChart(groups) {
    const svg = el('speed-bar-svg');
    const wrap = el('speed-bar-chart-wrap');
    const emptyEl = el('speed-bar-empty');
    const tooltip = el('speed-bar-tooltip');
    const titleEl = el('speed-bar-title');

    const metricTitleMap = { tps: t('speed.barTitle.tps'), ttft: t('speed.barTitle.ttft'), duration: t('speed.barTitle.duration') };
    if (titleEl) titleEl.textContent = metricTitleMap[speedMetric] || t('speed.barTitle.tps');

    if (!groups.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const rowH = 34;
    const padTop = 8;
    const padBottom = 10;
    const labelW = 148;
    const valW = 86;
    const barAreaW = width - labelW - valW - 12;
    const height = padTop + padBottom + groups.length * rowH;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const getVal = g => speedMetric === 'ttft' ? g.medianTtft : speedMetric === 'duration' ? g.medianDuration : g.medianTps;
    const maxVal = Math.max(...groups.map(g => getVal(g) || 0), 0.1);

    const nodes = [];
    groups.forEach((g, idx) => {
      const y = padTop + idx * rowH;
      const val = getVal(g) || 0;
      const w = Math.max(4, (val / maxVal) * barAreaW);
      const effText = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
      const displayLabel = `${g.productLabel}${effText}`;
      const unitStr = speedMetric === 'tps' ? `${val} tok/s` : t('speed.unitSec', { val });

      const rowGrp = createSvgEl('g', { style: 'cursor:pointer' });
      const bgHit = createSvgEl('rect', { x: 0, y, width, height: rowH - 4, rx: 4, fill: 'transparent' });
      const dot = createSvgEl('circle', {
        cx: 7,
        cy: y + 14,
        r: 3.5,
        fill: VENDOR_DOT_COLORS[g.vendor] || '#8a8a94'
      });
      const lbl = createSvgEl('text', {
        x: 15,
        y: y + 18,
        fill: 'var(--ag-text-primary, #ececef)',
        'font-size': '10.5'
      });
      if (lbl) lbl.textContent = displayLabel.length > 20 ? displayLabel.slice(0, 19) + '…' : displayLabel;

      const track = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: barAreaW,
        height: 14,
        rx: 3,
        fill: 'var(--ag-track-bg, rgba(255,255,255,0.08))'
      });
      const bar = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: w.toFixed(1),
        height: 14,
        rx: 3,
        fill: VENDOR_DOT_COLORS[g.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        opacity: g.lowSample ? '0.45' : '0.92'
      });
      const valTxt = createSvgEl('text', {
        x: labelW + barAreaW + 6,
        y: y + 18,
        fill: g.lowSample ? 'var(--ag-text-muted, #8a8a94)' : 'var(--ag-text-secondary, #c8c8d0)',
        'font-size': '10'
      });
      if (valTxt) valTxt.textContent = `${unitStr}${g.lowSample ? ` ${t('speed.lowSample')}` : ''}`;

      if (rowGrp) {
        if (bgHit) rowGrp.appendChild(bgHit);
        if (dot) rowGrp.appendChild(dot);
        if (lbl) rowGrp.appendChild(lbl);
        if (track) rowGrp.appendChild(track);
        if (bar) rowGrp.appendChild(bar);
        if (valTxt) rowGrp.appendChild(valTxt);
        rowGrp.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const rangeTxt = g.minTs && g.maxTs
            ? `${formatMonthDayTime(g.minTs)} ~ ${formatMonthDayTime(g.maxTs)}`
            : '—';
          tooltip.innerHTML =
            `<strong>${displayLabel}</strong><br>` +
            `${t('speed.tip.samples', { n: g.count, low: g.lowSample ? t('models.card.lowSampleParen') : '' })}<br>` +
            `${t('speed.tip.timeRange', { range: rangeTxt })}<br>` +
            `${t('speed.tip.medOut', { val: fmt(g.medianOutputTokens) })}<br>` +
            `${t('speed.tip.medIn', { val: fmt(g.medianInputTokens) })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = `${Math.max(4, y - 4)}px`;
            tooltip.style.right = '8px';
          }
        });
        rowGrp.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        rowGrp.addEventListener?.('click', () => {
          selectedSpeedExactModelId = g.modelExactId;
          renderSpeedComparisonTab();
        });
        nodes.push(rowGrp);
      }
    });
    svg.replaceChildren(...nodes);
  }

  function renderSpeedLineChart(selectedGroup) {
    const svg = el('speed-line-svg');
    const wrap = el('speed-line-chart-wrap');
    const emptyEl = el('speed-line-empty');
    const tooltip = el('speed-line-tooltip');

    const samples = (selectedGroup?.samples || []).filter(s => s && s.tps > 0);
    if (!samples.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const height = 148;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const maxTps = Math.max(...samples.map(s => Number(s.tps) || 0), 10);
    const minTps = Math.max(0, Math.min(...samples.map(s => Number(s.tps) || 0)) * 0.8);
    const spanTps = Math.max(1, maxTps - minTps);

    const nodes = [];
    // Y 轴参考线与刻度
    [0, 0.5, 1].forEach(ratio => {
      const y = padT + plotH * (1 - ratio);
      const val = Math.round(minTps + spanTps * ratio);
      const grid = createSvgEl('line', {
        x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
        stroke: 'var(--ag-border-subtle, rgba(255,255,255,0.08))', 'stroke-width': 1
      });
      const txt = createSvgEl('text', {
        x: padL - 5, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5'
      });
      if (txt) txt.textContent = String(val);
      if (grid) nodes.push(grid);
      if (txt) nodes.push(txt);
    });

    const pts = samples.map((s, idx) => {
      const x = samples.length === 1 ? padL + plotW / 2 : padL + (idx / (samples.length - 1)) * plotW;
      const y = padT + plotH * (1 - ((Number(s.tps) - minTps) / spanTps));
      return { x, y, sample: s };
    });

    if (pts.length >= 2) {
      const dAttr = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const path = createSvgEl('path', {
        d: dAttr, fill: 'none',
        stroke: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        'stroke-width': 1.8
      });
      if (path) nodes.push(path);
    }

    pts.forEach((pt, idx) => {
      const circle = createSvgEl('circle', {
        cx: pt.x.toFixed(1),
        cy: pt.y.toFixed(1),
        r: 3.5,
        fill: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        stroke: 'var(--ag-bg-panel, #181818)',
        'stroke-width': 1.2,
        style: 'cursor:pointer'
      });
      if (circle) {
        circle.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const s = pt.sample;
          const originTxt = s.origin === 'speed-test' ? t('speed.originProbe') : t('speed.origin.chat');
          const ttftTxt = s.ttftSec != null ? t('speed.unitSec', { val: s.ttftSec }) : t('speed.unknown');
          tooltip.innerHTML =
            `<strong>${t('speed.tip.tpsLine', { idx: idx + 1, tps: s.tps })}</strong><br>` +
            `${t('speed.tip.time', { val: formatMonthDayTime(s.ts || s.createdAt) || '—' })}<br>` +
            `${t('speed.tip.output', { val: fmt(s.outputTokens) })}<br>` +
            `${t('speed.tip.ttft', { val: ttftTxt })}<br>` +
            `${t('speed.tip.origin', { val: originTxt })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = '6px';
            tooltip.style.right = '8px';
          }
        });
        circle.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        nodes.push(circle);
      }
    });

    const firstLbl = createSvgEl('text', { x: padL, y: height - 6, fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (firstLbl) firstLbl.textContent = formatMonthDayTime(samples[0].ts || samples[0].createdAt) || '#1';
    const lastLbl = createSvgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (lastLbl && samples.length > 1) lastLbl.textContent = formatMonthDayTime(samples[samples.length - 1].ts || samples[samples.length - 1].createdAt) || `#${samples.length}`;
    if (firstLbl) nodes.push(firstLbl);
    if (lastLbl) nodes.push(lastLbl);

    svg.replaceChildren(...nodes);
  }

  let lastSpeedGroups = [];

  function renderSpeedComparisonTab() {
    const mergedCalls = mergeAvailableSpeedCalls();
    const daysArg = speedRangeDays === 'all' ? 'all' : Number(speedRangeDays);
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
        days: daysArg,
        origin: speedOriginFilter,
        metric: speedMetric,
        cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
      })
      : [];
    lastSpeedGroups = groups;

    renderSpeedBarChart(groups);

    if (!selectedSpeedExactModelId || !groups.some(g => g.modelExactId === selectedSpeedExactModelId)) {
      selectedSpeedExactModelId = groups[0]?.modelExactId || null;
    }
    const chosenGroup = groups.find(g => g.modelExactId === selectedSpeedExactModelId) || null;
    const speedDropLabel = el('speed-model-dropdown-label');
    if (speedDropLabel) {
      if (chosenGroup) {
        const effStr = chosenGroup.effort ? ` (${formatEffortZh(chosenGroup.effort)})` : '';
        speedDropLabel.textContent = `${chosenGroup.productLabel}${effStr}`;
      } else {
        speedDropLabel.textContent = t('speed.lineNoModel');
      }
    }

    if (!speedModelDropdownCtrl && typeof initDropdownController === 'function' && el('speed-model-dropdown-wrap')) {
      speedModelDropdownCtrl = initDropdownController({
        wrapId: 'speed-model-dropdown-wrap',
        triggerId: 'speed-model-dropdown-trigger',
        labelId: 'speed-model-dropdown-label',
        menuId: 'speed-model-dropdown-menu',
        emptyLabel: () => t('speed.lineNoModel'),
        searchPlaceholder: () => t('dropdown.speedSearch'),
        emptyText: () => t('dropdown.speedEmpty'),
        getSelectedValue: () => selectedSpeedExactModelId || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          selectedSpeedExactModelId = val;
          renderSpeedComparisonTab();
        },
        getOptions: () => lastSpeedGroups.map(g => {
          const effStr = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
          return {
            value: g.modelExactId,
            label: `${g.productLabel}${effStr}`,
            displayRight: t('speed.samples', { n: g.count })
          };
        })
      });
    } else if (speedModelDropdownCtrl && typeof speedModelDropdownCtrl.refresh === 'function') {
      speedModelDropdownCtrl.refresh();
    }

    renderSpeedLineChart(chosenGroup);
  }

  const SPEED_RANGE_MAP = { 'speed-range-7d': '7', 'speed-range-30d': '30', 'speed-range-all': 'all' };
  const SPEED_ORIGIN_MAP = { 'speed-origin-all': 'all', 'speed-origin-chat': 'chat' };
  const SPEED_METRIC_MAP = { 'speed-metric-tps': 'tps', 'speed-metric-ttft': 'ttft', 'speed-metric-duration': 'duration' };

  function bindSpeedFilterGroup(map, onPick) {
    const ids = Object.keys(map);
    ids.forEach(id => {
      el(id)?.addEventListener('click', () => {
        const val = map[id];
        onPick(val);
        ids.forEach(k => setPillActive(el(k), map[k] === val));
        renderSpeedComparisonTab();
      });
    });
  }

  bindSpeedFilterGroup(SPEED_RANGE_MAP, v => { speedRangeDays = v; });
  bindSpeedFilterGroup(SPEED_ORIGIN_MAP, v => { speedOriginFilter = v; });
  bindSpeedFilterGroup(SPEED_METRIC_MAP, v => { speedMetric = v; });

  applyContextViewVisibility();

  const UNLOCK_POST_URL = 'https://linux.do/t/topic/3117832';
  let unlockToastTimer = null;

  function showUnlockToast(msg) {
    if (!unlockLinkToast) return;
    if (unlockToastTimer) clearTimeout(unlockToastTimer);
    unlockLinkToast.textContent = msg;
    unlockLinkToast.style.display = 'block';
    unlockToastTimer = setTimeout(() => {
      unlockLinkToast.style.display = 'none';
    }, 4500);
  }

  async function openUnlockAuthorPost() {
    let opened = false;
    try {
      if (window.contextMeterAPI?.openExternal) {
        const res = await window.contextMeterAPI.openExternal(UNLOCK_POST_URL);
        if (res && res.ok) opened = true;
      }
    } catch {}

    if (!opened) {
      try {
        const w = window.open(UNLOCK_POST_URL, '_blank');
        if (w) opened = true;
      } catch {}
    }

    if (opened) {
      showUnlockToast(t('models.linkOpened'));
    } else {
      copyUnlockPostUrl(true);
    }
  }

  function copyUnlockPostUrl(fromFailedOpen = false) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(UNLOCK_POST_URL);
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = UNLOCK_POST_URL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch {}
    }
    showUnlockToast(fromFailedOpen
      ? t('models.linkCopyFallback')
      : t('models.copyOk'));
  }

  linkUnlockAuthor?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openUnlockAuthorPost();
  });

  linkUnlockAuthor?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      void openUnlockAuthorPost();
    }
  });

  btnCopyUnlockLink?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyUnlockPostUrl(false);
  });

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 模块 1.5: 插件面板语言 (Context Meter) 与客户端语言 (Antigravity)
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');
  const btnClientLangZhCn = el('btn-client-lang-zh-CN');
  const btnClientLangEn = el('btn-client-lang-en');

  function syncPanelLanguageButtons(lang) {
    const normalized = normalizePanelLanguage(lang);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  function syncClientLanguageButtons() {
    if (btnClientLangZhCn) {
      if (currentChineseEnabled) addClass(btnClientLangZhCn, 'active');
      else removeClass(btnClientLangZhCn, 'active');
      btnClientLangZhCn.setAttribute?.('aria-pressed', String(currentChineseEnabled));
    }
    if (btnClientLangEn) {
      if (!currentChineseEnabled) addClass(btnClientLangEn, 'active');
      else removeClass(btnClientLangEn, 'active');
      btnClientLangEn.setAttribute?.('aria-pressed', String(!currentChineseEnabled));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (cardDrawerArrow && cardDrawerBody) {
        const open = cardDrawerBody.style.display === 'block';
        cardDrawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (unlockDrawerArrow && unlockDrawerBody) {
        const open = unlockDrawerBody.style.display === 'block';
        unlockDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
      }
      const btnCostDet = el('btn-cost-details-toggle');
      const costDetBody = el('cost-details-pane');
      if (btnCostDet && costDetBody) {
        const open = costDetBody.style.display === 'block';
        btnCostDet.textContent = open ? t('cost.btnCollapse') : t('cost.btnExpand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch {}
    try { if (typeof applyTheme === 'function') applyTheme(); } catch {}
    try { render(); } catch {}
    try { renderSessionCost(); } catch {}
    try { renderHeaderModelDropdown(); } catch {}
    try { renderModelSettingsTab(); } catch {}
    try { renderSpeedComparisonTab(); } catch {}
    try { if (currentUnlockStatus) { renderClientStatusBar(); renderCompactSessionCard(); } } catch {}
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      } else {
        const pv = el('plan-summary-price-val');
        if (pv && /^\$19\.99\/(月|mo)$/.test(String(pv.textContent || '').trim())) {
          pv.textContent = `$19.99${t('plan.summary.perMonth')}`;
        }
      }
      if (typeof refreshRegionPresetSelectOptions === 'function') refreshRegionPresetSelectOptions();
      if (typeof refreshDirectCountryDisplay === 'function') refreshDirectCountryDisplay();
      if (typeof refreshDirectRegionDisplay === 'function') refreshDirectRegionDisplay();
      if (typeof refreshDirectCurrencyDisplay === 'function') refreshDirectCurrencyDisplay();
    } catch {}
    try {
      if (typeof renderEnhanceSectionUI === 'function') renderEnhanceSectionUI();
    } catch {}
    try {
      if (isChineseExpanded || isProxyExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView && typeof refreshEnhanceStatus === 'function') {
        void refreshEnhanceStatus();
      }
    } catch {}
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
      }
    } catch {}

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch {}
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  // 模块 2: 客户端界面汉化 (AntigravityChinese)
  // -------------------------------------------------------------
  const btnToggleChinese = el('btn-toggle-chinese');
  const chineseDrawerBody = el('chinese-drawer-body');
  const chineseDrawerArrow = el('chinese-drawer-arrow');
  const chineseBadge = el('chinese-badge');
  const chineseStatusDesc = el('chinese-status-desc');
  const btnToggleChineseModule = el('btn-toggle-chinese-module');

  let isChineseExpanded = false;
  let currentChineseEnabled = false;

  btnToggleChinese?.addEventListener('click', () => {
    isChineseExpanded = !isChineseExpanded;
    if (chineseDrawerBody) chineseDrawerBody.style.display = isChineseExpanded ? 'block' : 'none';
    if (chineseDrawerArrow) chineseDrawerArrow.textContent = isChineseExpanded ? t('drawer.collapse') : t('drawer.expand');
    btnToggleChinese?.setAttribute('aria-expanded', String(isChineseExpanded));
    if (isChineseExpanded) {
      void refreshModulesDisplay();
    }
  });

  // -------------------------------------------------------------
  // 模块 3: 免 TUN 网络直连 (AntigravityProxyNoTun)
  // -------------------------------------------------------------
  const btnToggleProxy = el('btn-toggle-proxy');
  const proxyDrawerBody = el('proxy-drawer-body');
  const proxyDrawerArrow = el('proxy-drawer-arrow');
  const proxyBadge = el('proxy-badge');
  const proxyStatusDesc = el('proxy-status-desc');
  const inputProxyUrl = el('input-proxy-url');
  const inputProxyBypass = el('input-proxy-bypass');
  const btnTestProxy = el('btn-test-proxy');
  const btnToggleProxyModule = el('btn-toggle-proxy-module');
  const proxyTestResult = el('proxy-test-result');

  let isProxyExpanded = false;
  let currentProxyEnabled = false;

  btnToggleProxy?.addEventListener('click', () => {
    isProxyExpanded = !isProxyExpanded;
    if (proxyDrawerBody) proxyDrawerBody.style.display = isProxyExpanded ? 'block' : 'none';
    if (proxyDrawerArrow) proxyDrawerArrow.textContent = isProxyExpanded ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleProxy?.setAttribute('aria-expanded', String(isProxyExpanded));
  });

  // -------------------------------------------------------------
  // 模块 3.5: 系统增强、提示词档位、品牌与推荐配置控制器 (PR #3 / PR #4 融合)
  // -------------------------------------------------------------
  const btnEnhancePresetApply = el('btn-enhance-preset-apply');
  const btnEnhanceRestoreAll = el('btn-enhance-restore-all');
  const enhanceGlobalBadge = el('enhance-global-badge');
  const enhancePresetConfirm = el('enhance-preset-confirm');
  const enhanceConfirmTitle = el('enhance-preset-confirm-text');
  const btnEnhanceConfirmCancel = el('btn-enhance-confirm-cancel');
  const btnEnhanceConfirmGo = el('btn-enhance-confirm-go');
  const enhanceGlobalResult = el('enhance-global-result');
  const enhanceResultText = el('enhance-global-result-text');
  const enhanceResultActions = el('enhance-global-result-actions');
  const enhanceManualNote = el('enhance-global-manual-note');
  const btnEnhanceRestartHost = el('btn-enhance-restart-host');
  const btnEnhanceRestartLs = el('btn-enhance-restart-ls');

  const chkPresetPrompt = el('chk-rec-prompt');
  const chkPresetTitle = el('chk-rec-title');
  const chkPresetLang = el('chk-rec-lang');
  const chkPresetCtx = el('chk-rec-ctx');

  const brandTitleBtns = {
    english: el('btn-brand-english'),
    hidden: el('btn-brand-hidden'),
    translated: el('btn-brand-translated')
  };

  const enhancePromptBadge = el('enhance-prompt-badge');
  const enhanceStatPrompt = el('enhance-stat-prompt');
  const enhanceStatTitle = el('enhance-stat-title');
  const enhanceStatSlots = el('enhance-stat-slots');
  const enhanceStatBackup = el('enhance-stat-backup');
  const enhanceTierGrid = el('enhance-tier-grid');
  const enhanceTierBtns = [0, 1, 2, 3, 4].map(n =>
    el(`enhance-tier-${n}`) || enhanceTierGrid?.querySelector?.(`[data-enhance-tier="${n}"]`) || null
  );
  const enhanceTierSummary = el('enhance-tier-matrix-title');
  const enhanceTierCurrentDesc = el('enhance-tier-current-desc');
  const enhanceTierKeeps = el('enhance-tier-keeps');
  const enhanceTierClears = el('enhance-tier-clears');
  const enhanceTierReplaces = el('enhance-tier-replaces');
  const enhanceTierMeaning = el('enhance-tier-meaning');
  const btnApplyBrandTitle = el('btn-apply-brand-title');
  const brandApplyFeedback = el('brand-apply-feedback');
  const enhanceChineseTitleCheck = el('chk-enhance-chinese-title');
  const btnApplyEnhancePrompt = el('btn-enhance-apply-prompt');
  const btnRefreshEnhance = el('btn-enhance-refresh');
  const enhancePromptResult = el('enhance-prompt-result');
  const enhancePromptResultText = el('enhance-prompt-result-text');
  const btnToggleEnhanceDetails = el('btn-toggle-enhance-details');
  const enhanceDetailsBody = el('enhance-details-body');
  const enhanceDetailsArrow = el('enhance-details-arrow');
  const enhanceBinaryList = el('enhance-binary-list');

  let currentBrandTitle = 'english';
  let currentEnhanceStatus = null;
  let selectedEnhanceTier = 0;
  let enhanceTitleDraft = false;
  let pendingEnhanceConfirmMode = null; // 'preset' | 'restore' | null
  let isEnhanceBusy = false;
  let hasPendingLsReload = false;

  function syncBrandTitleButtons(mode = currentBrandTitle) {
    for (const [k, btn] of Object.entries(brandTitleBtns)) {
      if (!btn) continue;
      const active = k === mode;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
  }

  function renderEnhancePromptMatrix(tier = selectedEnhanceTier) {
    const idx = [0, 1, 2, 3, 4].includes(Number(tier)) ? Number(tier) : 0;
    const allTierBtns = enhanceTierGrid?.querySelectorAll?.('[data-enhance-tier]') || enhanceTierBtns.filter(Boolean);
    allTierBtns.forEach?.((btn) => {
      const bIdx = Number(btn.getAttribute?.('data-enhance-tier'));
      const active = bIdx === idx;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    });
    if (enhanceTierSummary) enhanceTierSummary.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierCurrentDesc) enhanceTierCurrentDesc.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierKeeps) enhanceTierKeeps.textContent = t(`enhance.tier.${idx}.keeps`);
    if (enhanceTierClears) enhanceTierClears.textContent = t(`enhance.tier.${idx}.clears`);
    if (enhanceTierReplaces) enhanceTierReplaces.textContent = t(`enhance.tier.${idx}.replaces`);
    if (enhanceTierMeaning) enhanceTierMeaning.textContent = t(`enhance.tier.${idx}.meaning`);
  }

  function renderEnhanceSectionUI() {
    syncBrandTitleButtons(currentBrandTitle);
    renderEnhancePromptMatrix(selectedEnhanceTier);
    const data = currentEnhanceStatus;
    const s = data?.summary || data;
    const tierNum = s?.promptTier ?? s?.detectedTier;
    const hasTitle = Boolean(s?.chineseTitleEnabled);
    const titleMode = s?.chineseTitleMode || (hasTitle ? 'zh' : 'en');
    const slotCount = Number(s?.slotCount || 0);
    const totalCap = Number(s?.totalCapacityBytes || 0);
    const activeBytes = Number(s?.activeSlotBytes || 0);
    const allBak = Boolean(s?.allBackedUp ?? s?.hasBackup);
    const targetsList = Array.isArray(data?.binaries) ? data.binaries : (Array.isArray(data?.targets) ? data.targets : []);

    if (enhanceGlobalBadge) {
      if (!data || !data.supported) {
        enhanceGlobalBadge.textContent = t('enhance.status.unread');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      } else if (Number(tierNum) > 0 || hasTitle) {
        enhanceGlobalBadge.textContent = t('enhance.status.patchedActive');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else {
        enhanceGlobalBadge.textContent = t('enhance.status.stock');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      }
    }
    if (enhancePromptBadge) {
      if (!data || !data.supported) {
        enhancePromptBadge.textContent = t('enhance.status.unread');
        enhancePromptBadge.className = 'key-pill pill-muted';
      } else {
        enhancePromptBadge.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
        enhancePromptBadge.className = Number(tierNum) > 0 ? 'key-pill pill-ok' : 'key-pill pill-muted';
      }
    }
    if (enhanceStatPrompt) {
      if (!data || !data.supported) {
        enhanceStatPrompt.textContent = t('enhance.status.unread');
      } else {
        enhanceStatPrompt.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
      }
    }
    if (enhanceStatTitle) {
      if (!data || !data.supported) enhanceStatTitle.textContent = t('enhance.status.unread');
      else if (titleMode === 'zh' || hasTitle) enhanceStatTitle.textContent = hasPendingLsReload ? t('enhance.titleState.onWritten') : t('enhance.titleState.on');
      else if (titleMode === 'mixed') enhanceStatTitle.textContent = t('enhance.titleState.conflict');
      else enhanceStatTitle.textContent = t('enhance.titleState.off');
    }
    if (enhanceStatSlots) {
      if (!data || !data.supported || totalCap <= 0) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else {
        enhanceStatSlots.textContent = `${activeBytes} / ${totalCap} B (${slotCount})`;
      }
    }
    if (enhanceStatBackup) {
      if (!data || !data.supported) enhanceStatBackup.textContent = t('enhance.status.unread');
      else enhanceStatBackup.textContent = allBak ? t('enhance.status.backupYes') : t('enhance.status.backupNo');
    }
    if (enhanceBinaryList && targetsList.length) {
      enhanceBinaryList.textContent = targetsList.map(tgt => `${tgt.label || tgt.id || ''}: ${tgt.path || tgt}${tgt.exists === false ? ' (missing)' : ''}`).join(' | ');
    }
    if (enhanceDetailsArrow && enhanceDetailsBody) {
      const open = enhanceDetailsBody.style.display === 'block';
      enhanceDetailsArrow.textContent = open ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    }
  }

  function showEnhanceResultBox(ok, message, opts = {}) {
    if (!enhanceGlobalResult || !enhanceResultText) return;
    enhanceGlobalResult.style.display = 'block';
    enhanceGlobalResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhanceResultText.textContent = message;
    const needLs = Boolean(opts.needsLsRestart);
    const needHost = Boolean(opts.needsHostRestart);
    const canRestartHost = Boolean(hostSupportsRestart);
    if (btnEnhanceRestartLs) btnEnhanceRestartLs.hidden = !needLs;
    if (btnEnhanceRestartHost) btnEnhanceRestartHost.hidden = !(needHost && canRestartHost);
    if (enhanceManualNote) enhanceManualNote.hidden = !(needHost && !canRestartHost);
    if (enhanceResultActions) enhanceResultActions.hidden = !(needLs || (needHost && canRestartHost));
  }

  function showEnhancePromptResult(ok, message) {
    if (!enhancePromptResult || !enhancePromptResultText) return;
    enhancePromptResult.style.display = 'block';
    enhancePromptResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhancePromptResultText.textContent = message;
  }

  async function refreshEnhanceStatus(syncDrafts = true) {
    try {
      const res = await invokeEnhanceApi('status', {});
      if (res && res.ok && res.data) {
        currentEnhanceStatus = res.data;
        const s = res.data.summary || res.data;
        if (syncDrafts) {
          const tierVal = s.promptTier ?? s.detectedTier;
          if ([0, 1, 2, 3, 4].includes(Number(tierVal))) {
            selectedEnhanceTier = Number(tierVal);
          }
          enhanceTitleDraft = Boolean(s.chineseTitleEnabled);
          if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.checked = enhanceTitleDraft;
        }
      } else if (res && res.unavailable) {
        currentEnhanceStatus = { supported: false };
      }
    } catch {
      currentEnhanceStatus = null;
    }
    renderEnhanceSectionUI();
  }

  for (let i = 0; i < enhanceTierBtns.length; i++) {
    const btn = enhanceTierBtns[i];
    btn?.addEventListener('click', () => {
      selectedEnhanceTier = i;
      renderEnhancePromptMatrix(i);
    });
  }

  enhanceTierGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('[data-enhance-tier]');
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-enhance-tier'));
    if (![0, 1, 2, 3, 4].includes(idx)) return;
    selectedEnhanceTier = idx;
    renderEnhancePromptMatrix(idx);
  });

  enhanceChineseTitleCheck?.addEventListener('change', (e) => {
    enhanceTitleDraft = Boolean(e?.target?.checked);
  });

  btnToggleEnhanceDetails?.addEventListener('click', () => {
    if (!enhanceDetailsBody) return;
    const isHidden = enhanceDetailsBody.style.display === 'none' || !enhanceDetailsBody.style.display;
    enhanceDetailsBody.style.display = isHidden ? 'block' : 'none';
    btnToggleEnhanceDetails.setAttribute('aria-expanded', String(isHidden));
    renderEnhanceSectionUI();
  });

  btnRefreshEnhance?.addEventListener('click', () => {
    void refreshEnhanceStatus(true);
  });

  btnApplyEnhancePrompt?.addEventListener('click', async () => {
    if (isEnhanceBusy) return;
    isEnhanceBusy = true;
    const wantTitle = enhanceChineseTitleCheck ? Boolean(enhanceChineseTitleCheck.checked) : enhanceTitleDraft;
    if (btnApplyEnhancePrompt) {
      btnApplyEnhancePrompt.disabled = true;
      btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPromptBusy');
    }
    try {
      const res = await invokeEnhanceApi('apply', {
        promptTier: selectedEnhanceTier,
        chineseTitle: wantTitle,
        restartLanguageServer: false
      });
      if (!res || !res.ok) {
        const errMsg = t('enhance.result.fail', { err: translateBackendText(res?.error) || t('msg.unknownErr') });
        showEnhancePromptResult(false, errMsg);
        showEnhanceResultBox(false, errMsg);
      } else {
        const tierLabel = t(`enhance.tier.${selectedEnhanceTier}.short`);
        const titleLabel = wantTitle ? t('enhance.titleState.on') : t('enhance.titleState.off');
        hasPendingLsReload = true;
        const msg = t('enhance.result.appliedNeedRestartLs', { tier: tierLabel, title: titleLabel });
        showEnhancePromptResult(true, msg);
        showEnhanceResultBox(true, msg, { needsLsRestart: true, needsHostRestart: false });
      }
      await refreshEnhanceStatus(true);
    } catch (e) {
      const errMsg = t('enhance.result.fail', { err: e?.message || t('msg.unknownErr') });
      showEnhancePromptResult(false, errMsg);
      showEnhanceResultBox(false, errMsg);
    } finally {
      isEnhanceBusy = false;
      if (btnApplyEnhancePrompt) {
        btnApplyEnhancePrompt.disabled = false;
        btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPrompt');
      }
    }
  });

  btnEnhancePresetApply?.addEventListener('click', () => {
    const selectedLabels = [];
    if (chkPresetPrompt?.checked) selectedLabels.push(t('enhance.preset.itemPrompt'));
    if (chkPresetTitle?.checked) selectedLabels.push(t('enhance.preset.itemTitle'));
    if (chkPresetLang?.checked) selectedLabels.push(t('enhance.preset.itemLang'));
    if (chkPresetCtx?.checked) selectedLabels.push(t('enhance.preset.itemCtx'));
    if (!selectedLabels.length) {
      showEnhanceResultBox(false, t('enhance.confirm.noneSelected'));
      return;
    }
    pendingEnhanceConfirmMode = 'preset';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.presetSummary', { items: selectedLabels.join('、') });
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceRestoreAll?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = 'restore';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.restoreSummary');
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceConfirmCancel?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
  });

  btnEnhanceConfirmGo?.addEventListener('click', async () => {
    const mode = pendingEnhanceConfirmMode;
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
    if (!mode || isEnhanceBusy) return;

    isEnhanceBusy = true;
    try {
      const doneParts = [];
      const failedParts = [];
      let needsLsRestart = false;
      let needsHostRestart = false;

      if (mode === 'preset') {
        const wantPrompt = Boolean(chkPresetPrompt?.checked);
        const wantTitle = Boolean(chkPresetTitle?.checked);
        const wantLang = Boolean(chkPresetLang?.checked);
        const wantCtx = Boolean(chkPresetCtx?.checked);

        if (wantPrompt || wantTitle) {
          const itemLabel = [wantPrompt ? t('enhance.preset.itemPrompt') : '', wantTitle ? t('enhance.preset.itemTitle') : ''].filter(Boolean).join('、');
          try {
            const payload = {};
            if (wantPrompt) payload.promptTier = 4;
            if (wantTitle) payload.chineseTitle = true;
            const eRes = await invokeEnhanceApi('apply', payload);
            if (!eRes || !eRes.ok) {
              throw new Error(translateBackendText(eRes?.error) || t('msg.unknownErr'));
            }
            if (wantPrompt) doneParts.push(t('enhance.preset.itemPrompt'));
            if (wantTitle) doneParts.push(t('enhance.preset.itemTitle'));
            if (eRes.needsRestart !== false) needsLsRestart = true;
          } catch (stepErr) {
            failedParts.push(`${itemLabel}: ${stepErr?.message || t('msg.unknownErr')}`);
          }
        }

        if (wantLang) {
          try {
            const lRes = await invokeModulesApi('toggle', 'chinese', true, {
              language: 'zh-CN',
              brandTitle: currentBrandTitle
            });
            if (!lRes || !lRes.ok) {
              throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
            }
            doneParts.push(t('enhance.preset.itemLang'));
            needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
          }
        }

        if (wantCtx) {
          try {
            const cRes = await invokeUnlockApi('apply', { mode: 'dynamic', limitTokens: null });
            if (!cRes || !cRes.ok) {
              throw new Error(buildFriendlyWriteError(cRes?.error));
            }
            doneParts.push(t('enhance.preset.itemCtx'));
            if (cRes.needsRestart) needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.unknownErr')}`);
          }
        }
      } else if (mode === 'restore') {
        const promptTitleLabel = `${t('enhance.preset.itemPrompt')} / ${t('enhance.preset.itemTitle')}`;
        try {
          const rRes = await invokeEnhanceApi('restore', {});
          if (!rRes || !rRes.ok) {
            throw new Error(translateBackendText(rRes?.error) || t('msg.restoreFail'));
          }
          doneParts.push(promptTitleLabel);
          if (rRes.needsRestart) needsLsRestart = true;
        } catch (stepErr) {
          failedParts.push(`${promptTitleLabel}: ${stepErr?.message || t('msg.restoreFail')}`);
        }

        try {
          const lRes = await invokeModulesApi('toggle', 'chinese', false, { language: 'en', brandTitle: 'english' });
          if (!lRes || !lRes.ok) {
            throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
          }
          currentBrandTitle = 'english';
          doneParts.push(t('enhance.preset.itemLang'));
          needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
        }

        try {
          const cRes = await invokeUnlockApi('restore', {});
          if (!cRes || !cRes.ok) {
            throw new Error(buildFriendlyWriteError(cRes?.error));
          }
          doneParts.push(t('enhance.preset.itemCtx'));
          if (cRes.needsRestart) needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.restoreFail')}`);
        }
      }

      if (needsHostRestart) needsRestartAfterApply = true;

      if (failedParts.length > 0) {
        const msg = doneParts.length > 0
          ? t('enhance.result.partialFail', { done: doneParts.join('、'), failed: failedParts.join('；') })
          : t('enhance.result.fail', { err: failedParts.join('；') });
        showEnhanceResultBox(false, msg, { needsLsRestart, needsHostRestart });
      } else if (mode === 'preset') {
        showEnhanceResultBox(
          true,
          t('enhance.result.presetDone', { summary: doneParts.join('、') }),
          { needsLsRestart, needsHostRestart }
        );
      } else if (mode === 'restore') {
        showEnhanceResultBox(true, t('enhance.result.restoredDone'), { needsLsRestart, needsHostRestart: true });
      }
      await Promise.all([refreshEnhanceStatus(true), refreshModulesDisplay(), refreshUnlockStatus()]);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.fail', { err: e?.message || t('msg.unknownErr') }));
    } finally {
      isEnhanceBusy = false;
    }
  });

  btnEnhanceRestartLs?.addEventListener('click', async () => {
    try {
      const res = await invokeEnhanceApi('restart-ls', {});
      if (!res || !res.ok) {
        showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      const killedCount = Array.isArray(res.killed) ? res.killed.length : (Number(res.killed) || 0);
      hasPendingLsReload = false;
      showEnhanceResultBox(true, t('enhance.result.lsRestarted', { killed: killedCount }), { needsLsRestart: false, needsHostRestart: needsRestartAfterApply });
      await refreshEnhanceStatus(false);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: e?.message || t('msg.unknownErr') }));
    }
  });

  btnEnhanceRestartHost?.addEventListener('click', openClientRestartConfirmFlow);

  let selectedBrandTitle = currentBrandTitle;
  let brandObserver = null;

  function ensureBrandObserver(modeKey, targetBtn) {
    if (brandObserver) {
      try { brandObserver.disconnect(); } catch {}
      brandObserver = null;
    }
    if (!targetBtn || modeKey === 'english') return;
    try {
      const container = targetBtn.parentElement || targetBtn;
      brandObserver = new MutationObserver(() => {
        const btn = document.querySelector('button[data-agy-brand-item="true"]') || targetBtn;
        if (!btn) return;
        const txt = btn.textContent?.trim() || '';
        if (modeKey === 'hidden' && txt !== '') {
          btn.textContent = '';
        } else if (modeKey === 'translated' && txt !== '反重力') {
          btn.textContent = '反重力';
        }
      });
      brandObserver.observe(container, { childList: true, subtree: true, characterData: true });
    } catch {}
  }

  function applyBrandTitleToDom(modeKey) {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { found: false, applied: false, nodeText: null };
    }
    // 1. 优先通过持久化标记锁定曾确认过的品牌节点（确保隐藏清空文字后仍可精准识别与无损恢复）
    let targetBtn = document.querySelector('button[data-agy-brand-item="true"]');

    // 2. 若尚未标记，遍历所有 title-menu-bar-item 菜单按钮，精准仅匹配原文本为 Antigravity 的节点
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const menuItems = document.querySelectorAll('button[data-testid="title-menu-bar-item"]');
      for (const btn of menuItems) {
        const txt = btn.textContent?.trim();
        if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
          targetBtn = btn;
          break;
        }
      }
    }

    // 3. 备选：极左上角区域（top <= 70 && left <= 300）候选定位
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const candidateBtns = document.querySelectorAll('button.agy-button, button[class*="agy-button"]');
      for (const btn of candidateBtns) {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { top: 0, left: 0 };
        if (rect.top <= 70 && rect.left <= 300) {
          const txt = btn.textContent?.trim();
          if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
            targetBtn = btn;
            break;
          }
        }
      }
    }

    if (!targetBtn) {
      return { found: false, applied: false, nodeText: null };
    }

    // 永久保留节点引用与原始身份标记，不顺带修改 document.title 或任务栏标题
    targetBtn.setAttribute('data-agy-brand-item', 'true');
    targetBtn._agyBrandManaged = true;
    if (!targetBtn._agyOriginalText) {
      targetBtn._agyOriginalText = 'Antigravity';
    }

    const expectedText = modeKey === 'translated' ? '反重力' : (modeKey === 'hidden' ? '' : 'Antigravity');

    const nodes = targetBtn.childNodes ? Array.from(targetBtn.childNodes) : (targetBtn.children || []);
    let textNode = null;
    for (const node of nodes) {
      if (node && node.nodeType === 3) {
        textNode = node;
        break;
      }
    }

    // 保留菜单入口可用（不设置 display: none，隐藏模式仅清空文字），确保菜单功能随时可点击
    targetBtn.style.display = '';
    if (textNode) {
      textNode.nodeValue = expectedText;
    } else {
      targetBtn.textContent = expectedText;
    }
    targetBtn.setAttribute('data-agy-brand-mode', modeKey);

    ensureBrandObserver(modeKey, targetBtn);

    const currentText = targetBtn.textContent?.trim() || '';
    const isApplied = (modeKey === 'hidden' ? currentText === '' : currentText === expectedText);

    return {
      found: true,
      applied: isApplied,
      nodeText: currentText
    };
  }

  function showBrandFeedback(mode, isSuccess = true, customMsg = '', isApplied = false) {
    if (!brandApplyFeedback) return;
    if (!isSuccess) {
      brandApplyFeedback.textContent = customMsg || t('msg.saveFail');
      brandApplyFeedback.style.color = '#ef4444';
      brandApplyFeedback.hidden = false;
      return;
    }
    const modeLabel = t(`enhance.brand.${mode}`) || mode;
    let msg = customMsg;
    if (!msg) {
      msg = isApplied
        ? `${t('enhance.brand.switched', { mode: modeLabel })}（已即时生效）`
        : `${t('enhance.brand.switched', { mode: modeLabel })}（未检测到目标，${t('models.status.pendingRestart')}）`;
    }
    brandApplyFeedback.textContent = msg;
    if (!isApplied) {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'unlock-btn unlock-btn-secondary';
      rBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;cursor:pointer;';
      rBtn.textContent = t('models.btnRestartHost');
      rBtn.addEventListener('click', () => openClientRestartConfirmFlow());
      brandApplyFeedback.appendChild(rBtn);
    }
    brandApplyFeedback.style.color = isApplied ? '#10b981' : 'var(--ag-text-primary)';
    brandApplyFeedback.hidden = false;
  }

  async function applyBrandTitleSetting(modeKey) {
    try {
      const res = await invokeModulesApi('toggle', 'chinese', currentChineseEnabled, {
        language: currentChineseEnabled ? 'zh-CN' : 'en',
        brandTitle: modeKey
      });
      if (!res || !res.ok) {
        const err = translateBackendText(res?.error) || t('msg.saveFail');
        showBrandFeedback(modeKey, false, err, false);
        showEnhanceResultBox(false, err);
        return;
      }
      currentBrandTitle = modeKey;
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);

      // 实时真实 DOM 应用
      const domResult = applyBrandTitleToDom(modeKey);

      // 实时热同步（若已注入运行时环境）
      try {
        if (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__) {
          window.__AGY_I18N_CONFIG__.brandTitle = modeKey;
          if (typeof window.__AGY_RUN_FULL_SCAN__ === 'function') {
            window.__AGY_RUN_FULL_SCAN__();
          }
        }
      } catch {}

      const modeLabel = t(`enhance.brand.${modeKey}`) || modeKey;
      if (domResult.applied) {
        const appliedMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（左上角品牌已切换为：${modeLabel}）`;
        showBrandFeedback(modeKey, true, appliedMsg, true);
        showEnhanceResultBox(true, appliedMsg, { needsHostRestart: false });
      } else {
        const pendingMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（当前窗口未检测到品牌节点，重启客户端后生效）`;
        showBrandFeedback(modeKey, true, pendingMsg, false);
        showEnhanceResultBox(true, pendingMsg, { needsHostRestart: true });
      }
    } catch (e) {
      const err = e?.message || t('msg.saveFail');
      showBrandFeedback(modeKey, false, err, false);
      showEnhanceResultBox(false, err);
    }
  }

  for (const [modeKey, btn] of Object.entries(brandTitleBtns)) {
    btn?.addEventListener('click', () => {
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);
      void applyBrandTitleSetting(modeKey);
    });
  }

  btnApplyBrandTitle?.addEventListener('click', () => {
    void applyBrandTitleSetting(selectedBrandTitle || currentBrandTitle);
  });

  async function refreshModulesDisplay() {
    try {
      const res = await invokeModulesApi('status');
      if (!res || !res.ok || !res.data) {
        const errMsg = (res && res.error) ? translateBackendText(res.error) : t('msg.unknownErr');
        if (chineseBadge) {
          chineseBadge.textContent = t('mod.readFail');
          chineseBadge.className = 'key-pill pill-danger';
        }
        if (chineseStatusDesc) {
          chineseStatusDesc.textContent = t('mod.zh.failDetect', { err: errMsg });
        }
        if (proxyBadge) {
          proxyBadge.textContent = t('mod.readFail');
          proxyBadge.className = 'key-pill pill-danger';
        }
        if (proxyStatusDesc) {
          proxyStatusDesc.textContent = t('mod.proxy.failDetect', { err: errMsg });
        }
        return;
      }
      const cfg = res.data;

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      currentBrandTitle = cfg.modules?.chinese?.brandTitle || 'english';
      syncBrandTitleButtons(currentBrandTitle);
      applyBrandTitleToDom(currentBrandTitle);
      // 判定宿主界面是否已翻译：定向检查系统导航、活动栏、菜单及操作按钮等固有系统壳层（排除用户消息内容区域）
      const isDomTranslated = (() => {
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const systemContainers = document.querySelectorAll(
            "div[role='navigation'], nav, header, [role='banner'], aside, [data-testid*='sidebar'], [data-testid*='navigation'], [class*='@container/titlebar'], .monaco-workbench, .activitybar"
          );
          const systemKeywords = ['新建对话', '新建会话', '新建', '设置', '账户', '项目', '关于', '帮助', '工作区', '管理', '自定义扩展', '资源管理器', '活动栏'];
          for (let i = 0; i < systemContainers.length; i++) {
            const container = systemContainers[i];
            if (container.closest && container.closest('.chat-session, .conversation-view, .monaco-list-row, .markdown, [data-testid*="chat"], [data-testid*="message"]')) {
              continue; // 严格排除用户聊天内容区
            }
            const labeledNodes = container.querySelectorAll ? container.querySelectorAll('button, a, [role="button"], [aria-label], [title], span') : [];
            for (let j = 0; j < Math.min(labeledNodes.length, 40); j++) {
              const node = labeledNodes[j];
              const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
              if (label && systemKeywords.some(kw => label.includes(kw))) return true;
              const text = (node.textContent || '').trim();
              if (text && systemKeywords.some(kw => text.includes(kw))) return true;
            }
            const txt = container.innerText || '';
            if (systemKeywords.some(kw => txt.includes(kw))) return true;
          }
          const nav = document.querySelector("div[role='navigation'], nav");
          if (nav && nav.innerText && systemKeywords.some(kw => nav.innerText.includes(kw))) {
            return true;
          }
        } catch {}
        return false;
      })();
      const disk = res.disk || {};

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = disk.chinese ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!disk.chinese) {
          chineseBadge.textContent = t('mod.zh.badgeNotInjected');
          chineseBadge.className = 'key-pill pill-danger';
        } else {
          chineseBadge.textContent = t('mod.zh.badgePendingRestart');
          chineseBadge.className = 'key-pill pill-warn';
        }
      }
      if (chineseStatusDesc) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseStatusDesc.textContent = t('mod.zh.descRestartEn');
          } else {
            chineseStatusDesc.textContent = disk.chinese
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!disk.chinese) {
          chineseStatusDesc.textContent = t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();

      currentProxyEnabled = Boolean(cfg.modules?.proxy?.enabled);
      if (proxyBadge) {
        if (currentProxyEnabled) {
          proxyBadge.textContent = disk.proxy ? t('mod.proxy.badgeOk') : t('mod.proxy.badgeNotInjected');
          proxyBadge.className = disk.proxy ? 'key-pill pill-ok' : 'key-pill pill-warn';
        } else {
          proxyBadge.textContent = t('mod.proxy.badgeOff');
          proxyBadge.className = 'key-pill pill-muted';
        }
      }
      if (inputProxyUrl && cfg.modules?.proxy?.proxyUrl) {
        inputProxyUrl.value = cfg.modules.proxy.proxyUrl;
      }
      if (inputProxyBypass && cfg.modules?.proxy?.bypassList) {
        inputProxyBypass.value = cfg.modules.proxy.bypassList;
      }
      if (proxyStatusDesc) {
        if (currentProxyEnabled) {
          proxyStatusDesc.textContent = disk.proxy
            ? t('mod.proxy.descOn', { url: cfg.modules.proxy.proxyUrl })
            : t('mod.proxy.descNeedInject');
        } else {
          proxyStatusDesc.textContent = t('mod.proxy.descOff');
        }
      }
      if (btnToggleProxyModule) {
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (chineseBadge) {
        chineseBadge.textContent = t('mod.readErr');
        chineseBadge.className = 'key-pill pill-danger';
      }
      if (chineseStatusDesc) {
        chineseStatusDesc.textContent = t('mod.zh.errDetect', { err: errMsg });
      }
      if (proxyBadge) {
        proxyBadge.textContent = t('mod.readErr');
        proxyBadge.className = 'key-pill pill-danger';
      }
      if (proxyStatusDesc) {
        proxyStatusDesc.textContent = t('mod.proxy.errDetect', { err: errMsg });
      }
    }
  }

  async function setClientLanguageTarget(wantChinese) {
    if (Boolean(wantChinese) === Boolean(currentChineseEnabled)) return;
    if (btnToggleChineseModule) {
      btnToggleChineseModule.disabled = true;
      btnToggleChineseModule.textContent = t('mod.processing');
    }
    try {
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en',
        brandTitle: currentBrandTitle
      });
      if (!res || !res.ok) {
        showEnhanceResultBox(false, translateBackendText(res?.error) || t('mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, `${t('mod.zh.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleChineseModule) {
        btnToggleChineseModule.disabled = false;
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
    }
  }

  btnClientLangZhCn?.addEventListener('click', () => {
    void setClientLanguageTarget(true);
  });
  btnClientLangEn?.addEventListener('click', () => {
    void setClientLanguageTarget(false);
  });

  btnToggleChineseModule?.addEventListener('click', () => {
    void setClientLanguageTarget(!currentChineseEnabled);
  });

  btnToggleProxyModule?.addEventListener('click', async () => {
    try {
      btnToggleProxyModule.disabled = true;
      btnToggleProxyModule.textContent = t('mod.processing');
      const res = await invokeModulesApi('toggle', 'proxy', !currentProxyEnabled, {
        proxyUrl: inputProxyUrl?.value?.trim(),
        bypassList: inputProxyBypass?.value?.trim()
      });
      if (!res || !res.ok) {
        showEnhanceResultBox(false, translateBackendText(res?.error) || t('mod.proxy.toggleFail'));
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, `${t('mod.proxy.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleProxyModule) {
        btnToggleProxyModule.disabled = false;
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('settings.proxy.enableBtn');
      }
    }
  });

  btnTestProxy?.addEventListener('click', async () => {
    try {
      const api = window.contextMeterAPI;
      if (!api || typeof api.testProxy !== 'function') return;
      btnTestProxy.disabled = true;
      btnTestProxy.textContent = t('settings.proxy.testing');
      if (proxyTestResult) {
        proxyTestResult.style.display = 'block';
        proxyTestResult.textContent = t('settings.proxy.testingDetail');
      }
      const res = await api.testProxy(inputProxyUrl?.value?.trim());
      if (proxyTestResult) {
        if (!res || !res.ok) {
          proxyTestResult.textContent = t('settings.proxy.testFail', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
        } else {
          const d = res.data;
          proxyTestResult.innerHTML = `
            ${t('settings.proxy.resFmt')}: ${d.configValid ? t('settings.proxy.resValid') : t('settings.proxy.resInvalid')}<br>
            ${t('settings.proxy.resPort')}: ${d.proxyReachable ? t('settings.proxy.resReachable') : t('settings.proxy.resUnreachable')}<br>
            ${t('settings.proxy.resNet')}: ${d.internetReachable ? t('settings.proxy.resOnline') : t('settings.proxy.resOffline')}<br>
            ${t('settings.proxy.resModel')}: ${t('settings.proxy.resPending')}
            ${d.error ? `<br><span style="color:var(--ag-danger)">⚠️ ${translateBackendText(d.error)}</span>` : ''}
          `;
        }
      }
    } catch (e) {
      if (proxyTestResult) proxyTestResult.textContent = t('settings.proxy.testErr', { err: e.message });
    } finally {
      if (btnTestProxy) {
        btnTestProxy.disabled = false;
        btnTestProxy.textContent = t('settings.proxy.testBtn');
      }
    }
  });

  // 静默初始化检测一次解锁状态与各模块状态
  setTimeout(() => {
    void refreshUnlockStatus();
    void refreshModulesDisplay();
  }, 500);
  setTimeout(() => {
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);

  // 二级抽屉 1（面板 B 内）: 指标与背景颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  function toggleColorsDrawer(forceOpen) {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
    colorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker();
    }
  }
  btnColors?.addEventListener('click', () => toggleColorsDrawer());

  // 二级抽屉 2（面板 B 内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 模型卡片下一层详情折叠展开（实测预算、速度与内部详情）
  const btnCardDetails = el('btn-toggle-card-details');
  const cardDrawerBody = el('ctx-card-drawer-body');
  const cardDrawerArrow = el('ctx-card-drawer-arrow');
  btnCardDetails?.addEventListener('click', () => {
    if (!cardDrawerBody) return;
    const isHidden = cardDrawerBody.style.display === 'none' || !cardDrawerBody.style.display;
    cardDrawerBody.style.display = isHidden ? 'block' : 'none';
    if (cardDrawerArrow) cardDrawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnCardDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 3（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
  const btnTokenColors = el('btn-toggle-token-colors');
  const tokenColorDrawerBody = el('token-color-drawer-body');
  const tokenColorDrawerArrow = el('token-color-drawer-arrow');
  function toggleTokenColorsDrawer(forceOpen) {
    if (!tokenColorDrawerBody) return;
    const curHidden = tokenColorDrawerBody.style.display === 'none' || !tokenColorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    tokenColorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    tokenColorDrawerBody.classList?.toggle?.('is-expanded', nextOpen);
    if (tokenColorDrawerArrow) tokenColorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnTokenColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker(false);
    }
  }
  btnTokenColors?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('heat-legend-scale')?.addEventListener('click', () => toggleTokenColorsDrawer(true));

  // 热力图视图切换（每天 / 每周 / 累计总量）

  // 费用估算范围（默认本期：自然月）与估值模式（默认参考模型折算，首屏展示真实用量价值）
  let activeCostScope = 'period'; // 'period' | 'all'
  let costModelMode = 'ref'; // 'ref' | 'hybrid' | 'identified'
  let activeRefMode = 'all'; // 兼容旧接口 'all' | 'hybrid'

  function switchCostScope(scope) {
    activeCostScope = scope;
    setPillActive(el('cost-btn-scope-period'), scope === 'period');
    setPillActive(el('cost-btn-scope-all'), scope === 'all');
    renderActiveCostEstimateView();
  }
  el('cost-btn-scope-period')?.addEventListener('click', () => switchCostScope('period'));
  el('cost-btn-scope-all')?.addEventListener('click', () => switchCostScope('all'));

  function switchCostModelMode(mode) {
    costModelMode = mode;
    setPillActive(el('cost-btn-mode-ref'), mode === 'ref');
    setPillActive(el('cost-btn-mode-hybrid'), mode === 'hybrid');
    setPillActive(el('cost-btn-mode-identified'), mode === 'identified');
    renderActiveCostEstimateView();
  }
  el('cost-btn-mode-ref')?.addEventListener('click', () => switchCostModelMode('ref'));
  el('cost-btn-mode-hybrid')?.addEventListener('click', () => switchCostModelMode('hybrid'));
  el('cost-btn-mode-identified')?.addEventListener('click', () => switchCostModelMode('identified'));

  function toggleRefCostDrawer(forceOpen) {
    const body = el('ref-cost-drawer-body');
    const btn = el('btn-toggle-ref-cost-drawer');
    if (!body) return;
    const curHidden = body.style.display === 'none' || !body.style.display;
    const next = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    body.style.display = next ? 'block' : 'none';
    if (btn) btn.textContent = next ? t('cost.btnCollapse') : t('cost.btnExpand');
  }
  el('btn-toggle-ref-cost-drawer')?.addEventListener('click', () => toggleRefCostDrawer());

  function switchRefMode(mode) {
    activeRefMode = mode;
    costModelMode = mode === 'hybrid' ? 'hybrid' : 'ref';
    setPillActive(el('btn-ref-mode-all'), mode === 'all');
    setPillActive(el('btn-ref-mode-hybrid'), mode === 'hybrid');
    renderActiveCostEstimateView();
  }
  el('btn-ref-mode-all')?.addEventListener('click', () => switchRefMode('all'));
  el('btn-ref-mode-hybrid')?.addEventListener('click', () => switchRefMode('hybrid'));

  function renderActiveCostEstimateView() {
    const isPeriod = activeCostScope === 'period';
    const titleEl = el('cost-card-title');
    const periodTag = el('cost-period-tag');
    const grandVal = el('cost-grand-val');
    const grandSub = el('cost-grand-sub');
    const covPill = el('cost-coverage-pill');
    const subSpendVal = el('cost-sub-spend-val');
    const subSpendLbl = el('cost-sub-spend-lbl');
    const subNote = el('cost-sub-compare-note');
    const usageSummary = el('cost-usage-summary');
    const diffSummary = el('cost-diff-summary');
    const breakdown = el('cost-breakdown-info');

    // 分类卡片 DOM
    const inVal = el('ref-cost-input-val');
    const inTok = el('ref-cost-input-tok');
    const caVal = el('ref-cost-cache-val');
    const caTok = el('ref-cost-cache-tok');
    const outVal = el('ref-cost-output-val');
    const outTok = el('ref-cost-output-tok');

    if (titleEl) titleEl.textContent = isPeriod ? t('cost.title') : t('cost.titleAll');
    if (periodTag) {
      const pKey = ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag');
      periodTag.textContent = isPeriod ? pKey : t('cost.allHistory');
    }

    // 1. 提取当前范围真实用量与折算数据
    const curIn = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthInput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalInputTokens || 0);
    const curCa = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthCache || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalCacheTokens || 0);
    const curOut = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthOutput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalOutputTokens || 0);
    const curTotal = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.monthTokens || (curIn + curCa + curOut))
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens || (curIn + curCa + curOut));

    const refAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.all || {};
    const refMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonth || {};
    const refHybridAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.hybrid || {};
    const refHybridMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonthHybrid || refHybridAll;

    const curRef = isPeriod ? refMonth : refAll;
    const curHybrid = isPeriod ? refHybridMonth : refHybridAll;

    const ceSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateBySource || {};
    const ceAll = ceSourceMap[activeTokenSource] || ceSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimate || {};
    const cePeriod = ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth || ceAll;
    const curIdentified = isPeriod ? cePeriod : ceAll;

    let apiCost = 0;
    let pillText = t('cost.covFull');
    let pillClass = 'key-pill pill-good';

    // 2. 估值模式计算
    let effectiveRef = curRef;
    if ((effectiveRef.totalCostUSD === undefined || effectiveRef.totalCostUSD === null) && curTotal > 0) {
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      if (core && core.calculateReferenceModelCost) {
        effectiveRef = core.calculateReferenceModelCost({
          inputTokens: curIn,
          outputTokens: curOut,
          cacheTokens: curCa,
          totalTokens: curTotal
        }, 'gemini-3.8-flash', { pricingDate: '2026-11-09', mode: 'all' });
      }
    }

    const rateIn = Number(effectiveRef.matchedTier?.inputPerMillion ?? 0.75);
    const rateCa = Number(effectiveRef.matchedTier?.cacheReadPerMillion ?? 0.075);
    const rateOut = Number(effectiveRef.matchedTier?.outputPerMillion ?? 3.75);

    // 更新小摘要来源与时间描述行及非实付常驻标识
    const scopeDescEl = el('cost-scope-desc');
    if (scopeDescEl) {
      const srcName = activeTokenSource === 'desktop' ? t('tokens.srcDesktopLabel') : activeTokenSource === 'cli' ? 'CLI' : t('tokens.srcAllLabel');
      const pLabel = isPeriod ? (ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag')) : t('cost.allHistory');
      scopeDescEl.textContent = `${srcName} · ${pLabel}`;
    }
    const nonPaidBadge = el('cost-non-paid-badge');
    if (nonPaidBadge) nonPaidBadge.textContent = t('cost.nonPaidBadge');

    if (costModelMode === 'ref') {
      apiCost = Number(effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
          grandVal.title = `$${apiCost.toFixed(4)}`;
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else {
          grandVal.textContent = '$0.00';
          grandVal.title = t('cost.noRecords');
        }
      }
      if (grandSub) {
        grandSub.textContent = t('cost.refSub', {
          model: effectiveRef.modelDisplayName || 'Gemini 3.8 Flash',
          in: rateIn.toFixed(2),
          ca: rateCa.toFixed(3),
          out: rateOut.toFixed(2)
        });
      }
      pillText = t('cost.modeRef');
      pillClass = 'key-pill pill-muted';

      if (inVal) inVal.textContent = `$${Number(effectiveRef.inputCostUSD || (curIn * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
      if (caVal) caVal.textContent = `$${Number(effectiveRef.cacheCostUSD || (curCa * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
      if (outVal) outVal.textContent = `$${Number(effectiveRef.outputCostUSD || (curOut * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
    } else if (costModelMode === 'hybrid') {
      const h = curHybrid.hybrid || {};
      apiCost = Number(h.combinedTotalUSD || effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
        grandVal.title = t('cost.hybridSub', { known: h.knownCostUSD || 0, res: h.unpricedResidualCostUSD || 0 });
      }
      if (grandSub) {
        grandSub.textContent = t('cost.hybridSub', {
          known: Number(h.knownCostUSD || 0).toFixed(2),
          res: Number(h.unpricedResidualCostUSD || 0).toFixed(2)
        });
      }
      pillText = t('cost.hybridBadge');
      pillClass = 'key-pill pill-muted';

      const rb = h.residualTokensBreakdown || {};
      if (inVal) inVal.textContent = `$${Number(rb.inputCostUSD || (Number(rb.input || 0) * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.input || 0) });
      if (caVal) caVal.textContent = `$${Number(rb.cacheCostUSD || (Number(rb.cache || 0) * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) });
      if (outVal) outVal.textContent = `$${Number(rb.outputCostUSD || (Number(rb.output || 0) * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.output || 0) });
    } else {
      // 仅已识别真实模型
      const pricedCount = Number(curIdentified.pricedRequestsCount || 0);
      const unpricedCount = Number(curIdentified.unpricedRequestsCount || 0);
      const totalCount = pricedCount + unpricedCount;
      apiCost = Number(curIdentified.pricedCostUSD || 0);

      if (grandVal) {
        if (totalCount === 0) {
          grandVal.textContent = t('cost.noRecords');
        } else if (pricedCount === 0) {
          grandVal.textContent = t('cost.unpriced');
          grandVal.title = t('cost.identSubNone');
        } else if (apiCost < 0.01 && apiCost > 0) {
          grandVal.textContent = '<$0.01';
          grandVal.title = `$${apiCost.toFixed(6)}`;
        } else {
          grandVal.textContent = `$${apiCost.toFixed(2)}`;
          grandVal.title = `$${apiCost.toFixed(4)}`;
        }
      }
      if (grandSub) {
        grandSub.textContent = pricedCount > 0
          ? t('cost.identSub', { n: pricedCount })
          : t('cost.identSubNone');
      }
      if (pricedCount === 0) {
        pillText = t('cost.covPct', { pct: 0 });
        pillClass = 'key-pill pill-warn';
      } else {
        const pct = curIdentified.coveragePercent != null ? curIdentified.coveragePercent : 0;
        pillText = t('cost.covPct', { pct });
        pillClass = `key-pill ${pct >= 100 ? 'pill-good' : 'pill-warn'}`;
      }

      if (inVal) inVal.textContent = `$${((curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${((curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6).toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${((curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curIdentified.byCategory?.outputTokens || 0)} tok`;
    }

    if (covPill) {
      covPill.textContent = pillText;
      covPill.className = pillClass;
      covPill.setAttribute?.('class', pillClass);
    }

    // 3. 用户实际支出渲染（首屏并列右栏）
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const curSymbol = ps.currencySymbol || '$';
    if (subSpendLbl) subSpendLbl.textContent = t('cost.subSpendLabel');

    const extraNoCompare = isPeriod ? '' : t('cost.allNoCompare');
    if (subSpendVal && subNote) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subSpendVal.textContent = `${curSymbol}0`;
        subNote.textContent = t('cost.freeActive', { src: ps.acquisitionSourceName || t('cost.freePromo'), extra: extraNoCompare });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        subSpendVal.textContent = `${curSymbol}${Number(ps.actualPricePaid).toFixed(2)}`;
        const expTag = ps.isExpired ? t('cost.expiredTag') : '';
        subNote.textContent = `${ps.acquisitionSourceName || t('cost.subSpend')} · ${t('cost.paidLabel')} (${ps.billingCycle || t('plan.summary.perMonth')})${expTag}${extraNoCompare}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        subSpendVal.textContent = t('cost.paidUnknown');
        subNote.textContent = `${t('cost.publicRefMonthly', { p: ps.officialPriceMonthly })}${extraNoCompare}`;
      } else {
        subSpendVal.textContent = t('cost.unknown');
        subNote.textContent = t('cost.noPlanData');
      }
    }

    const subLine = el('cost-sub-line');
    if (subLine) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subLine.textContent = t('cost.subLineFree', { sym: curSymbol, src: ps.acquisitionSourceName || t('plan.tag.promo') });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const cnyPart = (ps.currency !== 'CNY' && ps.cnyFormatted) ? ` (${ps.cnyFormatted})` : '';
        subLine.textContent = t('cost.subLinePaid', {
          sym: curSymbol,
          val: Number(ps.actualPricePaid).toFixed(2),
          cny: cnyPart,
          cycle: ps.billingCycle || t('plan.summary.perMonth'),
          exp: ps.isExpired ? ' · ⚠️' : ''
        });
      } else {
        subLine.textContent = t('cost.subUnknown');
      }
    }

    // 4. 用量与参考差额指标条（注明累计处理 Token，含缓存读取）
    if (usageSummary) {
      usageSummary.textContent = t('cost.usageSummary', { total: fmtYi(curTotal), cache: fmtYi(curCa) });
    }
    if (diffSummary) {
      if (!isPeriod) {
        diffSummary.textContent = t('cost.diffAll');
      } else if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        diffSummary.textContent = t('cost.diffFree', { val: apiCost.toFixed(2) });
      } else if (ps.actualPricePaid !== null && ps.currency === 'USD') {
        const diff = apiCost - Number(ps.actualPricePaid);
        diffSummary.textContent = t('cost.diffPaid', { sign: diff >= 0 ? '+' : '', val: diff.toFixed(2) });
      } else {
        diffSummary.textContent = t('cost.diffUnknown');
      }
    }

    // 5. 详细未计价原因说明
    if (breakdown) {
      const modelKeys = Object.keys(curIdentified.byModel || {});
      const modelDetails = modelKeys.map(k => `${k}: $${curIdentified.byModel[k].costUSD} (${fmt(curIdentified.byModel[k].tokens)} tok)`).join('; ');
      breakdown.textContent = t('cost.breakdownPrefix', {
        details: modelDetails || t('cost.breakdownNone'),
        note: ''
      });
    }

    // 6. 兼容性辅助隐藏层同步
    const refGrand = el('ref-cost-grand-val');
    if (refGrand) refGrand.textContent = t('cost.refApprox', { val: Number(curRef.totalCostUSD || 0).toFixed(2) });
  }

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = customColors.tokenAccent || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
  }

  function switchHeatView(view, save = true) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ savedHeatView: view });
    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    const isClosingNow = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (pop && !pop.hidden && !isClosingNow) {
      const isInsidePicker = path.includes(pop);
      const isSwatchBtn = path.some(n => n?.classList?.contains?.('color-swatch-btn') || n?.classList?.contains?.('heat-leg-swatch') || n?.id?.startsWith?.('swatch-') || n?.id?.startsWith?.('heat-leg-'));
      if (!isInsidePicker && !isSwatchBtn) {
        closeColorPicker();
      }
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      const pop = el('color-picker-popover');
      const isEscClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
      if (pop && !pop.hidden && !isEscClosing) {
        const returnFocus = activePickerAnchor;
        closeColorPicker();
        returnFocus?.focus?.();
        return;
      }
      const tokenDrawer = el('token-color-drawer-body');
      if (tokenDrawer && tokenDrawer.style.display !== 'none') {
        toggleTokenColorsDrawer(false);
        btnTokenColors?.focus?.();
        return;
      }
      const colorDrawer = el('color-drawer-body');
      if (colorDrawer && colorDrawer.style.display !== 'none') {
        toggleColorsDrawer(false);
        btnColors?.focus?.();
        return;
      }
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);

  // =========================================================================
  // 模块 4: 数据渲染、完整本地 Token 历史读取与首次使用日起算时间轴
  // =========================================================================
  function renderFiles(session) {
    const parent = el('files'); parent.replaceChildren();
    if (!session) { const item = document.createElement('p'); item.textContent = t('files.reading'); parent.appendChild(item); return; }
    if (!Array.isArray(session.attachments) || !session.attachments.length) { const item = document.createElement('p'); item.textContent = t('files.empty'); parent.appendChild(item); return; }
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? t('files.refs', { n: file.references }) : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      const sizeInfo = file.width && file.height
        ? t('files.px', { w: file.width, h: file.height })
        : (typeof file.chars === 'number' && file.chars > 0 ? t('files.chars', { n: fmt(file.chars) }) : '');
      const tokenInfo = range(file) ? `${range(file)} token` : t('files.tokUnknown');
      const sheetsPart = file.sheets != null ? t('files.sheets', { sheets: file.sheets, cells: fmt(file.cells) }) : '';
      const hiddenPart = file.hiddenSheets ? t('files.hiddenSheets', { n: file.hiddenSheets }) : '';
      detail.textContent = `${file.source === 'assistant' ? t('files.assistantPrefix') : ''}${tokenInfo}${sizeInfo ? ` · ${sizeInfo}` : ''}${sheetsPart}${hiddenPart}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = t('files.unknownPrefix', { parts: file.unknownParts.join('；') }); item.appendChild(unknown); }
      parent.appendChild(item);
    }
  }

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString('en-US');
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  function parseLocalYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDotYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  function formatZhYmd(ymd) {
    const d = parseLocalYmd(ymd);
    if (!d) return ymd || '—';
    if (currentPanelLanguage === 'en') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function addDays(baseDate, deltaDays) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() + deltaDays);
    return d;
  }

  function getFirstUseDateStr() {
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (map[k]?.total > 0)).sort();
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return formatLocalYmd(new Date());
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = parseLocalYmd(firstStr) || today;
    const totalDays = 52 * 7; // 364 天（12 个月 / 52 周）
    const elapsedDays = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / 86400000)) + 1;

    let winStart;
    let winEnd;
    let canPrev = false;
    let canNext = false;

    if (elapsedDays <= totalDays) {
      // 使用未满一年：起点固定为实际首次使用日，向后铺满 12 个月（前置空白为 0）
      heatPageOffset = 0;
      winStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      winEnd = addDays(winStart, totalDays - 1);
    } else {
      // 使用满一年后：默认窗口滚动为「以今天结尾的最近 12 个月」，且起点永不早于首次使用日；支持 ‹ / › 翻页回看更早归档
      const latestStart = addDays(today, -(totalDays - 1));
      const stepDays = 26 * 7; // 每次翻页半年度（26 周）
      let candidateStart = addDays(latestStart, heatPageOffset * stepDays);
      if (candidateStart.getTime() <= firstDate.getTime()) {
        candidateStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const maxBackSteps = -Math.ceil((latestStart.getTime() - firstDate.getTime()) / (stepDays * 86400000));
        if (heatPageOffset < maxBackSteps) heatPageOffset = maxBackSteps;
      }
      winStart = candidateStart;
      winEnd = addDays(winStart, totalDays - 1);
      canPrev = winStart.getTime() > firstDate.getTime();
      canNext = heatPageOffset < 0;
    }

    const firstBadge = el('first-use-badge');
    if (firstBadge) firstBadge.textContent = t('tokens.firstUse', { date: formatZhYmd(firstStr) });
    const rangeEl = el('h-win-range');
    const prevBtn = el('h-page-prev');
    const nextBtn = el('h-page-next');

    if (activeHeatView === 'monthly') {
      const targetMonthDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
      const targetY = targetMonthDate.getFullYear();
      const targetM = targetMonthDate.getMonth();
      const firstY = firstDate.getFullYear();
      const firstM = firstDate.getMonth();
      const targetMonthKey = targetY * 12 + targetM;
      const firstMonthKey = firstY * 12 + firstM;
      canPrev = targetMonthKey > firstMonthKey;
      canNext = heatMonthOffset < 0;
      if (rangeEl) rangeEl.textContent = t('tokens.range.month', { y: targetY, m: currentPanelLanguage === 'en' ? String(targetM + 1).padStart(2, '0') : (targetM + 1) });
    } else if (activeHeatView === 'yearly') {
      const thisY = today.getFullYear();
      const targetY = thisY + heatYearOffset;
      const firstY = firstDate.getFullYear();
      canPrev = targetY > firstY;
      canNext = heatYearOffset < 0;
      if (rangeEl) {
        rangeEl.textContent = (targetY === thisY) ? t('tokens.range.yearToToday', { y: targetY }) : t('tokens.range.year', { y: targetY });
      }
    } else {
      if (rangeEl) rangeEl.textContent = `${formatDotYmd(winStart)} – ${formatDotYmd(winEnd)}`;
    }

    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;

    return { firstStr, firstDate, today, winStart, winEnd, totalDays, canPrev, canNext };
  }

  function applyTokenHistoryPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (Array.isArray(payload.speedRecords)) {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = payload.speedRecords;
      if (!isContextSettingsView && activeContextTab === 'speed') {
        renderSpeedComparisonTab();
      } else if (!isContextSettingsView && activeContextTab === 'models') {
        renderModelSettingsTab();
      }
    }
    if (payload.modelCapabilitiesById && typeof payload.modelCapabilitiesById === 'object') {
      mergeCapabilitiesMapClient(payload.modelCapabilitiesById);
    }
    if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
      const hasExisting = Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0;
      const incomingHasCaps = payload.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      const existingHasCaps = hasExisting && state.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!hasExisting || (incomingHasCaps && !existingHasCaps)) {
        state.cascadeModelConfigs = payload.cascadeModelConfigs;
        renderHeaderModelDropdown();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    }

    const hasExistingData = Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0;
    const incomingKeys = Object.keys(payload.dailyMap || {});
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(payload.dailyMap[k]?.total) || 0), 0);
    const hasIncomingRefCost = Boolean(payload.referenceCost?.currentMonth?.totalCostUSD || payload.referenceCost?.all?.totalCostUSD);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || incomingTotal > 0 || hasIncomingRefCost;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(payload, { source: activeTokenSource, todayStr })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.referenceCost = normalized.referenceCost;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      if (normalized.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate;
      if (normalized.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = normalized.updatedAt;
    } else {
      const newMap = {};
      if (payload.dailyMap && typeof payload.dailyMap === 'object') {
        for (const [dKey, rec] of Object.entries(payload.dailyMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || !rec) continue;
          newMap[dKey] = {
            total: Number(rec.total) || 0,
            input: Number(rec.input) || 0,
            output: Number(rec.output) || 0,
            cache: Number(rec.cache) || 0,
            steps: Number(rec.steps) || 0
          };
        }
      }
      ANTIGRAVITY_TOKEN_DATA.dailyMap = newMap;
      if (payload.dailyMapBySource) ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = payload.dailyMapBySource;
      if (payload.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = payload.firstUseDate;
      if (payload.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = payload.updatedAt;
      if (payload.currentPeriod) ANTIGRAVITY_TOKEN_DATA.currentPeriod = payload.currentPeriod;
      if (payload.referenceCost) ANTIGRAVITY_TOKEN_DATA.referenceCost = payload.referenceCost;

      const keys = Object.keys(newMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && newMap[k]?.total > 0).sort();
      const monthPrefix = todayStr.slice(0, 7);
      const yearPrefix = todayStr.slice(0, 4);
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, yearTokens = 0, monthDays = 0;
      let totalInput = 0, totalOutput = 0, totalCache = 0;
      let curMonthInput = 0, curMonthOutput = 0, curMonthCache = 0;
      for (const k of keys) {
        const r = newMap[k];
        const t = Number(r.total) || 0;
        totalTokens += t;
        totalInput += Number(r.input) || 0;
        totalOutput += Number(r.output) || 0;
        totalCache += Number(r.cache) || 0;
        if (k === todayStr) todayTokens += t;
        if (k.startsWith(monthPrefix)) {
          monthTokens += t;
          curMonthInput += Number(r.input) || 0;
          curMonthOutput += Number(r.output) || 0;
          curMonthCache += Number(r.cache) || 0;
          monthDays += 1;
        }
        if (k.startsWith(yearPrefix)) yearTokens += t;
      }
      const rawSum = payload.summary || {};
      ANTIGRAVITY_TOKEN_DATA.summary = {
        grandTotalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        totalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        todayTokens: todayTokens > 0 ? todayTokens : (Number(rawSum.todayTokens) || 0),
        monthTokens: Math.max(monthTokens, Number(rawSum.monthTokens) || 0),
        yearTokens: Math.max(yearTokens, Number(rawSum.yearTokens) || 0),
        totalInputTokens: Math.max(totalInput, Number(rawSum.totalInputTokens) || 0),
        totalOutputTokens: Math.max(totalOutput, Number(rawSum.totalOutputTokens) || 0),
        totalCacheTokens: Math.max(totalCache, Number(rawSum.totalCacheTokens) || 0),
        currentMonthInput: Math.max(curMonthInput, Number(rawSum.currentMonthInput) || 0),
        currentMonthOutput: Math.max(curMonthOutput, Number(rawSum.currentMonthOutput) || 0),
        currentMonthCache: Math.max(curMonthCache, Number(rawSum.currentMonthCache) || 0),
        totalDays: keys.length,
        totalConversations: Number(rawSum.totalConversations) || keys.length,
        firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
      };
    }

    if (payload.planStatus || payload.customPlanSettings) {
      let mergedPlan = payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      try {
        const email = mergedPlan.email || 'default';
        let customObj = lastSavedCustomPlan || payload.customPlanSettings || null;
        if (!customObj && typeof window !== 'undefined' && window.__AGContextMeterSettings?.customPlan) {
          customObj = window.__AGContextMeterSettings.customPlan;
        }
        if (!customObj) {
          const savedCustomRaw = localStorage?.getItem('ag_custom_plan_' + email.toLowerCase()) || localStorage?.getItem('ag_custom_plan_default');
          if (savedCustomRaw) customObj = JSON.parse(savedCustomRaw);
        }
        if (customObj && typeof customObj === 'object') {
          lastSavedCustomPlan = { ...customObj };
          try {
            const jsonStr = JSON.stringify(customObj);
            if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + email.toLowerCase(), jsonStr);
            localStorage?.setItem('ag_custom_plan_default', jsonStr);
          } catch {}
          if (core && core.resolveEffectivePlanStatus) {
            mergedPlan = core.resolveEffectivePlanStatus(payload.rawPlanStatus || payload.planStatus, customObj, { currentEmail: email });
          }
        }
      } catch {}
      ANTIGRAVITY_TOKEN_DATA.planStatus = mergedPlan;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus || mergedPlan;
      renderPlanDetail(mergedPlan);
    }

    if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimate = payload.costEstimate;
    }
    if (payload.costEstimateCurrentMonth) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = payload.costEstimateCurrentMonth;
    }
    if (payload.costEstimateBySource) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = payload.costEstimateBySource;
    } else if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = {
        all: payload.costEstimate,
        desktop: payload.costEstimate,
        cli: { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {} }
      };
    }

    // 重新汇总卡片统计与顶栏
    const sum = ANTIGRAVITY_TOKEN_DATA.summary;
    const totalTokens = sum.grandTotalTokens;
    const shownToday = sum.todayTokens;
    const monthTokens = sum.monthTokens;
    const yearTokens = sum.yearTokens;
    const convCount = sum.totalConversations;
    const totalDays = sum.totalDays || Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length;
    const avgMonth = Math.round(monthTokens / Math.max(1, totalDays));

    const fmtCardM = v => {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    };
    const badgeAmt = el('token-amount');
    const badgeExtra = el('token-hover-extra');
    const overAmt = el('overflow-tokens-val');
    if (badgeAmt) badgeAmt.textContent = fmtCardM(totalTokens);
    if (badgeExtra) badgeExtra.textContent = t('tokens.badge.today', { val: fmtCardM(shownToday) });
    if (overAmt) overAmt.textContent = fmtCardM(totalTokens);

    const tTotalVal = el('t-total-val');
    const tTotalSub = el('t-total-sub');
    const tTodayVal = el('t-today-val');
    const tTodaySub = el('t-today-sub');
    const tMonthVal = el('t-month-val');
    const tMonthSub = el('t-month-sub');
    const tYearVal = el('t-year-val');
    const tYearSub = el('t-year-sub');

    if (tTotalVal) tTotalVal.textContent = fmtCardM(totalTokens);
    if (tTotalSub) tTotalSub.textContent = `${totalTokens.toLocaleString('en-US')} Tokens`;
    if (tTodayVal) tTodayVal.textContent = fmtCardM(shownToday);
    if (tTodaySub) tTodaySub.textContent = t('tokens.card.todaySub', { n: convCount });
    if (tMonthVal) tMonthVal.textContent = fmtCardM(monthTokens);
    if (tMonthSub) tMonthSub.textContent = t('tokens.card.monthSub', { val: fmtCardM(avgMonth) });
    if (tYearVal) tYearVal.textContent = fmtCardM(yearTokens);
    if (tYearSub) tYearSub.textContent = t('tokens.card.yearSub', { n: totalDays });

    // 聚合全周期各区间预估费用
    const allDateKeys = Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap || {});
    const nowYmd = todayStr;
    const thisMonthPrefix = nowYmd.slice(0, 7);
    const thisYearPrefix = nowYmd.slice(0, 4);

    const todayCostInfo = getDailyModelCost(ANTIGRAVITY_TOKEN_DATA.dailyMap[nowYmd], nowYmd, activeCostModel, { mode: activeCostMode });
    const todayCostCny = convertToCNY(todayCostInfo.costUSD, 'USD');

    const totalCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, allDateKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const totalCostCny = convertToCNY(totalCostAgg.totalCostUSD, 'USD');

    const monthKeys = allDateKeys.filter(k => k.startsWith(thisMonthPrefix) && k <= nowYmd);
    const monthCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, monthKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const monthCostCny = convertToCNY(monthCostAgg.totalCostUSD, 'USD');

    const yearKeys = allDateKeys.filter(k => k.startsWith(thisYearPrefix) && k <= nowYmd);
    const yearCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, yearKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const yearCostCny = convertToCNY(yearCostAgg.totalCostUSD, 'USD');

    const tTotalCost = el('t-total-cost');
    const tTodayCost = el('t-today-cost');
    const tMonthCost = el('t-month-cost');
    const tYearCost = el('t-year-cost');

    if (tTotalCost) {
      tTotalCost.textContent = `≈ $${totalCostAgg.totalCostUSD.toFixed(2)}${totalCostCny !== null ? ` (¥${totalCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: totalCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tTodayCost) {
      tTodayCost.textContent = `≈ $${todayCostInfo.costUSD.toFixed(2)}${todayCostCny !== null ? ` (¥${todayCostCny.toFixed(2)})` : ''}`;
    }
    if (tMonthCost) {
      tMonthCost.textContent = `≈ $${monthCostAgg.totalCostUSD.toFixed(2)}${monthCostCny !== null ? ` (¥${monthCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: monthCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tYearCost) {
      tYearCost.textContent = `≈ $${yearCostAgg.totalCostUSD.toFixed(2)}${yearCostCny !== null ? ` (¥${yearCostCny.toFixed(2)})` : ''}${t('tokens.dailyAvg', { val: yearCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }

    // 规范化已完整保留输入/缓存/输出分类，执行费用视图渲染
    renderActiveCostEstimateView();

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }


  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return;
    let changed = false;
    const hasFinalCall = calls.some(c => c?.status === 'final');
    try {
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function') {
        const res = await window.contextMeterAPI.recordCalls(calls);
        if (res && res.ok === false) {
          console.warn('Context Meter: 记录调用入账失败', res.error);
        } else if (res?.changed) {
          changed = true;
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/record-calls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ calls })
        });
        if (!resp.ok) {
          console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${resp.status}`);
        } else {
          const res = await resp.json().catch(() => null);
          if (res && res.ok === false) {
            console.warn('Context Meter: 实时通道 record-calls 失败', res.error);
          } else if (res?.changed) {
            changed = true;
          }
        }
      }
      if (changed || hasFinalCall) {
        void syncTokenHistoryFromHost(false);
      }
    } catch (err) {
      console.warn('Context Meter: 调用入账发生异常', err);
    }
  }

  async function restoreSettingsFromHost() {
    if (state.disposed) return;
    const thisSeq = ++restoreRequestSeq;
    const startActionSeq = userActionSeq;
    try {
      let settingsRes = null;
      const currentEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';

      // 权威配置同步：宿主通信桥接可用时，以宿主最新持久化配置为准，避免启动快照覆盖最新状态
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function') {
        settingsRes = await window.contextMeterAPI.getSettings({ email: currentEmail });
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/get-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ email: currentEmail })
        });
        if (r.ok) settingsRes = await r.json().catch(() => null);
      } else if (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
        settingsRes = window.__AGContextMeterSettings;
      }

      // 若在网络等待期间有更新的恢复请求完成或用户发生了最新主动修改，丢弃旧回包！
      if (thisSeq < restoreRequestSeq || userActionSeq > startActionSeq) {
        return;
      }

      if (settingsRes?.ok) {
        if (settingsRes.uiPreferences?.restartVerification && typeof settingsRes.uiPreferences.restartVerification === 'object') {
          pendingRestartVerification = { ...settingsRes.uiPreferences.restartVerification };
          void refreshUnlockStatus();
        }
        if (settingsRes.contextScopeMode) {
          contextScopeMode = settingsRes.contextScopeMode === 'per_model' ? 'per_model' : 'unified';
        } else {
          const hasPerModelPrefs = settingsRes.contextPreferences && Object.values(settingsRes.contextPreferences).some(p => p && p.mode && p.mode !== 'default');
          contextScopeMode = hasPerModelPrefs ? 'per_model' : 'unified';
        }

        if (settingsRes.contextUnifiedPreference && typeof settingsRes.contextUnifiedPreference === 'object') {
          contextUnifiedPreference = { ...settingsRes.contextUnifiedPreference };
        } else {
          contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
        }

        if (settingsRes.contextPreferences && typeof settingsRes.contextPreferences === 'object') {
          contextPreferencesMap = { ...settingsRes.contextPreferences };
        }
        syncContextPreferencesCache(contextPreferencesMap);
        renderHeaderModelDropdown();
        if (!ctxDraftDirty) loadDraftFromSelectedModel(true);
        else renderCompactSessionCard();
        const savedView = settingsRes.savedHeatView || settingsRes.uiPreferences?.savedHeatView;
        if (savedView && ['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(savedView)) {
          switchHeatView(savedView, false);
        }
        const savedAutoUpdate = settingsRes.autoCheckUpdate !== undefined
          ? settingsRes.autoCheckUpdate
          : settingsRes.uiPreferences?.autoCheckUpdate;
        if (savedAutoUpdate !== undefined) {
          autoCheckUpdate = savedAutoUpdate !== false;
          const chk = el('check-auto-update');
          if (chk) chk.checked = autoCheckUpdate;
        }
        const savedLang = settingsRes.panelLanguage || settingsRes.uiPreferences?.panelLanguage;
        if (savedLang && ['zh-CN', 'zh-TW', 'en'].includes(savedLang) && savedLang !== currentPanelLanguage) {
          await applyPanelLanguage(savedLang, { persist: false });
        }
      } else {
        try {
          const localLang = localStorage?.getItem('ag_panel_language');
          if (localLang && ['zh-CN', 'zh-TW', 'en'].includes(localLang) && localLang !== currentPanelLanguage) {
            await applyPanelLanguage(localLang, { persist: false });
          }
        } catch {}
      }

      if (settingsRes?.ok && settingsRes.customPlan && typeof settingsRes.customPlan === 'object') {
        lastSavedCustomPlan = { ...settingsRes.customPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ok: true,
            customPlan: { ...settingsRes.customPlan },
            contextPreferences: { ...contextPreferencesMap }
          };
        }

        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || settingsRes.customPlan?.account || currentEmail || 'default';
        try {
          const jsonStr = JSON.stringify(settingsRes.customPlan);
          if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch {}
        applyCustomPlanObjectLocally(settingsRes.customPlan, email);
      } else {
        // 回退检查 localStorage
        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';
        const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
        const savedRaw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
        if (savedRaw) {
          const parsed = JSON.parse(savedRaw);
          if (parsed && typeof parsed === 'object') {
            lastSavedCustomPlan = { ...parsed };
            applyCustomPlanObjectLocally(parsed, parsed.account || email);
          }
        }
      }
    } catch {}
  }

  let historySyncBusy = false;
  let pendingHistoryForce = false;
  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      if (force) {
        pendingHistoryForce = true;
      }
      return;
    }
    historySyncBusy = true;
    try {
      await restoreSettingsFromHost();
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function') {
        const res = await window.contextMeterAPI.getTokenHistory(Boolean(force));
        if (res?.ok && res.data) {
          if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
          applyTokenHistoryPayload(res.data);
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/token-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ force: Boolean(force) })
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.ok && j.data) {
            if (typeof window !== 'undefined') window.__AGContextMeterHistory = j.data;
            applyTokenHistoryPayload(j.data);
          }
        }
      }
    } catch {}
    finally {
      historySyncBusy = false;
      if (pendingHistoryForce) {
        pendingHistoryForce = false;
        void syncTokenHistoryFromHost(true);
      }
      if (autoCheckUpdate) {
        setTimeout(() => { void checkAppUpdate(false); }, 1200);
      }
    }
  }

  function openGithubRepo(pathSuffix = '') {
    const url = 'https://github.com/elviscjn-cjn/antigravity-context-viewer' + pathSuffix;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.openExternal === 'function') {
      window.contextMeterAPI.openExternal(url);
    } else {
      window.open?.(url, '_blank');
    }
  }

  let currentUpdateTrigger = 'tokens';

  function positionUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    const triggerBtn = trigger === 'ctx' ? el('btn-check-update-ctx') : el('btn-check-update');
    if (!triggerBtn || typeof triggerBtn.getBoundingClientRect !== 'function') return;
    const rect = triggerBtn.getBoundingClientRect();
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024;
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 768) : 768;
    let right = Math.max(14, winW - rect.right);
    let top = rect.bottom + 8;
    if (top + 220 > winH) {
      top = Math.max(10, rect.top - 230);
    }
    pop.style.position = 'fixed';
    pop.style.top = `${Math.round(top)}px`;
    pop.style.right = `${Math.round(right)}px`;
    pop.style.left = 'auto';
  }

  function showUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    currentUpdateTrigger = trigger;
    positionUpdatePopover(trigger);
    pop.style.display = 'block';
  }

  function hideUpdatePopover() {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      const pop = el('update-popover');
      if (pop && pop.style.display === 'block') {
        positionUpdatePopover();
      }
    });
  }

  async function checkAppUpdate(manual = false, trigger = currentUpdateTrigger) {
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    const pop = el('update-popover');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const statusEl = el('up-pop-status');
    const applyBtn = el('btn-apply-update');

    // 检查桥接是否存在；若缺失则直接判定为更新功能不可用，严禁显示“最新”
    const currentVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.3';
    const hasBridge = typeof window !== 'undefined' && typeof window.contextMeterAPI?.checkUpdate === 'function';
    if (!hasBridge) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.unavailableTitle');
      if (verEl) verEl.textContent = t('update.unavailableVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.unavailableBody');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      if (manual) showUpdatePopover(trigger);
      return;
    }

    if (manual) {
      cachedLatestRelease = null;
      showUpdatePopover(trigger);
      if (titleEl) titleEl.textContent = t('update.checkingTitle');
      if (verEl) verEl.textContent = t('update.checkingVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.connecting');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
    }

    try {
      const res = await window.contextMeterAPI.checkUpdate({ force: manual, currentVersion: currentVer });

      // 返回 null、非对象或 ok: false 均为检查失败，严禁显示“最新”
      if (!res || res.ok === false) {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.failedTitle');
        if (verEl) verEl.textContent = t('update.failedVer', { ver: currentVer });
        const errMsg = res?.error ? translateBackendText(res.error) : t('update.failedFetch');
        if (bodyEl) bodyEl.textContent = t('update.failedBody', { err: errMsg });
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        if (manual) showUpdatePopover(trigger);
        return;
      }

      if (res.hasUpdate && res.latestVersion) {
        cachedLatestRelease = res;
        if (dot) dot.style.display = 'block';
        if (dotCtx) dotCtx.style.display = 'block';
        if (titleEl) titleEl.textContent = t('update.foundTitle');
        if (verEl) verEl.textContent = `v${res.currentVersion || currentVer} → v${res.latestVersion}`;
        if (bodyEl) {
          bodyEl.textContent = t('update.foundBody', { ver: res.latestVersion, notes: res.releaseNotes || t('update.defaultNotes') });
        }
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = t('update.applyNow');
          applyBtn.style.display = 'inline-block';
        }
        if (manual) showUpdatePopover(trigger);
      } else {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.latestTitle');
        const effectiveCurrent = res.installedVersion || res.currentVersion || currentVer;
        if (verEl) verEl.textContent = t('update.latestVer', { ver: effectiveCurrent });
        const updateStatusText = res.diskPendingRestart
          ? t('update.diskPending', { ver: effectiveCurrent })
          : t('update.latestBody', { ver: effectiveCurrent });
        if (bodyEl) bodyEl.textContent = updateStatusText;
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        if (manual) showUpdatePopover(trigger);
      }
    } catch (err) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.failedTitle');
      if (verEl) verEl.textContent = t('update.failedVer', { ver: currentVer });
      if (bodyEl) bodyEl.textContent = t('update.failedNetBody', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      if (manual) showUpdatePopover(trigger);
    }
  }

  async function applyAppUpdate() {
    const pop = el('update-popover');
    const applyBtn = el('btn-apply-update');
    const statusEl = el('up-pop-status');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    if (!cachedLatestRelease) return;

    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = t('update.updatingBtn');
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = t('update.downloading');
    }

    try {
      let res = null;
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.applyUpdate === 'function') {
        res = await window.contextMeterAPI.applyUpdate({ version: cachedLatestRelease.latestVersion });
      } else {
        throw new Error(t('update.noApi'));
      }
      if (res && res.ok) {
        const targetVer = res.version || res.installedVersion || cachedLatestRelease?.latestVersion || currentVer;
        currentVer = targetVer;
        const vEl = el('v');
        if (vEl) vEl.textContent = `v${currentVer}`;

        const dot = el('update-badge-dot');
        const dotCtx = el('update-badge-dot-ctx');
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';

        if (titleEl) titleEl.textContent = t('update.doneTitle');
        if (verEl) verEl.textContent = t('update.doneVer', { ver: currentVer });
        if (bodyEl) {
          bodyEl.textContent = res.liveInjected
            ? t('update.doneHot', { ver: currentVer })
            : t('update.doneDisk', { ver: currentVer });
        }
        if (applyBtn) {
          applyBtn.textContent = t('update.btnUpdated');
          applyBtn.disabled = false;
        }

        if (res.liveInjected) {
          if (statusEl) statusEl.textContent = t('update.doneHot', { ver: currentVer });
        } else {
          if (statusEl) statusEl.textContent = t('update.doneDisk', { ver: currentVer });
        }
        setTimeout(() => {
          if (pop) pop.style.display = 'none';
        }, 3500);
      } else {
        if (statusEl) statusEl.textContent = t('update.failStatus', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = t('update.errStatus', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
    }
  }

  el('btn-github-repo')?.addEventListener('click', () => openGithubRepo());
  el('btn-github-repo-ctx')?.addEventListener('click', () => openGithubRepo());
  el('btn-check-update')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'tokens') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'tokens');
    }
  });
  el('btn-check-update-ctx')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'ctx') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'ctx');
    }
  });
  el('btn-close-update-pop')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-update-later')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-view-release-page')?.addEventListener('click', () => {
    openGithubRepo(cachedLatestRelease?.tagName ? `/releases/tag/${cachedLatestRelease.tagName}` : '/releases');
  });
  el('btn-apply-update')?.addEventListener('click', () => void applyAppUpdate());

  el('check-auto-update')?.addEventListener('change', e => {
    autoCheckUpdate = e.target.checked;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ autoCheckUpdate });
    }
  });

function renderHeatmapGrid(forceRebuild = false) {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || !monthsBox) return;
    const win = computeTimelineWindow();
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}`;
    if (!forceRebuild && colsBox.children.length > 0 && colsBox.getAttribute('data-sig') === sig) return;

    colsBox.replaceChildren();
    monthsBox.replaceChildren();
    colsBox.setAttribute('data-sig', sig);

    const todayKey = formatLocalYmd(win.today);
    const list = [];
    for (let i = 0; i < win.totalDays; i++) {
      const d = addDays(win.winStart, i);
      const key = formatLocalYmd(d);
      const isFuture = d.getTime() > win.today.getTime();
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      list.push({ date: d, key, tokens: rec ? rec.total : 0, rec, isFuture, isToday: key === todayKey });
    }

    const monthMarkers = [];
    let lastM = -1;
    let lastCol = -10;

    for (let c = 0; c < 52; c++) {
      const col = document.createElement('div');
      col.className = 'heat-week-col';
      const slice = list.slice(c * 7, (c + 1) * 7);
      const mNum = slice[0].date.getMonth() + 1;
      if (mNum !== lastM) {
        if (c - lastCol >= 3 && 52 - c >= 2) {
          monthMarkers.push({ month: mNum, colIdx: c });
          lastCol = c;
        }
        lastM = mNum;
      }

      slice.forEach(item => {
        const cell = document.createElement('div');
        const lvl = getLvl(item.tokens);
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isToday ? ' is-today' : ''}`;
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));

        const showPop = () => {
          const d = item.date;
          const dateLabel = currentPanelLanguage === 'en'
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
          heatPopDate.textContent = `${dateLabel}${item.isToday ? t('heat.today') : (item.key === win.firstStr ? t('heat.firstUse') : '')}`;
          const costInfo = getDailyModelCost(item.rec, item.key, activeCostModel, { mode: activeCostMode });
          const cny = convertToCNY(costInfo.costUSD, 'USD');
          const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? t('heat.future') : '0 Tokens');
          if (item.rec) {
            heatPopDet.innerHTML = `
              <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(item.rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(item.rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(item.rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
            `.trim();
            heatPopDet.style.display = 'flex';
          } else {
            heatPopDet.style.display = 'none';
          }
          const r = cell.getBoundingClientRect();
          heatPop.style.left = `${r.left + r.width / 2}px`;
          heatPop.style.top = `${r.top - 6}px`;
          heatPop.style.opacity = '1';
        };

        cell.addEventListener('mouseenter', showPop);
        cell.addEventListener('mouseleave', hidePopover);
        cell.addEventListener('click', showPop);

        col.appendChild(cell);
      });
      colsBox.appendChild(col);
    }

    const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 13}px`;
      lbl.textContent = currentPanelLanguage === 'en' ? (shortMonthsEn[mm.month - 1] || `${mm.month}`) : `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });

    updateSummaryBar('daily', list.map(x => x.key));
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.replaceChildren();

    const scale = getEffectiveHeatmapScale();
    const [cEmpty, c1, c2, c3, c4] = scale;
    const win = computeTimelineWindow();
    const totalWeeks = 52;
    const weeksData = [];
    let max = 1;

    for (let c = 0; c < totalWeeks; c++) {
      let sum = 0;
      let sDate = null, eDate = null;
      for (let r = 0; r < 7; r++) {
        const d = addDays(win.winStart, c * 7 + r);
        const k = formatLocalYmd(d);
        if (!sDate) sDate = d;
        eDate = d;
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) sum += rec.total;
      }
      if (sum > max) max = sum;
      weeksData.push({ sum, sDate, eDate, startKey: formatLocalYmd(sDate) });
    }

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      col.setAttribute('data-week-start', w.startKey);
      const fill = document.createElement('div');
      fill.className = 'w-bar-fill';
      const pct = Math.max(3, (w.sum / max) * 100);
      fill.style.height = `${pct}%`;
      const lvl = getLvlForRange(w.sum, 'week', max);
      fill.style.backgroundColor = w.sum === 0 ? cEmpty : (scale[lvl] || c4);
      col.appendChild(fill);

      const showPop = () => {
        const weekDates = [];
        for (let r = 0; r < 7; r++) weekDates.push(formatLocalYmd(addDays(w.sDate, r)));
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, weekDates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        heatPopDate.textContent = `${w.sDate.getFullYear()}.${w.sDate.getMonth() + 1}.${w.sDate.getDate()} - ${w.eDate.getMonth() + 1}.${w.eDate.getDate()}`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens${costStr}` : '0 Tokens';
        heatPopDet.innerHTML = `<span>${t('heat.weeklyTotal', { avg: costAgg.dailyAverageUSD.toFixed(2) })}</span>`;
        heatPopDet.style.display = 'block';
        const r = col.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      col.addEventListener('mouseenter', showPop);
      col.addEventListener('mouseleave', hidePopover);
      col.addEventListener('click', showPop);

      box.appendChild(col);
    });

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('weekly', allWinDates);
  }

  function renderHeatmapCum() {
    const cvs = el('h-cum-canvas');
    if (!cvs || !cvs.getContext) return;
    const ctx = cvs.getContext('2d');
    const rect = cvs.getBoundingClientRect ? cvs.getBoundingClientRect() : { width: 670 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = (rect.width || 670);
    const height = 100;
    cvs.width = width * dpr;
    cvs.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const win = computeTimelineWindow();
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const winStartKey = formatLocalYmd(win.winStart);
    // 计算窗口起点之前的历史滚存基数（支持跨年翻页时累计曲线连续）
    let running = 0;
    for (const [k, rec] of Object.entries(map)) {
      if (k < winStartKey && rec?.total > 0) running += rec.total;
    }

    const activeEnd = win.winEnd.getTime() > win.today.getTime() ? win.today : win.winEnd;
    const plotDays = Math.max(1, Math.floor((activeEnd.getTime() - win.winStart.getTime()) / 86400000) + 1);
    const points = [];

    for (let i = 0; i < plotDays; i++) {
      const d = addDays(win.winStart, i);
      const k = formatLocalYmd(d);
      const rec = map[k];
      if (rec) running += rec.total;
      points.push({ date: d, key: k, val: running });
    }

    const max = running || 1;
    const denom = Math.max(1, points.length - 1);
    const step = points.length === 1 ? width : (width / denom);

    const scale = getEffectiveHeatmapScale();
    const strokeColor = customColors.tokenAccent || scale[4];
    const strokeRgb = hexToRgb(normalizeHex(strokeColor)) || { r: 192, g: 132, b: 252 };
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.36)`);
    grad.addColorStop(1, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.02)`);

    ctx.beginPath();
    ctx.moveTo(0, height);
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? width / 2 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.lineTo(width, height);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? 0 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const idx = points.length === 1 ? 0 : Math.min(points.length - 1, Math.max(0, Math.round(mouseX / step)));
      const pt = points[idx];
      const cumDates = [];
      for (const k of Object.keys(map)) {
        if (k <= pt.key) cumDates.push(k);
      }
      const costAgg = calculateIntervalCost(map, cumDates, activeCostModel, {
        mode: activeCostMode,
        todayStr: formatLocalYmd(win.today)
      });
      const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
      const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
      const cumDateLabel = currentPanelLanguage === 'en'
        ? `${pt.date.getFullYear()}-${String(pt.date.getMonth() + 1).padStart(2, '0')}-${String(pt.date.getDate()).padStart(2, '0')}`
        : `${pt.date.getFullYear()}年${pt.date.getMonth() + 1}月${pt.date.getDate()}日`;
      heatPopDate.textContent = `${cumDateLabel}${t('heat.cumSuffix')}`;
      heatPopVal.textContent = `${fmtYi(pt.val)} Tokens${costStr}`;
      heatPopDet.innerHTML = `<span>${t('heat.cumTotal', { avg: costAgg.dailyAverageUSD.toFixed(2) })}</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 12)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('cum', allWinDates);
  }

  function updateSummaryBar(viewType, dateKeys = []) {
    const sumTokensEl = el('h-sum-tokens');
    const sumCostEl = el('h-sum-cost');
    const sumDailyAvgEl = el('h-sum-daily-avg');
    const sumActiveAvgEl = el('h-sum-active-avg');
    const subRatioWrapEl = el('h-sum-sub-ratio-wrap');
    const subRatioEl = el('h-sum-sub-ratio');
    if (!sumTokensEl || !sumCostEl) return;

    const win = computeTimelineWindow();
    const todayStr = formatLocalYmd(win.today);
    const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, dateKeys, activeCostModel, {
      mode: activeCostMode,
      todayStr
    });

    const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
    sumTokensEl.textContent = `${fmtYi(costAgg.totalTokens)} Tokens`;
    sumCostEl.textContent = `≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}`;
    sumDailyAvgEl.textContent = `$${costAgg.dailyAverageUSD.toFixed(2)}`;
    sumActiveAvgEl.textContent = t('heat.activeDays', { avg: costAgg.activeDailyAverageUSD.toFixed(2), days: costAgg.activeDays });

    if ((viewType === 'monthly' || viewType === 'yearly') && subRatioWrapEl && subRatioEl) {
      const plan = resolveEffectivePlanStatus(ANTIGRAVITY_TOKEN_DATA.planStatus, ANTIGRAVITY_TOKEN_DATA.customPlanSettings);
      const paidVal = plan.actualPricePaid ?? plan.pricePaid ?? plan.officialPriceMonthly ?? null;
      const isZeroCost = plan.isZeroExtraCost || paidVal === 0;
      if (!isZeroCost && paidVal > 0 && costAgg.totalCostUSD > 0) {
        const subMonthlyUSD = plan.currency === 'USD' ? paidVal : (plan.actualPricePaidCNY ? plan.actualPricePaidCNY / 6.72 : paidVal);
        if (subMonthlyUSD > 0) {
          const ratio = (costAgg.totalCostUSD / (viewType === 'yearly' ? subMonthlyUSD * 12 : subMonthlyUSD)).toFixed(1);
          subRatioEl.textContent = t('heat.roi', { ratio });
          subRatioWrapEl.style.display = 'inline-flex';
        } else {
          subRatioWrapEl.style.display = 'none';
        }
      } else {
        subRatioWrapEl.style.display = 'none';
      }
    } else if (subRatioWrapEl) {
      subRatioWrapEl.style.display = 'none';
    }
  }

  function renderHeatmapMonthly() {
    const box = el('h-monthly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const todayKey = formatLocalYmd(today);

    // 计算当前所选月 (按 heatMonthOffset 自然月偏移)
    const targetDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

    const gap = 5;
    let bestR = 1, bestC = daysInMonth, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(daysInMonth / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    bestS = Math.floor(bestS);
    const showDayNum = bestS >= 22;

    const grid = document.createElement('div');
    grid.className = 'heat-month-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${bestC}, ${bestS}px)`;
    grid.style.gridAutoRows = `${bestS}px`;
    grid.style.gap = `${gap}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
    grid.style.height = `${H}px`;

    const dateKeys = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth, day);
      const k = formatLocalYmd(d);
      dateKeys.push(k);
      const isFuture = d.getTime() > today.getTime();
      const isToday = k === todayKey;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      const tokens = rec ? rec.total : 0;
      const lvl = getLvl(tokens);

      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isToday ? ' is-today' : ''}`;
      cell.style.width = `${bestS}px`;
      cell.style.height = `${bestS}px`;
      cell.style.backgroundColor = scale[lvl];
      cell.setAttribute('data-date', k);
      cell.setAttribute('data-tokens', String(tokens));

      if (showDayNum) {
        const numSpan = document.createElement('span');
        numSpan.className = 'heat-month-cell-num';
        numSpan.textContent = String(day);
        cell.appendChild(numSpan);
      }

      const showPop = () => {
        const costInfo = getDailyModelCost(rec, k, activeCostModel, { mode: activeCostMode });
        const cny = convertToCNY(costInfo.costUSD, 'USD');
        const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        const mDateLabel = currentPanelLanguage === 'en'
          ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          : `${targetYear}年${targetMonth + 1}月${day}日`;
        heatPopDate.textContent = `${mDateLabel}${isToday ? t('heat.today') : ''}`;
        heatPopVal.textContent = tokens > 0 ? `${fmtYi(tokens)} Tokens${costStr}` : (isFuture ? t('heat.future') : '0 Tokens');
        if (rec) {
          heatPopDet.innerHTML = `
            <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
          `.trim();
          heatPopDet.style.display = 'flex';
        } else {
          heatPopDet.style.display = 'none';
        }
        const r = cell.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      cell.addEventListener('mouseenter', showPop);
      cell.addEventListener('mouseleave', hidePopover);
      cell.addEventListener('click', showPop);

      grid.appendChild(cell);
    }

    box.appendChild(grid);
    updateSummaryBar('monthly', dateKeys);
  }

  function renderHeatmapYearly() {
    const box = el('h-yearly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const thisYear = today.getFullYear();
    const thisMonth = today.getMonth();
    const targetYear = thisYear + heatYearOffset;

    const monthsData = [];
    const allYearDates = [];
    let maxMonthTokens = 1;

    for (let m = 0; m < 12; m++) {
      const daysCount = new Date(targetYear, m + 1, 0).getDate();
      let mTokens = 0;
      const mDates = [];
      for (let d = 1; d <= daysCount; d++) {
        const dateObj = new Date(targetYear, m, d);
        const k = formatLocalYmd(dateObj);
        mDates.push(k);
        allYearDates.push(k);
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) mTokens += rec.total;
      }
      const isCurrent = (targetYear === thisYear && m === thisMonth);
      const isFuture = (targetYear > thisYear || (targetYear === thisYear && m > thisMonth));
      if (!isFuture && mTokens > maxMonthTokens) {
        maxMonthTokens = mTokens;
      }
      const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      monthsData.push({
        monthIndex: m,
        monthName: currentPanelLanguage === 'en' ? (shortMonthsEn[m] || `${m + 1}`) : `${m + 1}月`,
        tokens: mTokens,
        dates: mDates,
        isCurrent,
        isFuture
      });
    }

    const createSvgNode = tag => {
      if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
        return document.createElementNS('http://www.w3.org/2000/svg', tag);
      }
      return document.createElement(tag);
    };

    const svg = createSvgNode('svg');
    svg.setAttribute('class', 'heat-yearly-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    const Rmin = 6;
    const Rmax = 24;
    const colW = W / 12;
    const cy = 42;

    let peakMonthIndex = -1;
    let peakTokens = 0;
    monthsData.forEach(item => {
      if (!item.isFuture && item.tokens > peakTokens) {
        peakTokens = item.tokens;
        peakMonthIndex = item.monthIndex;
      }
    });

    monthsData.forEach((item, idx) => {
      const cx = colW * idx + colW / 2;
      const g = createSvgNode('g');
      g.setAttribute('class', 'heat-yearly-bubble-group');
      g.style.animationDelay = `${idx * 20}ms`;

      let radius = Rmin;
      if (!item.isFuture && item.tokens > 0) {
        const ratio = Math.sqrt(item.tokens / maxMonthTokens);
        radius = Rmin + ratio * (Rmax - Rmin);
      }

      const lvl = item.isFuture ? 0 : getLvlForRange(item.tokens, 'month', maxMonthTokens);
      const fillCol = item.isFuture ? 'transparent' : (scale[lvl] || scale[0]);

      const circle = createSvgNode('circle');
      circle.setAttribute('class', 'bubble-main');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', fillCol);
      circle.setAttribute('stroke', item.isFuture ? 'rgba(255,255,255,0.18)' : (item.monthIndex === peakMonthIndex ? 'var(--ag-text-primary)' : 'rgba(255,255,255,0.08)'));
      circle.setAttribute('stroke-width', item.monthIndex === peakMonthIndex ? '2' : '1');

      if (item.isFuture) {
        circle.setAttribute('stroke-dasharray', '2,2');
      }

      g.appendChild(circle);

      if (item.isCurrent) {
        const activeRing = createSvgNode('circle');
        activeRing.setAttribute('cx', String(cx));
        activeRing.setAttribute('cy', String(cy));
        activeRing.setAttribute('r', String(radius + 4));
        activeRing.setAttribute('fill', 'none');
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        activeRing.setAttribute('stroke-width', '1.5');
        activeRing.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(activeRing);
      }

      if (item.monthIndex === peakMonthIndex && item.tokens > 0) {
        const peakBadge = createSvgNode('text');
        peakBadge.setAttribute('x', String(cx));
        peakBadge.setAttribute('y', String(cy - radius - 5));
        peakBadge.setAttribute('text-anchor', 'middle');
        peakBadge.setAttribute('font-size', '8.5');
        peakBadge.setAttribute('font-weight', '600');
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        peakBadge.textContent = t('heat.peak');
        g.appendChild(peakBadge);
      }

      const text = createSvgNode('text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(H - 12));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', item.isCurrent ? 'var(--ag-text-primary)' : 'var(--ag-text-muted)');
      text.setAttribute('font-weight', item.isCurrent ? '600' : '400');
      text.textContent = item.monthName;
      g.appendChild(text);

      const showPop = () => {
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, item.dates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        const yearMonthLabel = currentPanelLanguage === 'en' ? `${item.monthName} ${targetYear}` : `${targetYear}年${item.monthName}`;
        heatPopDate.textContent = `${yearMonthLabel}${item.isCurrent ? t('heatmap.pop.inProgress') : (item.monthIndex === peakMonthIndex ? t('heatmap.pop.peak') : '')}`;
        heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? t('heatmap.pop.future') : '0 Tokens');
        heatPopDet.innerHTML = `<span>${t('heatmap.pop.monthlyDet', { avg: costAgg.dailyAverageUSD.toFixed(2), days: costAgg.activeDays })}</span>`;
        heatPopDet.style.display = 'block';

        const r = g.getBoundingClientRect ? g.getBoundingClientRect() : { left: cx, top: cy, width: radius * 2 };
        heatPop.style.left = `${r.left + (r.width || 0) / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      g.addEventListener('mouseenter', showPop);
      g.addEventListener('mouseleave', hidePopover);
      g.addEventListener('click', showPop);

      svg.appendChild(g);
    });

    box.appendChild(svg);
    updateSummaryBar('yearly', allYearDates);
  }

  // 初始化首次使用日与时间轴显示并触发后台完整历史同步
  computeTimelineWindow();
  void syncTokenHistoryFromHost();

  // 统一生成徽章、悬浮提示与速览卡片的状态数据
  function resolveDisplayStatus(d, session) {
    const ec = d?.errorClassification;
    let kind = ec?.kind || (d?.exceeded ? 'context_overflow' : d?.network ? 'network_error' : d?.error ? 'unknown' : 'none');

    // 如果没有显示分类但存在明确标志
    if (d?.exceeded) kind = 'context_overflow';

    if (kind === 'context_overflow' || d?.exceeded) {
      const sLimit = d?.serviceLimit || ec?.serviceLimit;
      const limStatus = sLimit ? t('diag.ctx.statusLim', { lim: short(sLimit) }) : '';
      const limTakeaway = sLimit ? t('diag.ctx.statusLim', { lim: fmt(sLimit) }) : '';
      return {
        kind: 'context_overflow',
        badgeText: t('diag.ctx.badge'),
        amountText: t('diag.ctx.amount'),
        keyBadgeText: t('diag.ctx.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.ctx.hover'),
        tipTitle: t('diag.ctx.tipTitle'),
        tipPct: t('diag.ctx.tipPct'),
        tipDetail: sLimit ? t('diag.ctx.tipDetailLim', { lim: fmtBubbleToken(sLimit) }) : t('diag.ctx.tipDetailDef'),
        statusText: t('diag.ctx.status', { lim: limStatus }),
        keyTakeaway: t('diag.ctx.takeaway', { lim: limTakeaway }),
        isError: true,
        isOverflow: true
      };
    }

    if (kind === 'quota_exhausted') {
      const pool = ec?.modelOrPool || d?.model || t('diag.quota.defPool');
      const resetStr = ec?.resetTimeZh ? t('diag.quota.reset', { time: ec.resetTimeZh }) : '';
      return {
        kind: 'quota_exhausted',
        badgeText: t('diag.quota.badge'),
        amountText: t('diag.quota.amount'),
        keyBadgeText: t('diag.quota.badge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.quota.hover'),
        tipTitle: t('diag.quota.tipTitle'),
        tipPct: t('diag.quota.tipPct'),
        tipDetail: t('diag.quota.tipDetail', { pool, reset: resetStr }),
        statusText: t('diag.quota.status', { pool, reset: resetStr }),
        keyTakeaway: t('diag.quota.takeaway', { pool, reset: resetStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'rate_limited') {
      const retryStr = ec?.retryAfterSec ? t('diag.rate.retry', { sec: ec.retryAfterSec }) : '';
      return {
        kind: 'rate_limited',
        badgeText: t('diag.rate.badge'),
        amountText: t('diag.rate.amount'),
        keyBadgeText: t('diag.rate.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.rate.hover'),
        tipTitle: t('diag.rate.tipTitle'),
        tipPct: t('diag.rate.tipPct'),
        tipDetail: t('diag.rate.tipDetail', { retry: retryStr }),
        statusText: t('diag.rate.status', { retry: retryStr }),
        keyTakeaway: t('diag.rate.takeaway', { retry: retryStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'network_error' || d?.network) {
      const cleanDiag = ec?.diagnostic || t('diag.net.defDiag');
      return {
        kind: 'network_error',
        badgeText: t('diag.net.badge'),
        amountText: t('diag.net.amount'),
        keyBadgeText: t('diag.net.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.net.hover'),
        tipTitle: t('diag.net.tipTitle'),
        tipPct: t('diag.net.tipPct'),
        tipDetail: t('diag.net.tipDetail', { diag: cleanDiag }),
        statusText: t('diag.net.status', { diag: cleanDiag }),
        keyTakeaway: t('diag.net.takeaway', { diag: cleanDiag }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'auth_error') {
      return {
        kind: 'auth_error',
        badgeText: t('diag.auth.badge'),
        amountText: t('diag.auth.amount'),
        keyBadgeText: t('diag.auth.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.auth.hover'),
        tipTitle: t('diag.auth.tipTitle'),
        tipPct: t('diag.auth.tipPct'),
        tipDetail: t('diag.auth.tipDetail'),
        statusText: t('diag.auth.status'),
        keyTakeaway: t('diag.auth.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'service_unavailable') {
      return {
        kind: 'service_unavailable',
        badgeText: t('diag.svc.badge'),
        amountText: t('diag.svc.amount'),
        keyBadgeText: t('diag.svc.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.svc.hover'),
        tipTitle: t('diag.svc.tipTitle'),
        tipPct: t('diag.svc.tipPct'),
        tipDetail: t('diag.svc.tipDetail'),
        statusText: t('diag.svc.status'),
        keyTakeaway: t('diag.svc.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'canceled') {
      return {
        kind: 'canceled',
        badgeText: t('diag.cancel.badge'),
        amountText: t('diag.cancel.amount'),
        keyBadgeText: t('diag.cancel.badge'),
        pillClass: 'key-pill pill-muted',
        hoverExtra: t('diag.cancel.hover'),
        tipTitle: t('diag.cancel.tipTitle'),
        tipPct: t('diag.cancel.tipPct'),
        tipDetail: t('diag.cancel.tipDetail'),
        statusText: t('diag.cancel.status'),
        keyTakeaway: t('diag.cancel.takeaway'),
        isError: false,
        isOverflow: false
      };
    }

    if (d?.error) {
      const diag = ec?.diagnostic || d.error;
      return {
        kind: 'unknown',
        badgeText: t('diag.unknown.badge'),
        amountText: t('diag.unknown.amount'),
        keyBadgeText: t('diag.unknown.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.unknown.hover'),
        tipTitle: t('diag.unknown.tipTitle'),
        tipPct: t('diag.unknown.tipPct'),
        tipDetail: t('diag.unknown.tipDetail', { diag }),
        statusText: t('diag.unknown.status', { diag }),
        keyTakeaway: t('diag.unknown.takeaway', { diag }),
        isError: true,
        isOverflow: false
      };
    }

    return {
      kind: 'none',
      badgeText: '',
      amountText: '',
      keyBadgeText: '',
      pillClass: 'key-pill pill-good',
      hoverExtra: '',
      tipTitle: '',
      tipPct: '',
      tipDetail: '',
      statusText: '',
      keyTakeaway: '',
      isError: false,
      isOverflow: false
    };
  }
  function updateRingAndBubble(d, session, pct, danger, stale, incomplete) {
    const ringFill = el('ring-fill');
    const tipTitle = el('ctx-tip-title');
    const tipPct = el('ctx-tip-pct');
    const tipDetail = el('ctx-tip-detail');

    // 区分常态颜色与高占用告警状态
    let occupancy = 'normal';
    if (danger || (pct != null && pct >= 90)) {
      occupancy = 'danger';
    } else if ((pct != null && pct >= 75) || stale) {
      occupancy = 'warn';
    }
    host.setAttribute('data-occupancy', occupancy);

    // 1. 圆环进度与未知容量状态表达（未知容量绝不画成 0% 或 100%）
    if (ringFill) {
      if (d?.exceeded) {
        ringFill.setAttribute('data-ring-state', 'exceeded');
        ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '1';
      } else if (pct != null) {
        ringFill.setAttribute('data-ring-state', 'determinate');
        if (pct <= 0) {
          ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '0';
        } else {
          const arcLen = Math.max(1.8, (Math.min(100, pct) / 100) * RING_CIRCUMFERENCE);
          ringFill.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '1';
        }
      } else {
        // 容量未知 / 仅估算 / 尚未就绪：使用均匀虚线环段表示非确定比例，不画成 0% 空环或 100% 满环
        ringFill.setAttribute('data-ring-state', d?.estimated ? 'estimated' : 'unknown');
        ringFill.setAttribute('stroke-dasharray', '3.2 4.97');
        ringFill.style.opacity = '0.55';
      }
    }

    // 2. 悬停信息气泡三层文案（标题 — 使用比例 — 用量与容量）
    if (!tipTitle || !tipPct || !tipDetail) return;

    const disp = resolveDisplayStatus(d, session);
    if (disp.isError || disp.kind === 'canceled') {
      tipTitle.textContent = disp.tipTitle;
      tipPct.textContent = disp.tipPct;
      tipDetail.textContent = disp.tipDetail;
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleVal', { used: usedRound, rem: remRound });
      tipDetail.textContent = t('tip.detail.usedOfBudget', { used: fmtBubbleToken(d.actual), budget: fmtBubbleToken(d.budget), inc: '' });
    } else if (stale) {
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleUnknown');
      tipDetail.textContent = session?.total
        ? t('tip.detail.sessionEst', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) })
        : t('tip.detail.waitBg');
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = t('tip.title.high90');
        tipPct.textContent = t('tip.pct.high90', { used: usedRound, rem: remRound });
      } else if (rawPct >= 75) {
        tipTitle.textContent = t('tip.title.high75');
        tipPct.textContent = t('tip.pct.high75', { used: usedRound, rem: remRound });
      } else {
        tipTitle.textContent = t('tip.title.normal');
        tipPct.textContent = t('tip.pct.normal', { used: usedRound, rem: remRound });
      }
      tipDetail.textContent = t('tip.detail.usedOfBudget', {
        used: fmtBubbleToken(d.actual),
        budget: fmtBubbleToken(d.budget),
        inc: incomplete ? t('tip.detail.incSuffix') : ''
      });
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noBudget');
      tipDetail.textContent = t('tip.detail.usedNoBudget', { used: fmtBubbleToken(d.actual) });
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.estOnly');
      const budgetPart = d.budget ? t('tip.detail.estBudgetPart', { budget: fmtBubbleToken(d.budget) }) : t('tip.detail.estNoBudgetPart');
      tipDetail.textContent = t('tip.detail.estUsed', { used: fmtBubbleToken(d.estimate), budget: budgetPart });
    } else if (session?.total) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.waitStats');
      tipDetail.textContent = t('tip.detail.sessionCum', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) });
    } else {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.notReady');
      tipDetail.textContent = t('tip.detail.readingSession');
    }

    if (state.tooltipOpen) positionContextTooltip();
  }

  function syncSpeedBadgeText() {
    const sp = state.latest?.speed;
    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    if (!speedAmount) return;
    const isCompact = state.layoutMode === 'compact';
    if (sp?.tps != null) {
      speedAmount.textContent = isCompact ? `${sp.tps}` : `${sp.tps} tok/s`;
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${sp.tps} tok/s`;
    } else if (state.requestBusy) {
      const calcText = t('badge.speedCalc');
      speedAmount.textContent = isCompact ? '…' : calcText;
      if (overflowSpeedVal) overflowSpeedVal.textContent = calcText;
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  // 渲染上下文与全局状态（无论在主页 / 还是会话页 /c/<id>，始终保持插件栏挂载与可用）
  function render() {
    host.hidden = false;
    host.setAttribute('data-has-session', state.route ? 'true' : 'false');
    ensureHostDocked();
    if (!state.route) {
      hideContextTooltip();
      const barFill = el('bar-fill');
      if (barFill) barFill.style.width = '0%';
      const badgePctVal = el('badge-pct-val');
      if (badgePctVal) badgePctVal.textContent = '--%';
      el('amount').textContent = t('badge.noSession');
      setHoverExtra(t('badge.clickOpenCli'));
      syncSpeedBadgeText();
      el('badge-tokens').title = t('badge.tokensTitle');
      return;
    }
    renderSessionCost();

    const d = state.latest, session = state.scan?.session;
    const disp = resolveDisplayStatus(d, session);
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = disp.isError || d?.exceeded;

    let pct = null;
    if (d?.exceeded) {
      pct = 100;
    } else if (d?.percent != null && !danger && !stale) {
      pct = Math.min(100, Math.max(0, d.percent));
    } else if (d?.actual != null && d?.budget && !danger && !stale) {
      pct = Math.min(100, Math.max(0, (d.actual / d.budget) * 100));
    }

    const barColor = danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff';
    const tone = danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff';
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

    updateRingAndBubble(d, session, pct, danger, stale, incomplete);

    syncContextModelSelectionFromState();

    // 若观测到的上下文预算变化且抽屉已展开或尚未读取状态，触发一次轻量同步（不再据此判定真实请求已验证）
    if (d?.budget && d.budget !== lastAutoObservedBudget && d.budget > 256000) {
      lastAutoObservedBudget = d.budget;
      if (currentUnlockStatus || (unlockDrawerBody && unlockDrawerBody.style.display === 'block')) {
        void refreshUnlockStatus();
      }
    }

    const status = disp.isError
      ? disp.statusText
      : stale ? t('badge.status.stale')
      : state.scanError ? t('badge.status.scanErr', { err: translateBackendText(state.scanError) })
      : incomplete ? t('badge.status.incomplete', { count: session.unknownFiles })
      : d?.estimated ? t('badge.status.estimated')
      : t('badge.status.normal');
    el('status').textContent = status;

    const corpus = session?.total
      ? t('badge.corpus.range', { range: range(session.total), inc: incomplete ? t('badge.corpus.incPlus') : '' })
      : state.scanBusy ? t('badge.corpus.scanning') : t('badge.corpus.pending');

    const badgePctVal = el('badge-pct-val');
    if (disp.isError || disp.kind === 'canceled') {
      el('amount').textContent = disp.amountText;
      if (badgePctVal) badgePctVal.textContent = disp.badgeText;
      setHoverExtra(disp.hoverExtra);
    } else if (stale) {
      el('amount').textContent = t('badge.delayed');
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      el('amount').textContent = `${short(d.actual)}${pctStr}`;
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      el('amount').textContent = t('badge.actualUnknown');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(` · ${corpus}`);
    }

    el('badge-tokens').title = t('badge.tokensTitle');

    // 渲染输出速度 (统一使用 tok/s)
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedHoverExtra = el('speed-hover-extra');
    syncSpeedBadgeText();
    if (speedBadge) {
      if (sp?.tps != null) {
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
        speedBadge.title = t('badge.speedTitleDetail', {
          tps: sp.tps,
          streaming: sp.streamingTps ? t('badge.speedStreamingPart', { tps: sp.streamingTps }) : '',
          duration: sp.duration || '—',
          ttft: sp.ttft || '—',
          streamSec: sp.streamingSec || '—',
          output: fmt(sp.outputTokens)
        });
      } else if (state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = t('badge.speedTitleWait');
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = t('badge.speedHoverIdle');
        speedBadge.title = t('badge.speedTitleIdle');
      }
    }

    if (el('key-summary')) {
      const keyBar = el('key-bar-fill');
      const keyBadge = el('key-badge');
      const keyUsed = el('key-used');
      const keyLimit = el('key-limit');
      const keyRemaining = el('key-remaining');
      const keyTakeaway = el('key-takeaway');

      if (keyBar) keyBar.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

      if (disp.isError || disp.kind === 'canceled') {
        if (keyBadge) {
          keyBadge.textContent = disp.keyBadgeText;
          keyBadge.className = disp.pillClass;
        }

        const usedTokenCount = d?.actual != null ? d.actual : (d?.used != null ? d.used : (d?.estimate != null ? d.estimate : (session?.total?.low ?? null)));
        const budgetTokenCount = d?.budget || (d?.serviceLimit ? d.serviceLimit : 983040);

        if (disp.isOverflow) {
          if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : t('key.overflowUsed');
          if (keyLimit) keyLimit.textContent = d.serviceLimit ? short(d.serviceLimit) : short(budgetTokenCount);
          if (keyRemaining) keyRemaining.textContent = t('key.overflowRem');
        } else {
          // 非超限错误：保留已有上下文用量，标明其状态，不归零、不清空
          if (keyUsed) {
            keyUsed.textContent = usedTokenCount != null ? (d?.actual != null ? `${short(usedTokenCount)}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}` : t('key.estShort', { val: short(usedTokenCount) })) : '—';
          }
          if (keyLimit) keyLimit.textContent = budgetTokenCount ? short(budgetTokenCount) : '—';
          if (keyRemaining) {
            if (usedTokenCount != null && budgetTokenCount) {
              const rem = Math.max(0, budgetTokenCount - usedTokenCount);
              const remP = Math.max(0, 100 - (pct || ((usedTokenCount / budgetTokenCount) * 100)));
              keyRemaining.textContent = `${short(rem)} (${remP.toFixed(1)}%)`;
            } else {
              keyRemaining.textContent = t('key.pending');
            }
          }
        }
        if (keyTakeaway) keyTakeaway.textContent = disp.keyTakeaway;
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = t('key.pill.tight'); keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = t('key.pill.elevated'); keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = t('key.pill.normal'); keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        if (keyLimit) keyLimit.textContent = short(limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.textContent = t('key.takeaway.90', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else if (pct >= 75) {
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else {
            keyTakeaway.textContent = t('key.takeaway.ok', { pct: pct.toFixed(1), rem: short(remainVal) });
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (session?.total ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) keyTakeaway.textContent = t('key.takeaway.est');
      }
    }

    if (el('speed-summary')) {
      const spBadge = el('speed-badge');
      const spVal = el('speed-val');
      const spDur = el('speed-duration');
      const spTtft = el('speed-ttft');
      const spTokens = el('speed-tokens');
      const spTakeaway = el('speed-takeaway');

      if (sp?.tps != null) {
        if (spBadge) {
          if (sp.tps >= 80) { spBadge.textContent = t('speed.pill.fast'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 35) { spBadge.textContent = t('speed.pill.smooth'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 15) { spBadge.textContent = t('speed.pill.good'); spBadge.className = 'key-pill pill-warn'; }
          else { spBadge.textContent = t('speed.pill.slow'); spBadge.className = 'key-pill pill-danger'; }
        }
        if (spVal) spVal.textContent = `${sp.tps} tok/s`;
        if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
        if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
        if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
        if (spTakeaway) {
          const modelStr = d?.model ? `（${d.model}）` : '';
          const streamInfo = sp.streamingTps ? t('speed.streamPart', { tps: sp.streamingTps }) : '';
          spTakeaway.textContent = t('speed.takeaway.ok', {
            tone: sp.tps >= 35 ? t('speed.tone.smooth') : t('speed.tone.steady'),
            tps: sp.tps,
            stream: streamInfo,
            dur: sp.duration,
            tok: fmt(sp.outputTokens),
            model: modelStr
          });
        }
      } else {
        if (spBadge) { spBadge.textContent = state.requestBusy ? t('speed.pill.calc') : t('speed.pill.idle'); spBadge.className = 'key-pill pill-muted'; }
        if (spVal) spVal.textContent = '—';
        if (spDur) spDur.textContent = '—';
        if (spTtft) spTtft.textContent = '—';
        if (spTokens) spTokens.textContent = '—';
        if (spTakeaway) spTakeaway.textContent = t('speed.takeaway.idle');
      }
    }

    el('model').textContent = d?.model?.startsWith('MODEL_PLACEHOLDER') ? t('tech.modelPlaceholder', { id: d.model }) : d?.model || t('tech.modelMissing');
    el('request-status').textContent = d?.exceeded ? t('tech.req.exceeded') : d?.network ? t('tech.req.network') : d?.error ? t('tech.req.failed') : d?.status === 'reported' ? t('tech.req.reported') : d?.status === 'estimated' ? t('tech.req.estimated') : t('tech.req.waiting');
    el('actual').textContent = d?.actual != null ? token(d.actual) : d?.exceeded ? t('tech.actual.exceeded', { val: fmt(d.serviceLimit || 0) }) : t('tech.actual.unknown');
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = t('tech.actual.exceededNoLim');
    el('estimate').textContent = d?.estimate ? t('tech.est.val', { val: fmt(d.estimate), note: d.exceeded ? t('tech.est.under') : t('tech.est.ref') }) : t('tech.est.none');
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? t('tech.svcLim.val', { val: fmt(d.serviceLimit) }) : t('tech.svcLim.none');
    el('percent').textContent = d?.percent != null && !danger && !stale ? t('tech.pct.val', { pct: d.percent.toFixed(1) }) : t('tech.pct.none');
    el('session-total').textContent = session?.total ? range(session.total) + (incomplete ? t('tech.plusUnknown') : '') : state.scanError ? t('tech.scanIncomplete') : t('tech.scanning');
    el('characters').textContent = session?.total ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session?.groups ? range(session.groups[name]) : '—';
    el('system').textContent = session?.groups ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session?.attachmentTotal ? range(session.attachmentTotal) + (incomplete ? t('tech.plusUnknownShort') : '') : '—';
    el('steps').textContent = session?.steps != null ? t('tech.stepsVal', { steps: fmt(session.steps), user: session.userMessages, assistant: session.assistantMessages }) : t('tech.stepsNone');
    el('coverage').textContent = Array.isArray(session?.attachments)
      ? t('tech.coverageVal', {
          total: session.attachments.length,
          user: session.attachments.filter(f => f.source === 'user').length,
          assistant: session.attachments.filter(f => f.source === 'assistant').length,
          read: session.attachments.filter(f => f.chars > 0).length,
          unknown: session.unknownFiles,
          rescan: state.scanBusy ? t('tech.coverageRescan') : '',
          err: state.scanError ? t('tech.coverageErr', { err: translateBackendText(state.scanError) }) : ''
        })
      : (state.scanError ? translateBackendText(state.scanError) : t('tech.coverageScanning'));
    el('updated').textContent = t('tech.updatedVal', {
      req: state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : t('tech.unread'),
      scan: state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : t('tech.unfinished')
    });
    el('refresh').disabled = state.scanBusy;
  }

  async function requestPoll(generation, id) {
    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken; if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      const parsedCalls = [];
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          state.sessionCallsMap.set(call.callId, call);
          parsedCalls.push(call);
        }
      }
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c.isPriced ? (c.costUSD || 0) : 0), 0);
      if (parsedCalls.length) {
        if (!state.reportedFinalCallIds) state.reportedFinalCallIds = new Set();
        if (!state.reportedFinalCallOutputs) state.reportedFinalCallOutputs = new Map();
        const callsToReport = [];
        for (const call of parsedCalls) {
          if (call && call.status === 'final' && call.callId) {
            const lastOutput = state.reportedFinalCallOutputs.get(call.callId);
            const currentOutput = call.outputTokens || 0;
            if (!state.reportedFinalCallIds.has(call.callId) || (lastOutput != null && currentOutput > lastOutput)) {
              callsToReport.push(call);
            }
          }
        }
        if (callsToReport.length) {
          for (const call of callsToReport) {
            state.reportedFinalCallIds.add(call.callId);
            state.reportedFinalCallOutputs.set(call.callId, call.outputTokens || 0);
          }
          void recordModelCallsRemote(callsToReport);
        }
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const value = summarize(rows[i], { cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] });
        if (value) {
          state.latest = withStepError(value, rows[i]);
          const callInfo = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
          recordObservationFromSummary(state.latest, id, {
            callId: callInfo?.callId || null,
            stepCount: state.count,
            ts: Date.now()
          });
          break;
        }
      }
      state.requestAt = Date.now(); state.requestError = '';
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally { clearTimeout(timeout); state.controllers.delete(controller); if (generation === state.generation && !state.disposed) { state.requestBusy = false; state.requestNext = Date.now() + (document.hidden ? 15000 : 3000); render(); } }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      if (window.contextMeterAPI?.scan) result = await window.contextMeterAPI.scan(id, force);
      else if (window.__AGContextMeterLive) {
        const live = window.__AGContextMeterLive, controller = new AbortController(); state.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 180000);
        try { const response = await fetch(`http://127.0.0.1:${live.port}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token }, body: JSON.stringify({ id, force }), signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); result = await response.json(); }
        finally { clearTimeout(timeout); state.controllers.delete(controller); }
      } else throw new Error('完整重启 Antigravity 后启用附件扫描');
      if (generation !== state.generation || state.disposed) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.modelCapabilitiesById && typeof result.data.modelCapabilitiesById === 'object') {
        mergeCapabilitiesMapClient(result.data.modelCapabilitiesById);
      }
      if (Array.isArray(result.data.cascadeModelConfigs) && result.data.cascadeModelConfigs.length) {
        state.cascadeModelConfigs = result.data.cascadeModelConfigs;
      }
      if (result.data.scannedAt >= state.requestAt && result.data.latest) {
        state.latest = result.data.latest;
        state.requestAt = result.data.scannedAt;
        const genSteps = Number(result.data.generatorCount);
        const msgSteps = Number(result.data.session?.userMessages || 0) + Number(result.data.session?.assistantMessages || 0);
        const resolvedStepCount = Number.isFinite(genSteps) && genSteps >= 0 ? genSteps : (msgSteps > 0 ? msgSteps : state.count);
        recordObservationFromSummary(state.latest, id, {
          callId: result.data.latestCallId || null,
          stepCount: resolvedStepCount,
          ts: Number(result.data.scannedAt || Date.now())
        });
      }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastHistorySync = 0;
  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
    if (!csrf) return;
    if (Date.now() - lastAvailableModelsSync < 300000 && state.modelCapabilitiesById && Object.keys(state.modelCapabilitiesById).length > 0) {
      return;
    }
    availableModelsFetchInFlight = true;
    try {
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ forceRefresh: false })
      });
      if (!response.ok) return;
      const data = await response.json();
      const modelsObj = data?.response?.models || data?.models;
      if (!modelsObj || typeof modelsObj !== 'object') return;
      const entries = Array.isArray(modelsObj)
        ? modelsObj.map(item => [item?.model || item?.modelId || '', item])
        : Object.entries(modelsObj);
      const nextCaps = {};
      for (const [entryKey, d] of entries) {
        if (!d || typeof d !== 'object') continue;
        const rawId = String(d.model || d.modelId || entryKey || '').trim();
        if (!rawId) continue;
        const normKey = rawId.toLowerCase().replace(/^model_/, '');
        const maxTokens = Number.isSafeInteger(Number(d.maxTokens)) && Number(d.maxTokens) > 0 ? Number(d.maxTokens) : null;
        const maxOutputTokens = d.maxOutputTokens != null && Number.isSafeInteger(Number(d.maxOutputTokens)) && Number(d.maxOutputTokens) >= 0
          ? Number(d.maxOutputTokens)
          : null;
        const rec = {
          modelId: rawId,
          displayName: d.displayName || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget: d.thinkingBudget ?? null,
          minThinkingBudget: d.minThinkingBudget ?? null,
          thinkingLevel: d.thinkingLevel || null,
          supportsModelInfoOverride: typeof d.supportsModelInfoOverride === 'boolean' ? d.supportsModelInfoOverride : null,
          capabilitySource: 'get_available_models'
        };
        if (normKey) nextCaps[normKey] = rec;
        if (entryKey) nextCaps[String(entryKey).trim().toLowerCase().replace(/^model_/, '')] = rec;
      }
      if (Object.keys(nextCaps).length > 0) {
        mergeCapabilitiesMapClient(nextCaps);
        lastAvailableModelsSync = Date.now();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
          renderPresetSelectionUI();
        }
      }
    } catch {}
    finally {
      availableModelsFetchInFlight = false;
    }
  }

  function tick() {
    if (!state.disposed && !host.isConnected) {
      ensureHostDocked();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.reportedFinalCallIds) state.reportedFinalCallIds.clear();
      if (state.reportedFinalCallOutputs) state.reportedFinalCallOutputs.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [], sessionCostTotal: 0,
        requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        reportedFinalCallIds: state.reportedFinalCallIds || new Set(),
        reportedFinalCallOutputs: state.reportedFinalCallOutputs || new Map()
      });
      toggle(false); hideContextTooltip(); renderFiles(null); render();
      void syncTokenHistoryFromHost(false);
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
  }

  const timer = setInterval(tick, 500);
  globalThis.__AGContextMeter = {
    version: typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.3',
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch {}; applyTheme(); },
    getCustomColors: () => ({ ...customColors }),
    setCustomColor,
    resetCustomColors,
    resetHeatmapLevels,
    getHeatPreset: () => heatPreset,
    setHeatPreset,
    getHeatPalette: () => getEffectiveHeatmapScale(),
    getActivePickerSlot: () => activePickerSlot,
    openColorPicker,
    closeColorPicker,
    applyTokenHistoryPayload,
    applyPickerHex,
    setTokenHistoryForTest: payload => applyTokenHistoryPayload(payload),
    getPlanDetailExpanded: () => planDetailExpanded,
    setPlanDetailExpanded,
    switchTokenView,
    switchHeatView: view => switchHeatView(view),
    getActiveHeatView: () => activeHeatView,
    renderHeatmapMonthly: () => renderHeatmapMonthly(),
    renderHeatmapYearly: () => renderHeatmapYearly(),
    checkUpdate: manual => checkAppUpdate(manual),
    applyUpdate: () => applyAppUpdate(),
    getLatestRelease: () => cachedLatestRelease,
    openGithubRepo: path => openGithubRepo(path),
    updateHeatTabThumb: () => updateHeatTabThumb(),
    getPlanSettings: () => ({
      country: ANTIGRAVITY_TOKEN_DATA.planStatus?.country || '未知',
      subscriptionRegion: ANTIGRAVITY_TOKEN_DATA.planStatus?.subscriptionRegion || ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      region: ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      currency: ANTIGRAVITY_TOKEN_DATA.planStatus?.currency || 'USD',
      currencySymbol: ANTIGRAVITY_TOKEN_DATA.planStatus?.currencySymbol || '$',
      actualPricePaid: ANTIGRAVITY_TOKEN_DATA.planStatus?.actualPricePaid ?? null,
      lastSaveResult
    }),
    setCountry: val => applyDirectCountrySelection(val),
    setCurrency: val => applyDirectCurrencySelection(val),
    restoreSettingsFromHost,
    launchCli: opts => triggerLaunchCli(opts),
    getLastCliLaunchResult: () => lastCliLaunchResult,
    getTimelineWindow: () => {
      const w = computeTimelineWindow();
      return {
        firstUseDate: w.firstStr,
        winStart: formatLocalYmd(w.winStart),
        winEnd: formatLocalYmd(w.winEnd),
        totalDays: w.totalDays,
        canPrev: w.canPrev,
        canNext: w.canNext
      };
    },
    repositionPanelsForTest: () => positionFloatingPanels(),
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => {
      const next = computeNextLayoutMode(width, state.layoutMode);
      applyLayoutMode(next);
      return state.layoutMode;
    },
    findTopRightClusterForTest: () => findTopRightCluster(),
    syncWindowControlsOverlayForTest: () => syncWindowControlsOverlay(),
    computeWindowControlsWidthForTest: el => computeWindowControlsWidth(el),
    getContextPreferencesState: () => ({
      activeSessionModelKey,
      activeSessionProductKey,
      selectedEditModelKey,
      selectedProductKey,
      activeContextTab,
      isContextSettingsView,
      draft: { ...ctxDraft },
      contextPreferences: { ...contextPreferencesMap },
      unlockStatus: currentUnlockStatus ? { ...currentUnlockStatus } : null,
      pendingRestartVerification: pendingRestartVerification ? { ...pendingRestartVerification } : null,
      needsRestartAfterApply
    }),
    setContextLatestForTest: (latestObj, configs = [], capabilitiesById = null) => {
      if (capabilitiesById && typeof capabilitiesById === 'object') mergeCapabilitiesMapClient(capabilitiesById);
      if (Array.isArray(configs) && configs.length) state.cascadeModelConfigs = configs;
      state.latest = latestObj;
      if (latestObj && (state.route || state.activeConversationId)) {
        recordObservationFromSummary(latestObj, state.route || state.activeConversationId, { ts: latestObj.ts || Date.now() });
      }
      manualModelSelection = false;
      render();
      return { activeSessionModelKey, activeSessionProductKey, selectedEditModelKey, selectedProductKey, draft: { ...ctxDraft } };
    },
    setModelCapabilitiesForTest: (capabilitiesById) => {
      mergeCapabilitiesMapClient(capabilitiesById);
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getBudgetTrackerTracesForTest: () => (budgetTracker && typeof budgetTracker.exportDiagnosticTraces === 'function')
      ? budgetTracker.exportDiagnosticTraces()
      : [],
    switchContextTabForTest: (tab) => switchContextTab(tab),
    openContextSettingsForTest: (opts) => openContextSettings(opts),
    setSpeedRecordsForTest: (records, calls = []) => {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = Array.isArray(records) ? records : [];
      if (Array.isArray(calls)) state.sessionCalls = calls;
      if (!isContextSettingsView && activeContextTab === 'speed') renderSpeedComparisonTab();
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    setRestartVerificationForTest: (ver, preSnapshot = null) => {
      pendingRestartVerification = ver ? { ...ver } : null;
      if (preSnapshot) preRestartSnapshot = preSnapshot;
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getKnownModelProductsForTest: () => getKnownModelProducts(),
    refreshUnlockStatusForTest: () => refreshUnlockStatus(),
    refreshEnhanceStatusForTest: () => refreshEnhanceStatus(),
    getEnhanceStateForTest: () => ({
      currentBrandTitle,
      selectedEnhanceTier,
      enhanceTitleDraft,
      hasPendingLsReload,
      currentEnhanceStatus: currentEnhanceStatus ? { ...currentEnhanceStatus } : null
    }),
    getUnlockUiStateForTest: () => ({
      hostSupportsRestart,
      needsRestartAfterApply,
      resultBoxDisplay: unlockResultBox?.style?.display || '',
      resultRestartHidden: btnUnlockResultRestart ? btnUnlockResultRestart.hidden : null,
      resultRetryHidden: btnUnlockResultRetry ? btnUnlockResultRetry.hidden : null,
      resultManualHidden: unlockResultManual ? unlockResultManual.hidden : null,
      headerRestartHidden: btnRestartHost ? btnRestartHost.hidden : null
    }),
    getContextScopeModeForTest: () => getContextScopeMode(),
    setContextScopeModeForTest: mode => setScopeMode(mode),
    getContextUnifiedPreferenceForTest: () => getContextUnifiedPreference(),
    getPanelLanguage: () => getPanelLanguage(),
    setPanelLanguage: (lang, opts) => applyPanelLanguage(lang, opts),
    restoreSettingsForTest: () => restoreSettingsFromHost(),
    translateForTest: (key, vars) => t(key, vars),
    applyStaticTranslationsForTest: (rootNode) => applyStaticPanelTranslations(rootNode),
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls, sessionCostTotal: state.sessionCostTotal }),
    dispose() {
      state.disposed = true;
      for (const controller of state.controllers) controller.abort();
      clearInterval(timer);
      if (layoutRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf);
      syncHostStackingElevation(false);
      try { uninstallRequestInterceptor(); } catch {}
      try { themeObserver?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { hostDomObserver?.disconnect(); } catch {}
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        window.removeEventListener?.('mousemove', onPointerMove);
        window.removeEventListener?.('mouseup', onPointerUp);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      } catch {}
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch {}
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch {}
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  refreshRegionPresetSelectOptions();
  renderEnhanceSectionUI();
  void restoreSettingsFromHost();
  installRequestInterceptor();
  render();
  tick();
})();

