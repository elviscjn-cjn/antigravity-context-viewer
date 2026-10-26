(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const { summarize } = globalThis.__AGContextMeterCore;
  const host = document.createElement('div'); host.id = 'ag-context-meter';
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

  shadow.innerHTML = `<style>
    :host{
      position:fixed;top:4px;right:146px;z-index:2147483000;
      font:12px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      -webkit-app-region:no-drag;user-select:none;display:flex;align-items:center;gap:6px;
      
      /* 深色默认变量 */
      --ag-bg-badge:#1e1e1e;
      --ag-bg-badge-hover:#343434;
      --ag-border-badge:transparent;
      --ag-border-badge-hover:transparent;
      --ag-shadow-badge:none;
      --ag-text-badge:#c8c8ce;
      --ag-text-badge-hover:#f2f2f5;
      --ag-text-token:#c084fc;
      --ag-text-token-hover:#e9d5ff;
      --ag-token-dot:#c084fc;
      --ag-token-dot-shadow:0 0 6px rgba(192,132,252,0.8);
      --ag-text-speed:#38bdf8;
      --ag-text-speed-hover:#7dd3fc;
      --ag-track-bg:rgba(255,255,255,0.12);
      --ag-track-shadow:inset 0 1px 2px rgba(0,0,0,0.45);
      --ag-text-extra:#9898a0;
      
      --ag-bg-panel:#1e1e1e;
      --ag-border-panel:rgba(255,255,255,0.08);
      --ag-shadow-panel:0 16px 42px rgba(0,0,0,0.65),0 2px 8px rgba(0,0,0,0.35);
      --ag-text-primary:#ececec;
      --ag-text-secondary:#d8d8dc;
      --ag-text-muted:#888892;
      --ag-border-subtle:rgba(255,255,255,0.08);
      
      --ag-bg-card:rgba(255,255,255,0.03);
      --ag-bg-card-hover:rgba(255,255,255,0.06);
      --ag-border-card:rgba(255,255,255,0.06);
      --ag-bg-subcard:rgba(255,255,255,0.025);
      --ag-border-subcard:rgba(255,255,255,0.04);
      --ag-bg-status:rgba(255,255,255,0.03);
      --ag-text-status:#c8c8d0;
      
      --ag-btn-bg:rgba(255,255,255,0.05);
      --ag-btn-hover:rgba(255,255,255,0.09);
      --ag-btn-border:rgba(255,255,255,0.1);
      --ag-btn-border-hover:rgba(255,255,255,0.16);
      --ag-btn-text:#d4d4d8;
      
      --ag-pill-muted-bg:rgba(255,255,255,0.05);
      --ag-pill-muted-border:rgba(255,255,255,0.1);
      --ag-pill-muted-text:#9a9aa2;
      
      --ag-tab-active-bg:rgba(255,255,255,0.08);
      --ag-tab-active-text:#ffffff;
      --ag-tab-active-purple-bg:rgba(192,132,252,0.12);
      --ag-tab-active-purple-text:#c084fc;
      
      --ag-heat-bg:rgba(0,0,0,0.25);
      --ag-heat-lvl-0:#27272a;
      --ag-heat-lvl-1:#3f1e6b;
      --ag-heat-lvl-2:#652ab7;
      --ag-heat-lvl-3:#9053f8;
      --ag-heat-lvl-4:#c084fc;
      --ag-heat-outline:#ffffff;
      
      --ag-pop-bg:rgba(34,34,38,0.96);
      --ag-pop-border:rgba(255,255,255,0.12);
      --ag-pop-shadow:0 8px 24px rgba(0,0,0,0.6);
      --ag-pop-text:#ffffff;
      --ag-pop-muted:#d4d4d8;
      --ag-pop-sub:#a1a1aa;
      
      --ag-scrollbar-thumb:rgba(255,255,255,0.14);
      --ag-scrollbar-hover:rgba(255,255,255,0.24);
      
      color-scheme:dark;
      color:#d4d4d4;
    }

    /* 浅色模式规范: 常驻 #f3f3f3, 交互 #eaeaea, 字体 #101010, 无突兀边框融入背景 */
    :host([data-theme="light"]){
      --ag-bg-badge:#f3f3f3;
      --ag-bg-badge-hover:#eaeaea;
      --ag-border-badge:transparent;
      --ag-border-badge-hover:transparent;
      --ag-shadow-badge:none;
      --ag-text-badge:#101010;
      --ag-text-badge-hover:#101010;
      --ag-text-token:#101010;
      --ag-text-token-hover:#101010;
      --ag-token-dot:#8b5cf6;
      --ag-token-dot-shadow:0 0 6px rgba(139,92,246,0.5);
      --ag-text-speed:#0284c7;
      --ag-text-speed-hover:#0369a1;
      --ag-track-bg:rgba(0,0,0,0.08);
      --ag-track-shadow:inset 0 1px 2px rgba(0,0,0,0.06);
      --ag-text-extra:#666666;
      
      --ag-bg-panel:#ffffff;
      --ag-border-panel:rgba(0,0,0,0.1);
      --ag-shadow-panel:0 16px 42px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06);
      --ag-text-primary:#101010;
      --ag-text-secondary:#222222;
      --ag-text-muted:#666666;
      --ag-border-subtle:rgba(0,0,0,0.08);
      
      --ag-bg-card:#f3f3f3;
      --ag-bg-card-hover:#eaeaea;
      --ag-border-card:rgba(0,0,0,0.08);
      --ag-bg-subcard:#ffffff;
      --ag-border-subcard:rgba(0,0,0,0.06);
      --ag-bg-status:#f3f3f3;
      --ag-text-status:#101010;
      
      --ag-btn-bg:#f3f3f3;
      --ag-btn-hover:#eaeaea;
      --ag-btn-border:rgba(0,0,0,0.1);
      --ag-btn-border-hover:rgba(0,0,0,0.18);
      --ag-btn-text:#101010;
      
      --ag-pill-muted-bg:#ffffff;
      --ag-pill-muted-border:rgba(0,0,0,0.12);
      --ag-pill-muted-text:#666666;
      
      --ag-tab-active-bg:#f3f3f3;
      --ag-tab-active-text:#101010;
      --ag-tab-active-purple-bg:rgba(139,92,246,0.12);
      --ag-tab-active-purple-text:#7c3aed;
      
      --ag-heat-bg:#f3f3f3;
      --ag-heat-lvl-0:#eaeaea;
      --ag-heat-lvl-1:#e9d5ff;
      --ag-heat-lvl-2:#c084fc;
      --ag-heat-lvl-3:#9333ea;
      --ag-heat-lvl-4:#6b21a8;
      --ag-heat-outline:#101010;
      
      --ag-pop-bg:rgba(255,255,255,0.98);
      --ag-pop-border:rgba(0,0,0,0.12);
      --ag-pop-shadow:0 8px 24px rgba(0,0,0,0.12);
      --ag-pop-text:#101010;
      --ag-pop-muted:#444444;
      --ag-pop-sub:#666666;
      
      --ag-scrollbar-thumb:rgba(0,0,0,0.14);
      --ag-scrollbar-hover:rgba(0,0,0,0.26);
      
      color-scheme:light;
      color:#101010;
    }

    *{box-sizing:border-box}
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb);border-radius:3px}
    ::-webkit-scrollbar-thumb:hover{background:var(--ag-scrollbar-hover)}
    button{font:inherit;color:inherit;cursor:pointer}
    button:focus-visible{outline:1.5px solid rgba(128,128,128,0.35);outline-offset:1px}
    
    /* 胶囊 1: 会话上下文 */
    #badge{
      display:inline-flex;align-items:center;height:26px;max-width:520px;padding:0 9px;
      border:1px solid var(--ag-border-badge);border-radius:6px;
      background:var(--ag-bg-badge);color:var(--ag-text-badge);box-shadow:var(--ag-shadow-badge);
      white-space:nowrap;font-variant-numeric:tabular-nums;
      transition:background-color .28s cubic-bezier(.16,1,.3,1),color .28s cubic-bezier(.16,1,.3,1),border-color .28s cubic-bezier(.16,1,.3,1),transform .12s cubic-bezier(.16,1,.3,1);
      will-change:background-color,color,transform;
    }
    #badge:hover,#badge:focus-visible,#badge[aria-expanded="true"]{
      background:var(--ag-bg-badge-hover);color:var(--ag-text-badge-hover);border-color:var(--ag-border-badge-hover);
    }
    #badge:active{transform:scale(0.98)}
    .meter-bar-track{width:42px;height:6px;margin-right:7px;background:var(--ag-track-bg);border-radius:3px;overflow:hidden;flex-shrink:0;box-shadow:var(--ag-track-shadow)}
    .meter-bar-fill{height:100%;width:0%;border-radius:3px;background:var(--bar-color,#69c0ff);transition:width .36s cubic-bezier(.22,1,.36,1),background-color .3s ease}
    #amount{font-weight:500;font-size:12px;letter-spacing:-0.01em;overflow:hidden;text-overflow:ellipsis}
    #hover-wrap{display:inline-block;width:0;opacity:0;overflow:hidden;vertical-align:middle;transition:width .28s cubic-bezier(.16,1,.3,1),opacity .24s cubic-bezier(.16,1,.3,1);will-change:width,opacity}
    #badge:hover #hover-wrap,#badge:focus-visible #hover-wrap,#badge[aria-expanded="true"] #hover-wrap{width:var(--extra-w,0px);opacity:1}
    #hover-extra{display:inline-block;padding-left:6px;color:var(--ag-text-extra);font-size:11.5px;font-weight:400;white-space:nowrap;transform:translateX(4px);transition:transform .28s cubic-bezier(.16,1,.3,1)}
    #badge:hover #hover-extra,#badge:focus-visible #hover-extra,#badge[aria-expanded="true"] #hover-extra{transform:translateX(0)}

    /* 胶囊 2: 全局 Token 活动 */
    #badge-tokens{
      display:inline-flex;align-items:center;height:26px;padding:0 9px;
      border:1px solid var(--ag-border-badge);border-radius:6px;
      background:var(--ag-bg-badge);color:var(--ag-text-token);box-shadow:var(--ag-shadow-badge);
      white-space:nowrap;font-variant-numeric:tabular-nums;transition:all .28s cubic-bezier(.16,1,.3,1);gap:5px;
    }
    #badge-tokens:hover,#badge-tokens[aria-expanded="true"]{
      background:var(--ag-bg-badge-hover);color:var(--ag-text-token-hover);border-color:var(--ag-border-badge-hover);
    }
    #badge-tokens:active{transform:scale(0.98)}
    .token-fire-dot{width:6px;height:6px;border-radius:50%;background:var(--ag-token-dot);box-shadow:var(--ag-token-dot-shadow);flex-shrink:0}
    #token-amount{font-weight:600;font-size:12px;letter-spacing:-0.01em;color:var(--ag-text-token)}
    #token-hover-extra{max-width:0;opacity:0;overflow:hidden;transition:all .28s cubic-bezier(.16,1,.3,1);font-size:11.5px;color:var(--ag-text-extra);white-space:nowrap}
    #badge-tokens:hover #token-hover-extra{max-width:140px;opacity:1;margin-left:3px}

    /* 胶囊 3: 模型输出速度与耗时 */
    #badge-speed{
      display:inline-flex;align-items:center;height:26px;padding:0 9px;
      border:1px solid var(--ag-border-badge);border-radius:6px;
      background:var(--ag-bg-badge);color:var(--ag-text-speed);box-shadow:var(--ag-shadow-badge);
      white-space:nowrap;font-variant-numeric:tabular-nums;transition:all .28s cubic-bezier(.16,1,.3,1);gap:5px;
      cursor:pointer;outline:none;
    }
    #badge-speed:hover,#badge-speed[aria-expanded="true"]{
      background:var(--ag-bg-badge-hover);color:var(--ag-text-speed-hover);border-color:var(--ag-border-badge-hover);
    }
    #badge-speed:active{transform:scale(0.98)}
    .speed-icon{font-size:12px;line-height:1;flex-shrink:0;color:var(--ag-text-speed)}
    #speed-amount{font-weight:600;font-size:12px;letter-spacing:-0.01em;color:var(--ag-text-speed)}
    #speed-hover-extra{max-width:0;opacity:0;overflow:hidden;transition:all .28s cubic-bezier(.16,1,.3,1);font-size:11.5px;color:var(--ag-text-extra);white-space:nowrap}
    #badge-speed:hover #speed-hover-extra{max-width:200px;opacity:1;margin-left:3px}

    /* 弹出主面板 */
    #panel{
      position:absolute;top:32px;right:0;width:450px;max-width:calc(100vw - 24px);max-height:calc(100vh - 64px);
      overflow:auto;border:1px solid var(--ag-border-panel);border-radius:10px;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);box-shadow:var(--ag-shadow-panel);padding:15px;
      opacity:1;transform:translateY(0) scale(1);transform-origin:top right;visibility:visible;pointer-events:auto;
      transition:width .25s ease,opacity .18s cubic-bezier(.16,1,.3,1),transform .18s cubic-bezier(.16,1,.3,1),visibility .18s;
    }
    #panel.wide-mode{width:730px}
    #panel[hidden]{display:block!important;opacity:0;transform:translateY(-5px) scale(0.975);visibility:hidden;pointer-events:none}
    
    /* 顶栏控制条 */
    .panel-header-bar{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:10px;margin-bottom:12px}
    .panel-tabs{display:flex;align-items:center;gap:6px}
    .panel-header-actions{display:flex;align-items:center;gap:4px}
    
    .panel-tab-btn{
      background:none;border:1px solid transparent;color:var(--ag-text-muted);font-size:12.5px;font-weight:500;
      padding:4px 9px;border-radius:6px;transition:all .15s;
    }
    .panel-tab-btn:hover{color:var(--ag-text-primary);background:var(--ag-bg-badge-hover)}
    .panel-tab-btn.active{color:var(--ag-tab-active-text);background:var(--ag-tab-active-bg);border-color:var(--ag-border-card);font-weight:600}
    .panel-tab-btn.active-purple{color:var(--ag-tab-active-purple-text);background:var(--ag-tab-active-purple-bg);border-color:transparent;font-weight:600}
    
    .panel-icon-btn{
      background:none;border:0;color:var(--ag-text-muted);font-size:14px;line-height:1;
      padding:4px 7px;border-radius:5px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;
    }
    .panel-icon-btn:hover{color:var(--ag-text-primary);background:var(--ag-bg-badge-hover)}
    #close{font-size:17px;padding:2px 7px}

    h3{margin:0;font-size:13.5px;font-weight:600;color:var(--ag-text-primary)}
    h4{margin:14px 0 6px;font-size:11.5px;font-weight:600;color:var(--ag-text-secondary)}
    p{margin:6px 0;color:var(--ag-text-muted)}
    dl{display:grid;grid-template-columns:1fr auto;gap:5px;margin:0}
    dt{color:var(--ag-text-muted)}
    dd{margin:0;text-align:right;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:270px}
    
    #key-summary{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:12px 13px;margin:8px 0 12px}
    .key-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .key-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px}
    .key-pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid transparent}
    .pill-good{color:#52c41a;background:rgba(82,196,26,0.12);border-color:rgba(82,196,26,0.28)}
    :host([data-theme="light"]) .pill-good{color:#389e0d;background:#f6ffed;border-color:#b7eb8f}
    .pill-warn{color:#faad14;background:rgba(250,173,20,0.12);border-color:rgba(250,173,20,0.28)}
    :host([data-theme="light"]) .pill-warn{color:#d46b08;background:#fff7e6;border-color:#ffd591}
    .pill-danger{color:#ff4d4f;background:rgba(255,77,79,0.14);border-color:rgba(255,77,79,0.32)}
    :host([data-theme="light"]) .pill-danger{color:#cf1322;background:#fff1f0;border-color:#ffa39e}
    .pill-muted{color:var(--ag-pill-muted-text);background:var(--ag-pill-muted-bg);border-color:var(--ag-pill-muted-border)}
    
    .key-bar-track{width:100%;height:7px;background:var(--ag-track-bg);border-radius:3.5px;overflow:hidden;margin-bottom:10px;box-shadow:var(--ag-track-shadow)}
    .key-bar-fill{height:100%;width:0%;border-radius:3.5px;background:var(--bar-color,#69c0ff);transition:width .36s cubic-bezier(.22,1,.36,1),background-color .3s ease}
    .key-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;margin-bottom:8px}
    .key-stat{background:var(--ag-bg-subcard);padding:6px 4px;border-radius:6px;border:1px solid var(--ag-border-subcard)}
    .key-stat-label{font-size:10px;color:var(--ag-text-muted);margin-bottom:2px}
    .key-stat-val{font-size:12.5px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .key-takeaway{font-size:11px;color:var(--ag-text-secondary);padding-top:7px;border-top:1px solid var(--ag-border-subcard);line-height:1.4}
    
    #status{padding:7px 10px;border:0;border-left:2.5px solid var(--tone,#666);border-radius:4px;background:var(--ag-bg-status);color:var(--ag-text-status);font-weight:500;font-size:11.5px}
    #model{overflow-wrap:anywhere;font-size:11.5px;color:var(--ag-text-muted)}
    #note,#coverage,#updated{font-size:11px;color:var(--ag-text-muted)}
    #refresh{border:1px solid var(--ag-btn-border);border-radius:6px;background:var(--ag-btn-bg);color:var(--ag-btn-text);padding:4px 10px;margin-top:8px;transition:background-color .15s ease,border-color .15s ease}
    #refresh:hover:not(:disabled){background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    
    #files{max-height:230px;overflow:auto}
    .file{padding:8px 0;border-top:1px solid var(--ag-border-subtle)}
    .file-name{overflow-wrap:anywhere;color:var(--ag-text-primary)}
    .file-detail{color:var(--ag-text-muted);font-size:11px}
    .file-unknown{color:#e6b865;font-size:11px}
    :host([data-theme="light"]) .file-unknown{color:#b45309}
    #v{color:var(--ag-text-muted);font-size:10px;font-weight:400;margin-left:6px}

    /* 🔥 全局 Token 活动 */
    #view-tokens{display:flex;flex-direction:column;gap:12px}
    .token-stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .t-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px;transition:background .15s ease}
    .t-card:hover{background:var(--ag-bg-card-hover)}
    .t-card-lbl{font-size:11px;color:var(--ag-text-muted);display:flex;justify-content:space-between}
    .t-card-val{font-size:17px;font-weight:700;color:var(--ag-text-primary);letter-spacing:-0.3px}
    .t-card-sub{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    
    .heatmap-section{background:var(--ag-heat-bg);border:1px solid var(--ag-border-card);border-radius:10px;padding:12px 14px}
    .heat-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .heat-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .heat-tabs{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--ag-text-muted)}
    .heat-tab-btn{background:none;border:0;color:var(--ag-text-muted);cursor:pointer;padding:2px 0;transition:color .15s}
    .heat-tab-btn:hover{color:var(--ag-text-primary)}
    .heat-tab-btn.active{color:var(--ag-text-primary);font-weight:600}
    
    .heat-scroll-box{overflow-x:auto;padding-bottom:4px}
    .heat-grid-cols{display:flex;gap:3px}
    .heat-week-col{display:flex;flex-direction:column;gap:3px}
    .heat-cell{width:10px;height:10px;border-radius:2px;background:var(--ag-heat-lvl-0);cursor:pointer;transition:transform .12s}
    .heat-cell:hover{transform:scale(1.35);z-index:5;outline:1.5px solid var(--ag-heat-outline)}
    .lvl-0{background:var(--ag-heat-lvl-0)}
    .lvl-1{background:var(--ag-heat-lvl-1)}
    .lvl-2{background:var(--ag-heat-lvl-2)}
    .lvl-3{background:var(--ag-heat-lvl-3)}
    .lvl-4{background:var(--ag-heat-lvl-4)}

    .heat-months{position:relative;height:18px;margin-top:4px;font-size:11px;color:var(--ag-text-muted)}
    .heat-month-item{position:absolute;white-space:nowrap}

    /* 每周柱图 */
    #h-weekly-box{display:none;height:105px;align-items:flex-end;gap:3px;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:3px}
    .w-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer}
    .w-bar-fill{width:100%;border-radius:2px 2px 0 0;background:var(--ag-heat-lvl-0);min-height:3px;transition:height .25s ease,background .15s}
    .w-bar-col:hover .w-bar-fill{background:var(--ag-tab-active-purple-text,#c084fc)!important;transform:scaleY(1.05)}

    /* 累计曲线 Canvas */
    #h-cum-box{display:none;height:105px;position:relative}
    canvas#h-cum-canvas{width:100%;height:105px;display:block}

    .heat-popover{position:fixed;pointer-events:none;background:var(--ag-pop-bg);backdrop-filter:blur(8px);border:1px solid var(--ag-pop-border);border-radius:8px;padding:6px 10px;box-shadow:var(--ag-pop-shadow);z-index:99999;opacity:0;transform:translate(-50%,-100%) translateY(-6px);transition:opacity .15s}
    .pop-date{font-size:11.5px;color:var(--ag-pop-muted)}
    .pop-val{font-size:13px;font-weight:600;color:var(--ag-pop-text)}
    .pop-det{font-size:10px;color:var(--ag-pop-sub);margin-top:2px;display:flex;gap:6px}

    @media(max-width:800px){:host{top:34px;right:12px}#badge{max-width:calc(100vw - 24px)}#panel{width:400px}}
  </style>

  <!-- 顶部胶囊 1: 会话上下文 (原汁原味) -->
  <button id="badge" aria-label="会话与上下文统计" aria-expanded="false">
    <div id="bar-wrap" class="meter-bar-track" aria-hidden="true"><div id="bar-fill" class="meter-bar-fill"></div></div>
    <span id="amount">读取中…</span>
    <span id="hover-wrap"><span id="hover-extra"></span></span>
  </button>

  <!-- 顶部胶囊 2: 全局 Token 活动 (ChatGPT 风格) -->
  <button id="badge-tokens" aria-label="账号 Token 活动统计">
    <span class="token-fire-dot"></span>
    <span id="token-amount">4.29亿</span>
    <span id="token-hover-extra">· 今日 6919W</span>
  </button>

  <!-- 顶部胶囊 3: 模型输出速度与耗时 (⚡ Speed) -->
  <button id="badge-speed" aria-label="模型输出速度与耗时统计">
    <span class="speed-icon">⚡</span>
    <span id="speed-amount">-- tok/s</span>
    <span id="speed-hover-extra"></span>
  </button>

  <!-- 弹出式主面板 -->
  <section id="panel" hidden aria-label="统计与活动详情">
    <!-- 顶栏：双视图切换与主题控制 -->
    <div class="panel-header-bar">
      <div class="panel-tabs">
        <button id="tab-nav-context" class="panel-tab-btn active">💬 当前会话上下文</button>
        <button id="tab-nav-tokens" class="panel-tab-btn">🔥 账号 Token 活动</button>
      </div>
      <div class="panel-header-actions">
        <button id="theme-toggle" class="panel-icon-btn" aria-label="切换浅色/深色主题" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）">🌓</button>
        <button id="close" class="panel-icon-btn" aria-label="收起详情">×</button>
      </div>
    </div>

    <!-- 视图 1: 原版会话上下文 -->
    <div id="view-context">
      <h3>会话与上下文统计<span id="v">v2.5</span></h3>
      <div id="key-summary">
        <div class="key-header"><span class="key-title">⭐ 核心用量速览（看这一项就够）</span><span id="key-badge" class="key-pill pill-muted">读取中</span></div>
        <div class="key-bar-track"><div id="key-bar-fill" class="key-bar-fill"></div></div>
        <div class="key-stats"><div class="key-stat"><div class="key-stat-label">当前已用</div><div id="key-used" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label">预算上限</div><div id="key-limit" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label">剩余可用</div><div id="key-remaining" class="key-stat-val">—</div></div></div>
        <div id="key-takeaway" class="key-takeaway">正在计算核心指标…</div>
      </div>
      <!-- ⚡ 最新生成速度与耗时速览卡片 -->
      <div id="speed-summary" style="background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:12px 13px;margin:8px 0 12px;">
        <div class="key-header">
          <span class="key-title" style="color:var(--ag-text-speed);">⚡ 最新生成速度与耗时速览</span>
          <span id="speed-badge" class="key-pill pill-muted">待生成</span>
        </div>
        <div class="key-stats" style="grid-template-columns:repeat(4,1fr);">
          <div class="key-stat">
            <div class="key-stat-label">输出速度</div>
            <div id="speed-val" class="key-stat-val" style="color:var(--ag-text-speed);">—</div>
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
      <p id="status">正在核对请求和附件…</p><p id="model"></p>
      <h4>最近一次模型请求</h4>
      <dl><dt>请求状态</dt><dd id="request-status">—</dd><dt>模型返回输入＋输出</dt><dd id="actual">—</dd><dt>客户端估算（可能漏附件）</dt><dd id="estimate">—</dd><dt>客户端预算字段</dt><dd id="budget">—</dd><dt>该次报错的服务端限制</dt><dd id="service-limit">—</dd><dt>相对客户端预算</dt><dd id="percent">—</dd></dl>
      <h4>整个会话累计内容 · 本地估算</h4>
      <dl><dt>可读取文本 token 估算</dt><dd id="session-total">扫描中…</dd><dt>实际读取文字字符数</dt><dd id="characters">—</dd><dt>用户消息</dt><dd id="user">—</dd><dt>模型回复</dt><dd id="assistant">—</dd><dt>可见思考内容</dt><dd id="thinking">—</dd><dt>工具调用与工具输出</dt><dd id="tools">—</dd><dt>历史压缩摘要</dt><dd id="summaries">—</dd><dt>当前系统提示与工具定义</dt><dd id="system">—</dd><dt>上传／输出附件文本</dt><dd id="attachment-total">—</dd><dt>历史步骤完整性</dt><dd id="steps">—</dd></dl>
      <p id="coverage"></p><h4>附件逐项检查</h4><div id="files"></div><button id="refresh">重新扫描整段会话与附件</button>
      <p id="note">会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。</p>
      <p id="updated"></p>
    </div>

    <!-- 视图 2: 🔥 账号 Token 活动 -->
    <div id="view-tokens" style="display:none">
      <!-- 4 大核心统计看板 -->
      <div class="token-stat-cards">
        <div class="t-card">
          <div class="t-card-lbl"><span>账号累计总消耗</span><span style="color:var(--ag-tab-active-purple-text)">全量</span></div>
          <div class="t-card-val" id="t-total-val">4.29 亿</div>
          <div class="t-card-sub" id="t-total-sub">428,514,452 个 Token</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>今日使用</span><span style="color:#0284c7">Today</span></div>
          <div class="t-card-val" id="t-today-val">6918.9 万</div>
          <div class="t-card-sub" id="t-today-sub">38会话实时累加</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>本月使用 (10月)</span><span style="color:var(--ag-tab-active-purple-text)">当月</span></div>
          <div class="t-card-val" id="t-month-val">4.29 亿</div>
          <div class="t-card-sub" id="t-month-sub">日均约 6121.6万</div>
        </div>
        <div class="t-card">
          <div class="t-card-lbl"><span>整年使用 (2026)</span><span style="color:var(--ag-tab-active-purple-text)">年度</span></div>
          <div class="t-card-val" id="t-year-val">4.29 亿</div>
          <div class="t-card-sub" id="t-year-sub">365天活动连续记录</div>
        </div>
      </div>

      <!-- ChatGPT 同款 7x52 热力图 -->
      <div class="heatmap-section">
        <div class="heat-header">
          <div class="heat-title">Token 活动</div>
          <div class="heat-tabs">
            <button class="heat-tab-btn active" id="h-tab-daily">每天</button>
            <button class="heat-tab-btn" id="h-tab-weekly">每周</button>
            <button class="heat-tab-btn" id="h-tab-cum">累计总量</button>
          </div>
        </div>
        <div class="heat-scroll-box">
          <!-- 每天视图 -->
          <div id="h-daily-box">
            <div class="heat-grid-cols" id="h-grid-cols"></div>
            <div class="heat-months" id="h-months"></div>
          </div>
          <!-- 每周视图 -->
          <div id="h-weekly-box"></div>
          <!-- 累计总量视图 -->
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

  <!-- 浮动 Tooltip -->
  <div class="heat-popover" id="heat-pop">
    <div class="pop-date" id="heat-pop-date">10月24日</div>
    <div class="pop-val" id="heat-pop-val">2.47亿 个 Token</div>
    <div class="pop-det" id="heat-pop-det"></div>
  </div>`;

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => v >= 1e6 ? `${parseFloat((v / 1e6).toFixed(2))}M` : v >= 1000 ? `${parseFloat((v / 1000).toFixed(1))}K` : fmt(v);
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? '未提供' : `${fmt(value)} tokens`;
  const state = { route: null, count: 0, latest: null, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0, scanError: '', scan: null, generation: 0, controllers: new Set(), disposed: false };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;

  // --- 🔥 视图状态（每天 / 每周 / 累计总量） ---
  let activeHeatView = 'daily';

  // --- 浅色 / 深色主题管理系统 ---
  let currentThemeMode = 'auto';
  try {
    currentThemeMode = (typeof localStorage !== 'undefined' && localStorage.getItem('ag_theme_mode')) || 'auto';
  } catch {}

  function getSystemTheme() {
    try {
      const body = document.body;
      const doc = document.documentElement;
      if (body?.classList?.contains('theme-light')) return 'light';
      if (body?.classList?.contains('theme-dark')) return 'dark';
      if (doc?.style?.colorScheme === 'light') return 'light';
      if (doc?.style?.colorScheme === 'dark') return 'dark';
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
    const btn = el('theme-toggle');
    if (btn) {
      if (currentThemeMode === 'auto') {
        btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
        btn.title = `当前主题：跟随IDE (${activeTheme === 'light' ? '浅色' : '深色'})\n点击切换为：浅色模式`;
      } else if (currentThemeMode === 'light') {
        btn.textContent = '☀️';
        btn.title = '当前主题：浅色模式 (常驻)\n点击切换为：深色模式';
      } else {
        btn.textContent = '🌙';
        btn.title = '当前主题：深色模式 (常驻)\n点击切换为：跟随IDE';
      }
    }
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
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      }
    }
  } catch {}

  applyTheme();

  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } });
    return { ...(value || {}), ...failure, model: value?.model || '', used: null, estimate: null, actual: null, percent: null };
  }

  function toggle(open, tab = 'context') {
    el('panel').hidden = !open;
    el('badge').setAttribute('aria-expanded', String(open));
    el('badge-tokens')?.setAttribute('aria-expanded', String(open));
    el('badge-speed')?.setAttribute('aria-expanded', String(open));
    if (open) switchPanelTab(tab);
  }

  function switchPanelTab(tab) {
    const btnContext = el('tab-nav-context');
    const btnTokens = el('tab-nav-tokens');
    const vContext = el('view-context');
    const vTokens = el('view-tokens');
    const panel = el('panel');

    if (tab === 'tokens') {
      btnContext.className = 'panel-tab-btn';
      btnTokens.className = 'panel-tab-btn active-purple';
      vContext.style.display = 'none';
      vTokens.style.display = 'flex';
      panel.classList.add('wide-mode');
      renderHeatmapGrid();
    } else {
      btnContext.className = 'panel-tab-btn active';
      btnTokens.className = 'panel-tab-btn';
      vContext.style.display = 'block';
      vTokens.style.display = 'none';
      panel.classList.remove('wide-mode');
    }
  }

  el('badge').addEventListener('click', () => toggle(el('panel').hidden, 'context'));
  el('badge-tokens').addEventListener('click', () => toggle(el('panel').hidden || el('view-tokens').style.display === 'none', 'tokens'));
  el('badge-speed')?.addEventListener('click', () => toggle(el('panel').hidden || el('view-context').style.display === 'none', 'context'));
  el('close').addEventListener('click', () => toggle(false));
  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('tab-nav-context').addEventListener('click', () => switchPanelTab('context'));
  el('tab-nav-tokens').addEventListener('click', () => switchPanelTab('tokens'));

  // --- 🔥 视图切换（每天 / 每周 / 累计总量）交互逻辑 ---
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
  const outside = e => { if (!e.composedPath().includes(host)) toggle(false); };
  const escape = e => { if (e.key === 'Escape') toggle(false); };
  document.addEventListener('click', outside); document.addEventListener('keydown', escape);

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
    if (!extra) return;
    if (extra.textContent !== text) {
      extra.textContent = text;
      const rawW = extra.getBoundingClientRect ? extra.getBoundingClientRect().width : (extra.offsetWidth || extra.scrollWidth || 0);
      const w = Math.ceil(rawW);
      host.style.setProperty('--extra-w', (text ? (w > 0 ? w + 2 : text.length * 7 + 8) : 0) + 'px');
    }
  }

  // --- 🔥 全局 Token 活动热力图逻辑 ---
  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    return n.toLocaleString();
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  // 1. 每天视图
  function renderHeatmapGrid() {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || colsBox.children.length > 0) return; // 避免重复填充

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
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} 个 Token` : '无 Token 消耗';
          if (item.rec) {
            heatPopDet.innerHTML = `<span>输入: ${fmtYi(item.rec.input)}</span><span>输出: ${fmtYi(item.rec.output)}</span><span>缓存: ${fmtYi(item.rec.cache)}</span>`;
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

  // 2. 每周视图渲染
  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.innerHTML = '';

    const isLight = host.getAttribute('data-theme') === 'light';
    const cEmpty = isLight ? '#eaeaea' : '#27272a';
    const c1 = isLight ? '#e9d5ff' : '#3f1e6b';
    const c2 = isLight ? '#c084fc' : '#652ab7';
    const c3 = isLight ? '#9333ea' : '#9053f8';
    const c4 = isLight ? '#6b21a8' : '#c084fc';

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
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} 个 Token` : '该周无消耗';
        heatPopDet.innerHTML = `<span>周累计消耗</span>`;
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

  // 3. 累计总量视图渲染 (Canvas 渐变面积图)
  function renderHeatmapCum() {
    const cvs = el('h-cum-canvas');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    const rect = cvs.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
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
    const strokeColor = isLight ? '#7c3aed' : '#c084fc';
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
      heatPopVal.textContent = `${fmtYi(pt.val)} 个 Token`;
      heatPopDet.innerHTML = `<span>截至当日全周期累计</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 10)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;
  }

  // 渲染上下文状态
  function render() {
    host.hidden = !state.route; if (!state.route) return;
    const d = state.latest, session = state.scan?.session;
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = d?.exceeded || d?.error;

    let pct = null;
    if (d?.exceeded) {
      pct = 100;
    } else if (d?.percent != null && !danger && !stale) {
      pct = Math.min(100, Math.max(0, d.percent));
    } else if (d?.used && d?.budget && !danger && !stale) {
      pct = Math.min(100, Math.max(0, (d.used / d.budget) * 100));
    }

    const barColor = danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff';
    const tone = danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff';
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

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

    el('badge').title = status + '\n' + (d?.actual != null ? `当前用量: ${fmt(d.actual)} tokens${d.budget ? ` / ${fmt(d.budget)}` : ''} (${pct != null ? pct.toFixed(1) + '%' : '未知%'})` : el('amount').textContent) + '\n' + corpus + '\n点击展开详情 · 右键快速切换浅色/深色主题';
    el('badge-tokens').title = '账号 Token 活动统计\n点击展开图表看板 · 右键快速切换浅色/深色主题';

    // 渲染胶囊 3: 模型输出速度与耗时
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedAmount = el('speed-amount');
    const speedHoverExtra = el('speed-hover-extra');
    if (speedBadge && speedAmount) {
      if (sp?.tps != null) {
        speedAmount.textContent = `${sp.tps} tok/s`;
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
        speedBadge.title = `最新模型输出速度：${sp.tps} tok/s${sp.streamingTps ? ` (流式 ${sp.streamingTps} tok/s)` : ''}\n总耗时：${sp.duration || '—'}s (首字 ${sp.ttft || '—'}s + 流式 ${sp.streamingSec || '—'}s)\n本次产出：${fmt(sp.outputTokens)} tokens (正文 ${fmt(sp.responseTokens)} + 思考 ${fmt(sp.thinkingTokens)})\n点击展开详情 · 右键快速切换浅色/深色主题`;
      } else if (state.requestBusy) {
        speedAmount.textContent = '计算中…';
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = '正在等待模型返回或计算生成指标…\n点击展开详情 · 右键快速切换浅色/深色主题';
      } else {
        speedAmount.textContent = '-- tok/s';
        if (speedHoverExtra) speedHoverExtra.textContent = ' · 待生成';
        speedBadge.title = '模型输出速度与耗时\n等待模型回复完成后记录实际 TPS 速度\n点击展开详情 · 右键快速切换浅色/深色主题';
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
      Object.assign(state, { route: id, count: 0, latest: null, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0, scanError: '', scan: null }); toggle(false); renderFiles(null); render();
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
  }

  const timer = setInterval(tick, 500);
  globalThis.__AGContextMeter = {
    version: '2.5.0',
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch {}; applyTheme(); },
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy }),
    dispose() {
      state.disposed = true;
      for (const controller of state.controllers) controller.abort();
      clearInterval(timer);
      try { themeObserver?.disconnect(); } catch {}
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      host.remove();
    }
  };
  tick();
})();
