(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const { summarize } = globalThis.__AGContextMeterCore;
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "2026-10-26 03:40:45",
    summary: {
      grandTotalTokens: 428514452,
      totalInputTokens: 20858713,
      totalOutputTokens: 2065839,
      totalCacheTokens: 405589900,
      todayTokens: 69188942,
      monthTokens: 428514452,
      yearTokens: 428514452,
      totalSteps: 3831,
      totalConversations: 38
    },
    dailyMap: {
      "2026-10-20": { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 },
      "2026-10-21": { total: 1457865, input: 329634, output: 30447, cache: 1097784, steps: 43 },
      "2026-10-22": { total: 4196139, input: 377290, output: 36609, cache: 3782240, steps: 70 },
      "2026-10-23": { total: 25451505, input: 2179043, output: 123722, cache: 23148740, steps: 276 },
      "2026-10-24": { total: 247085955, input: 8760254, output: 765106, cache: 237560595, steps: 2071 },
      "2026-10-25": { total: 77539057, input: 4374559, output: 505159, cache: 72659339, steps: 686 },
      "2026-10-26": { total: 69188942, input: 4099902, output: 552552, cache: 64536488, steps: 622 }
    }
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  shadow.innerHTML = `<style>
    :host{
      position:fixed;top:6px;right:138px;z-index:2147483000;
      font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      -webkit-app-region:no-drag;user-select:none;display:inline-flex;align-items:center;gap:2px;
      height:28px;flex-shrink:0;vertical-align:middle;

      /* 优先复用 Antigravity 宿主主题变量，无变量时回退深色默认值 */
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

      /* 悬浮层与面板（优先对齐宿主 HoverWidget / Card 变量） */
      --ag-float-bg:var(--vscode-editorHoverWidget-background,#21252b);
      --ag-float-border:var(--vscode-editorHoverWidget-border,rgba(255,255,255,0.12));
      --ag-float-shadow:var(--vscode-widget-shadow,0 8px 24px rgba(0,0,0,0.48),0 2px 6px rgba(0,0,0,0.28));

      --ag-bg-panel:#1e1e22;
      --ag-border-panel:rgba(255,255,255,0.10);
      --ag-shadow-panel:0 14px 36px rgba(0,0,0,0.55),0 2px 8px rgba(0,0,0,0.28);
      --ag-text-primary:#ececef;
      --ag-text-secondary:#c8c8d0;
      --ag-text-muted:#8a8a94;
      --ag-border-subtle:rgba(255,255,255,0.08);

      --ag-bg-card:rgba(255,255,255,0.03);
      --ag-bg-card-hover:rgba(255,255,255,0.055);
      --ag-border-card:rgba(255,255,255,0.07);
      --ag-bg-subcard:rgba(255,255,255,0.02);
      --ag-border-subcard:rgba(255,255,255,0.05);
      --ag-bg-status:rgba(255,255,255,0.03);
      --ag-text-status:#c8c8d0;

      --ag-btn-bg:rgba(255,255,255,0.05);
      --ag-btn-hover:rgba(255,255,255,0.09);
      --ag-btn-border:rgba(255,255,255,0.10);
      --ag-btn-border-hover:rgba(255,255,255,0.18);
      --ag-btn-text:#d4d4d8;

      --ag-pill-muted-bg:rgba(255,255,255,0.05);
      --ag-pill-muted-border:rgba(255,255,255,0.10);
      --ag-pill-muted-text:#9a9aa2;

      --ag-track-bg:rgba(255,255,255,0.12);
      --ag-track-shadow:none;

      --ag-heat-bg:rgba(0,0,0,0.20);
      --ag-heat-lvl-0:#27272a;
      --ag-heat-lvl-1:#3f1e6b;
      --ag-heat-lvl-2:#652ab7;
      --ag-heat-lvl-3:#9053f8;
      --ag-heat-lvl-4:var(--ag-custom-token-accent,#c084fc);
      --ag-heat-outline:#ffffff;

      --ag-pop-bg:var(--ag-float-bg);
      --ag-pop-border:var(--ag-float-border);
      --ag-pop-shadow:var(--ag-float-shadow);
      --ag-pop-text:var(--ag-text-primary);
      --ag-pop-muted:var(--ag-text-secondary);
      --ag-pop-sub:var(--ag-text-muted);

      --ag-scrollbar-thumb:rgba(255,255,255,0.14);
      --ag-scrollbar-hover:rgba(255,255,255,0.24);

      color-scheme:dark;
      color:var(--ag-text-primary);
    }

    /* 融入宿主原生布局容器时参与正常 Flexbox 空间分配 */
    :host([data-dock="flow"]){
      position:relative;top:auto;right:auto;z-index:20;
      margin-right:2px;
    }

    /* 窗口非活动状态适度降低顶栏对比度 */
    :host([data-window-active="false"]) .ag-unit{
      opacity:0.72;
    }
    :host([data-window-active="false"]) .ag-unit:hover,
    :host([data-window-active="false"]) .ag-unit:focus-visible{
      opacity:1;
    }

    /* 浅色模式规范 */
    :host([data-theme="light"]){
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

      --ag-float-bg:#ffffff;
      --ag-float-border:rgba(0,0,0,0.12);
      --ag-float-shadow:0 8px 24px rgba(0,0,0,0.12),0 2px 6px rgba(0,0,0,0.06);

      --ag-bg-panel:#ffffff;
      --ag-border-panel:rgba(0,0,0,0.10);
      --ag-shadow-panel:0 14px 36px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06);
      --ag-text-primary:#18181b;
      --ag-text-secondary:#3f3f46;
      --ag-text-muted:#71717a;
      --ag-border-subtle:rgba(0,0,0,0.08);

      --ag-bg-card:#f4f4f5;
      --ag-bg-card-hover:#ececee;
      --ag-border-card:rgba(0,0,0,0.07);
      --ag-bg-subcard:#ffffff;
      --ag-border-subcard:rgba(0,0,0,0.06);
      --ag-bg-status:#f4f4f5;
      --ag-text-status:#27272a;

      --ag-btn-bg:#f4f4f5;
      --ag-btn-hover:#e4e4e7;
      --ag-btn-border:rgba(0,0,0,0.10);
      --ag-btn-border-hover:rgba(0,0,0,0.18);
      --ag-btn-text:#18181b;

      --ag-pill-muted-bg:#ffffff;
      --ag-pill-muted-border:rgba(0,0,0,0.12);
      --ag-pill-muted-text:#52525b;

      --ag-track-bg:rgba(0,0,0,0.08);
      --ag-track-shadow:none;

      --ag-heat-bg:#f4f4f5;
      --ag-heat-lvl-0:#e4e4e7;
      --ag-heat-lvl-1:#e9d5ff;
      --ag-heat-lvl-2:#c084fc;
      --ag-heat-lvl-3:#9333ea;
      --ag-heat-lvl-4:var(--ag-custom-token-accent,#6b21a8);
      --ag-heat-outline:#18181b;

      --ag-scrollbar-thumb:rgba(0,0,0,0.14);
      --ag-scrollbar-hover:rgba(0,0,0,0.26);

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
      transition:background-color .14s ease,color .14s ease,border-color .14s ease,opacity .14s ease;
      flex-shrink:0;
    }
    .ag-unit:hover,.ag-unit:focus-visible,.ag-unit[aria-expanded="true"]{
      background:var(--ag-toolbar-bg-hover);
      color:var(--ag-toolbar-fg-hover);
    }
    .ag-unit:active{
      background:var(--ag-toolbar-bg-active);
    }

    /* 单元 1: 上下文小圆环按钮（与原生 28x28 图标按钮同尺度） */
    #badge.ag-unit-ring{
      width:28px;height:28px;padding:0;
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
      color:inherit;
    }

    /* 单元 3: 累计 Token 用量 */
    #badge-tokens{
      color:var(--ag-custom-token-total,var(--ag-token-total-default));
    }
    #badge-tokens:hover,#badge-tokens:focus-visible,#badge-tokens[aria-expanded="true"]{
      color:var(--ag-custom-token-total,var(--ag-toolbar-fg-hover));
    }
    .token-fire-dot{
      width:6px;height:6px;border-radius:50%;
      background:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      flex-shrink:0;opacity:0.9;
    }
    #token-amount{
      font-variant-numeric:tabular-nums;
      color:inherit;
    }

    /* 单元 4: 窄屏溢出菜单入口 */
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
    :host([data-layout="compact"]) #badge-tokens{
      padding:0 5px;font-size:11.5px;gap:3px;
    }
    :host([data-layout="minimal"]) #badge-speed,
    :host([data-layout="minimal"]) #badge-tokens{
      display:none!important;
    }
    :host([data-layout="minimal"]) #badge-overflow{
      display:inline-flex!important;
    }
    :host([data-layout="ring-only"]) #badge-speed,
    :host([data-layout="ring-only"]) #badge-tokens,
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

    /* 自定义颜色设置网格 */
    .color-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:6px}
    .color-item{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:6px 8px;border-radius:6px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }
    .color-item-lbl{font-size:11px;color:var(--ag-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .color-item-ctrls{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .color-picker{
      width:20px;height:20px;padding:0;border:1px solid var(--ag-border-card);
      border-radius:4px;background:transparent;cursor:pointer;
    }
    .color-reset-btn{
      font-size:10.5px;padding:2px 6px;border-radius:4px;
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-muted);
    }
    .color-reset-btn:hover{color:var(--ag-text-primary);background:var(--ag-btn-hover)}
    .color-reset-btn[data-mode="auto"]{opacity:0.55}

    /* 弹出面板：上下文 (#panel) 与 Token 活动 (#panel-tokens) 独立面板 */
    .ag-panel{
      position:fixed;top:38px;right:16px;z-index:2147483500;
      max-width:calc(100vw - 24px);max-height:calc(100vh - 52px);
      overflow:auto;border:1px solid var(--ag-border-panel);border-radius:10px;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);box-shadow:var(--ag-shadow-panel);padding:14px;
      opacity:1;transform:translateY(0);visibility:visible;pointer-events:auto;
      transition:opacity .14s ease,transform .14s ease,visibility .14s ease;
      contain:layout paint;
    }
    #panel{width:450px}
    #panel-tokens{width:730px}
    .ag-panel[hidden]{display:block!important;opacity:0;transform:translateY(-4px);visibility:hidden;pointer-events:none}

    /* 顶栏控制条 */
    .panel-header-bar{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:9px;margin-bottom:11px}
    .panel-title{display:flex;align-items:center;gap:5px}
    .panel-title-tokens{color:var(--ag-custom-token-accent,var(--ag-token-accent-default))}
    .panel-header-actions{display:flex;align-items:center;gap:4px}

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
    dl{display:grid;grid-template-columns:1fr auto;gap:5px;margin:0}
    dt{color:var(--ag-text-muted)}
    dd{margin:0;text-align:right;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:270px}

    #key-summary{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:6px 0 10px}
    .key-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
    .key-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px}
    .key-pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid transparent}
    .pill-good{color:#52c41a;background:rgba(82,196,26,0.12);border-color:rgba(82,196,26,0.28)}
    :host([data-theme="light"]) .pill-good{color:#389e0d;background:#f6ffed;border-color:#b7eb8f}
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
    #v{color:var(--ag-text-muted);font-size:10px;font-weight:400;margin-left:6px}

    /* 全局 Token 活动 */
    #view-tokens{display:flex;flex-direction:column;gap:11px}
    .token-stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .t-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px;transition:background-color .14s ease}
    .t-card:hover{background:var(--ag-bg-card-hover)}
    .t-card-lbl{font-size:11px;color:var(--ag-text-muted);display:flex;justify-content:space-between}
    .t-card-val{font-size:16.5px;font-weight:700;color:var(--ag-text-primary);letter-spacing:-0.3px;font-variant-numeric:tabular-nums}
    #t-total-val{color:var(--ag-custom-token-total,var(--ag-text-primary))}
    #t-today-val{color:var(--ag-custom-token-accent,var(--ag-text-primary))}
    .t-card-sub{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .heatmap-section{background:var(--ag-heat-bg);border:1px solid var(--ag-border-card);border-radius:10px;padding:12px 14px}
    .heat-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .heat-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .heat-tabs{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--ag-text-muted)}
    .heat-tab-btn{background:none;border:0;color:var(--ag-text-muted);cursor:pointer;padding:2px 0;transition:color .14s ease}
    .heat-tab-btn:hover{color:var(--ag-text-primary)}
    .heat-tab-btn.active{color:var(--ag-text-primary);font-weight:600}

    .heat-scroll-box{overflow-x:auto;padding-bottom:4px}
    .heat-grid-cols{display:flex;gap:3px}
    .heat-week-col{display:flex;flex-direction:column;gap:3px}
    .heat-cell{width:10px;height:10px;border-radius:2px;background:var(--ag-heat-lvl-0);cursor:pointer;transition:transform .12s ease}
    .heat-cell:hover{transform:scale(1.3);z-index:5;outline:1.5px solid var(--ag-heat-outline)}
    .lvl-0{background:var(--ag-heat-lvl-0)}
    .lvl-1{background:var(--ag-heat-lvl-1)}
    .lvl-2{background:var(--ag-heat-lvl-2)}
    .lvl-3{background:var(--ag-heat-lvl-3)}
    .lvl-4{background:var(--ag-heat-lvl-4)}

    .heat-months{position:relative;height:18px;margin-top:4px;font-size:11px;color:var(--ag-text-muted)}
    .heat-month-item{position:absolute;white-space:nowrap}

    #h-weekly-box{display:none;height:105px;align-items:flex-end;gap:3px;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:3px}
    .w-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer}
    .w-bar-fill{width:100%;border-radius:2px 2px 0 0;background:var(--ag-heat-lvl-0);min-height:3px;transition:height .22s ease,background-color .14s ease}
    .w-bar-col:hover .w-bar-fill{background:var(--ag-custom-token-accent,#c084fc)!important}

    #h-cum-box{display:none;height:105px;position:relative}
    canvas#h-cum-canvas{width:100%;height:105px;display:block}

    .heat-popover{position:fixed;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);border-radius:8px;padding:6px 10px;box-shadow:var(--ag-pop-shadow);z-index:2147483600;opacity:0;transform:translate(-50%,-100%) translateY(-6px);transition:opacity .12s ease}
    .pop-date{font-size:11.5px;color:var(--ag-pop-muted)}
    .pop-val{font-size:13px;font-weight:600;color:var(--ag-pop-text)}
    .pop-det{font-size:10px;color:var(--ag-pop-sub);margin-top:2px;display:flex;gap:6px}

    @media (prefers-reduced-motion: reduce){
      *,.ag-unit,.ring-fill,.key-bar-fill,.ag-panel,#context-tooltip,.heat-cell,.w-bar-fill{
        transition:none!important;animation:none!important;
      }
    }
    @media(max-width:800px){
      #panel{width:calc(100vw - 24px)}
      #panel-tokens{width:calc(100vw - 24px)}
    }
  </style>

  <!-- 顶部基本单元 1: 上下文小圆环 -->
  <button id="badge" class="ag-unit ag-unit-ring" type="button" aria-label="会话与上下文统计" aria-describedby="context-tooltip" aria-expanded="false">
    <svg id="ring-svg" class="ring-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle id="ring-track" class="ring-track" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1"></circle>
      <circle id="ring-fill" class="ring-fill" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1" stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="3.2 4.97"></circle>
    </svg>
    <div id="bar-wrap" class="sr-only" aria-hidden="true"><div id="bar-fill" class="meter-bar-fill"></div></div>
    <span id="amount" class="sr-only">读取中…</span>
    <span id="hover-wrap" class="sr-only"><span id="hover-extra"></span></span>
  </button>

  <!-- 顶部基本单元 2: 输出速度 (tok/s) -->
  <button id="badge-speed" class="ag-unit" type="button" aria-label="模型输出速度与耗时统计" aria-expanded="false">
    <span class="speed-icon" aria-hidden="true">⚡</span>
    <span id="speed-amount">-- tok/s</span>
    <span id="speed-hover-extra" class="sr-only"></span>
  </button>

  <!-- 顶部基本单元 3: 累计 Token 用量 -->
  <button id="badge-tokens" class="ag-unit" type="button" aria-label="账号 Token 活动统计" aria-expanded="false">
    <span class="token-fire-dot" aria-hidden="true"></span>
    <span id="token-amount">428.5M</span>
    <span id="token-hover-extra" class="sr-only">· 今日 69.2M</span>
  </button>

  <!-- 顶部基本单元 4: 窄屏溢出菜单按钮 -->
  <button id="badge-overflow" class="ag-unit" type="button" aria-label="更多统计指标" aria-expanded="false">
    <svg class="overflow-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25"></circle>
      <circle cx="8" cy="8" r="1.25"></circle>
      <circle cx="12.5" cy="8" r="1.25"></circle>
    </svg>
  </button>

  <!-- 上下文圆环悬停/聚焦信息气泡（参考图三层结构） -->
  <div id="context-tooltip" role="tooltip" data-visible="false" data-placement="bottom">
    <div id="ctx-tip-title" class="ctx-tip-title">上下文窗口：</div>
    <div id="ctx-tip-pct" class="ctx-tip-pct">数据尚未就绪</div>
    <div id="ctx-tip-detail" class="ctx-tip-detail">正在读取当前会话上下文用量…</div>
  </div>

  <!-- 窄屏溢出菜单 -->
  <div id="overflow-menu" hidden aria-label="更多统计快捷菜单">
    <button id="overflow-speed-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span>⚡</span><span>输出速度</span></span>
      <span id="overflow-speed-val" class="overflow-item-val">-- tok/s</span>
    </button>
    <button id="overflow-tokens-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span class="token-fire-dot"></span><span>累计用量</span></span>
      <span id="overflow-tokens-val" class="overflow-item-val">428.5M</span>
    </button>
  </div>

  <!-- 弹出式面板 1: 会话上下文与速度监控 (#panel, 450px) -->
  <section id="panel" class="ag-panel" hidden aria-label="会话与上下文详情">
    <div class="panel-header-bar">
      <div class="panel-title">
        <span style="font-size:13px;font-weight:600;color:var(--ag-text-primary)">💬 当前会话上下文</span>
      </div>
      <div class="panel-header-actions">
        <button id="theme-toggle" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）">🌓</button>
        <button id="close" class="panel-icon-btn" type="button" aria-label="收起详情">×</button>
      </div>
    </div>

    <div id="view-context">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <h3 style="margin:0">会话用量与生成监控<span id="v">v2.6</span></h3>
      </div>

      <!-- 卡片 1: 核心用量速览 -->
      <div id="key-summary">
        <div class="key-header"><span class="key-title">⭐ 核心用量速览</span><span id="key-badge" class="key-pill pill-muted">读取中</span></div>
        <div class="key-bar-track"><div id="key-bar-fill" class="key-bar-fill"></div></div>
        <div class="key-stats"><div class="key-stat"><div class="key-stat-label">当前已用</div><div id="key-used" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label">预算上限</div><div id="key-limit" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label">剩余可用</div><div id="key-remaining" class="key-stat-val">—</div></div></div>
        <div id="key-takeaway" class="key-takeaway">正在计算核心指标…</div>
      </div>

      <!-- 卡片 2: 输出速度与延迟速览 -->
      <div id="speed-summary" style="background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:8px 0 10px;">
        <div class="key-header">
          <span class="key-title" style="color:var(--ag-custom-speed,var(--ag-text-primary));">⚡ 最新生成速度与耗时</span>
          <span id="speed-badge" class="key-pill pill-muted">待生成</span>
        </div>
        <div class="key-stats" style="grid-template-columns:repeat(4,1fr);">
          <div class="key-stat">
            <div class="key-stat-label">输出速度</div>
            <div id="speed-val" class="key-stat-val" style="color:var(--ag-custom-speed,var(--ag-text-primary));">—</div>
          </div>
          <div class="key-stat">
            <div class="key-stat-label">生成耗时</div>
            <div id="speed-duration" class="key-stat-val">—</div>
          </div>
          <div class="key-stat">
            <div class="key-stat-label">首字延迟</div>
            <div id="speed-ttft" class="key-stat-val">—</div>
          </div>
          <div class="key-stat">
            <div class="key-stat-label">本次输出</div>
            <div id="speed-tokens" class="key-stat-val">—</div>
          </div>
        </div>
        <div id="speed-takeaway" class="key-takeaway">等待首次模型输出产生速度统计…</div>
      </div>

      <!-- 二级交互折叠区 1: 颜色与外观自定义 -->
      <div class="tech-drawer">
        <button id="btn-toggle-colors" class="drawer-trigger" aria-expanded="false" type="button">
          <span class="drawer-trigger-left"><span>🎨 指标颜色自定义（默认跟随主题）</span></span>
          <span id="color-drawer-arrow" class="drawer-arrow">▼ 展开设置</span>
        </button>
        <div id="color-drawer-body" class="drawer-body" style="display:none;">
          <div class="color-grid">
            <div class="color-item">
              <span class="color-item-lbl">圆环已用部分</span>
              <div class="color-item-ctrls">
                <input id="color-ringUsed" class="color-picker" type="color" value="#e6e6eb" aria-label="上下文圆环已用部分颜色" />
                <button id="reset-ringUsed" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl">圆环轨道</span>
              <div class="color-item-ctrls">
                <input id="color-ringTrack" class="color-picker" type="color" value="#52525b" aria-label="圆环轨道颜色" />
                <button id="reset-ringTrack" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl">上下文用量文字</span>
              <div class="color-item-ctrls">
                <input id="color-contextText" class="color-picker" type="color" value="#ececef" aria-label="上下文用量文字颜色" />
                <button id="reset-contextText" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl">输出速度</span>
              <div class="color-item-ctrls">
                <input id="color-speedText" class="color-picker" type="color" value="#38bdf8" aria-label="输出速度颜色" />
                <button id="reset-speedText" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl">累计 token 用量</span>
              <div class="color-item-ctrls">
                <input id="color-tokenTotal" class="color-picker" type="color" value="#c084fc" aria-label="累计 token 用量颜色" />
                <button id="reset-tokenTotal" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl">其他 token 指标</span>
              <div class="color-item-ctrls">
                <input id="color-tokenAccent" class="color-picker" type="color" value="#a78bfa" aria-label="其他 token 指标颜色" />
                <button id="reset-tokenAccent" class="color-reset-btn" type="button" data-mode="auto">默认</button>
              </div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:7px">
            <span style="font-size:10.5px;color:var(--ag-text-muted)">注：高占用与超限告警色独立保留，不被常态颜色覆盖。</span>
            <button id="reset-all-colors" class="color-reset-btn" type="button">全部恢复跟随主题</button>
          </div>
        </div>
      </div>

      <!-- 二级交互折叠区 2: 底层技术参数与附件审计 -->
      <div class="tech-drawer">
        <button id="btn-toggle-details" class="drawer-trigger" aria-expanded="false" type="button">
          <span class="drawer-trigger-left">
            <span>📋 底层技术参数与附件审计</span>
          </span>
          <span id="drawer-arrow" class="drawer-arrow">▼ 点击展开明细</span>
        </button>
        <div id="drawer-body" class="drawer-body" style="display:none;">
          <p id="status">正在核对请求和附件…</p><p id="model"></p>
          <h4>最近一次模型请求</h4>
          <dl><dt>请求状态</dt><dd id="request-status">—</dd><dt>模型返回输入＋输出</dt><dd id="actual">—</dd><dt>客户端估算（可能漏附件）</dt><dd id="estimate">—</dd><dt>客户端预算字段</dt><dd id="budget">—</dd><dt>该次报错的服务端限制</dt><dd id="service-limit">—</dd><dt>相对客户端预算</dt><dd id="percent">—</dd></dl>
          <h4>整个会话累计内容 · 本地估算</h4>
          <dl><dt>可读取文本 token 估算</dt><dd id="session-total">扫描中…</dd><dt>实际读取文字字符数</dt><dd id="characters">—</dd><dt>用户消息</dt><dd id="user">—</dd><dt>模型回复</dt><dd id="assistant">—</dd><dt>可见思考内容</dt><dd id="thinking">—</dd><dt>工具调用与工具输出</dt><dd id="tools">—</dd><dt>历史压缩摘要</dt><dd id="summaries">—</dd><dt>当前系统提示与工具定义</dt><dd id="system">—</dd><dt>上传／输出附件文本</dt><dd id="attachment-total">—</dd><dt>历史步骤完整性</dt><dd id="steps">—</dd></dl>
          <p id="coverage"></p><h4>附件逐项检查</h4><div id="files"></div><button id="refresh" type="button">重新扫描整段会话与附件</button>
          <p id="note">会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。</p>
          <p id="updated"></p>
        </div>
      </div>
    </div>
  </section>

  <!-- 弹出式面板 2: 账号 Token 活动与 7x52 活跃热力图 (#panel-tokens, 730px) -->
  <section id="panel-tokens" class="ag-panel" hidden aria-label="账号 Token 活动详情">
    <div class="panel-header-bar">
      <div class="panel-title panel-title-tokens">
        <span style="font-size:13px;font-weight:600;color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">🔥 账号 Token 活动</span>
      </div>
      <div class="panel-header-actions">
        <button id="theme-toggle-tokens" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）">🌓</button>
        <button id="close-tokens" class="panel-icon-btn" type="button" aria-label="收起详情">×</button>
      </div>
    </div>

    <div id="view-tokens">
      <div class="token-stat-cards">
        <div class="t-card">
          <div class="t-card-lbl"><span>全量累计</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Total</span></div>
          <div class="t-card-val" id="t-total-val">428.5M</div>
          <div class="t-card-sub" id="t-total-sub">428,514,452 Tokens</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>今日使用</span><span style="color:var(--ag-custom-token-accent,#0284c7)">Today</span></div>
          <div class="t-card-val" id="t-today-val">69.2M</div>
          <div class="t-card-sub" id="t-today-sub">38 会话实时累加</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>本月使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Month</span></div>
          <div class="t-card-val" id="t-month-val">428.5M</div>
          <div class="t-card-sub" id="t-month-sub">日均约 61.2M</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>年度使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Year</span></div>
          <div class="t-card-val" id="t-year-val">428.5M</div>
          <div class="t-card-sub" id="t-year-sub">365 天活动记录</div>
        </div>
      </div>

      <div class="heatmap-section">
        <div class="heat-header">
          <div class="heat-title">Token 活动</div>
          <div class="heat-tabs">
            <button class="heat-tab-btn active" id="h-tab-daily" type="button">每天</button>
            <button class="heat-tab-btn" id="h-tab-weekly" type="button">每周</button>
            <button class="heat-tab-btn" id="h-tab-cum" type="button">累计总量</button>
          </div>
        </div>
        <div class="heat-scroll-box">
          <div id="h-daily-box">
            <div class="heat-grid-cols" id="h-grid-cols"></div>
            <div class="heat-months" id="h-months"></div>
          </div>
          <div id="h-weekly-box"></div>
          <div id="h-cum-box">
            <canvas id="h-cum-canvas"></canvas>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11px;color:var(--ag-text-muted)">
          <span>点击或悬浮格子查看当日详细 Token 构成</span>
          <div style="display:flex;align-items:center;gap:4px">
            <span>少</span>
            <div style="width:8px;height:8px;border-radius:2px;background:var(--ag-heat-lvl-0)"></div>
            <div style="width:8px;height:8px;border-radius:2px;background:var(--ag-heat-lvl-1)"></div>
            <div style="width:8px;height:8px;border-radius:2px;background:var(--ag-heat-lvl-2)"></div>
            <div style="width:8px;height:8px;border-radius:2px;background:var(--ag-heat-lvl-3)"></div>
            <div style="width:8px;height:8px;border-radius:2px;background:var(--ag-heat-lvl-4)"></div>
            <span>多</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 热力图浮动 Tooltip -->
  <div class="heat-popover" id="heat-pop">
    <div class="pop-date" id="heat-pop-date">10月24日</div>
    <div class="pop-val" id="heat-pop-val">2.47亿 个 Token</div>
    <div class="pop-det" id="heat-pop-det"></div>
  </div>`;

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
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
    if (v == null) return '未知';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? '未提供' : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    disposed: false, layoutMode: 'wide', tooltipOpen: false
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';

  // =========================================================================
  // 模块 1: 主题跟随与 6 项独立自定义颜色管理
  // =========================================================================
  const COLOR_SLOTS = {
    ringUsed: '--ag-custom-ring-used',
    ringTrack: '--ag-custom-ring-track',
    contextText: '--ag-custom-context-text',
    speedText: '--ag-custom-speed',
    tokenTotal: '--ag-custom-token-total',
    tokenAccent: '--ag-custom-token-accent'
  };
  const COLOR_STORAGE_KEY = 'ag_custom_colors_v1';
  const customColors = {
    ringUsed: '',
    ringTrack: '',
    contextText: '',
    speedText: '',
    tokenTotal: '',
    tokenAccent: ''
  };

  try {
    const rawColors = typeof localStorage !== 'undefined' && localStorage.getItem(COLOR_STORAGE_KEY);
    if (rawColors) {
      const parsed = JSON.parse(rawColors);
      for (const k of Object.keys(COLOR_SLOTS)) {
        if (typeof parsed?.[k] === 'string') customColors[k] = parsed[k];
      }
    }
  } catch {}

  function saveCustomColors() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(customColors));
      }
    } catch {}
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
      const inputEl = el(`color-${key}`);
      const resetBtn = el(`reset-${key}`);
      if (inputEl && val) inputEl.value = val;
      if (resetBtn) {
        resetBtn.setAttribute('data-mode', val ? 'custom' : 'auto');
        resetBtn.textContent = val ? '恢复默认' : '跟随主题';
      }
    }
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
  }

  function setCustomColor(key, value) {
    if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, key)) return;
    customColors[key] = value ? String(value).trim() : '';
    saveCustomColors();
    applyCustomColors();
  }

  function resetCustomColors() {
    for (const key of Object.keys(COLOR_SLOTS)) customColors[key] = '';
    saveCustomColors();
    applyCustomColors();
  }

  let currentThemeMode = 'auto';
  try {
    currentThemeMode = (typeof localStorage !== 'undefined' && localStorage.getItem('ag_theme_mode')) || 'auto';
  } catch {}

  function parseRgbLuminance(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const s = colorStr.trim();
    if (s.startsWith('#')) {
      const hex = s.slice(1);
      const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex.slice(0, 6);
      if (full.length === 6) {
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        if (!Number.isNaN(r)) return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      }
    }
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
    }
    return null;
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

  function applyTheme() {
    const activeTheme = resolveTheme();
    host.setAttribute('data-theme', activeTheme);
    const btns = [el('theme-toggle'), el('theme-toggle-tokens')].filter(Boolean);
    btns.forEach(btn => {
      if (currentThemeMode === 'auto') {
        btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
        btn.title = `当前主题：跟随宿主 (${activeTheme === 'light' ? '浅色' : '深色'})\n点击切换为：浅色模式`;
      } else if (currentThemeMode === 'light') {
        btn.textContent = '☀️';
        btn.title = '当前主题：浅色模式 (固定)\n点击切换为：深色模式';
      } else {
        btn.textContent = '🌙';
        btn.title = '当前主题：深色模式 (固定)\n点击切换为：跟随宿主';
      }
    });
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
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

  // 绑定 6 项自定义颜色控件事件
  for (const key of Object.keys(COLOR_SLOTS)) {
    const inputEl = el(`color-${key}`);
    const resetBtn = el(`reset-${key}`);
    inputEl?.addEventListener('input', e => setCustomColor(key, e.target?.value || ''));
    inputEl?.addEventListener('change', e => setCustomColor(key, e.target?.value || ''));
    resetBtn?.addEventListener('click', () => setCustomColor(key, ''));
  }
  el('reset-all-colors')?.addEventListener('click', resetCustomColors);

  // =========================================================================
  // 模块 2: 宿主布局挂载、渐进式宽度收缩与悬浮层跟随定位
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

  function ensureHostDocked() {
    if (state.disposed) return;
    const titlebar = findHostTitlebar();
    if (titlebar) {
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

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      let rightOffset = 142;
      if (typeof document.querySelector === 'function') {
        const topRightBar = document.querySelector('div.absolute.right-0.top-0');
        if (topRightBar?.getBoundingClientRect) {
          const r = topRightBar.getBoundingClientRect();
          if (r.width > 0) rightOffset = Math.max(142, Math.ceil((window.innerWidth || 1280) - r.left + 8));
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
          const minTitleWidth = tbRect.left < 168 ? 175 : 215;
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
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
  }

  function updateResponsiveLayout() {
    if (state.disposed) return;
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

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const top = Math.max(36, Math.min(vh - 120, Math.round(hRect.bottom + 6)));
      const baseRight = Math.max(12, Math.round(vw - hRect.right));

      const pContext = el('panel');
      if (pContext && !pContext.hidden) {
        const maxRight = Math.max(12, vw - 450 - 12);
        pContext.style.top = `${top}px`;
        pContext.style.right = `${Math.min(baseRight, maxRight)}px`;
      }
      const pTokens = el('panel-tokens');
      if (pTokens && !pTokens.hidden) {
        const maxRight = Math.max(12, vw - 730 - 12);
        pTokens.style.top = `${top}px`;
        pTokens.style.right = `${Math.min(baseRight, maxRight)}px`;
      }
      const pOverflow = el('overflow-menu');
      if (pOverflow && !pOverflow.hidden) {
        const maxRight = Math.max(12, vw - 220 - 12);
        pOverflow.style.top = `${top}px`;
        pOverflow.style.right = `${Math.min(baseRight, maxRight)}px`;
      }
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
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } });
    return { ...(value || {}), ...failure, model: value?.model || '', used: null, estimate: null, actual: null, percent: null };
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

    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');

    if (target === 'tokens') {
      hideContextTooltip();
      pContext.hidden = true;
      pTokens.hidden = false;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      positionFloatingPanels();
      renderHeatmapGrid();
    } else if (target === 'context') {
      hideContextTooltip();
      pTokens.hidden = true;
      pContext.hidden = false;
      bContext.setAttribute('aria-expanded', 'true');
      bSpeed?.setAttribute('aria-expanded', 'true');
      bTokens.setAttribute('aria-expanded', 'false');
      positionFloatingPanels();
    } else {
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      hidePopover();
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
    if (willOpen) positionFloatingPanels();
  }

  el('badge').addEventListener('click', toggleContext);
  el('badge-speed')?.addEventListener('click', toggleContext);
  el('badge-tokens').addEventListener('click', toggleTokens);
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-speed-btn')?.addEventListener('click', () => showPanel('context'));
  el('overflow-tokens-btn')?.addEventListener('click', () => showPanel('tokens'));
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));

  // 上下文圆环悬停与键盘聚焦气泡 + 面板打开时的平滑互切
  el('badge').addEventListener('mouseenter', () => {
    if (isAnyPanelOpen()) {
      if (!el('panel-tokens').hidden) showPanel('context');
    } else {
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

  el('badge-speed')?.addEventListener('mouseenter', () => {
    if (isAnyPanelOpen() && !el('panel-tokens').hidden) {
      showPanel('context');
    }
  });
  el('badge-tokens').addEventListener('mouseenter', () => {
    if (isAnyPanelOpen() && !el('panel').hidden) {
      showPanel('tokens');
    }
  });

  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('theme-toggle-tokens')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // 二级抽屉 1: 颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  btnColors?.addEventListener('click', () => {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    colorDrawerBody.style.display = isHidden ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = isHidden ? '▲ 收起设置' : '▼ 展开设置';
    btnColors.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 2: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? '▲ 点击收起明细' : '▼ 点击展开明细';
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 热力图视图切换（每天 / 每周 / 累计总量）
  function switchHeatView(view) {
    activeHeatView = view;
    const tDaily = el('h-tab-daily');
    const tWeekly = el('h-tab-weekly');
    const tCum = el('h-tab-cum');
    const bDaily = el('h-daily-box');
    const bWeekly = el('h-weekly-box');
    const bCum = el('h-cum-box');

    tDaily.classList.remove('active');
    tWeekly.classList.remove('active');
    tCum.classList.remove('active');
    bDaily.style.display = 'none';
    bWeekly.style.display = 'none';
    bCum.style.display = 'none';
    hidePopover();

    if (view === 'weekly') {
      tWeekly.classList.add('active');
      bWeekly.style.display = 'flex';
      renderHeatmapWeekly();
    } else if (view === 'cum') {
      tCum.classList.add('active');
      bCum.style.display = 'block';
      renderHeatmapCum();
    } else {
      tDaily.classList.add('active');
      bDaily.style.display = 'block';
      renderHeatmapGrid();
    }
  }

  el('h-tab-daily')?.addEventListener('click', () => switchHeatView('daily'));
  el('h-tab-weekly')?.addEventListener('click', () => switchHeatView('weekly'));
  el('h-tab-cum')?.addEventListener('click', () => switchHeatView('cum'));

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    if (!e.composedPath().includes(host)) {
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);

  // =========================================================================
  // 模块 4: 数据渲染与圆环/气泡状态更新
  // =========================================================================
  function renderFiles(session) {
    const parent = el('files'); parent.replaceChildren();
    if (!session) { const item = document.createElement('p'); item.textContent = '正在读取全量会话附件引用…'; parent.appendChild(item); return; }
    if (!session.attachments.length) { const item = document.createElement('p'); item.textContent = '归档中没有上传附件引用。'; parent.appendChild(item); return; }
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? `（引用 ${file.references} 次）` : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      detail.textContent = `${file.source === 'assistant' ? '模型输出附件 · ' : ''}${file.chars ? `${range(file)} token · ${fmt(file.chars)} 字符` : '内容 token 未知'}${file.sheets != null ? ` · ${file.sheets} 个工作表，${fmt(file.cells)} 个单元格` : ''}${file.hiddenSheets ? `（含 ${file.hiddenSheets} 个隐藏表）` : ''}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = '未计全：' + file.unknownParts.join('；'); item.appendChild(unknown); }
      parent.appendChild(item);
    }
  }

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
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

  function renderHeatmapGrid() {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || colsBox.children.length > 0) return;

    const now = new Date();
    const totalDays = 52 * 7;
    const list = [];
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${day}`;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      list.push({ date: d, key, tokens: rec ? rec.total : 0, rec });
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
        cell.className = `heat-cell lvl-${lvl}`;

        const showPop = () => {
          const d = item.date;
          heatPopDate.textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens` : '0 Tokens';
          if (item.rec) {
            heatPopDet.innerHTML = `<span>Prompt: ${fmtYi(item.rec.input)}</span><span>Output: ${fmtYi(item.rec.output)}</span><span>Cache: ${fmtYi(item.rec.cache)}</span>`;
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

    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 13}px`;
      lbl.textContent = `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.innerHTML = '';

    const isLight = host.getAttribute('data-theme') === 'light';
    const cEmpty = isLight ? '#e4e4e7' : '#27272a';
    const c1 = isLight ? '#e9d5ff' : '#3f1e6b';
    const c2 = isLight ? '#c084fc' : '#652ab7';
    const c3 = isLight ? '#9333ea' : '#9053f8';
    const c4 = customColors.tokenAccent || (isLight ? '#6b21a8' : '#c084fc');

    const now = new Date();
    const totalWeeks = 52;
    const weeksData = [];
    let max = 1;

    for (let c = 0; c < totalWeeks; c++) {
      let sum = 0;
      let sDate = null, eDate = null;
      for (let r = 0; r < 7; r++) {
        const off = (52 - c - 1) * 7 + (6 - r);
        const d = new Date(now);
        d.setDate(now.getDate() - off);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!sDate) sDate = d;
        eDate = d;
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) sum += rec.total;
      }
      if (sum > max) max = sum;
      weeksData.push({ sum, sDate, eDate });
    }

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      const fill = document.createElement('div');
      fill.className = 'w-bar-fill';
      const pct = Math.max(3, (w.sum / max) * 100);
      fill.style.height = `${pct}%`;
      fill.style.backgroundColor = w.sum === 0 ? cEmpty : (w.sum < 1e7 ? c1 : (w.sum < 5e7 ? c2 : (w.sum < 1.5e8 ? c3 : c4)));
      col.appendChild(fill);

      const showPop = () => {
        heatPopDate.textContent = `${w.sDate.getMonth() + 1}月${w.sDate.getDate()}日 - ${w.eDate.getMonth() + 1}月${w.eDate.getDate()}日`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens` : '0 Tokens';
        heatPopDet.innerHTML = `<span>Weekly Total · 周累计</span>`;
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

    const now = new Date();
    const totalDays = 52 * 7;
    let running = 0;
    const points = [];

    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      if (rec) running += rec.total;
      points.push({ date: d, val: running });
    }

    const max = running || 1;
    const step = width / (points.length - 1);

    const isLight = host.getAttribute('data-theme') === 'light';
    const strokeColor = customColors.tokenAccent || (isLight ? '#7c3aed' : '#c084fc');
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    if (isLight) {
      grad.addColorStop(0, 'rgba(124, 58, 237, 0.28)');
      grad.addColorStop(1, 'rgba(233, 213, 255, 0.02)');
    } else {
      grad.addColorStop(0, 'rgba(192, 132, 252, 0.4)');
      grad.addColorStop(1, 'rgba(63, 30, 107, 0)');
    }

    ctx.beginPath();
    ctx.moveTo(0, height);
    points.forEach((pt, idx) => {
      const x = idx * step;
      const y = height - (pt.val / max) * (height - 10);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = idx * step;
      const y = height - (pt.val / max) * (height - 10);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const idx = Math.min(points.length - 1, Math.max(0, Math.round(mouseX / step)));
      const pt = points[idx];
      heatPopDate.textContent = `${pt.date.getMonth() + 1}月${pt.date.getDate()}日 (累计)`;
      heatPopVal.textContent = `${fmtYi(pt.val)} Tokens`;
      heatPopDet.innerHTML = `<span>Cumulative Total · 累计总消耗</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 10)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;
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

    if (d?.exceeded) {
      tipTitle.textContent = '上下文窗口（超限告警）：';
      tipPct.textContent = '100% 已用（已超出上限）';
      tipDetail.textContent = d.serviceLimit
        ? `已超上限，共 ${fmtBubbleToken(d.serviceLimit)} token`
        : '服务端已拒绝输入（超出容量上限）';
    } else if (d?.error) {
      tipTitle.textContent = '上下文窗口（请求异常）：';
      tipPct.textContent = '最近请求失败（占用未知）';
      tipDetail.textContent = d?.budget
        ? `预算上限 ${fmtBubbleToken(d.budget)} token`
        : '暂无有效的新用量统计';
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = '上下文窗口（数据过期）：';
      tipPct.textContent = `${usedRound}% 已用（剩余 ${remRound}% · 统计延迟）`;
      tipDetail.textContent = `已用 ${fmtBubbleToken(d.actual)} token，共 ${fmtBubbleToken(d.budget)}`;
    } else if (stale) {
      tipTitle.textContent = '上下文窗口（数据过期）：';
      tipPct.textContent = '统计读取延迟（剩余未知）';
      tipDetail.textContent = session
        ? `会话估算 ≈ ${fmtBubbleToken(session.total.low)}–${fmtBubbleToken(session.total.high)} token`
        : '正在等待后台更新统计数据';
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = '上下文窗口（高占用告警）：';
        tipPct.textContent = `${usedRound}% 已用（剩余 ${remRound}% · 接近上限）`;
      } else if (rawPct >= 75) {
        tipTitle.textContent = '上下文窗口（占用偏高）：';
        tipPct.textContent = `${usedRound}% 已用（剩余 ${remRound}% · 占用偏高）`;
      } else {
        tipTitle.textContent = '上下文窗口：';
        tipPct.textContent = `${usedRound}% 已用（剩余 ${remRound}%）`;
      }
      tipDetail.textContent = `已用 ${fmtBubbleToken(d.actual)} token，共 ${fmtBubbleToken(d.budget)}${incomplete ? '（含未知附件）' : ''}`;
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = '上下文窗口：';
      tipPct.textContent = '容量未知（未返回上限）';
      tipDetail.textContent = `已用 ${fmtBubbleToken(d.actual)} token，总容量未知`;
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = '上下文窗口（本地估算）：';
      tipPct.textContent = '真实占比未知（仅估算）';
      tipDetail.textContent = `已用 ≈ ${fmtBubbleToken(d.estimate)} token${d.budget ? `，共 ${fmtBubbleToken(d.budget)}` : '，总容量未知'}`;
    } else if (session) {
      tipTitle.textContent = '上下文窗口（本地估算）：';
      tipPct.textContent = '等待请求统计（仅归档估算）';
      tipDetail.textContent = `会话累计 ≈ ${fmtBubbleToken(session.total.low)}–${fmtBubbleToken(session.total.high)} token`;
    } else {
      tipTitle.textContent = '上下文窗口：';
      tipPct.textContent = '数据尚未就绪';
      tipDetail.textContent = '正在读取当前会话上下文用量…';
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
      speedAmount.textContent = isCompact ? '…' : '计算中…';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '计算中…';
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  // 渲染上下文与全局状态
  function render() {
    host.hidden = !state.route;
    if (!state.route) {
      hideContextTooltip();
      return;
    }
    ensureHostDocked();

    const d = state.latest, session = state.scan?.session;
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = d?.exceeded || d?.error;

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

    const status = d?.exceeded ? '服务端已拒绝：输入超限。本地估算不可靠，不能据此判断剩余空间。' : d?.error ? '最近请求失败。没有有效的新用量统计，请查看原始错误。' : stale ? '最近请求统计读取异常或延迟，不能判断剩余空间。' : state.scanError ? '全会话扫描未完成：' + state.scanError : incomplete ? `存在 ${session.unknownFiles} 个附件含未知内容；会话总量仍未计全，不能据此保证不会超限。` : d?.estimated ? '只有客户端估算，附件等内容可能未计全；当前请求真实占用未知。' : '请求用量与会话累计分别统计；会话 token 数始终为本地估算。';
    el('status').textContent = status;

    const corpus = session ? `会话${range(session.total)}${incomplete ? '＋未知' : ''}` : state.scanBusy ? '会话扫描中…' : '会话待扫描';

    if (d?.exceeded) {
      el('amount').textContent = '服务端超限';
      setHoverExtra(' · 100% 已溢出');
    } else if (d?.error) {
      el('amount').textContent = '请求失败';
      setHoverExtra('');
    } else if (stale) {
      el('amount').textContent = '统计延迟';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      el('amount').textContent = `${short(d.actual)}${pctStr}`;
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      el('amount').textContent = '真实量未知';
      setHoverExtra(` · ${corpus}`);
    }

    el('badge-tokens').title = '账号累计 Token 活动统计（点击展开详情）';

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
        speedBadge.title = `最新模型输出速度：${sp.tps} tok/s${sp.streamingTps ? ` (流式 ${sp.streamingTps} tok/s)` : ''}\n总耗时：${sp.duration || '—'}s (首字 ${sp.ttft || '—'}s + 流式 ${sp.streamingSec || '—'}s)\n本次产出：${fmt(sp.outputTokens)} tokens`;
      } else if (state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = '正在等待模型返回或计算生成指标…';
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = ' · 待生成';
        speedBadge.title = '模型输出速度与耗时 (tok/s)';
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

      if (d?.exceeded) {
        if (keyBadge) { keyBadge.textContent = '已超限'; keyBadge.className = 'key-pill pill-danger'; }
        if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : '超限';
        if (keyLimit) keyLimit.textContent = d.serviceLimit ? short(d.serviceLimit) : (d.budget ? short(d.budget) : '1M');
        if (keyRemaining) keyRemaining.textContent = '0 (已溢出)';
        if (keyTakeaway) keyTakeaway.textContent = `✖ 已超出服务端最大限制${d.serviceLimit ? `（${fmt(d.serviceLimit)} tokens）` : ''}，当前对话已被拒绝。需精简或新建会话。`;
      } else if (d?.error) {
        if (keyBadge) { keyBadge.textContent = '异常'; keyBadge.className = 'key-pill pill-danger'; }
        if (keyUsed) keyUsed.textContent = '—';
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = '—';
        if (keyTakeaway) keyTakeaway.textContent = '✖ 最近请求遇到错误，未产生有效的最新统计结果。';
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = '紧张'; keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = '偏高'; keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = '正常'; keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        if (keyLimit) keyLimit.textContent = short(limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.textContent = `⚠ 上下文已消耗 ${pct.toFixed(1)}%，仅剩约 ${short(remainVal)} tokens，接近预算上限！建议清理冗余上下文。`;
          } else if (pct >= 75) {
            keyTakeaway.textContent = `⚡ 已使用 ${pct.toFixed(1)}%，剩余可用空间约 ${short(remainVal)} tokens，注意大文件或长输出。`;
          } else {
            keyTakeaway.textContent = `✔ 当前用量健康（${pct.toFixed(1)}%），剩余可用空间充足（约 ${short(remainVal)} tokens），可正常继续对话。`;
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? '估算' : '读取中'; keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? `约 ${short(d.estimate)}` : (session ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = '待确认';
        if (keyTakeaway) keyTakeaway.textContent = 'ℹ 当前主要依赖本地估算或待服务端返回实际统计，暂不计算精确剩余空间。';
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
          if (sp.tps >= 80) { spBadge.textContent = '极速'; spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 35) { spBadge.textContent = '流畅'; spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 15) { spBadge.textContent = '良好'; spBadge.className = 'key-pill pill-warn'; }
          else { spBadge.textContent = '偏慢'; spBadge.className = 'key-pill pill-danger'; }
        }
        if (spVal) spVal.textContent = `${sp.tps} tok/s`;
        if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
        if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
        if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
        if (spTakeaway) {
          const modelStr = d?.model ? `（${d.model}）` : '';
          const streamInfo = sp.streamingTps ? `，纯流式传输达 ${sp.streamingTps} tok/s` : '';
          spTakeaway.textContent = `✔ 输出${sp.tps >= 35 ? '流畅' : '平稳'}（${sp.tps} tok/s${streamInfo}），总耗时 ${sp.duration}s 内生成 ${fmt(sp.outputTokens)} tokens${modelStr}。`;
        }
      } else {
        if (spBadge) { spBadge.textContent = state.requestBusy ? '计算中' : '待生成'; spBadge.className = 'key-pill pill-muted'; }
        if (spVal) spVal.textContent = '—';
        if (spDur) spDur.textContent = '—';
        if (spTtft) spTtft.textContent = '—';
        if (spTokens) spTokens.textContent = '—';
        if (spTakeaway) spTakeaway.textContent = 'ℹ 等待当前或下一次模型输出完成，将自动计算精确输出速度 (tok/s)、首字延迟与总耗时。';
      }
    }

    el('model').textContent = d?.model?.startsWith('MODEL_PLACEHOLDER') ? '模型标识：' + d.model : d?.model || '未返回模型信息';
    el('request-status').textContent = d?.exceeded ? '输入超限（已失败）' : d?.error ? '已失败' : d?.status === 'reported' ? '已返回实际统计' : d?.status === 'estimated' ? '只有本地估算' : '等待统计，未确认执行状态';
    el('actual').textContent = d?.actual != null ? token(d.actual) : d?.exceeded ? `>${fmt(d.serviceLimit || 0)}（实际总数未返回）` : '真实用量未知';
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = '已超限；实际数值未知';
    el('estimate').textContent = d?.estimate ? `约 ${fmt(d.estimate)} · ${d.exceeded ? '已证实低估' : '仅供参考'}` : '未提供';
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? `${fmt(d.serviceLimit)}（仅该次错误证据）` : '本次没有服务端限制证据';
    el('percent').textContent = d?.percent != null && !danger && !stale ? `${d.percent.toFixed(1)}%（非 1M 总容量）` : '不提供安全余量百分比';
    el('session-total').textContent = session ? range(session.total) + (incomplete ? ' ＋ 未知内容' : '') : state.scanError ? '扫描未完成' : '扫描中…';
    el('characters').textContent = session ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session ? range(session.groups[name]) : '—';
    el('system').textContent = session ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session ? range(session.attachmentTotal) + (incomplete ? ' ＋ 未知' : '') : '—';
    el('steps').textContent = session ? `${fmt(session.steps)} 条；${session.userMessages} 条用户消息／${session.assistantMessages} 条回复` : '尚未完成全量读取';
    el('coverage').textContent = session ? `${session.attachments.length} 个附件条目（${session.attachments.filter(f => f.source === 'user').length} 个上传、${session.attachments.filter(f => f.source === 'assistant').length} 个模型/工具输出）；${session.attachments.filter(f => f.chars > 0).length} 个已读到文本，${session.unknownFiles} 个含未计内容。${state.scanBusy ? ' 正在重新扫描…' : ''}${state.scanError ? ' 最近重扫失败，当前为旧结果：' + state.scanError : ''}` : state.scanError || '正在扫描整段归档，不依赖页面已加载的聊天条数。';
    el('updated').textContent = `请求统计 ${state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : '未读取'} · 全量扫描 ${state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : '未完成'}`;
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
      for (let i = rows.length - 1; i >= 0; i--) { const value = summarize(rows[i]); if (value) { state.latest = withStepError(value, rows[i]); break; } }
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
        try { const response = await fetch(`http://127.0.0.1:${live.port}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token }, body: JSON.stringify({ id, force }), signal: controller.signal }); if (!response.ok) throw new Error(`扫描接口 HTTP ${response.status}`); result = await response.json(); }
        finally { clearTimeout(timeout); state.controllers.delete(controller); }
      } else throw new Error('完整重启 Antigravity 后启用附件扫描');
      if (generation !== state.generation || state.disposed) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.scannedAt >= state.requestAt && result.data.latest) { state.latest = result.data.latest; state.requestAt = result.data.scannedAt; }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  function tick() {
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      Object.assign(state, { route: id, count: 0, latest: null, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0, scanError: '', scan: null }); toggle(false); hideContextTooltip(); renderFiles(null); render();
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
  }

  const timer = setInterval(tick, 500);
  globalThis.__AGContextMeter = {
    version: '2.6.0',
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch {}; applyTheme(); },
    getCustomColors: () => ({ ...customColors }),
    setCustomColor,
    resetCustomColors,
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => {
      const next = computeNextLayoutMode(width, state.layoutMode);
      applyLayoutMode(next);
      return state.layoutMode;
    },
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode }),
    dispose() {
      state.disposed = true;
      for (const controller of state.controllers) controller.abort();
      clearInterval(timer);
      if (layoutRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf);
      try { themeObserver?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { hostDomObserver?.disconnect(); } catch {}
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
      } catch {}
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      host.remove();
    }
  };
  tick();
})();
