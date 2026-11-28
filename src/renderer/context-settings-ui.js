/**
 * Context Meter 原生设置页、压缩进度页与同级「账号与额度」页 UI 模块（Shadow DOM 安全）
 *
 * 本模块统一承载宿主 Settings 左栏三个同级自定义页：
 * 1. Context Meter（设置页，对齐宿主 max-w-2xl mx-auto p-6 居中排版、透明画布卡片、胶囊控件与宿主 Accent 实时同步）
 * 2. 压缩进度（实时阶段与检查点追踪页）
 * 3. 账号与额度（页首当前账号与 Google 会员等级卡、搜索/套餐筛选/列表卡片/分页、逐账号可独立折叠 5H/7D 配额详情、页尾历史阈值规则与共享池及本机消耗对账）
 */
const {
  buildNativeSettingsPageCss,
  buildNativeSettingsPageHtml,
  initContextSettingsUI,
  renderContextSettingsUI,
  buildCompactionProgressPageHtml,
  renderCompactionProgressPage,
  buildHostAccountsPageHtml,
  initHostAccountsPage,
  renderHostAccountsPage,
  beginAccountQuotaRefreshMotion,
  completeAccountQuotaRefreshMotion,
  buildAccountQuotaBarsSpec,
  formatHumanPoolTitle
} = (function () {
  'use strict';

  function byId(root, id) {
    if (!root || !id) return null;
    if (typeof root.getElementById === 'function') {
      const hit = root.getElementById(id);
      if (hit) return hit;
    }
    if (typeof root.querySelector === 'function') {
      return root.querySelector('#' + id);
    }
    return null;
  }

  const LOCAL_EXTRA_I18N = Object.freeze({
    'zh-CN': Object.freeze({
      cliColorTitle: 'CLI 图标颜色',
      cliColorDesc: '自定义右上角终端入口图标配色，支持跟随客户端强调色、单色或调色板自选',
      cliColorAccent: '跟随强调色',
      cliColorMono: '纯白或中性单色',
      cliColorCustom: '自定义颜色',
      cliColorPickAria: '选择 CLI 图标自定义颜色',
      auxCoexistTitle: '辅助栏布局模式',
      auxCoexistDesc: '在标签页与并排布局之间切换，并与辅助栏顶栏保持同步',
      auxCoexistTab: '标签页',
      auxCoexistSplit: '并排',
      auxLayoutShortcutTitle: '布局切换快捷键',
      auxLayoutShortcutDesc: '无辅助栏时按下该组合键在标签页与并排之间切换，点击输入框后按下新组合键即可修改',
      auxLayoutShortcutReset: '恢复默认',
      auxLayoutShortcutAria: '设置布局切换全局快捷键',
      mainCapsuleTitle: '主窗五槽位胶囊',
      mainCapsuleDesc: '在主窗会话头打开 IDE 左侧显示五槽位指标胶囊，关闭后完全回到原生界面',
      sessionFourViewsTitle: '会话内四视角切换',
      sessionFourViewsDesc: '在主会话标题下方显示对话、轨迹、上下文与编队标签条，关闭后完全回到原生界面',
      profileHomeTitle: '个人 Token 用量主页',
      profileHomeDesc: '在主内容区提供独立个人用量主页与左起热力图，关闭后隐藏全部入口并彻底卸载页面'
    }),
    'zh-TW': Object.freeze({
      cliColorTitle: 'CLI 圖示顏色',
      cliColorDesc: '自訂右上角終端入口圖示配色，支援跟隨用戶端強調色、單色或調色盤自選',
      cliColorAccent: '跟隨強調色',
      cliColorMono: '純白或中性單色',
      cliColorCustom: '自訂顏色',
      cliColorPickAria: '選擇 CLI 圖示自訂顏色',
      auxCoexistTitle: '輔助欄版面模式',
      auxCoexistDesc: '在分頁與並排版面之間切換，並與輔助欄頂欄保持同步',
      auxCoexistTab: '分頁',
      auxCoexistSplit: '並排',
      auxLayoutShortcutTitle: '版面切換快捷鍵',
      auxLayoutShortcutDesc: '無輔助欄時按下此組合鍵在分頁與並排之間切換，點擊輸入框後按下新組合鍵即可修改',
      auxLayoutShortcutReset: '恢復預設',
      auxLayoutShortcutAria: '設定版面切換全域快捷鍵',
      mainCapsuleTitle: '主視窗五槽位膠囊',
      mainCapsuleDesc: '在主視窗工作階段頂部開啟 IDE 左側顯示五槽位指標膠囊，關閉後完全回到原生介面',
      sessionFourViewsTitle: '工作階段四視角切換',
      sessionFourViewsDesc: '在主工作階段標題下方顯示對話、軌跡、上下文與編隊頁籤列，關閉後完全回到原生介面',
      profileHomeTitle: '個人 Token 用量主頁',
      profileHomeDesc: '在主內容區提供獨立個人用量主頁與左起熱力圖，關閉後隱藏全部入口並徹底卸載頁面'
    }),
    en: Object.freeze({
      cliColorTitle: 'CLI icon color',
      cliColorDesc: 'Choose whether the top-right terminal icon follows accent, monochrome or a custom palette color',
      cliColorAccent: 'Follow accent',
      cliColorMono: 'Monochrome',
      cliColorCustom: 'Custom color',
      cliColorPickAria: 'Pick custom CLI icon color',
      auxCoexistTitle: 'Right panel layout mode',
      auxCoexistDesc: 'Switch between tabs and split layout in sync with the auxiliary header control',
      auxCoexistTab: 'Tabs',
      auxCoexistSplit: 'Split',
      auxLayoutShortcutTitle: 'Layout toggle shortcut',
      auxLayoutShortcutDesc: 'Press this key combo when the auxiliary bar is absent to switch between tabs and split',
      auxLayoutShortcutReset: 'Reset',
      auxLayoutShortcutAria: 'Configure global layout toggle shortcut',
      mainCapsuleTitle: 'Main window 5-slot capsule',
      mainCapsuleDesc: 'Show the 5-slot metrics capsule next to Open IDE in the session header; turn off to restore native UI',
      sessionFourViewsTitle: 'Session four-view tabs',
      sessionFourViewsDesc: 'Show Chat, Trace, Context and Squad tabs below the session header; turn off to restore native UI',
      profileHomeTitle: 'Personal Token Usage Home',
      profileHomeDesc: 'Provide a standalone Token Usage profile page with left-to-right heatmap; turn off to hide entries and unmount'
    })
  });

  function resolveLocalExtraCopy(lang) {
    var raw = String(lang || 'zh-CN');
    if (raw === 'zh-TW' || /^zh[-_](tw|hk|mo|hant)/i.test(raw)) return LOCAL_EXTRA_I18N['zh-TW'];
    if (/^en/i.test(raw)) return LOCAL_EXTRA_I18N.en;
    return LOCAL_EXTRA_I18N['zh-CN'];
  }

  function showToast(root, message) {
    var toastEl = byId(root, 'ag-ns-toast') || byId(root, 'ag-ac-toast');
    if (!toastEl || !message) return;
    toastEl.textContent = String(message);
    toastEl.classList?.remove?.('is-leaving');
    toastEl.hidden = false;
    if (toastEl._agNsTimer) clearTimeout(toastEl._agNsTimer);
    if (toastEl._agNsLeaveTimer) clearTimeout(toastEl._agNsLeaveTimer);
    toastEl._agNsLeaveTimer = setTimeout(function () {
      toastEl.classList?.add?.('is-leaving');
    }, 1320);
    toastEl._agNsTimer = setTimeout(function () {
      toastEl.hidden = true;
      toastEl.classList?.remove?.('is-leaving');
    }, 1500);
  }

  function buildNativeSettingsPageCss() {
    return `
/* =========================================================
 * Context Meter / 压缩进度 / 账号与额度 原生融合样式
 * 对齐宿主 Settings max-w-2xl mx-auto p-6，透明画布卡片与动态 Accent
 * ========================================================= */
:host {
  display: block !important;
  position: relative;
  box-sizing: border-box !important;
  width: 100% !important;
  height: 100% !important;
  max-height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  scrollbar-gutter: stable;
  background: transparent;
  color: var(--foreground, #ececef);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

:host([hidden]) {
  display: none !important;
}

:host,
:host([data-theme="dark"]),
:host([data-panel-tone="dark"]) {
  --ag-ns-bg-content: var(--background, #181818);
  --ag-ns-bg-card: transparent;
  --ag-ns-bg-card-subtle: rgba(255, 255, 255, 0.02);
  --ag-ns-bg-inset: rgba(255, 255, 255, 0.035);
  --ag-ns-bg-seg-track: var(--secondary, rgba(255, 255, 255, 0.06));
  --ag-ns-bg-seg-active: var(--card, rgba(255, 255, 255, 0.14));
  --ag-ns-bg-btn: var(--secondary, rgba(255, 255, 255, 0.07));
  --ag-ns-bg-btn-hover: rgba(255, 255, 255, 0.12);
  --ag-ns-bg-input: var(--input, rgba(255, 255, 255, 0.04));
  --ag-ns-switch-off: rgba(255, 255, 255, 0.22);
  --ag-ns-switch-off-border: rgba(255, 255, 255, 0.14);
  --ag-ns-switch-knob: #FFFFFF;
  --ag-ns-border-card: var(--border, #262626);
  --ag-ns-border-divider: var(--border, rgba(255, 255, 255, 0.08));
  --ag-ns-border-control: var(--border, rgba(255, 255, 255, 0.14));
  --ag-ns-text-primary: var(--foreground, #F4F4F4);
  --ag-ns-text-secondary: var(--secondary-foreground, #D4D4D4);
  --ag-ns-text-muted: var(--muted-foreground, #8E8E8E);
  --ag-ns-seg-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  --ag-ns-accent: var(--ag-host-accent, var(--primary, #3274f6));
  --ag-ns-accent-fg: var(--ag-host-accent-fg, #ffffff);
  --ag-ns-accent-border: var(--ag-host-accent-border, var(--ag-ns-accent));
  --ag-ns-accent-knob: var(--ag-host-accent-knob, #ffffff);
  --ag-ns-accent-text: var(--ag-host-accent-text, var(--ag-ns-accent));
  --ag-ns-accent-soft: var(--ag-ns-accent-text);
  --ag-ns-accent-ring: color-mix(in srgb, var(--ag-ns-accent-border) 28%, transparent);
  --ag-ns-accent-selected-bg: color-mix(in srgb, var(--ag-ns-accent) 16%, transparent);
  --ag-ns-dd-menu-bg: #1e1e22;
  --ag-ns-dd-menu-border: rgba(255, 255, 255, 0.14);
  --ag-ns-dd-menu-shadow: 0 16px 40px rgba(0, 0, 0, 0.62), 0 4px 12px rgba(0, 0, 0, 0.38);
  --ag-ns-dd-item-hover: rgba(255, 255, 255, 0.08);
  --ag-ns-cand-checked-bg: color-mix(in srgb, var(--ag-ns-accent) 15%, transparent);
  --ag-ns-cand-checked-border: color-mix(in srgb, var(--ag-ns-accent) 48%, transparent);
  --ag-ns-ultra-bg: #f4f4f6;
  --ag-ns-ultra-text: #141416;
  --ag-ns-danger: #EF4444;
  --ag-ns-ok: #10B981;
  --ag-ns-warn: #F59E0B;
}

:host([data-theme="light"]),
:host([data-panel-tone="light"]) {
  --ag-ns-bg-content: var(--background, #FFFFFF);
  --ag-ns-bg-card: transparent;
  --ag-ns-bg-card-subtle: rgba(0, 0, 0, 0.015);
  --ag-ns-bg-inset: rgba(0, 0, 0, 0.03);
  --ag-ns-bg-seg-track: var(--secondary, #EFEFEF);
  --ag-ns-bg-seg-active: var(--background, #FFFFFF);
  --ag-ns-bg-btn: var(--background, #FFFFFF);
  --ag-ns-bg-btn-hover: var(--muted, #F3F3F5);
  --ag-ns-bg-input: var(--background, #FFFFFF);
  --ag-ns-switch-off: #C7C7CC;
  --ag-ns-switch-off-border: #AEAEB2;
  --ag-ns-switch-knob: #FFFFFF;
  --ag-ns-border-card: var(--border, #E5E5E8);
  --ag-ns-border-divider: var(--border, #ECECF0);
  --ag-ns-border-control: var(--border, #D4D4DA);
  --ag-ns-text-primary: var(--foreground, #141416);
  --ag-ns-text-secondary: var(--secondary-foreground, #303036);
  --ag-ns-text-muted: var(--muted-foreground, #6A6A72);
  --ag-ns-seg-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04);
  --ag-ns-accent: var(--ag-host-accent, var(--primary, #3274f6));
  --ag-ns-accent-fg: var(--ag-host-accent-fg, #ffffff);
  --ag-ns-accent-border: var(--ag-host-accent-border, var(--ag-ns-accent));
  --ag-ns-accent-knob: var(--ag-host-accent-knob, #ffffff);
  --ag-ns-accent-text: var(--ag-host-accent-text, var(--ag-ns-accent));
  --ag-ns-accent-soft: var(--ag-ns-accent-text);
  --ag-ns-accent-ring: color-mix(in srgb, var(--ag-ns-accent-border) 24%, transparent);
  --ag-ns-accent-selected-bg: color-mix(in srgb, var(--ag-ns-accent) 12%, transparent);
  --ag-ns-dd-menu-bg: #FFFFFF;
  --ag-ns-dd-menu-border: rgba(0, 0, 0, 0.12);
  --ag-ns-dd-menu-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.08);
  --ag-ns-dd-item-hover: rgba(0, 0, 0, 0.05);
  --ag-ns-cand-checked-bg: color-mix(in srgb, var(--ag-ns-accent) 10%, transparent);
  --ag-ns-cand-checked-border: color-mix(in srgb, var(--ag-ns-accent) 44%, transparent);
  --ag-ns-ultra-bg: #18181b;
  --ag-ns-ultra-text: #ffffff;
  --ag-ns-danger: #DC2626;
  --ag-ns-ok: #059669;
  --ag-ns-warn: #D97706;
}

:host::-webkit-scrollbar { width: 8px; }
:host::-webkit-scrollbar-track { background: transparent; }
:host::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.28);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
:host::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.45);
  border: 2px solid transparent;
  background-clip: padding-box;
}

.ag-ns-page,
.ag-ns-page *,
.ag-ns-page *::before,
.ag-ns-page *::after {
  box-sizing: border-box;
}

/* 对齐宿主原生 Settings Browser 页：max-w-2xl (672px) 居中 + 24px 内边距 */
.ag-ns-page {
  position: relative;
  width: 100%;
  max-width: 672px;
  margin: 0 auto;
  padding: 24px 24px 56px;
  color: var(--ag-ns-text-primary);
  background: transparent;
  font-family: inherit;
}

.ag-ns-page.is-accounts-wide {
  max-width: 960px;
}
svg[hidden] {
  display: none !important;
}

.ag-ns-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0 0 20px;
}

.ag-ns-title-wrap {
  min-width: 0;
  flex: 1 1 260px;
}

.ag-ns-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.015em;
  color: var(--ag-ns-text-primary);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ag-ns-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ag-ns-text-muted);
}

.ag-ns-header-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ag-ns-group {
  position: relative;
  margin: 0 0 20px;
}

.ag-ns-group.is-dropdown-open {
  z-index: 60;
}

.ag-ns-group-title {
  margin: 0 0 8px 2px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ag-ns-text-muted);
}

.ag-ns-card {
  position: relative;
  border-radius: 12px;
  border: 1px solid var(--ag-ns-border-card);
  background: var(--ag-ns-bg-card);
  overflow: visible;
}

.ag-ns-card.is-dropdown-open {
  z-index: 60;
}

.ag-ns-row:first-child {
  border-top: none;
  border-top-left-radius: 11px;
  border-top-right-radius: 11px;
}

.ag-ns-row:last-child,
.ag-ns-collapse-body:last-child {
  border-bottom-left-radius: 11px;
  border-bottom-right-radius: 11px;
}

.ag-ns-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-top: 1px solid var(--ag-ns-border-divider);
  transition: background-color 120ms ease;
}

.ag-ns-row.is-switch-row {
  cursor: pointer;
}

.ag-ns-row.is-switch-row:hover {
  background: var(--ag-ns-bg-card-subtle);
}

.ag-ns-row.is-switch-row[data-switch-disabled="true"] {
  cursor: default;
}

.ag-ns-row.is-switch-row[data-switch-disabled="true"]:hover {
  background: transparent;
}

.ag-ns-row.is-switch-row[data-switch-disabled="true"] .ag-ns-row-title {
  opacity: 0.68;
}

.ag-ns-row-stack {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.ag-ns-row-text {
  min-width: 0;
  flex: 1 1 auto;
}

.ag-ns-row-title {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.38;
  color: var(--ag-ns-text-primary);
}

.ag-ns-row-desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ag-ns-text-muted);
  word-break: break-word;
}

.ag-ns-row-desc.is-error { color: var(--ag-ns-danger); }
.ag-ns-row-desc.is-ok { color: var(--ag-ns-ok); }

.ag-ns-control {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ag-ns-control-nowrap {
  flex-wrap: nowrap;
}

.ag-ns-control-pair {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ag-ns-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  display: block;
}

.ag-ns-chevron {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  display: block;
  transition: transform 140ms ease;
}

.ag-ns-btn[aria-expanded="true"] .ag-ns-chevron {
  transform: rotate(180deg);
}

/* 胶囊分段选择器（对齐宿主原生胶囊形态） */
.ag-ns-seg {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  padding: 2px;
  gap: 2px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-seg-track);
}

.ag-ns-seg-indicator {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 999px;
  background: var(--ag-ns-bg-seg-active);
  box-shadow: var(--ag-ns-seg-shadow);
  pointer-events: none;
  z-index: 0;
  will-change: transform, width, height;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), width 160ms cubic-bezier(0.23, 1, 0.32, 1), height 160ms cubic-bezier(0.23, 1, 0.32, 1), opacity 140ms ease;
}

.ag-ns-seg-btn {
  position: relative;
  z-index: 1;
  border: none;
  background: transparent;
  color: var(--ag-ns-text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 6px 11px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 140ms ease, background-color 140ms ease;
}

.ag-ns-seg-btn:hover { color: var(--ag-ns-text-primary); }

.ag-ns-seg-btn.is-active {
  background: var(--ag-ns-bg-seg-active);
  color: var(--ag-ns-text-primary);
  box-shadow: var(--ag-ns-seg-shadow);
}

.ag-ns-seg.has-slider .ag-ns-seg-btn.is-active {
  background: transparent;
  box-shadow: none;
}

/* #127 统一布尔开关控件：轨道 40x22、滑块 18px、热区至少 40x24、零右侧暗边/缺口、宿主 Accent 与完整交互态 */
.ag-ns-switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 40px;
  min-height: 24px;
}

/* 稳态下置空即隐藏，杜绝冗余已开启/已关闭文字与布局空位 */
.ag-ns-switch-state {
  font-size: 11.5px;
  color: var(--ag-ns-text-muted);
  white-space: nowrap;
}
.ag-ns-switch-state:empty,
.ag-ns-switch-state[hidden] {
  display: none !important;
}
.ag-ns-switch-state[data-tone="busy"] { color: var(--ag-ns-accent); }
.ag-ns-switch-state[data-tone="error"] { color: var(--ag-ns-danger); }
.ag-ns-switch-state[data-tone="warn"] { color: var(--ag-ns-warn); }

.ag-ns-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  border: 0;
  box-shadow: inset 0 0 0 1px var(--ag-ns-switch-off-border);
  background: var(--ag-ns-switch-off);
  padding: 0;
  margin: 0;
  cursor: pointer;
  flex: 0 0 auto;
  vertical-align: middle;
  transition: background-color 160ms ease, box-shadow 160ms ease, opacity 140ms ease, filter 140ms ease;
}

/* 扩展交互热区至 44x28（>= 40x24），保持视觉轨道 40x22 利落精致 */
.ag-ns-switch::before {
  content: "";
  position: absolute;
  inset: -3px -2px;
  border-radius: 999px;
}

.ag-ns-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--ag-ns-switch-knob);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transform: translateX(0);
  transition: transform 160ms cubic-bezier(0.22, 1.2, 0.36, 1), width 120ms ease, background-color 140ms ease;
}

.ag-ns-switch:hover:not(:disabled):not([aria-busy="true"]) {
  filter: brightness(1.06);
}

.ag-ns-switch:active:not(:disabled):not([aria-busy="true"])::after {
  width: 20px;
}

.ag-ns-switch.is-on,
.ag-ns-switch[aria-checked="true"] {
  background: var(--ag-ns-accent);
  box-shadow: none;
}

.ag-ns-switch.is-on::after,
.ag-ns-switch[aria-checked="true"]::after {
  transform: translateX(18px);
  background: var(--ag-ns-accent-knob);
}

.ag-ns-switch.is-on:active:not(:disabled):not([aria-busy="true"])::after,
.ag-ns-switch[aria-checked="true"]:active:not(:disabled):not([aria-busy="true"])::after {
  transform: translateX(16px);
}

.ag-ns-switch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  filter: none;
}

.ag-ns-switch[aria-busy="true"] {
  opacity: 0.62;
  cursor: wait;
}

/* 中性胶囊按钮（仅明确提交使用动态 Accent） */
.ag-ns-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  outline: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  white-space: nowrap;
  font-weight: 500;
  transition: background-color 130ms ease, border-color 130ms ease, filter 130ms ease;
}

.ag-ns-btn[hidden] { display: none !important; }
.ag-ac-eye-open[hidden],
.ag-ac-eye-closed[hidden] { display: none !important; }
.ag-ns-btn:hover { background: var(--ag-ns-bg-btn-hover); }

.ag-ns-btn.is-primary {
  background: color-mix(in srgb, var(--ag-ns-accent) 88%, #0f172a);
  border-color: var(--ag-ns-accent-border);
  color: #ffffff;
}
.ag-ns-btn.is-primary:hover { filter: brightness(0.96); }
.ag-ns-btn:active:not(:disabled) { transform: scale(0.97); }
.ag-ns-btn.is-toggle-on {
  border-color: var(--ag-ns-accent-border);
  background: color-mix(in srgb, var(--ag-ns-accent) 14%, var(--ag-ns-bg-btn));
  color: var(--ag-ns-accent-text);
}

.ag-ns-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.ag-ns-btn-danger:hover {
  color: var(--ag-ns-danger);
  border-color: var(--ag-ns-danger);
}

.ag-ns-select,
.ag-ns-input {
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-input);
  color: var(--ag-ns-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1;
  outline: none;
}

.ag-ns-select {
  cursor: pointer;
  padding-right: 22px;
}
.ag-ns-select.is-enhanced { display: none !important; }

.ag-ns-dd-wrap {
  position: relative;
  display: inline-block;
  min-width: 148px;
  max-width: 100%;
  box-sizing: border-box;
}
.ag-ns-dd-wrap[data-dd-key="autoSwitchTarget"] { min-width: 210px; }
.ag-ns-dd-wrap[data-dd-key="autoSwitchMetric"] { min-width: 168px; }
.ag-ns-dd-wrap[data-dd-key="planTier"] { min-width: 176px; }
.ag-ns-dd-wrap[data-dd-key="billingRegion"] { min-width: 152px; }
.ag-ns-dd-wrap[data-dd-key="displayCurrency"] { min-width: 96px; }
.ag-ns-dd-wrap.is-open { z-index: 200; }

.ag-ns-dd-trigger {
  width: 100%;
  min-height: 30px;
  padding: 5px 10px 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  outline: none;
  transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}

.ag-ns-dd-trigger:hover { background: var(--ag-ns-bg-btn-hover); }

.ag-ns-dd-trigger:focus-visible,
.ag-ns-dd-wrap.is-open .ag-ns-dd-trigger {
  border-color: var(--ag-ns-accent);
  box-shadow: 0 0 0 2px var(--ag-ns-accent-ring);
  background: var(--ag-ns-bg-btn);
}

.ag-ns-dd-label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  color: var(--ag-ns-text-primary);
}

.ag-ns-dd-arrow {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--ag-ns-text-muted);
  transition: transform 160ms ease, color 140ms ease;
}
.ag-ns-dd-wrap.is-open .ag-ns-dd-arrow {
  transform: rotate(180deg);
  color: var(--ag-ns-text-primary);
}

.ag-ns-dd-menu {
  display: none;
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  min-width: 100%;
  max-width: min(320px, calc(100vw - 48px));
  max-height: 260px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--ag-ns-dd-menu-bg);
  border: 1px solid var(--ag-ns-dd-menu-border);
  border-radius: 10px;
  box-shadow: var(--ag-ns-dd-menu-shadow);
  padding: 4px;
  z-index: 210;
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
  transform-origin: top center;
  pointer-events: none;
  transition: opacity 140ms ease, transform 140ms ease;
}
.ag-ns-dd-wrap.align-right .ag-ns-dd-menu { left: auto; right: 0; }
.ag-ns-dd-wrap.open-up .ag-ns-dd-menu { top: auto; bottom: calc(100% + 5px); transform-origin: bottom center; transform: translateY(4px) scale(0.98); }
.ag-ns-dd-wrap.is-open .ag-ns-dd-menu { display: block; opacity: 1; transform: none; pointer-events: auto; }
.ag-ns-dd-menu::-webkit-scrollbar { width: 5px; }
.ag-ns-dd-menu::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.32); border-radius: 999px; }

.ag-ns-dd-search-wrap {
  position: sticky;
  top: -4px;
  margin: -4px -4px 4px -4px;
  padding: 6px;
  background: var(--ag-ns-dd-menu-bg);
  border-bottom: 1px solid var(--ag-ns-border-divider);
  z-index: 2;
}
.ag-ns-dd-search-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-input);
  color: var(--ag-ns-text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
.ag-ns-dd-search-input:focus { border-color: var(--ag-ns-accent); }

.ag-ns-dd-group {
  padding: 6px 9px 3px;
  margin-top: 3px;
  border-top: 1px solid var(--ag-ns-border-divider);
  font-size: 11px;
  font-weight: 600;
  color: var(--ag-ns-text-muted);
  user-select: none;
}
.ag-ns-dd-group:first-child { margin-top: 0; border-top: none; }

.ag-ns-dd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--ag-ns-text-secondary);
  cursor: pointer;
  user-select: none;
  transition: background-color 110ms ease, color 110ms ease;
}
.ag-ns-dd-item:hover,
.ag-ns-dd-item.is-focus {
  background: var(--ag-ns-dd-item-hover);
  color: var(--ag-ns-text-primary);
}
.ag-ns-dd-item.is-selected {
  background: var(--ag-ns-accent-selected-bg);
  color: var(--ag-ns-accent);
  font-weight: 600;
}
.ag-ns-dd-item-text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ag-ns-dd-check {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ag-ns-accent);
  opacity: 0;
}
.ag-ns-dd-item.is-selected .ag-ns-dd-check { opacity: 1; }
.ag-ns-dd-empty { padding: 10px 8px; text-align: center; font-size: 12px; color: var(--ag-ns-text-muted); }

.ag-ns-input { width: 210px; }
.ag-ns-input-wide { width: 100%; max-width: 420px; flex: 1 1 220px; }
.ag-ns-input-sm { width: 82px; }
.ag-ns-input::placeholder { color: var(--ag-ns-text-muted); }

.ag-ns-input:focus,
.ag-ns-select:focus,
.ag-ns-btn:focus-visible,
.ag-ns-switch:focus-visible,
.ag-ns-seg-btn:focus-visible,
.ag-ns-color-swatch-btn:focus-visible {
  outline: 2px solid var(--ag-ns-accent);
  outline-offset: 2px;
}

.ag-ns-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-seg-track);
  color: var(--ag-ns-text-muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.ag-ns-pill[hidden] { display: none !important; }
.ag-ns-pill.is-accent,
.ag-ns-pill[data-stage="active"],
.ag-ns-pill[data-stage="latest"] {
  color: var(--ag-ns-ok);
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.12);
}
.ag-ns-pill[data-stage="downloaded"] {
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.35);
  background: rgba(56, 189, 248, 0.14);
}
.ag-ns-pill.is-warn,
.ag-ns-pill[data-stage="pending_restart"],
.ag-ns-pill[data-stage="available"] {
  color: var(--ag-ns-warn);
  border-color: rgba(245, 158, 11, 0.38);
  background: rgba(245, 158, 11, 0.14);
}
.ag-ns-pill.is-danger,
.ag-ns-pill[data-stage="error"] {
  color: var(--ag-ns-danger);
  border-color: rgba(239, 68, 68, 0.38);
  background: rgba(239, 68, 68, 0.14);
}
.ag-ns-pill.is-info {
  color: var(--ag-ns-accent);
  border-color: color-mix(in srgb, var(--ag-ns-accent) 40%, transparent);
  background: color-mix(in srgb, var(--ag-ns-accent) 14%, transparent);
}

.ag-cp-bar-track {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--ag-ns-bg-seg-track);
  border: 1px solid var(--ag-ns-border-control);
}
.ag-cp-bar-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--ag-ns-accent);
  transition: width 220ms cubic-bezier(0.23, 1, 0.32, 1);
}
.ag-cp-bar-track[data-indeterminate="true"] .ag-cp-bar-fill {
  width: 38% !important;
  animation: ag-cp-indeterminate 1.4s ease-in-out infinite;
}
@keyframes ag-cp-indeterminate {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(300%); }
}
.ag-cp-events { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--ag-ns-text-secondary); }
.ag-cp-event-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--ag-ns-bg-inset);
}

.ag-ns-inline-feedback { font-size: 12px; line-height: 1.4; color: var(--ag-ns-text-muted); }
.ag-ns-inline-feedback[data-tone="busy"] { color: var(--ag-ns-accent); }
.ag-ns-inline-feedback[data-tone="ok"] { color: var(--ag-ns-ok); }
.ag-ns-inline-feedback[data-tone="error"] { color: var(--ag-ns-danger); }

.ag-ns-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ag-ns-kv {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--ag-ns-bg-inset);
  border: 1px solid var(--ag-ns-border-divider);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ag-ns-k { font-size: 11px; color: var(--ag-ns-text-muted); }
.ag-ns-v { font-size: 12px; font-weight: 600; color: var(--ag-ns-text-primary); word-break: break-word; }

.ag-ns-cand-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ag-ns-cand-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 11px 5px 7px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-inset);
  font-size: 12px;
  font-weight: 500;
  color: var(--ag-ns-text-primary);
  cursor: pointer;
  user-select: none;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.ag-ns-cand-chip:hover { border-color: var(--ag-ns-cand-checked-border); }
.ag-ns-cand-chip.is-checked,
.ag-ns-cand-chip:has(input[type="checkbox"]:checked) {
  background: var(--ag-ns-cand-checked-bg);
  border-color: var(--ag-ns-cand-checked-border);
}
.ag-ns-cand-chip input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 28px;
  height: 16px;
  min-width: 28px;
  min-height: 16px;
  margin: 0;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-switch-off-border);
  background: var(--ag-ns-switch-off);
  flex: 0 0 auto;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease;
}
.ag-ns-cand-chip input[type="checkbox"]::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ag-ns-switch-knob);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transform: translateX(0);
  transition: transform 160ms cubic-bezier(0.22, 1.2, 0.36, 1);
}
.ag-ns-cand-chip input[type="checkbox"]:checked {
  background: var(--ag-ns-accent);
  border-color: var(--ag-ns-accent-border);
}
.ag-ns-cand-chip input[type="checkbox"]:checked::after {
  transform: translateX(12px);
  background: var(--ag-ns-accent-knob);
}
.ag-ns-cand-chip input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--ag-ns-accent-border);
  outline-offset: 2px;
}
.ag-ns-cand-active-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ag-ns-accent) 18%, transparent);
  color: var(--ag-ns-accent-text);
}

.ag-ns-collapse-body {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-card-subtle);
}
.ag-ns-collapse-body[hidden] { display: none; }

.ag-ns-color-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ag-ns-color-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-inset);
  cursor: pointer;
}
.ag-ns-color-item:hover { border-color: var(--ag-ns-border-control); }
.ag-ns-color-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ag-ns-color-name { font-size: 12px; font-weight: 500; color: var(--ag-ns-text-primary); }
.ag-ns-color-hex { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: var(--ag-ns-text-muted); }
.ag-ns-color-input { display: none !important; }
.ag-ns-color-swatch-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--swatch-color, #181818);
  cursor: pointer;
  flex: 0 0 24px;
}
.ag-ns-color-actions { margin-top: 10px; display: flex; justify-content: flex-end; }

.ag-ns-note-box {
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--ag-ns-bg-inset);
  border: 1px solid var(--ag-ns-border-divider);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ag-ns-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ag-ns-note-box[hidden] { display: none; }
.ag-ns-note-box.is-error { border-color: rgba(239, 68, 68, 0.35); color: var(--ag-ns-danger); }
.ag-ns-note-box.is-ok { border-color: rgba(16, 185, 129, 0.35); color: var(--ag-ns-ok); }

.ag-ns-toast {
  position: sticky;
  bottom: 16px;
  margin: 14px auto 0;
  width: fit-content;
  max-width: 90%;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-dd-menu-bg);
  color: var(--ag-ns-text-primary);
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
  z-index: 5;
  pointer-events: none;
  opacity: 1;
  transform: translate3d(0, 0, 0);
  transition: opacity 180ms ease, transform 180ms ease;
}
.ag-ns-toast.is-leaving { opacity: 0; transform: translate3d(0, 4px, 0); }
.ag-ns-toast[hidden] { display: none; }

/* =========================================================
 * 同级独立「账号与额度」页样式（高密度左/中/右三区 + 原生主题融合 + 退零再充能动效）
 * ========================================================= */
.ag-ac-hero-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 13px 16px;
  border-radius: 12px;
  border: 1px solid var(--ag-ns-border-card);
  background: var(--ag-ns-bg-card);
  margin-bottom: 16px;
}
.ag-ac-hero-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1 1 240px;
}
.ag-ac-avatar {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  flex: 0 0 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13.5px;
  font-weight: 700;
  color: #ffffff;
  overflow: hidden;
  user-select: none;
  position: relative;
}
.ag-ac-avatar.is-sm { width: 28px; height: 28px; flex-basis: 28px; font-size: 11.5px; }
.ag-ac-avatar.is-xs { width: 24px; height: 24px; flex-basis: 24px; font-size: 10.5px; margin-top: 1px; }
.ag-ac-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ag-ac-hero-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ag-ac-hero-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ag-ac-hero-name { font-size: 14.5px; font-weight: 600; color: var(--ag-ns-text-primary); }
.ag-ac-hero-email { font-size: 12px; color: var(--ag-ns-text-muted); word-break: break-all; }
.ag-ac-plan-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 13px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.ag-ac-plan-pill.is-ultra {
  background: var(--ag-ns-ultra-bg);
  border-color: var(--ag-ns-ultra-bg);
  color: var(--ag-ns-ultra-text);
}
.ag-ac-plan-pill.is-pro {
  background: color-mix(in srgb, var(--ag-ns-accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--ag-ns-accent-border) 48%, transparent);
  color: var(--ag-ns-accent-text);
}

.ag-ac-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  background: var(--ag-ns-bg-seg-track);
  border: 1px solid var(--ag-ns-border-control);
  color: var(--ag-ns-text-secondary);
  font-variant-numeric: tabular-nums;
}

.ag-ac-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.ag-ac-search-wrap {
  position: relative;
  flex: 1 1 190px;
  min-width: 150px;
}
.ag-ac-search-input {
  width: 100%;
  height: 32px;
  padding: 0 12px 0 30px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-input);
  color: var(--ag-ns-text-primary);
  font-size: 12.5px;
  outline: none;
}
.ag-ac-search-input:focus { border-color: var(--ag-ns-accent); box-shadow: 0 0 0 2px var(--ag-ns-accent-ring); }
.ag-ac-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--ag-ns-text-muted);
  pointer-events: none;
}

.ag-ac-filter-pills {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-seg-track);
}
.ag-ac-filter-btn {
  border: none;
  background: transparent;
  color: var(--ag-ns-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}
.ag-ac-filter-btn:hover { color: var(--ag-ns-text-primary); }
.ag-ac-filter-btn.is-active {
  background: var(--ag-ns-bg-seg-active);
  color: var(--ag-ns-text-primary);
  box-shadow: var(--ag-ns-seg-shadow);
}

/* 三区列表骨架：左区身份 | 中区双列多池配额 | 右区时间与精简图标操作 */
.ag-ac-list-header {
  display: grid;
  grid-template-columns: minmax(144px, 1.15fr) minmax(240px, 2.35fr) minmax(96px, auto);
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--ag-ns-border-divider);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ag-ns-text-muted);
}
.ag-ac-col-right-head {
  text-align: right;
}

.ag-ac-rows { display: flex; flex-direction: column; }
.ag-ac-rows.is-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
}

.ag-ac-item {
  border-top: 1px solid var(--ag-ns-border-divider);
  transition: background-color 140ms ease;
}
.ag-ac-item:first-child { border-top: none; }
.ag-ac-rows.is-cards .ag-ac-item {
  border: 1px solid var(--ag-ns-border-card);
  border-radius: 12px;
  background: var(--ag-ns-bg-card);
  overflow: visible;
  display: flex;
  flex-direction: column;
}

.ag-ac-item.is-switching > .ag-ac-item-summary {
  background: color-mix(in srgb, var(--ag-ns-accent) 12%, transparent);
}

.ag-ac-item-summary {
  display: grid;
  grid-template-columns: minmax(144px, 1.15fr) minmax(240px, 2.35fr) minmax(96px, auto);
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  background: transparent;
}
.ag-ac-item:hover > .ag-ac-item-summary {
  background: color-mix(in srgb, var(--ag-ns-text-primary) 2.5%, transparent);
}
.ag-ac-item.is-active > .ag-ac-item-summary {
  background: color-mix(in srgb, var(--ag-ns-accent) 7%, transparent);
}
.ag-ac-rows.is-cards .ag-ac-item-summary {
  grid-template-columns: 1fr;
  gap: 10px;
  padding: 12px;
  flex: 1 1 auto;
}

/* 左区：账号身份 + 真实套餐徽标 + 精简模型能力标签 */
.ag-ac-id-cell {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
}
.ag-ac-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  margin-top: 5px;
  flex: 0 0 7px;
  background: var(--ag-ns-border-control);
}
.ag-ac-status-dot.is-active { background: var(--ag-ns-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ag-ns-ok) 22%, transparent); }
.ag-ac-status-dot.is-danger { background: var(--ag-ns-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ag-ns-danger) 20%, transparent); }
.ag-ac-status-dot.is-warn { background: var(--ag-ns-warn); }

.ag-ac-id-info { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 5px; }
.ag-ac-id-email-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ag-ns-text-primary);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.ag-ac-id-email-btn:hover { text-decoration: underline; text-underline-offset: 2px; }
.ag-ac-item.is-active .ag-ac-id-email-btn {
  color: var(--ag-ns-accent-text);
}
.ag-ac-id-email-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-ac-id-subname {
  font-size: 11px;
  color: var(--ag-ns-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-ac-tag-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ag-ac-mini-tag[hidden] {
  display: none !important;
}
.ag-ac-mini-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  padding: 1.5px 6px;
  border-radius: 5px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-inset);
  color: var(--ag-ns-text-secondary);
  white-space: nowrap;
}
.ag-ac-mini-tag.is-ultra { background: var(--ag-ns-ultra-bg); color: var(--ag-ns-ultra-text); border-color: transparent; }
.ag-ac-mini-tag.is-pro { background: color-mix(in srgb, var(--ag-ns-accent) 16%, transparent); color: var(--ag-ns-accent-text); border-color: color-mix(in srgb, var(--ag-ns-accent-border) 42%, transparent); }
.ag-ac-mini-tag.is-free { background: var(--ag-ns-bg-inset); color: var(--ag-ns-text-muted); }
.ag-ac-mini-tag.is-active { background: color-mix(in srgb, var(--ag-ns-ok) 15%, transparent); color: var(--ag-ns-ok); border-color: color-mix(in srgb, var(--ag-ns-ok) 38%, transparent); }
.ag-ac-mini-tag.is-danger { background: rgba(239, 68, 68, 0.14); color: var(--ag-ns-danger); border-color: rgba(239, 68, 68, 0.36); }
.ag-ac-mini-tag.is-warn { background: rgba(245, 158, 11, 0.14); color: var(--ag-ns-warn); border-color: rgba(245, 158, 11, 0.36); }
.ag-ac-mini-tag.is-cap-argon { background: color-mix(in srgb, var(--ag-ns-accent) 14%, transparent); color: var(--ag-ns-accent-text); border-color: color-mix(in srgb, var(--ag-ns-accent-border) 36%, transparent); }
.ag-ac-mini-tag.is-cap-claude { background: rgba(245, 158, 11, 0.12); color: var(--ag-ns-warn); border-color: rgba(245, 158, 11, 0.30); }
.ag-ac-mini-tag.is-cap-gpt { background: rgba(16, 185, 129, 0.12); color: var(--ag-ns-ok); border-color: rgba(16, 185, 129, 0.30); }

/* 中区：2 列紧凑多池配额胶囊网格 + 底部细进度条 */
.ag-ac-pools-cell {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  min-width: 0;
}
.ag-ac-rows.is-cards .ag-ac-pools-cell {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.ag-ac-pool-capsule {
  position: relative;
  height: 25px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 7px 2px;
  border-radius: 7px;
  background: var(--ag-ns-bg-inset);
  border: 1px solid var(--ag-ns-border-divider);
  overflow: hidden;
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  min-width: 0;
  transition: border-color 180ms ease, background-color 180ms ease;
}
.ag-ac-pool-capsule.is-full-row {
  grid-column: 1 / -1;
}
.ag-ac-pool-capsule.is-argon {
  border-color: color-mix(in srgb, var(--ag-ns-accent) 32%, var(--ag-ns-border-divider));
  background: color-mix(in srgb, var(--ag-ns-accent) 5%, var(--ag-ns-bg-inset));
}
.ag-ac-pool-capsule.is-exhausted {
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.08);
}
.ag-ac-pool-capsule.is-recharging-wait .ag-ac-pool-track {
  animation: ag-ac-track-breathe 1.1s ease-in-out infinite;
}
@keyframes ag-ac-track-breathe {
  0%, 100% { opacity: 0.42; }
  50% { opacity: 0.9; }
}

.ag-ac-pool-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2.5px;
  background: color-mix(in srgb, var(--ag-ns-text-primary) 10%, transparent);
  overflow: hidden;
  pointer-events: none;
}
.ag-ac-pool-fill {
  height: 100%;
  width: 0%;
  border-radius: 0 2px 2px 0;
  background: var(--ag-ns-ok);
  will-change: width;
}
.ag-ac-pool-fill[data-tone="warn"] { background: var(--ag-ns-warn); }
.ag-ac-pool-fill[data-tone="danger"] { background: var(--ag-ns-danger); }
.ag-ac-pool-fill[data-tone="muted"] { background: transparent; }

.ag-ac-pool-left {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}
.ag-ac-pool-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  flex: 0 0 5px;
  background: var(--ag-ns-accent-text);
}
.ag-ac-pool-dot.is-3p { background: var(--ag-ns-warn); }
.ag-ac-pool-dot.is-argon { background: var(--ag-ns-accent-text); }
.ag-ac-pool-name {
  font-weight: 600;
  color: var(--ag-ns-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-ac-pool-reset {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
  color: var(--ag-ns-text-muted);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
.ag-ac-pool-reset.is-soon { color: var(--ag-ns-warn); }
.ag-ac-pool-pct {
  position: relative;
  z-index: 1;
  min-width: 26px;
  text-align: right;
  font-weight: 700;
  font-size: 10.5px;
  color: var(--ag-ns-ok);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}
.ag-ac-pool-pct[data-tone="warn"] { color: var(--ag-ns-warn); }
.ag-ac-pool-pct[data-tone="danger"] { color: var(--ag-ns-danger); }
.ag-ac-pool-pct[data-tone="muted"] { color: var(--ag-ns-text-muted); font-weight: 500; }

.ag-ac-pool-empty-banner {
  grid-column: 1 / -1;
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px dashed var(--ag-ns-border-control);
  background: var(--ag-ns-bg-inset);
  color: var(--ag-ns-text-muted);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ag-ac-pool-empty-banner.is-danger {
  border-style: solid;
  border-color: rgba(239, 68, 68, 0.42);
  background: rgba(239, 68, 68, 0.08);
  color: var(--ag-ns-danger);
}

/* 右区：最后使用时间 + 单行精简图标操作组 */
.ag-ac-right-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
}
.ag-ac-rows.is-cards .ag-ac-right-cell {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
  border-top: 1px solid var(--ag-ns-border-divider);
}
.ag-ac-last-cell {
  font-size: 11px;
  color: var(--ag-ns-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ag-ac-ops-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  flex-wrap: nowrap;
}
.ag-ac-icon-btn {
  width: 27px;
  height: 27px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease, transform 120ms ease;
}
.ag-ac-icon-btn:hover:not(:disabled) {
  background: var(--ag-ns-bg-btn-hover);
  color: var(--ag-ns-text-primary);
}
.ag-ac-icon-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.ag-ac-icon-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.ag-ac-icon-btn.is-active-mark {
  color: var(--ag-ns-ok);
  border-color: color-mix(in srgb, var(--ag-ns-ok) 36%, transparent);
  background: color-mix(in srgb, var(--ag-ns-ok) 10%, transparent);
  opacity: 0.88;
}
.ag-ac-icon-btn.is-danger:hover:not(:disabled) {
  color: var(--ag-ns-danger);
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.10);
}
.ag-ac-icon-btn.is-expanded {
  color: var(--ag-ns-accent-text);
  border-color: color-mix(in srgb, var(--ag-ns-accent-border) 50%, transparent);
}
.ag-ac-icon-btn.is-spinning svg,
.ag-ns-btn.is-spinning svg {
  animation: ag-ns-spin 760ms linear infinite;
}

.ag-ac-op-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ag-ac-op-btn:hover:not(:disabled) { background: var(--ag-ns-bg-btn-hover); }
.ag-ac-op-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ag-ac-op-btn.is-primary {
  background: var(--ag-ns-accent);
  border-color: var(--ag-ns-accent-border);
  color: var(--ag-ns-accent-fg);
}
.ag-ac-op-btn.is-danger {
  background: var(--ag-ns-danger);
  border-color: var(--ag-ns-danger);
  color: #ffffff;
}

/* 页内行级确认条（切号 / 移除二次确认，绝不躲在宿主弹窗底层） */
.ag-ac-inline-confirm {
  margin: 0 14px 10px;
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--ag-ns-accent) 40%, var(--ag-ns-border-control));
  background: color-mix(in srgb, var(--ag-ns-accent) 9%, var(--ag-ns-bg-inset));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.ag-ac-inline-confirm.is-danger {
  border-color: rgba(239, 68, 68, 0.44);
  background: rgba(239, 68, 68, 0.09);
}
.ag-ac-inline-confirm-text {
  font-size: 12px;
  color: var(--ag-ns-text-primary);
  line-height: 1.4;
  flex: 1 1 200px;
}
.ag-ac-inline-confirm-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.ag-ac-detail {
  padding: 12px 14px 14px;
  border-top: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-card-subtle);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ag-ac-detail[hidden] { display: none !important; }
.ag-ac-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.ag-ac-rows.is-cards .ag-ac-detail-grid {
  grid-template-columns: 1fr;
}
.ag-ac-detail-card {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-inset);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.ag-ac-detail-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--ag-ns-text-muted);
}

.ag-ac-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-top: 1px solid var(--ag-ns-border-divider);
  font-size: 11.5px;
  color: var(--ag-ns-text-muted);
}
.ag-ac-pagination[hidden] { display: none !important; }
.ag-ac-page-btns { display: inline-flex; align-items: center; gap: 6px; }

.ag-ac-details-section {
  border-radius: 12px;
  border: 1px solid var(--ag-ns-border-card);
  background: var(--ag-ns-bg-card);
  margin-bottom: 14px;
  overflow: visible;
}
.ag-ac-details-summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--ag-ns-text-primary);
  user-select: none;
}
.ag-ac-details-summary::-webkit-details-marker { display: none; }
.ag-ac-details-body {
  border-top: 1px solid var(--ag-ns-border-divider);
}

.ag-ns-btn.is-busy .ag-ns-icon { animation: ag-ns-spin 800ms linear infinite; }
@keyframes ag-ns-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .ag-ns-seg-indicator,
  .ag-ns-toast,
  .ag-ns-switch,
  .ag-ns-switch::after,
  .ag-ns-chevron,
  .ag-ns-btn.is-busy .ag-ns-icon,
  .ag-ac-icon-btn.is-spinning svg,
  .ag-ns-btn.is-spinning svg,
  .ag-ac-pool-capsule.is-recharging-wait .ag-ac-pool-track,
  .ag-ac-pool-fill {
    transition: none !important;
    animation: none !important;
  }
  .ag-cp-bar-track[data-indeterminate="true"] .ag-cp-bar-fill {
    animation: none;
    transform: none;
    width: 100% !important;
    opacity: 0.55;
  }
}

@media (max-width: 920px) {
  .ag-ac-list-header {
    grid-template-columns: minmax(150px, 1fr) minmax(240px, 1.8fr) auto;
  }
  .ag-ac-item-summary {
    grid-template-columns: minmax(150px, 1fr) minmax(240px, 1.8fr) auto;
  }
  .ag-ac-rows.is-cards,
  .ag-ac-detail-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .ag-ns-page { padding: 18px 16px 44px; }
  .ag-ns-row { flex-direction: column; align-items: flex-start; gap: 10px; }
  .ag-ns-control { width: 100%; justify-content: flex-start; flex-wrap: wrap; }
  .ag-ns-control-nowrap { flex-wrap: wrap; }
  .ag-ns-input { width: 100%; max-width: 280px; }
  .ag-ns-color-grid,
  .ag-ns-grid-2,
  .ag-ac-rows.is-cards,
  .ag-ac-detail-grid { grid-template-columns: 1fr; }
  .ag-ac-list-header { display: none; }
  .ag-ac-item-summary { grid-template-columns: 1fr; gap: 8px; }
  .ag-ac-right-cell {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}
`;
  }

  function buildNativeSettingsPageHtml() {
    return `
<section id="ag-ns-root" class="ag-ns-page" aria-label="Context Meter 设置">
  <header class="ag-ns-header">
    <div class="ag-ns-title-wrap">
      <h1 id="ag-ns-title" class="ag-ns-title">Context Meter</h1>
      <p id="ag-ns-subtitle" class="ag-ns-subtitle" data-i18n="hostSettings.subtitle">与插件共享状态 · 在此查看前后台版本、在线更新与常用开关</p>
    </div>
  </header>

  <!-- 1. 外观与主题 -->
  <div id="ag-ns-sec-appearance" class="ag-ns-group" data-section-id="ui-slim-prefs-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.appearance">外观与主题</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.themeMode.title">插件与客户端主题</div>
          <div id="ag-ns-theme-desc" class="ag-ns-row-desc" data-i18n="ns.themeMode.desc">选择浅色或深色将同步整个 Antigravity 客户端，选择跟随宿主则还原宿主控制</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="themeMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="auto" data-i18n="ns.themeMode.auto">跟随宿主</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="light" data-i18n="ns.themeMode.light">浅色</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="dark" data-i18n="ns.themeMode.dark">深色</button>
          </div>
        </div>
      </div>

      <div id="ag-ns-row-cli-icon-color" class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-cliIconColorMode" class="ag-ns-row-title">CLI 图标颜色</div>
          <div id="ag-ns-desc-cliIconColorMode" class="ag-ns-row-desc">自定义右上角终端入口图标配色，支持跟随客户端强调色、单色或调色板自选</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-cliIconColorMode" aria-describedby="ag-ns-desc-cliIconColorMode" data-ag-ns-seg="cliIconColorMode">
            <button type="button" id="ag-ns-btn-cli-color-accent" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="accent" data-value="accent">跟随强调色</button>
            <button type="button" id="ag-ns-btn-cli-color-mono" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="mono" data-value="mono">纯白或中性单色</button>
            <button type="button" id="ag-ns-btn-cli-color-custom" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="custom" data-value="custom">自定义颜色</button>
          </div>
          <div id="ag-ns-cli-custom-swatch-wrap" class="ag-ns-color-item" data-ag-ns-color-pick="cliIcon" hidden style="padding:4px 8px;min-height:30px;gap:8px;cursor:pointer;">
            <span class="ag-ns-color-hex" data-ag-ns-color-hex="cliIcon">#3274F6</span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="cliIcon" value="#3274f6" tabindex="-1" aria-hidden="true" />
            <button type="button" id="ag-ns-swatch-cliIcon" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="cliIcon" aria-label="选择 CLI 图标自定义颜色"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.colors.title">指标与背景颜色自定义</div>
          <div class="ag-ns-row-desc" data-i18n="ns.colors.desc">自定义面板背景、上下文圆环、速率与 Token 色值</div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-toggle-colors" class="ag-ns-btn" aria-expanded="false" aria-controls="ag-ns-colors-body">
            <span id="ag-ns-toggle-colors-label" data-i18n="ns.colors.expand">展开设置</span>
            <svg class="ag-ns-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="ag-ns-colors-body" class="ag-ns-collapse-body" hidden>
        <div class="ag-ns-color-grid">
          <div class="ag-ns-color-item" data-ag-ns-color-pick="panelBg">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="ns.colors.panelBg">面板背景</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="panelBg">#181818</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="panelBg" value="#181818" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="panelBg" aria-label="选择面板背景颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="ringUsed">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.ringUsed">圆环已用部分</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="ringUsed">#E6E6EB</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="ringUsed" value="#e6e6eb" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="ringUsed" aria-label="选择圆环已用颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="ringTrack">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.ringTrack">圆环轨道</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="ringTrack">#52525B</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="ringTrack" value="#52525b" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="ringTrack" aria-label="选择圆环轨道颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="contextText">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.contextText">上下文用量文字</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="contextText">#ECECEF</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="contextText" value="#ececef" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="contextText" aria-label="选择上下文文字颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="speedText">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.speedText">输出速度</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="speedText">#38BDF8</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="speedText" value="#38bdf8" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="speedText" aria-label="选择输出速度颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="tokenTotal">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.tokenTotal">累计 token 用量</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="tokenTotal">#3274F6</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="tokenTotal" value="#3274f6" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="tokenTotal" aria-label="选择累计用量颜色"></button>
          </div>
          <div class="ag-ns-color-item" data-ag-ns-color-pick="tokenAccent">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.tokenAccent">其他 token 指标</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="tokenAccent">#38BDF8</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="tokenAccent" value="#38bdf8" tabindex="-1" aria-hidden="true" />
            <button type="button" class="ag-ns-color-swatch-btn" data-ag-ns-swatch="tokenAccent" aria-label="选择其他指标颜色"></button>
          </div>
        </div>
        <div class="ag-ns-color-actions">
          <button type="button" id="ag-ns-reset-colors" class="ag-ns-btn" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 顶栏 -->
  <div id="ag-ns-sec-topbar" class="ag-ns-group" data-group-area="topbar">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.topbar">顶栏</h2>
    <div class="ag-ns-card">
      <div id="ag-ns-row-main-capsule-enabled" class="ag-ns-row is-switch-row" data-switch-row="mainCapsuleEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-mainCapsuleEnabled" class="ag-ns-row-title">主窗五槽位胶囊</div>
          <div id="ag-ns-desc-mainCapsuleEnabled" class="ag-ns-row-desc">在主窗会话头打开 IDE 左侧显示五槽位指标胶囊，关闭后完全回到原生界面</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-mainCapsuleEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="mainCapsuleEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-mainCapsuleEnabled" class="ag-ns-switch is-on" role="switch" aria-checked="true" data-ag-ns-switch="mainCapsuleEnabled" aria-labelledby="ag-ns-title-mainCapsuleEnabled" aria-describedby="ag-ns-desc-mainCapsuleEnabled"></button>
          </div>
        </div>
      </div>

      <div id="ag-ns-row-session-four-views-enabled" class="ag-ns-row is-switch-row" data-switch-row="sessionFourViewsEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-sessionFourViewsEnabled" class="ag-ns-row-title">会话内四视角切换</div>
          <div id="ag-ns-desc-sessionFourViewsEnabled" class="ag-ns-row-desc">在主会话标题下方显示对话、轨迹、上下文与编队标签条，关闭后完全回到原生界面</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-sessionFourViewsEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="sessionFourViewsEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-sessionFourViewsEnabled" class="ag-ns-switch is-on" role="switch" aria-checked="true" data-ag-ns-switch="sessionFourViewsEnabled" aria-labelledby="ag-ns-title-sessionFourViewsEnabled" aria-describedby="ag-ns-desc-sessionFourViewsEnabled"></button>
          </div>
        </div>
      </div>

      <div id="ag-ns-row-profile-home-enabled" class="ag-ns-row is-switch-row" data-switch-row="profileHomeEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-profileHomeEnabled" class="ag-ns-row-title">个人 Token 用量主页</div>
          <div id="ag-ns-desc-profileHomeEnabled" class="ag-ns-row-desc">在主内容区提供独立个人用量主页与左起热力图，关闭后隐藏全部入口并彻底卸载页面</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-profileHomeEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="profileHomeEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-profileHomeEnabled" class="ag-ns-switch is-on" role="switch" aria-checked="true" data-ag-ns-switch="profileHomeEnabled" aria-labelledby="ag-ns-title-profileHomeEnabled" aria-describedby="ag-ns-desc-profileHomeEnabled"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-topbarMode" class="ag-ns-row-title" data-i18n="ns.topbarMode.title">顶栏入口形态</div>
          <div id="ag-ns-desc-topbarMode" class="ag-ns-row-desc" data-i18n="ns.topbarMode.desc">控制顶栏常驻状态入口的展示形式</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-topbarMode" aria-describedby="ag-ns-desc-topbarMode" data-ag-ns-seg="topbarMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="full" data-i18n="settings.topbarMode.full">完整显示</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="compact" data-i18n="settings.topbarMode.compact">精简圆环</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="hidden" data-i18n="settings.topbarMode.hidden">隐藏</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="radialTopbar">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-radialTopbar" class="ag-ns-row-title" data-i18n="settings.radial.topbar.title">顶栏径向展开</div>
          <div id="ag-ns-radialTopbar-desc" class="ag-ns-row-desc" data-i18n="ns.radialTopbar.desc">点击顶栏上下文圆环原地收缩为正圆并向下展开 180° 扇形</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-radialTopbar" class="ag-ns-switch-state" data-ag-ns-sw-status="radialTopbar" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-radialTopbar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialTopbar" aria-labelledby="ag-ns-title-radialTopbar" aria-describedby="ag-ns-radialTopbar-desc"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-quotaWindowMode" class="ag-ns-row-title" data-i18n="settings.quotaBadgeMode.label">顶栏额度窗口</div>
          <div id="ag-ns-desc-quotaWindowMode" class="ag-ns-row-desc" data-i18n="settings.quotaBadgeMode.desc">支持右键或 Alt 加点击切换</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-quotaWindowMode" aria-describedby="ag-ns-desc-quotaWindowMode" data-ag-ns-seg="quotaWindowMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="auto" data-i18n="settings.quotaBadgeMode.auto">自动最紧缩</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="5h" data-i18n="settings.quotaBadgeMode.5h">5H 窗口</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="weekly" data-i18n="settings.quotaBadgeMode.weekly">7D 窗口</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="both" data-i18n="settings.quotaBadgeMode.both">5H 与 7D 双显</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-panelDockMode" class="ag-ns-row-title" data-i18n="ns.panelDockMode.title">面板显示位置</div>
          <div id="ag-ns-desc-panelDockMode" class="ag-ns-row-desc" data-i18n="ns.panelDockMode.desc">切换详情面板打开时的承载容器</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-panelDockMode" aria-describedby="ag-ns-desc-panelDockMode" data-ag-ns-seg="panelDockMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="popover" data-i18n="settings.panelDockMode.popover">顶栏浮层</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="aux" data-i18n="settings.panelDockMode.aux">右侧辅助栏</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="page" data-i18n="settings.panelDockMode.page">独立页面</button>
          </div>
        </div>
      </div>

      <div id="ag-ns-row-aux-coexist-mode" class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-auxCoexistMode" class="ag-ns-row-title">辅助栏布局模式</div>
          <div id="ag-ns-desc-auxCoexistMode" class="ag-ns-row-desc">在标签页与并排布局之间切换，并与辅助栏顶栏保持同步</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-auxCoexistMode" aria-describedby="ag-ns-desc-auxCoexistMode" data-ag-ns-seg="auxCoexistMode">
            <button type="button" id="ag-ns-btn-aux-coexist-tab" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="tab" data-value="tab">标签页</button>
            <button type="button" id="ag-ns-btn-aux-coexist-split" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="split" data-value="split">并排</button>
          </div>
        </div>
      </div>

      <div id="ag-ns-row-aux-layout-shortcut" class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-auxLayoutShortcut" class="ag-ns-row-title">布局切换快捷键</div>
          <div id="ag-ns-desc-auxLayoutShortcut" class="ag-ns-row-desc">无辅助栏时按下该组合键在标签页与并排之间切换，点击输入框后按下新组合键即可修改</div>
        </div>
        <div class="ag-ns-control ag-ns-control-nowrap">
          <input type="text" id="ag-ns-input-auxLayoutShortcut" class="ag-ns-input" readonly value="Ctrl+Alt+L" data-ag-ns-shortcut="auxLayoutShortcut" aria-labelledby="ag-ns-title-auxLayoutShortcut" aria-describedby="ag-ns-desc-auxLayoutShortcut" style="width:120px;text-align:center;font-family:monospace;cursor:pointer" />
          <button type="button" id="ag-ns-btn-reset-auxLayoutShortcut" class="ag-ns-btn" data-ag-ns-shortcut-reset="auxLayoutShortcut">恢复默认</button>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="autoHideTopbarOnDock">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-autoHideTopbarOnDock" class="ag-ns-row-title" data-i18n="ns.autoHideTopbarOnDock.title">辅助栏与独立页展开时自动隐藏顶栏入口</div>
          <div id="ag-ns-desc-autoHideTopbarOnDock" class="ag-ns-row-desc" data-i18n="ns.autoHideTopbarOnDock.desc">展开停靠面板时自动收起顶栏冗余入口</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-autoHideTopbarOnDock" class="ag-ns-switch-state" data-ag-ns-sw-status="autoHideTopbarOnDock" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-autoHideTopbarOnDock" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoHideTopbarOnDock" aria-labelledby="ag-ns-title-autoHideTopbarOnDock" aria-describedby="ag-ns-desc-autoHideTopbarOnDock"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row" id="ag-ns-row-quick-actions">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.quickActions.title">当前会话快捷操作条</div>
          <div id="ag-ns-dock-feedback" class="ag-ns-row-desc" data-i18n="settings.quickActions.desc">一行完成打开、复制与跳转</div>
        </div>
        <div class="ag-ns-control ag-ns-control-nowrap">
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openRight" data-i18n="settings.dock.openRightBtn">在右侧打开</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openPage" data-i18n="settings.dock.fbPage">独立页面</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="copyUrl" data-i18n="settings.dock.fbCopyUrl">复制链接</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openExternal" data-i18n="settings.dock.openExternalBtn">外部浏览器</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. 底栏 -->
  <div id="ag-ns-sec-bottombar" class="ag-ns-group" data-group-area="bottombar">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.bottombar">底栏</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row is-switch-row" data-switch-row="showComposerBar">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-showComposerBar" class="ag-ns-row-title" data-i18n="ns.showComposerBar.title">底栏状态条</div>
          <div id="ag-ns-desc-showComposerBar" class="ag-ns-row-desc" data-i18n="ns.showComposerBar.desc">在输入框底部展示当前上下文、速率、缓存命中与额度摘要</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-showComposerBar" class="ag-ns-switch-state" data-ag-ns-sw-status="showComposerBar" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-showComposerBar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="showComposerBar" aria-labelledby="ag-ns-title-showComposerBar" aria-describedby="ag-ns-desc-showComposerBar"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="radialBottombar">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-radialBottombar" class="ag-ns-row-title" data-i18n="settings.radial.bottombar.title">底栏径向展开</div>
          <div id="ag-ns-radialBottombar-desc" class="ag-ns-row-desc" data-i18n="ns.radialBottombar.desc">点击底栏上下文入口原地收缩为正圆并向上展开 180° 扇形</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-radialBottombar" class="ag-ns-switch-state" data-ag-ns-sw-status="radialBottombar" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-radialBottombar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialBottombar" aria-labelledby="ag-ns-title-radialBottombar" aria-describedby="ag-ns-radialBottombar-desc"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 4. 悬浮圆环 -->
  <div id="ag-ns-sec-floating" class="ag-ns-group" data-group-area="floating">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.floating">悬浮圆环</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row is-switch-row" data-switch-row="radialOrb">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-radialOrb" class="ag-ns-row-title" data-i18n="settings.radial.orb.title">悬浮圆环</div>
          <div id="ag-ns-desc-radialOrb" class="ag-ns-row-desc" data-i18n="ns.radialOrb.desc">窗口顶层可拖拽悬浮球，点击展开 360° 六瓣花环</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-radialOrb" class="ag-ns-switch-state" data-ag-ns-sw-status="radialOrb" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-radialOrb" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialOrb" aria-labelledby="ag-ns-title-radialOrb" aria-describedby="ag-ns-desc-radialOrb"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 5. 统计显示 -->
  <div id="ag-ns-sec-interaction" class="ag-ns-group" data-section-id="ctx-prefs-group-display" data-group-area="stats">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.stats">统计显示</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row is-switch-row" data-switch-row="showTurnFooter">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-showTurnFooter" class="ag-ns-row-title" data-i18n="settings.turnFooter.label">每轮回复尾部统计</div>
          <div id="ag-ns-desc-showTurnFooter" class="ag-ns-row-desc" data-i18n="ns.turnFooter.desc">在助手回复操作栏末尾显示本轮模型、用量与耗时微标</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-showTurnFooter" class="ag-ns-switch-state" data-ag-ns-sw-status="showTurnFooter" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-showTurnFooter" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="showTurnFooter" aria-labelledby="ag-ns-title-showTurnFooter" aria-describedby="ag-ns-desc-showTurnFooter"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-speedDisplayMode" class="ag-ns-row-title" data-i18n="ns.speedMode.title">实时速度显示口径</div>
          <div id="ag-ns-desc-speedDisplayMode" class="ag-ns-row-desc" data-i18n="ns.speedMode.desc">切换顶栏、当前会话与回复尾标的速率口径，独立速度对比页口径保持不变</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-speedDisplayMode" aria-describedby="ag-ns-desc-speedDisplayMode" data-ag-ns-seg="speedDisplayMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="streaming" data-i18n="ns.speedMode.streaming">累计流式</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="e2e" data-i18n="ns.speedMode.e2e">端到端</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-barFontScale" class="ag-ns-row-title" data-i18n="ns.barFontScale.title">底栏与回复尾标字号</div>
          <div id="ag-ns-desc-barFontScale" class="ag-ns-row-desc" data-i18n="ns.barFontScale.desc">调节底栏状态条与助手回复尾部统计的字号档位</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-barFontScale" aria-describedby="ag-ns-desc-barFontScale" data-ag-ns-seg="barFontScale">
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="compact" data-i18n="ns.barFontScale.compact">紧凑</button>
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="standard" data-i18n="ns.barFontScale.standard">标准</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="large" data-i18n="ns.barFontScale.large">放大</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-footerContrast" class="ag-ns-row-title" data-i18n="ns.footerContrast.title">回复尾标对比度</div>
          <div id="ag-ns-desc-footerContrast" class="ag-ns-row-desc" data-i18n="ns.footerContrast.desc">浅色高分屏下可切换增强对比度以提升可读性</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" aria-labelledby="ag-ns-title-footerContrast" aria-describedby="ag-ns-desc-footerContrast" data-ag-ns-seg="footerContrast">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="standard" data-i18n="ns.footerContrast.standard">标准</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="high" data-i18n="ns.footerContrast.high">增强</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.shortcuts.title">账号与数据面板直达</div>
          <div class="ag-ns-row-desc" data-i18n="ns.shortcuts.desc">账号与规则已迁移至左侧同级账号与额度页，额度看板与历史用量可由此快速打开</div>
        </div>
        <div class="ag-ns-control">
          <button id="ag-hs-btn-open-accounts" class="ag-ns-btn" type="button" data-ag-ns-action="openAccountsTab" data-i18n="accountsPage.navLabel">账号与额度</button>
          <button id="ag-hs-btn-open-quota" class="ag-ns-btn" type="button" data-ag-ns-action="openQuotaBoard" data-i18n="hostSettings.btn.quota">模型额度看板</button>
          <button id="ag-hs-btn-open-tokens" class="ag-ns-btn" type="button" data-ag-ns-action="openTokensBoard" data-i18n="hostSettings.btn.tokens">已记录用量</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 6. 实验功能 · 额外消耗额度 -->
  <div id="ag-ns-sec-experimental" class="ag-ns-group" data-group-area="experimental">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.experimental">实验功能 · 额外消耗额度</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row is-switch-row" data-switch-row="nextPromptEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-nextPromptEnabled" class="ag-ns-row-title" data-i18n="settings.nextPrompt.label">下一句预测建议</div>
          <div id="ag-ns-desc-nextPromptEnabled" class="ag-ns-row-desc" data-i18n="ns.nextPrompt.desc">默认关闭 · 开启后每轮结束会调用当前账号模型并消耗额外额度，按 Tab 填入草稿</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-nextPromptEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="nextPromptEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-nextPromptEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="nextPromptEnabled" aria-labelledby="ag-ns-title-nextPromptEnabled" aria-describedby="ag-ns-desc-nextPromptEnabled"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 5. 客户端界面语言与品牌 -->
  <div id="ag-ns-sec-i18n" class="ag-ns-group" data-section-id="client-brand-lang-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.i18n">客户端界面语言与品牌</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div class="ag-ns-row-title" data-i18n="ns.clientLang.title">Antigravity 客户端界面语言</div>
            <div id="ag-ns-i18n-desc" class="ag-ns-row-desc" data-i18n="settings.clientLang.detecting">正在检测桌面端汉化运行状态…</div>
          </div>
          <span id="ag-ns-i18n-badge" class="ag-ns-pill">当前是英语客户端</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="clientLanguage">
            <button type="button" id="ag-ns-btn-client-zh" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="zh-CN">简体中文</button>
            <button type="button" id="ag-ns-btn-client-en" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="en">English</button>
          </div>
          <button type="button" id="ag-ns-btn-apply-client-lang" class="ag-ns-btn is-primary" data-ag-ns-action="applyClientLang" data-i18n="settings.clientLang.applyRestart">应用并重启</button>
        </div>
        <div id="ag-ns-client-lang-feedback" class="ag-ns-note-box" hidden></div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.brand.title">左上角品牌文字显示</div>
          <div id="ag-ns-brand-desc" class="ag-ns-row-desc" data-i18n="ns.brand.desc">仅作用于宿主左上角品牌位，不影响插件面板语言</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="brandTitle">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="english" data-i18n="enhance.brand.english">Antigravity</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="hidden" data-i18n="enhance.brand.hidden">隐藏</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="translated" data-i18n="enhance.brand.translated">反重力</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.panelLang.title">插件面板语言</div>
          <div class="ag-ns-row-desc" data-i18n="ns.panelLang.desc">仅控制 Context Meter 面板与设置语言，不随宿主界面切换</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="panelLanguage">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="zh-CN">简体中文</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="zh-TW">繁體中文</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="en">English</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 6. 压缩恢复与回答规则 -->
  <div id="ag-ns-sec-enhance" class="ag-ns-group" data-section-id="rehydrate-hook-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.enhance">压缩恢复与回答规则</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div class="ag-ns-row-title" data-i18n="rehydrate.card.title">改善 AGY 有损压缩</div>
            <div class="ag-ns-row-desc" data-i18n="ns.rehydrate.desc">压缩后自动从本地记录把最初要求、最近原话与刚改文件补回给 AI</div>
          </div>
          <span id="ag-ns-rehydrate-badge" class="ag-ns-pill" data-i18n="settings.common.reading">读取中…</span>
        </div>
        <div class="ag-ns-grid-2">
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="rehydrate.stat.hook">当前状态</span>
            <span id="ag-ns-rehydrate-hook" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="rehydrate.stat.python">Python 运行环境</span>
            <span id="ag-ns-rehydrate-python" class="ag-ns-v">--</span>
          </div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-btn-rehydrate-install-py" class="ag-ns-btn is-primary" hidden data-ag-ns-action="rehydrateInstallPython" data-i18n="rehydrate.btn.installPython">一键安装 Python 3.12</button>
          <button type="button" id="ag-ns-btn-rehydrate-enable" class="ag-ns-btn" data-ag-ns-action="rehydrateEnable" data-i18n="rehydrate.btn.enable">开启</button>
          <button type="button" id="ag-ns-btn-rehydrate-disable" class="ag-ns-btn" data-ag-ns-action="rehydrateDisable" data-i18n="rehydrate.btn.disable">停用</button>
          <button type="button" id="ag-ns-btn-rehydrate-refresh" class="ag-ns-btn" data-ag-ns-action="rehydrateRefresh" data-i18n="models.btn.refreshStatus">刷新状态</button>
          <button type="button" id="ag-ns-btn-open-compact-progress" class="ag-ns-btn" data-ag-ns-action="openCompactionProgress" data-i18n="compactProgress.btnOpen">查看压缩进度</button>
        </div>
        <div id="ag-ns-rehydrate-feedback" class="ag-ns-inline-feedback" role="status" aria-live="polite"></div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="autoCompactEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-autoCompactEnabled" class="ag-ns-row-title" data-i18n="ns.autoCompact.title">达到阈值时自动发送压缩命令</div>
          <div id="ag-ns-autocompact-desc" class="ag-ns-row-desc" data-i18n="ns.autoCompact.desc">默认关闭 · 独立于压缩后恢复，停用上方恢复卡时会同步关闭此开关</div>
        </div>
        <div class="ag-ns-control ag-ns-control-pair">
          <input id="ag-ns-inp-autoCompactThreshold" class="ag-ns-input ag-ns-input-sm" type="number" min="50" max="99" value="85" data-ag-ns-input="autoCompactThreshold" aria-label="自动压缩阈值百分比" />
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-autoCompactEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="autoCompactEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-autoCompactEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoCompactEnabled" aria-labelledby="ag-ns-title-autoCompactEnabled" aria-describedby="ag-ns-autocompact-desc"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div class="ag-ns-row-title" data-i18n="enhance.prompt.title">回答与工具使用规则</div>
            <div id="ag-ns-enhance-desc" class="ag-ns-row-desc" data-i18n="ns.enhance.desc">调整语言服务提示模板档位并支持恢复官方默认</div>
          </div>
          <span id="ag-ns-enhance-badge" class="ag-ns-pill" data-i18n="settings.common.reading">读取中…</span>
        </div>
        <div class="ag-ns-control" style="justify-content:space-between;width:100%">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="enhancePromptTier">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="0">0 · <span data-i18n="enhance.tier.0.short">原版</span></button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="1">1 · <span data-i18n="enhance.tier.1.short">基础</span></button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="2">2 · <span data-i18n="enhance.tier.2.short">精简</span></button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="3">3 · <span data-i18n="enhance.tier.3.short">深度</span></button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="4">4 · <span data-i18n="enhance.tier.4.short">极简</span></button>
          </div>
          <div class="ag-ns-control">
            <button type="button" class="ag-ns-btn is-primary" data-ag-ns-action="enhanceApply" data-i18n="enhance.btn.applyPrompt">应用提示词与标题设置</button>
            <button type="button" class="ag-ns-btn ag-ns-btn-danger" data-ag-ns-action="enhanceRestoreAll" data-i18n="enhance.restoreAll.btn">全部恢复官方默认</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="enhanceChineseTitle">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-enhanceChineseTitle" class="ag-ns-row-title" data-i18n="enhance.titlePatch.label">自动生成简体中文会话标题</div>
          <div id="ag-ns-desc-enhanceChineseTitle" class="ag-ns-row-desc" data-i18n="ns.enhanceTitle.desc">等长替换会话命名提示词，支持随时恢复英文</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-enhanceChineseTitle" class="ag-ns-switch-state" data-ag-ns-sw-status="enhanceChineseTitle" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-enhanceChineseTitle" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="enhanceChineseTitle" aria-labelledby="ag-ns-title-enhanceChineseTitle" aria-describedby="ag-ns-desc-enhanceChineseTitle"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 7. 免 TUN 代理与网络 -->
  <div id="ag-ns-sec-proxy" class="ag-ns-group" data-section-id="proxy-notun-drawer">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.proxy">免 TUN 代理与网络</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row is-switch-row" data-switch-row="proxyEnabled">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-proxyEnabled" class="ag-ns-row-title" data-i18n="ns.proxyEnabled.title">启用本地免 TUN 代理</div>
          <div id="ag-ns-proxy-desc" class="ag-ns-row-desc" data-i18n="ns.proxyEnabled.desc">无需开启系统级虚拟网卡即可接管模型请求</div>
        </div>
        <div class="ag-ns-control">
          <span id="ag-ns-proxy-badge" class="ag-ns-pill" hidden></span>
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-proxyEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="proxyEnabled" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-proxyEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="proxyEnabled" aria-labelledby="ag-ns-title-proxyEnabled" aria-describedby="ag-ns-proxy-desc"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.proxyUrl.title">代理地址</div>
          <div class="ag-ns-row-desc" data-i18n="ns.proxyUrl.desc">填写本地 HTTP 或 SOCKS5 代理端口</div>
        </div>
        <div class="ag-ns-control ag-ns-control-pair">
          <input type="text" id="ag-ns-input-proxyUrl" class="ag-ns-input" data-ag-ns-input="proxyUrl" placeholder="http://127.0.0.1:7897" autocomplete="off" spellcheck="false" />
          <button type="button" id="ag-ns-btn-test-proxy" class="ag-ns-btn" data-ag-ns-action="testProxy" data-i18n="ns.proxy.test">测试连通性</button>
          <button type="button" id="ag-ns-btn-apply-proxy" class="ag-ns-btn" data-ag-ns-action="applyProxy" data-i18n="ns.proxyUrl.apply">应用</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 8. 订阅与费用估算 -->
  <div id="ag-ns-sec-billing" class="ag-ns-group" data-section-id="settings-billing-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.billing">订阅与费用估算</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.planTier.title">订阅档位</div>
          <div id="ag-ns-billing-rate-desc" class="ag-ns-row-desc" data-i18n="ns.planTier.desc">用于计算月度额度与单次会话成本参考</div>
        </div>
        <div class="ag-ns-control">
          <select id="ag-ns-sel-planTier" class="ag-ns-select" data-ag-ns-select="planTier">
            <option value="auto" data-i18n="plan.tier.auto">✨ 自动检测</option>
            <option value="free" data-i18n="plan.tier.free">免费版</option>
            <option value="plus" data-i18n="plan.tier.plus">Google AI Plus</option>
            <option value="pro" data-i18n="plan.tier.pro">Google AI Pro</option>
            <option value="ultra_5x" data-i18n="plan.tier.ultra5x">Google AI Ultra 5x</option>
            <option value="ultra_20x" data-i18n="plan.tier.ultra20x">Google AI Ultra 20x</option>
            <option value="ultra" data-i18n="plan.tier.ultra">Google AI Ultra</option>
          </select>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.billingRegion.title">账单地区与显示货币</div>
          <div class="ag-ns-row-desc" data-i18n="ns.billingRegion.desc">按所选地区参考定价与汇率折算估算金额</div>
        </div>
        <div class="ag-ns-control ag-ns-control-pair">
          <select id="ag-ns-sel-billingRegion" class="ag-ns-select" data-ag-ns-select="billingRegion">
            <option value="未知" data-i18n="plan.region.unknown">未知</option>
            <option value="US">US 美国</option>
            <option value="JP">JP 日本</option>
            <option value="HK">HK 中国香港</option>
            <option value="TW">TW 中国台湾</option>
            <option value="KR">KR 韩国</option>
            <option value="SG">SG 新加坡</option>
            <option value="GB">UK 英国</option>
            <option value="EU">EU 欧洲</option>
            <option value="TR">TR 土耳其</option>
            <option value="IN">IN 印度</option>
            <option value="BR">BR 巴西</option>
            <option value="CN">CN 中国大陆</option>
          </select>
          <select id="ag-ns-sel-displayCurrency" class="ag-ns-select" data-ag-ns-select="displayCurrency">
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
            <option value="HKD">HKD</option>
            <option value="TWD">TWD</option>
            <option value="JPY">JPY</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- 9. 版本更新与宿主路径 -->
  <div id="ag-ns-sec-update" class="ag-ns-group" data-section-id="settings-about-update-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.update">版本更新与宿主路径</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div id="ag-hs-sec-version" class="ag-ns-row-title" data-i18n="hostSettings.sec.version">插件版本与运行状态</div>
            <div id="ag-ns-update-meta" class="ag-ns-row-desc">Stable · --</div>
          </div>
          <span id="ag-hs-update-stage-pill" class="ag-ns-pill" data-stage="idle">未检查</span>
        </div>
        <div class="ag-ns-grid-2">
          <div class="ag-ns-kv">
            <span id="ag-hs-lbl-frontend" class="ag-ns-k" data-i18n="hostSettings.lbl.frontend">前端界面版本</span>
            <span id="ag-hs-val-frontend" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span id="ag-hs-lbl-backend" class="ag-ns-k" data-i18n="hostSettings.lbl.backend">后台采集版本</span>
            <span id="ag-hs-val-backend" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span id="ag-hs-lbl-bridge" class="ag-ns-k" data-i18n="hostSettings.lbl.bridge">通信通道</span>
            <span id="ag-hs-val-bridge" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span id="ag-hs-lbl-target" class="ag-ns-k" data-i18n="hostSettings.lbl.target">目标版本</span>
            <span id="ag-hs-val-target" class="ag-ns-v">--</span>
          </div>
        </div>
        <div id="ag-hs-update-detail" class="ag-ns-note-box"></div>
        <div class="ag-ns-control">
          <button type="button" id="ag-hs-btn-check-update" class="ag-ns-btn" data-ag-ns-action="checkUpdate" data-i18n="hostSettings.btn.check">检查更新</button>
          <button type="button" id="ag-hs-btn-apply-update" class="ag-ns-btn is-primary" hidden data-ag-ns-action="applyUpdate" data-i18n="update.applyNow">立即下载更新</button>
          <button type="button" id="ag-hs-btn-restart-host" class="ag-ns-btn is-primary" hidden data-ag-ns-action="restartHost" data-i18n="update.restartBtn">重启客户端生效</button>
          <button type="button" id="ag-hs-btn-verify-runtime" class="ag-ns-btn" data-ag-ns-action="verifyRuntime" data-i18n="hostSettings.btn.verify">校验运行态</button>
          <button type="button" id="ag-hs-btn-release-page" class="ag-ns-btn" data-ag-ns-action="openReleasePage" data-i18n="update.viewRelease">查看更新日志</button>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="autoCheckUpdate">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-autoCheckUpdate" class="ag-ns-row-title" data-i18n="ns.autoCheckUpdate.title">启动时自动检查更新但不自动安装</div>
          <div id="ag-ns-desc-autoCheckUpdate" class="ag-ns-row-desc" data-i18n="ns.autoCheckUpdate.desc">发现新版本时仅在界面内提示</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-autoCheckUpdate" class="ag-ns-switch-state" data-ag-ns-sw-status="autoCheckUpdate" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-autoCheckUpdate" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoCheckUpdate" aria-labelledby="ag-ns-title-autoCheckUpdate" aria-describedby="ag-ns-desc-autoCheckUpdate"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row is-switch-row" data-switch-row="betaChannel">
        <div class="ag-ns-row-text">
          <div id="ag-ns-title-betaChannel" class="ag-ns-row-title" data-i18n="hostSettings.beta.label">接收预发布测试版本</div>
          <div id="ag-ns-desc-betaChannel" class="ag-ns-row-desc" data-i18n="hostSettings.beta.desc">开启后检查更新可获取 Beta 通道版本</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span id="ag-ns-status-betaChannel" class="ag-ns-switch-state" data-ag-ns-sw-status="betaChannel" aria-live="polite" hidden></span>
            <button type="button" id="ag-ns-sw-betaChannel" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="betaChannel" aria-labelledby="ag-ns-title-betaChannel" aria-describedby="ag-ns-desc-betaChannel"></button>
          </div>
        </div>
      </div>

      <!-- 自定义 Antigravity 安装路径（Issue #109 / #116 / #113） -->
      <div class="ag-ns-row ag-ns-row-stack" id="ag-ns-row-install-path">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div class="ag-ns-row-title" data-i18n="ns.installPath.title">Antigravity 实际安装路径</div>
            <div id="ag-ns-install-path-desc" class="ag-ns-row-desc" data-i18n="ns.installPath.desc">支持非默认盘安装目录或 resources/app.asar 路径，留空时自动探测</div>
          </div>
          <span id="ag-ns-install-path-badge" class="ag-ns-pill" hidden></span>
        </div>
        <div id="ag-ns-install-path-detected" class="ag-ns-note-box"></div>
        <div class="ag-ns-control" style="width:100%">
          <input type="text" id="ag-ns-input-hostInstallPath" class="ag-ns-input ag-ns-input-wide" data-ag-ns-input="hostInstallPath" placeholder="F:\\Apps\\Antigravity" autocomplete="off" spellcheck="false" />
          <button type="button" id="ag-ns-btn-browse-install-path" class="ag-ns-btn" data-ag-ns-action="browseHostInstallPath" data-i18n="ns.installPath.browse">选择路径</button>
          <button type="button" id="ag-ns-btn-save-install-path" class="ag-ns-btn is-primary" data-ag-ns-action="saveHostInstallPath" data-i18n="ns.installPath.save">保存路径</button>
          <button type="button" id="ag-ns-btn-clear-install-path" class="ag-ns-btn" data-ag-ns-action="clearHostInstallPath" data-i18n="ns.installPath.clear">恢复自动探测</button>
        </div>
        <div id="ag-ns-install-path-feedback" class="ag-ns-note-box" hidden></div>
      </div>

      <div class="ag-ns-row ag-ns-row-stack is-switch-row" id="ag-ns-row-host-guard" data-switch-row="hostGuardEnabled">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div id="ag-ns-title-hostGuardEnabled" class="ag-ns-row-title" data-i18n="ns.hostGuard.title">宿主更新后自动恢复</div>
            <div id="ag-ns-host-guard-desc" class="ag-ns-row-desc" data-i18n="ns.hostGuard.desc">开启后常驻监听宿主覆盖并在安全时机自动恢复已启用模块</div>
          </div>
          <div class="ag-ns-control">
            <span id="ag-ns-host-guard-badge" class="ag-ns-pill" hidden></span>
            <div class="ag-ns-switch-wrap">
              <span id="ag-ns-status-hostGuardEnabled" class="ag-ns-switch-state" data-ag-ns-sw-status="hostGuardEnabled" aria-live="polite" hidden></span>
              <button type="button" id="ag-ns-sw-hostGuardEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="hostGuardEnabled" aria-labelledby="ag-ns-title-hostGuardEnabled" aria-describedby="ag-ns-host-guard-desc"></button>
            </div>
          </div>
        </div>
        <div id="ag-ns-host-guard-meta" class="ag-ns-note-box"></div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-btn-host-guard-check" class="ag-ns-btn" data-ag-ns-action="hostGuardCheck" data-i18n="ns.hostGuard.btnCheck">刷新状态</button>
          <button type="button" id="ag-ns-btn-host-guard-recover" class="ag-ns-btn is-primary" hidden data-ag-ns-action="hostGuardRecover" data-i18n="ns.hostGuard.btnRecover">立即恢复</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 10. 本地数据与诊断 -->
  <div id="ag-ns-sec-data" class="ag-ns-group" data-section-id="settings-diag-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.data">本地数据与诊断</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div id="ag-hs-sec-diag" class="ag-ns-row-title" data-i18n="hostSettings.sec.diag">诊断日志与状态导出</div>
            <div class="ag-ns-row-desc" data-i18n="ns.exportDiag.desc">用于排查采集异常或备份当前运行态信息</div>
          </div>
          <div class="ag-ns-control">
            <button type="button" id="ag-hs-btn-copy-diag" class="ag-ns-btn" data-ag-ns-action="copyDiag" data-i18n="hostSettings.btn.copyDiag">复制诊断信息</button>
            <button type="button" id="ag-ns-btn-export-diag" class="ag-ns-btn" data-ag-ns-action="exportDiag" data-i18n="ns.exportDiag.btn">导出诊断包</button>
          </div>
        </div>
        <div id="ag-hs-diag-summary" class="ag-ns-note-box"></div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.clearCache.title">清理本地统计缓存</div>
          <div id="ag-ns-cache-size-desc" class="ag-ns-row-desc">当前占用 0 KB · 清理不影响原有配置项</div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-btn-clear-cache" class="ag-ns-btn ag-ns-btn-danger" data-ag-ns-action="clearCache" data-i18n="ns.clearCache.btn">清理缓存</button>
        </div>
      </div>
    </div>
  </div>

  <div id="ag-ns-toast" class="ag-ns-toast" role="status" aria-live="polite" hidden></div>
</section>
`.trim();
  }

  function closeAllNativeDropdowns(container, exceptWrap) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    var openWraps = container.querySelectorAll('.ag-ns-dd-wrap.is-open');
    for (var i = 0; i < openWraps.length; i++) {
      var w = openWraps[i];
      if (w === exceptWrap) continue;
      w.classList?.remove?.('is-open', 'open-up', 'align-right');
      var trig = w.querySelector ? w.querySelector('.ag-ns-dd-trigger') : null;
      if (trig) trig.setAttribute?.('aria-expanded', 'false');
    }
    var raised = container.querySelectorAll('.ag-ns-card.is-dropdown-open, .ag-ns-group.is-dropdown-open, .ag-ac-details-section.is-dropdown-open');
    for (var j = 0; j < raised.length; j++) {
      if (exceptWrap && raised[j].contains && raised[j].contains(exceptWrap)) continue;
      raised[j].classList?.remove?.('is-dropdown-open');
    }
  }

  function collectNativeSelectEntries(sel) {
    var entries = [];
    if (!sel) return entries;
    var pushOpt = function (o) {
      if (!o || o.hidden || o.disabled) return;
      entries.push({
        value: String(o.value ?? ''),
        label: String(o.textContent || o.text || o.value || '').trim()
      });
    };
    var kids = sel.children ? Array.from(sel.children) : [];
    if (kids.length > 0) {
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        var tag = String(child?.tagName || '').toUpperCase();
        if (tag === 'OPTGROUP') {
          var subKids = child.children ? Array.from(child.children) : [];
          var visibleSub = [];
          for (var s = 0; s < subKids.length; s++) {
            if (subKids[s] && !subKids[s].hidden && !subKids[s].disabled) {
              visibleSub.push(subKids[s]);
            }
          }
          if (visibleSub.length > 0) {
            var gLabel = String(child.getAttribute?.('label') || child.label || '').trim();
            if (gLabel) entries.push({ isGroup: true, label: gLabel });
            for (var v = 0; v < visibleSub.length; v++) pushOpt(visibleSub[v]);
          }
        } else if (tag === 'OPTION') {
          pushOpt(child);
        }
      }
    }
    if (entries.length === 0 && sel.options) {
      var allOpts = Array.from(sel.options);
      for (var a = 0; a < allOpts.length; a++) pushOpt(allOpts[a]);
    }
    return entries;
  }

  function hasVisibleLegacyEmptyPlaceholder(sel) {
    if (!sel) return false;
    if (sel.getAttribute?.('data-legacy-placeholder') === 'true') return true;
    var opts = sel.options ? Array.from(sel.options) : [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (o && String(o.value ?? '') === '' && o.disabled && !o.hidden) {
        return true;
      }
    }
    return false;
  }

  function resolveNativeSelectLabel(sel) {
    if (!sel) return '';
    if (hasVisibleLegacyEmptyPlaceholder(sel)) {
      var opts0 = sel.options ? Array.from(sel.options) : [];
      for (var p = 0; p < opts0.length; p++) {
        if (opts0[p] && String(opts0[p].value ?? '') === '' && opts0[p].disabled && !opts0[p].hidden) {
          return String(opts0[p].textContent || opts0[p].text || '').trim();
        }
      }
    }
    var curVal = String(sel.value ?? '');
    var opts = sel.options ? Array.from(sel.options) : [];
    for (var i = 0; i < opts.length; i++) {
      if (String(opts[i].value ?? '') === curVal) {
        return String(opts[i].textContent || opts[i].text || curVal).trim();
      }
    }
    var entries = collectNativeSelectEntries(sel);
    for (var j = 0; j < entries.length; j++) {
      if (!entries[j].isGroup) return entries[j].label;
    }
    return curVal;
  }

  /**
   * 原生设置页与同级账号页自定义下拉组件（已落实 Issue #123 完整修复）：
   * 1. 稳定 menu 节点事件委托 + mousedown 阻止触发器失焦；
   * 2. 基于选项列表签名 + 过滤词缓存，展开期间后台刷新只原地更新选中态，不重建 DOM；
   * 3. 识别旧规则可见空值占位项，即使目标值与首项相同也强制走一次真实 change 进入草稿。
   */
  function enhanceNativeSelect(container, sel) {
    if (!container || !sel || sel._agNsDdCtrl) return sel?._agNsDdCtrl || null;
    var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function' || !sel.parentNode) return null;

    var key = sel.getAttribute?.('data-ag-ns-select') || sel.id || '';
    sel.classList?.add?.('is-enhanced');
    sel.setAttribute?.('aria-hidden', 'true');
    sel.setAttribute?.('tabindex', '-1');

    var wrap = doc.createElement('div');
    wrap.className = 'ag-ns-dd-wrap';
    wrap.setAttribute('data-dd-key', key);
    if (sel.id) wrap.setAttribute('data-dd-for', sel.id);

    var trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ag-ns-dd-trigger';
    if (sel.id) trigger.id = sel.id + '-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (sel.id) trigger.setAttribute('aria-controls', sel.id + '-menu');

    var labelEl = doc.createElement('span');
    labelEl.className = 'ag-ns-dd-label';

    var arrowEl = doc.createElement('span');
    arrowEl.className = 'ag-ns-dd-arrow';
    arrowEl.setAttribute('aria-hidden', 'true');
    arrowEl.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.25 6 7.75l3.5-3.5"/></svg>';

    trigger.appendChild(labelEl);
    trigger.appendChild(arrowEl);

    var menu = doc.createElement('div');
    menu.className = 'ag-ns-dd-menu';
    menu.setAttribute('role', 'listbox');
    if (sel.id) menu.id = sel.id + '-menu';

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    var focusIdx = -1;
    var visibleOpts = [];
    var currentFilterKw = '';
    var lastRenderedSig = '';

    function focusTriggerNoScroll() {
      if (typeof trigger.focus !== 'function') return;
      try { trigger.focus({ preventScroll: true }); } catch { trigger.focus(); }
    }

    function getUiLangHint() {
      var activeSeg = container.querySelector ? container.querySelector('[data-ag-ns-seg="panelLanguage"] .ag-ns-seg-btn.is-active') : null;
      return activeSeg?.getAttribute?.('data-val') || 'zh-CN';
    }

    function computeEntriesSig(entries, kw) {
      var parts = [String(kw || '')];
      for (var i = 0; i < entries.length; i++) {
        parts.push(entries[i].isGroup ? ('G:' + entries[i].label) : ('O:' + entries[i].value + '=' + entries[i].label));
      }
      return parts.join('|');
    }

    function updateSelectedVisualInPlace() {
      var isLegacy = hasVisibleLegacyEmptyPlaceholder(sel);
      var curVal = isLegacy ? '' : String(sel.value ?? '');
      var itemEls = menu.querySelectorAll ? menu.querySelectorAll('.ag-ns-dd-item') : [];
      for (var i = 0; i < itemEls.length; i++) {
        var itemEl = itemEls[i];
        var v = String(itemEl.getAttribute?.('data-value') ?? '');
        var isSel = !isLegacy && v === curVal;
        itemEl.classList?.toggle?.('is-selected', isSel);
        itemEl.setAttribute?.('aria-selected', isSel ? 'true' : 'false');
      }
    }

    function closeMenu(restoreFocus) {
      wrap.classList?.remove?.('is-open', 'open-up', 'align-right');
      trigger.setAttribute('aria-expanded', 'false');
      var card = wrap.closest ? wrap.closest('.ag-ns-card, .ag-ac-details-section') : null;
      var group = wrap.closest ? wrap.closest('.ag-ns-group') : null;
      if (card) card.classList?.remove?.('is-dropdown-open');
      if (group) group.classList?.remove?.('is-dropdown-open');
      focusIdx = -1;
      if (restoreFocus) focusTriggerNoScroll();
    }

    function selectEntry(entry) {
      if (!entry || entry.disabled) return;
      var wasLegacyPlaceholder = hasVisibleLegacyEmptyPlaceholder(sel);
      var changed = wasLegacyPlaceholder || (String(sel.value ?? '') !== String(entry.value ?? ''));
      if (wasLegacyPlaceholder) {
        sel.removeAttribute?.('data-legacy-placeholder');
        var opts = sel.options ? Array.from(sel.options) : [];
        for (var p = 0; p < opts.length; p++) {
          if (opts[p] && String(opts[p].value ?? '') === '' && opts[p].disabled) {
            opts[p].hidden = true;
          }
        }
      }
      sel.value = entry.value;
      syncLabel();
      closeMenu(true);
      if (changed) {
        if (typeof Event !== 'undefined') {
          sel.dispatchEvent?.(new Event('change', { bubbles: true }));
        } else {
          sel.dispatchEvent?.({ type: 'change', target: sel });
        }
      }
    }

    function setKeyboardFocus(nextIdx) {
      var itemEls = menu.querySelectorAll ? menu.querySelectorAll('.ag-ns-dd-item') : [];
      if (!itemEls.length) return;
      focusIdx = Math.max(0, Math.min(nextIdx, itemEls.length - 1));
      for (var i = 0; i < itemEls.length; i++) {
        itemEls[i].classList?.toggle?.('is-focus', i === focusIdx);
      }
    }

    function renderMenuItems(filterKw, forceRebuild) {
      var listBox = menu.querySelector ? menu.querySelector('.ag-ns-dd-list') : null;
      if (!listBox) return;

      var kw = String(filterKw || '').trim().toLowerCase();
      currentFilterKw = kw;
      var allEntries = collectNativeSelectEntries(sel);
      var sig = computeEntriesSig(allEntries, kw);
      if (!forceRebuild && sig === lastRenderedSig && listBox.children && listBox.children.length > 0) {
        updateSelectedVisualInPlace();
        return;
      }
      lastRenderedSig = sig;

      if (typeof listBox.replaceChildren === 'function') listBox.replaceChildren();
      else listBox.innerHTML = '';

      var isLegacy = hasVisibleLegacyEmptyPlaceholder(sel);
      var curVal = isLegacy ? '' : String(sel.value ?? '');
      var filtered = [];
      var pendingGroup = null;
      visibleOpts = [];

      for (var i = 0; i < allEntries.length; i++) {
        var entry = allEntries[i];
        if (entry.isGroup) {
          pendingGroup = entry;
          continue;
        }
        var hit = !kw || entry.label.toLowerCase().indexOf(kw) >= 0 || entry.value.toLowerCase().indexOf(kw) >= 0;
        if (hit) {
          if (pendingGroup) {
            filtered.push(pendingGroup);
            pendingGroup = null;
          }
          filtered.push(entry);
          visibleOpts.push(entry);
        }
      }

      if (visibleOpts.length === 0) {
        var lang = getUiLangHint();
        var emptyDiv = doc.createElement('div');
        emptyDiv.className = 'ag-ns-dd-empty';
        emptyDiv.textContent = lang === 'en' ? 'No matching options' : (lang === 'zh-TW' ? '無符合項目' : '无匹配选项');
        listBox.appendChild(emptyDiv);
        focusIdx = -1;
        return;
      }

      var optCursor = 0;
      for (var j = 0; j < filtered.length; j++) {
        var it = filtered[j];
        if (it.isGroup) {
          var gEl = doc.createElement('div');
          gEl.className = 'ag-ns-dd-group';
          gEl.setAttribute('role', 'presentation');
          gEl.textContent = it.label;
          listBox.appendChild(gEl);
          continue;
        }
        var optIdx = optCursor++;
        var isSel = !isLegacy && it.value === curVal;
        var itemEl = doc.createElement('div');
        itemEl.className = 'ag-ns-dd-item' + (isSel ? ' is-selected' : '');
        itemEl.setAttribute('role', 'option');
        itemEl.setAttribute('aria-selected', isSel ? 'true' : 'false');
        itemEl.setAttribute('data-value', it.value);
        itemEl.setAttribute('data-index', String(optIdx));
        itemEl.title = it.label;

        var txt = doc.createElement('span');
        txt.className = 'ag-ns-dd-item-text';
        txt.textContent = it.label;

        var chk = doc.createElement('span');
        chk.className = 'ag-ns-dd-check';
        chk.setAttribute('aria-hidden', 'true');
        chk.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 6.3 4.9 9l4.9-5.8"/></svg>';

        itemEl.appendChild(txt);
        itemEl.appendChild(chk);
        listBox.appendChild(itemEl);
        if (isSel) focusIdx = optIdx;
      }
    }

    // 稳定菜单节点事件委托：防 mousedown 失焦 + 刷新夹在按下与松开之间仍精准命中
    menu.addEventListener('mousedown', function (ev) {
      var itemNode = ev.target && ev.target.closest ? ev.target.closest('.ag-ns-dd-item') : null;
      if (itemNode && menu.contains(itemNode)) {
        ev.preventDefault?.();
      }
    });
    menu.addEventListener('click', function (ev) {
      var itemNode = ev.target && ev.target.closest ? ev.target.closest('.ag-ns-dd-item') : null;
      if (!itemNode || !menu.contains(itemNode)) return;
      ev.stopPropagation?.();
      var val = String(itemNode.getAttribute?.('data-value') ?? '');
      var hit = null;
      for (var i = 0; i < visibleOpts.length; i++) {
        if (String(visibleOpts[i].value ?? '') === val) { hit = visibleOpts[i]; break; }
      }
      if (!hit) {
        var fresh = collectNativeSelectEntries(sel);
        for (var j = 0; j < fresh.length; j++) {
          if (!fresh[j].isGroup && String(fresh[j].value ?? '') === val) { hit = fresh[j]; break; }
        }
      }
      if (hit) selectEntry(hit);
    });

    function buildMenu() {
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      else menu.innerHTML = '';
      lastRenderedSig = '';
      currentFilterKw = '';

      var allEntries = collectNativeSelectEntries(sel);
      var optionCount = 0;
      for (var i = 0; i < allEntries.length; i++) {
        if (!allEntries[i].isGroup) optionCount++;
      }

      var searchInput = null;
      if (optionCount > 8) {
        var lang = getUiLangHint();
        var sWrap = doc.createElement('div');
        sWrap.className = 'ag-ns-dd-search-wrap';
        searchInput = doc.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'ag-ns-dd-search-input';
        searchInput.placeholder = lang === 'en' ? 'Search...' : (lang === 'zh-TW' ? '搜尋…' : '搜索…');
        searchInput.addEventListener('click', function (ev) { ev?.stopPropagation?.(); });
        searchInput.addEventListener('input', function (ev) {
          renderMenuItems(ev.target ? ev.target.value : '', false);
        });
        searchInput.addEventListener('keydown', handleOpenKeydown);
        sWrap.appendChild(searchInput);
        menu.appendChild(sWrap);
      }

      var listBox = doc.createElement('div');
      listBox.className = 'ag-ns-dd-list';
      menu.appendChild(listBox);

      renderMenuItems('', true);
      return searchInput;
    }

    function openMenu() {
      closeAllNativeDropdowns(container, wrap);
      var searchInput = buildMenu();

      try {
        var rect = trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : null;
        var rootHost = container.getRootNode ? container.getRootNode().host : null;
        var hostRect = rootHost && rootHost.getBoundingClientRect ? rootHost.getBoundingClientRect() : null;
        var viewBottom = hostRect && hostRect.height > 0 ? Math.min(hostRect.bottom, (typeof window !== 'undefined' ? window.innerHeight : 900)) : (typeof window !== 'undefined' ? window.innerHeight : 900);
        var viewTop = hostRect && hostRect.height > 0 ? Math.max(hostRect.top, 0) : 0;
        var viewRight = hostRect && hostRect.width > 0 ? hostRect.right : (typeof window !== 'undefined' ? window.innerWidth : 1200);
        if (rect && rect.height > 0) {
          var spaceBelow = viewBottom - rect.bottom;
          var spaceAbove = rect.top - viewTop;
          if (spaceBelow < 240 && spaceAbove > spaceBelow) wrap.classList?.add?.('open-up');
          else wrap.classList?.remove?.('open-up');
          if (rect.left + Math.max(rect.width, 200) > viewRight - 10) wrap.classList?.add?.('align-right');
          else wrap.classList?.remove?.('align-right');
        }
      } catch {
        wrap.classList?.remove?.('open-up', 'align-right');
      }

      var card = wrap.closest ? wrap.closest('.ag-ns-card, .ag-ac-details-section') : null;
      var group = wrap.closest ? wrap.closest('.ag-ns-group') : null;
      if (card) card.classList?.add?.('is-dropdown-open');
      if (group) group.classList?.add?.('is-dropdown-open');

      wrap.classList?.add?.('is-open');
      trigger.setAttribute('aria-expanded', 'true');

      if (searchInput && typeof searchInput.focus === 'function') {
        try { searchInput.focus({ preventScroll: true }); } catch { searchInput.focus(); }
      }
    }

    function handleOpenKeydown(ev) {
      if (!wrap.classList?.contains?.('is-open')) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault?.();
        setKeyboardFocus(focusIdx < 0 ? 0 : focusIdx + 1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault?.();
        setKeyboardFocus(focusIdx <= 0 ? 0 : focusIdx - 1);
      } else if (ev.key === 'Enter') {
        ev.preventDefault?.();
        if (focusIdx >= 0 && visibleOpts[focusIdx]) selectEntry(visibleOpts[focusIdx]);
        else if (visibleOpts.length === 1) selectEntry(visibleOpts[0]);
      } else if (ev.key === 'Escape') {
        ev.preventDefault?.();
        closeMenu(true);
      }
    }

    trigger.addEventListener('click', function (ev) {
      ev?.stopPropagation?.();
      if (wrap.classList?.contains?.('is-open')) closeMenu(false);
      else openMenu();
    });

    trigger.addEventListener('keydown', function (ev) {
      var isOpen = Boolean(wrap.classList?.contains?.('is-open'));
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault?.();
        if (isOpen && ev.key === 'Enter') handleOpenKeydown(ev);
        else if (isOpen) closeMenu(false);
        else openMenu();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault?.();
        if (!isOpen) openMenu();
        else handleOpenKeydown(ev);
      } else if (ev.key === 'Escape' && isOpen) {
        ev.preventDefault?.();
        closeMenu(true);
      }
    });

    function syncLabel() {
      var txt = resolveNativeSelectLabel(sel);
      if (labelEl.textContent !== txt) labelEl.textContent = txt;
      trigger.title = txt;
      if (wrap.classList?.contains?.('is-open')) {
        // #123 展开期间仅在选项或搜索签名实际变化时重建，否则原地更新选中态
        renderMenuItems(currentFilterKw, false);
      }
    }

    syncLabel();
    var ctrl = { wrap: wrap, trigger: trigger, menu: menu, sync: syncLabel, close: closeMenu, open: openMenu };
    sel._agNsDdCtrl = ctrl;
    return ctrl;
  }

  function syncAllNativeSelectDropdowns(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    var selects = container.querySelectorAll('[data-ag-ns-select]');
    for (var i = 0; i < selects.length; i++) {
      var ctrl = selects[i]._agNsDdCtrl || enhanceNativeSelect(container, selects[i]);
      if (ctrl && typeof ctrl.sync === 'function') ctrl.sync();
    }
  }

  function initContextSettingsUI(root, callbacks) {
    var container = byId(root, 'ag-ns-root');
    if (!container || container.dataset?.agNsBound === '1') {
      return;
    }
    if (container.dataset) container.dataset.agNsBound = '1';

    var cbs = callbacks || {};

    var segGroups = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-seg]') : [];
    for (var i = 0; i < segGroups.length; i++) {
      (function (group) {
        var key = group.getAttribute('data-ag-ns-seg');
        group.addEventListener('click', function (e) {
          var btn = e.target && e.target.closest ? e.target.closest('.ag-ns-seg-btn') : null;
          if (!btn || !group.contains(btn) || btn.disabled) return;
          var val = btn.getAttribute('data-val');
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, val, { sourceEl: btn });
          }
        });
      })(segGroups[i]);
    }

    function hasNonEmptyTextSelection(targetRoot) {
      try {
        if (typeof targetRoot?.getSelection === 'function') {
          const srSel = String(targetRoot.getSelection()?.toString?.() || '').trim();
          if (srSel.length > 0) return true;
        }
        const winObj = container.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
        if (typeof winObj?.getSelection === 'function') {
          const wSel = String(winObj.getSelection()?.toString?.() || '').trim();
          if (wSel.length > 0) return true;
        }
      } catch { }
      return false;
    }

    var switches = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-switch]') : [];
    for (var j = 0; j < switches.length; j++) {
      (function (sw) {
        var key = sw.getAttribute('data-ag-ns-switch');
        var row = sw.closest ? sw.closest('.ag-ns-row') : null;
        if (row) {
          row.classList?.add?.('is-switch-row');
          var titleEl = row.querySelector ? row.querySelector('.ag-ns-row-title') : null;
          var descEl = row.querySelector ? row.querySelector('.ag-ns-row-desc') : null;
          if (titleEl && !titleEl.id && key) titleEl.id = 'ag-ns-title-' + key;
          if (descEl && !descEl.id && key) descEl.id = 'ag-ns-desc-' + key;
          if (titleEl && titleEl.id && !sw.getAttribute('aria-labelledby')) {
            sw.setAttribute('aria-labelledby', titleEl.id);
          }
          if (descEl && descEl.id && !sw.getAttribute('aria-describedby')) {
            sw.setAttribute('aria-describedby', descEl.id);
          }
          if (descEl && descEl.id) {
            sw.setAttribute('data-base-describedby', descEl.id);
          }
          row.addEventListener('click', function (ev) {
            if (sw.disabled || sw.getAttribute('aria-busy') === 'true') return;
            var tNode = ev && ev.target;
            if (tNode === sw) return;
            if (tNode && typeof tNode.closest === 'function') {
              if (tNode.closest('button, input, select, textarea, a, label, .ag-ns-dd-wrap, .ag-ns-seg, [role="switch"], [role="combobox"], [role="radiogroup"]')) {
                return;
              }
            }
            if (hasNonEmptyTextSelection(root)) return;
            sw.click();
          });
        }
        sw.addEventListener('click', function () {
          if (sw.disabled || sw.getAttribute('aria-busy') === 'true') return;
          var nextVal = sw.getAttribute('aria-checked') !== 'true';
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, nextVal, { sourceEl: sw });
          }
        });
      })(switches[j]);
    }

    var selects = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-select]') : [];
    for (var k = 0; k < selects.length; k++) {
      (function (sel) {
        var key = sel.getAttribute('data-ag-ns-select');
        enhanceNativeSelect(container, sel);
        sel.addEventListener('change', function () {
          if (sel._agNsDdCtrl && typeof sel._agNsDdCtrl.sync === 'function') {
            sel._agNsDdCtrl.sync();
          }
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, sel.value, { sourceEl: sel });
          }
        });
      })(selects[k]);
    }

    container.addEventListener('click', function (e) {
      if (!e.target?.closest?.('.ag-ns-dd-wrap')) {
        closeAllNativeDropdowns(container, null);
      }
    });

    var ownerDoc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (ownerDoc && typeof ownerDoc.addEventListener === 'function') {
      if (!ownerDoc._agNsActiveContainers) ownerDoc._agNsActiveContainers = new Set();
      ownerDoc._agNsActiveContainers.add(container);
      if (!ownerDoc._agNsDdOutsideBound) {
        ownerDoc._agNsDdOutsideBound = true;
        ownerDoc.addEventListener('click', function (e) {
          var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
          for (var p = 0; p < path.length; p++) {
            if (path[p]?.classList?.contains?.('ag-ns-dd-wrap')) return;
          }
          for (var box of ownerDoc._agNsActiveContainers) {
            if (box && box.isConnected) closeAllNativeDropdowns(box, null);
          }
        });
      }
    }

    var inputs = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-input]') : [];
    for (var inpIdx = 0; inpIdx < inputs.length; inpIdx++) {
      (function (inp) {
        var key = inp.getAttribute('data-ag-ns-input');
        inp.addEventListener('input', function () {
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, inp.value, { sourceEl: inp, eventType: 'input' });
          }
        });
      })(inputs[inpIdx]);
    }

    var shortcutInputs = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-shortcut]') : [];
    for (var scIdx = 0; scIdx < shortcutInputs.length; scIdx++) {
      (function (scInp) {
        var key = scInp.getAttribute('data-ag-ns-shortcut');
        scInp.addEventListener('keydown', function (ev) {
          if (!ev) return;
          var rawKey = String(ev.key || '');
          if (rawKey === 'Tab') return;
          ev.preventDefault?.();
          ev.stopPropagation?.();
          if (rawKey === 'Escape') {
            scInp.blur?.();
            return;
          }
          if (/^(Control|Alt|Shift|Meta)$/i.test(rawKey)) return;
          var parts = [];
          if (ev.ctrlKey) parts.push('Ctrl');
          if (ev.metaKey) parts.push('Meta');
          if (ev.altKey) parts.push('Alt');
          if (ev.shiftKey) parts.push('Shift');
          if (parts.length === 0) return;
          var mainKey = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
          parts.push(mainKey);
          var combo = parts.join('+');
          scInp.value = combo;
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, combo, { sourceEl: scInp, eventType: 'shortcut' });
          }
        });
      })(shortcutInputs[scIdx]);
    }

    var shortcutResetBtns = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-shortcut-reset]') : [];
    for (var srIdx = 0; srIdx < shortcutResetBtns.length; srIdx++) {
      (function (btn) {
        var key = btn.getAttribute('data-ag-ns-shortcut-reset');
        btn.addEventListener('click', function () {
          var targetInp = container.querySelector ? container.querySelector('[data-ag-ns-shortcut="' + key + '"]') : null;
          if (targetInp) targetInp.value = 'Ctrl+Alt+L';
          if (typeof cbs.onChange === 'function') {
            cbs.onChange(key, 'Ctrl+Alt+L', { sourceEl: btn, eventType: 'shortcut-reset' });
          }
        });
      })(shortcutResetBtns[srIdx]);
    }

    var toggleColorsBtn = byId(root, 'ag-ns-toggle-colors');
    var toggleColorsLabel = byId(root, 'ag-ns-toggle-colors-label');
    var colorsBody = byId(root, 'ag-ns-colors-body');
    if (toggleColorsBtn && colorsBody) {
      toggleColorsBtn.addEventListener('click', function () {
        var nextOpen = colorsBody.hidden;
        colorsBody.hidden = !nextOpen;
        toggleColorsBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        if (toggleColorsLabel) {
          var expandTxt = toggleColorsBtn.getAttribute('data-label-expand') || '展开设置';
          var collapseTxt = toggleColorsBtn.getAttribute('data-label-collapse') || '收起设置';
          toggleColorsLabel.textContent = nextOpen ? collapseTxt : expandTxt;
        }
      });
    }

    var colorInputs = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-color]') : [];
    for (var m = 0; m < colorInputs.length; m++) {
      (function (input) {
        var colorKey = input.getAttribute('data-ag-ns-color');
        input.addEventListener('input', function () {
          var hexUpper = String(input.value || '').toUpperCase();
          var hexLabel = container.querySelector ? container.querySelector('[data-ag-ns-color-hex="' + colorKey + '"]') : null;
          if (hexLabel) hexLabel.textContent = hexUpper;
          var swBtn = container.querySelector ? container.querySelector('[data-ag-ns-swatch="' + colorKey + '"]') : null;
          if (swBtn) swBtn.style.setProperty('--swatch-color', input.value);
          if (typeof cbs.onColorChange === 'function') {
            cbs.onColorChange(colorKey, input.value);
          }
        });
      })(colorInputs[m]);
    }

    // 点击色块卡片或色块按钮唤起与插件主题一致的自定义颜色选取器，不再弹出系统原生浅/灰拾色框
    var colorCards = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-color-pick]') : [];
    for (var cpIdx = 0; cpIdx < colorCards.length; cpIdx++) {
      (function (cardEl) {
        var colorKey = cardEl.getAttribute('data-ag-ns-color-pick');
        cardEl.addEventListener('click', function (ev) {
          ev?.stopPropagation?.();
          var nameNode = cardEl.querySelector ? cardEl.querySelector('.ag-ns-color-name') : null;
          var swBtn = cardEl.querySelector ? cardEl.querySelector('[data-ag-ns-swatch]') : cardEl;
          var rect = swBtn && typeof swBtn.getBoundingClientRect === 'function' ? swBtn.getBoundingClientRect() : null;
          if (typeof cbs.onAction === 'function') {
            cbs.onAction('openColorPicker', {
              colorKey: colorKey,
              label: nameNode ? String(nameNode.textContent || '').trim() : colorKey,
              rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null
            });
          }
        });
      })(colorCards[cpIdx]);
    }

    var resetColorsBtn = byId(root, 'ag-ns-reset-colors');
    if (resetColorsBtn) {
      resetColorsBtn.addEventListener('click', function () {
        if (typeof cbs.onResetColors === 'function') cbs.onResetColors();
      });
    }

    var actionBtns = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-action]') : [];
    for (var n = 0; n < actionBtns.length; n++) {
      (function (btn) {
        var actionName = btn.getAttribute('data-ag-ns-action');
        btn.addEventListener('click', function () {
          var payload = null;
          if (actionName === 'applyProxy' || actionName === 'testProxy') {
            var proxyInput = byId(root, 'ag-ns-input-proxyUrl');
            payload = { proxyUrl: proxyInput ? String(proxyInput.value || '').trim() : '' };
          } else if (actionName === 'saveHostInstallPath') {
            var pathInp = byId(root, 'ag-ns-input-hostInstallPath');
            payload = { customPath: pathInp ? String(pathInp.value || '').trim() : '' };
          }
          if (typeof cbs.onAction === 'function') {
            cbs.onAction(actionName, payload);
          }
        });
      })(actionBtns[n]);
    }
  }

  function renderContextSettingsUI(root, data) {
    var container = byId(root, 'ag-ns-root');
    if (!container || !data) return;

    var settings = data.settings || {};
    var colors = data.colors || {};
    var status = data.status || {};
    var swFbMap = status.switchFeedback || {};

    var syncSegSlider = function (group, activeBtn) {
      if (!group || !activeBtn || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      var w = activeBtn.offsetWidth || 0;
      var h = activeBtn.offsetHeight || 0;
      if (!(w > 0 && h > 0)) return;
      var slider = group.querySelector ? group.querySelector(':scope > .ag-ns-seg-indicator') : null;
      if (!slider) {
        slider = document.createElement('span');
        slider.className = 'ag-ns-seg-indicator';
        slider.setAttribute('aria-hidden', 'true');
        if (group.firstChild) group.insertBefore(slider, group.firstChild);
        else group.appendChild(slider);
      }
      group.classList?.add?.('has-slider');
      slider.style.width = w + 'px';
      slider.style.height = h + 'px';
      slider.style.transform = 'translate3d(' + (activeBtn.offsetLeft || 0) + 'px, ' + (activeBtn.offsetTop || 0) + 'px, 0)';
    };

    var segGroups = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-seg]') : [];
    for (var i = 0; i < segGroups.length; i++) {
      var group = segGroups[i];
      var segKey = group.getAttribute('data-ag-ns-seg');
      var curVal = settings[segKey] !== undefined ? String(settings[segKey]) : '';
      var btns = group.querySelectorAll ? group.querySelectorAll('.ag-ns-seg-btn') : [];
      var matchedActive = null;
      for (var b = 0; b < btns.length; b++) {
        var isActive = btns[b].getAttribute('data-val') === curVal;
        btns[b].classList?.toggle?.('is-active', isActive);
        btns[b].setAttribute?.('aria-checked', isActive ? 'true' : 'false');
        if (isActive) matchedActive = btns[b];
      }
      if (matchedActive) syncSegSlider(group, matchedActive);
    }

    // #127 派生禁用态：顶栏隐藏时禁用顶栏径向展开，底栏关闭时禁用底栏径向展开
    var topbarHidden = settings.topbarMode === 'hidden';
    var composerOff = settings.showComposerBar === false;

    var switches = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-switch]') : [];
    for (var j = 0; j < switches.length; j++) {
      var sw = switches[j];
      var swKey = sw.getAttribute('data-ag-ns-switch');
      var fb = swFbMap[swKey] || null;
      var isOn = Boolean(settings[swKey]);
      var isBusy = Boolean(fb && fb.busy);
      var derivedDisabled = (swKey === 'radialTopbar' && topbarHidden) || (swKey === 'radialBottombar' && composerOff);
      sw.classList?.toggle?.('is-on', isOn);
      sw.setAttribute?.('aria-checked', isOn ? 'true' : 'false');
      sw.disabled = Boolean(isBusy || (fb && fb.disabled) || derivedDisabled);
      if (isBusy) sw.setAttribute?.('aria-busy', 'true');
      else sw.removeAttribute?.('aria-busy');

      var swRow = sw.closest ? sw.closest('.ag-ns-row') : null;
      if (swRow) {
        swRow.setAttribute?.('data-switch-disabled', sw.disabled ? 'true' : 'false');
      }

      var stEl = container.querySelector ? container.querySelector('[data-ag-ns-sw-status="' + swKey + '"]') : null;
      var baseDescId = sw.getAttribute?.('data-base-describedby') || '';
      if (!baseDescId) {
        var existingDescBy = String(sw.getAttribute?.('aria-describedby') || '').trim();
        if (existingDescBy) {
          baseDescId = existingDescBy.split(/\s+/).filter(function (idTok) { return idTok && (!stEl || idTok !== stEl.id); }).join(' ');
          if (baseDescId) sw.setAttribute?.('data-base-describedby', baseDescId);
        }
      }
      if (stEl) {
        var dynamicTone = fb && fb.tone && fb.tone !== 'idle';
        var showDynamicText = Boolean(fb && fb.text && (fb.busy || dynamicTone));
        var derivedHint = '';
        if (!showDynamicText && derivedDisabled) {
          derivedHint = swKey === 'radialTopbar'
            ? (status.radialTopbarDisabledHint || '顶栏入口已隐藏')
            : (status.radialBottombarDisabledHint || '底栏状态条已关闭');
        }
        var finalText = showDynamicText ? String(fb.text) : derivedHint;
        stEl.textContent = finalText;
        stEl.hidden = !finalText;
        stEl.setAttribute('data-tone', showDynamicText ? (fb.tone || 'busy') : (derivedHint ? 'warn' : 'idle'));
        if (stEl.id) {
          var describedIds = [baseDescId, finalText ? stEl.id : ''].filter(Boolean).join(' ');
          if (describedIds) sw.setAttribute?.('aria-describedby', describedIds);
        }
      }
    }

    var selects = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-select]') : [];
    for (var k = 0; k < selects.length; k++) {
      var sel = selects[k];
      var selKey = sel.getAttribute('data-ag-ns-select');
      if (settings[selKey] !== undefined && sel.value !== String(settings[selKey]) && root.activeElement !== sel) {
        sel.value = String(settings[selKey]);
      }
    }
    syncAllNativeSelectDropdowns(container);

    var proxyInput = byId(root, 'ag-ns-input-proxyUrl');
    if (proxyInput && typeof settings.proxyUrl === 'string' && root.activeElement !== proxyInput) {
      if (proxyInput.value !== settings.proxyUrl) proxyInput.value = settings.proxyUrl;
    }

    var installPathInput = byId(root, 'ag-ns-input-hostInstallPath');
    if (installPathInput && typeof settings.hostInstallPath === 'string' && root.activeElement !== installPathInput) {
      if (installPathInput.value !== settings.hostInstallPath) installPathInput.value = settings.hostInstallPath;
    }
    var installDetected = byId(root, 'ag-ns-install-path-detected');
    if (installDetected) {
      if (status.hostInstallDetectedText) {
        installDetected.hidden = false;
        installDetected.textContent = status.hostInstallDetectedText;
      } else {
        installDetected.hidden = true;
      }
    }
    var installBadge = byId(root, 'ag-ns-install-path-badge');
    if (installBadge) {
      if (status.hostInstallBadgeText) {
        installBadge.hidden = false;
        installBadge.textContent = status.hostInstallBadgeText;
        installBadge.className = 'ag-ns-pill ' + (status.hostInstallBadgeClass || '');
      } else {
        installBadge.hidden = true;
      }
    }
    var installFb = byId(root, 'ag-ns-install-path-feedback');
    if (installFb) {
      if (status.hostInstallFeedbackText) {
        installFb.hidden = false;
        installFb.textContent = status.hostInstallFeedbackText;
        installFb.className = 'ag-ns-note-box ' + (status.hostInstallFeedbackTone === 'error' ? 'is-error' : (status.hostInstallFeedbackTone === 'ok' ? 'is-ok' : ''));
      } else {
        installFb.hidden = true;
      }
    }
    var clearInstallBtn = byId(root, 'ag-ns-btn-clear-install-path');
    if (clearInstallBtn) {
      clearInstallBtn.disabled = Boolean(status.hostInstallBusy || !status.hasCustomInstallPath);
    }
    var saveInstallBtn = byId(root, 'ag-ns-btn-save-install-path');
    if (saveInstallBtn) saveInstallBtn.disabled = Boolean(status.hostInstallBusy);
    var browseInstallBtn = byId(root, 'ag-ns-btn-browse-install-path');
    if (browseInstallBtn) browseInstallBtn.disabled = Boolean(status.hostInstallBusy);

    var acThInput = byId(root, 'ag-ns-inp-autoCompactThreshold');
    if (acThInput && settings.autoCompactThreshold !== undefined && root.activeElement !== acThInput) {
      var acThStr = String(settings.autoCompactThreshold);
      if (acThInput.value !== acThStr) acThInput.value = acThStr;
    }
    if (acThInput) acThInput.disabled = Boolean(status.autoCompactBusy);

    var colorKeys = ['panelBg', 'ringUsed', 'ringTrack', 'contextText', 'speedText', 'tokenTotal', 'tokenAccent', 'cliIcon'];
    for (var c = 0; c < colorKeys.length; c++) {
      var ck = colorKeys[c];
      if (!colors[ck]) continue;
      var colorInput = container.querySelector ? container.querySelector('[data-ag-ns-color="' + ck + '"]') : null;
      var colorHex = container.querySelector ? container.querySelector('[data-ag-ns-color-hex="' + ck + '"]') : null;
      var colorSwatch = container.querySelector ? container.querySelector('[data-ag-ns-swatch="' + ck + '"]') : null;
      if (colorInput && String(colorInput.value || '').toLowerCase() !== String(colors[ck]).toLowerCase()) {
        colorInput.value = colors[ck];
      }
      if (colorHex) colorHex.textContent = String(colors[ck]).toUpperCase();
      if (colorSwatch) {
        colorSwatch.style.setProperty('--swatch-color', colors[ck]);
        colorSwatch.style.background = colors[ck];
      }
    }

    var cliCustomWrap = byId(root, 'ag-ns-cli-custom-swatch-wrap');
    if (cliCustomWrap) {
      cliCustomWrap.hidden = settings.cliIconColorMode !== 'custom';
    }
    var extraCopy = resolveLocalExtraCopy(settings.panelLanguage);
    var setTextById = function (id, txt) {
      var n = byId(root, id);
      if (n && txt) n.textContent = txt;
    };
    setTextById('ag-ns-title-cliIconColorMode', extraCopy.cliColorTitle);
    setTextById('ag-ns-desc-cliIconColorMode', extraCopy.cliColorDesc);
    setTextById('ag-ns-btn-cli-color-accent', extraCopy.cliColorAccent);
    setTextById('ag-ns-btn-cli-color-mono', extraCopy.cliColorMono);
    setTextById('ag-ns-btn-cli-color-custom', extraCopy.cliColorCustom);
    var cliSwatchBtn = byId(root, 'ag-ns-swatch-cliIcon');
    if (cliSwatchBtn) cliSwatchBtn.setAttribute('aria-label', extraCopy.cliColorPickAria);
    setTextById('ag-ns-title-auxCoexistMode', extraCopy.auxCoexistTitle);
    setTextById('ag-ns-desc-auxCoexistMode', extraCopy.auxCoexistDesc);
    setTextById('ag-ns-btn-aux-coexist-tab', extraCopy.auxCoexistTab);
    setTextById('ag-ns-btn-aux-coexist-split', extraCopy.auxCoexistSplit);
    setTextById('ag-ns-title-auxLayoutShortcut', extraCopy.auxLayoutShortcutTitle);
    setTextById('ag-ns-desc-auxLayoutShortcut', extraCopy.auxLayoutShortcutDesc);
    setTextById('ag-ns-btn-reset-auxLayoutShortcut', extraCopy.auxLayoutShortcutReset);
    setTextById('ag-ns-title-mainCapsuleEnabled', extraCopy.mainCapsuleTitle);
    setTextById('ag-ns-desc-mainCapsuleEnabled', extraCopy.mainCapsuleDesc);
    setTextById('ag-ns-title-sessionFourViewsEnabled', extraCopy.sessionFourViewsTitle);
    setTextById('ag-ns-desc-sessionFourViewsEnabled', extraCopy.sessionFourViewsDesc);
    setTextById('ag-ns-title-profileHomeEnabled', extraCopy.profileHomeTitle);
    setTextById('ag-ns-desc-profileHomeEnabled', extraCopy.profileHomeDesc);
    var shortcutInpEl = byId(root, 'ag-ns-input-auxLayoutShortcut');
    if (shortcutInpEl) {
      shortcutInpEl.setAttribute('aria-label', extraCopy.auxLayoutShortcutAria);
      if (typeof settings.auxLayoutShortcut === 'string' && settings.auxLayoutShortcut && root.activeElement !== shortcutInpEl) {
        if (shortcutInpEl.value !== settings.auxLayoutShortcut) shortcutInpEl.value = settings.auxLayoutShortcut;
      }
    }

    var themeDesc = byId(root, 'ag-ns-theme-desc');
    if (themeDesc && status.themeSyncDescText) {
      themeDesc.textContent = status.themeSyncDescText;
      themeDesc.classList?.toggle?.('is-error', status.themeSyncError === true);
    }

    var i18nBadge = byId(root, 'ag-ns-i18n-badge');
    if (i18nBadge && status.clientLangBadgeText) {
      i18nBadge.textContent = status.clientLangBadgeText;
      i18nBadge.className = 'ag-ns-pill ' + (status.clientLangBadgeClass || '');
    }
    var i18nDesc = byId(root, 'ag-ns-i18n-desc');
    if (i18nDesc && status.clientLangDescText) i18nDesc.textContent = status.clientLangDescText;
    var applyClientLangBtn = byId(root, 'ag-ns-btn-apply-client-lang');
    if (applyClientLangBtn) {
      applyClientLangBtn.disabled = Boolean(status.clientLangBusy);
      if (status.clientLangBtnText) applyClientLangBtn.textContent = status.clientLangBtnText;
    }
    var clientLangFb = byId(root, 'ag-ns-client-lang-feedback');
    if (clientLangFb) {
      if (status.clientLangFeedback) {
        clientLangFb.hidden = false;
        clientLangFb.textContent = status.clientLangFeedback;
        clientLangFb.className = 'ag-ns-note-box ' + (status.clientLangFeedbackOk === false ? 'is-error' : (status.clientLangFeedbackOk === true ? 'is-ok' : ''));
      } else {
        clientLangFb.hidden = true;
      }
    }

    var rehydrateBadge = byId(root, 'ag-ns-rehydrate-badge');
    if (rehydrateBadge && status.rehydrateBadgeText) {
      rehydrateBadge.textContent = status.rehydrateBadgeText;
      rehydrateBadge.className = 'ag-ns-pill ' + (status.rehydrateBadgeClass || '');
    }
    var rehydrateHookEl = byId(root, 'ag-ns-rehydrate-hook');
    if (rehydrateHookEl && status.rehydrateHookText !== undefined) rehydrateHookEl.textContent = status.rehydrateHookText;
    var rehydratePyEl = byId(root, 'ag-ns-rehydrate-python');
    if (rehydratePyEl && status.rehydratePythonText !== undefined) rehydratePyEl.textContent = status.rehydratePythonText;
    var btnRehydratePy = byId(root, 'ag-ns-btn-rehydrate-install-py');
    if (btnRehydratePy) btnRehydratePy.hidden = !status.rehydrateShowInstallPy;
    var btnRehydrateEn = byId(root, 'ag-ns-btn-rehydrate-enable');
    var btnRehydrateDis = byId(root, 'ag-ns-btn-rehydrate-disable');
    var btnRehydrateRef = byId(root, 'ag-ns-btn-rehydrate-refresh');
    if (btnRehydrateEn) {
      btnRehydrateEn.disabled = Boolean(status.rehydrateBusy || status.rehydrateDisableEnable);
      if (status.rehydrateEnableBtnText) btnRehydrateEn.textContent = status.rehydrateEnableBtnText;
    }
    if (btnRehydrateDis) {
      btnRehydrateDis.disabled = Boolean(status.rehydrateBusy || status.rehydrateDisableDisable);
      if (status.rehydrateDisableBtnText) btnRehydrateDis.textContent = status.rehydrateDisableBtnText;
    }
    if (btnRehydrateRef) btnRehydrateRef.disabled = Boolean(status.rehydrateBusy);
    var rhFbEl = byId(root, 'ag-ns-rehydrate-feedback');
    if (rhFbEl) {
      rhFbEl.textContent = status.rehydrateFeedbackText || '';
      rhFbEl.setAttribute('data-tone', status.rehydrateFeedbackTone || 'idle');
    }

    var enhBadge = byId(root, 'ag-ns-enhance-badge');
    if (enhBadge && status.enhanceBadgeText) {
      enhBadge.textContent = status.enhanceBadgeText;
      enhBadge.className = 'ag-ns-pill ' + (status.enhanceBadgeClass || '');
    }

    // 紧邻免 TUN 代理开关的胶囊只在动态/异常状态出现（待重启、未注入、运行生效差异），稳态不重复显示「已启用/未启用」
    var proxyBadge = byId(root, 'ag-ns-proxy-badge');
    if (proxyBadge) {
      if (status.proxyDynamicBadgeText) {
        proxyBadge.hidden = false;
        proxyBadge.textContent = status.proxyDynamicBadgeText;
        proxyBadge.className = 'ag-ns-pill ' + (status.proxyBadgeClass || '');
      } else {
        proxyBadge.hidden = true;
        proxyBadge.textContent = '';
      }
    }
    var proxyDesc = byId(root, 'ag-ns-proxy-desc');
    if (proxyDesc && status.proxyDescText) proxyDesc.textContent = status.proxyDescText;

    var rateDesc = byId(root, 'ag-ns-billing-rate-desc');
    if (rateDesc && status.billingHint) rateDesc.textContent = status.billingHint;

    var updateMeta = byId(root, 'ag-ns-update-meta');
    if (updateMeta) {
      var channelText = settings.betaChannel ? 'Beta' : 'Stable';
      var versionText = status.version || '--';
      updateMeta.textContent = channelText + ' · ' + versionText;
    }

    var checkUpdateBtn = byId(root, 'ag-hs-btn-check-update');
    if (checkUpdateBtn) {
      var busy = Boolean(status.checkingUpdate);
      checkUpdateBtn.disabled = busy;
      checkUpdateBtn.classList?.toggle?.('is-busy', busy);
    }

    // 紧邻宿主守护开关的胶囊只在需要提示的异常/待恢复/读取中态显示，稳态不重复显示「已启用/未启用」
    var hgBadge = byId(root, 'ag-ns-host-guard-badge');
    if (hgBadge) {
      if (status.hostGuardDynamicBadgeText) {
        hgBadge.hidden = false;
        hgBadge.textContent = status.hostGuardDynamicBadgeText;
        hgBadge.className = 'ag-ns-pill ' + (status.hostGuardBadgeClass || '');
      } else {
        hgBadge.hidden = true;
        hgBadge.textContent = '';
      }
    }
    var hgMeta = byId(root, 'ag-ns-host-guard-meta');
    if (hgMeta) {
      if (status.hostGuardMetaText) {
        hgMeta.hidden = false;
        hgMeta.textContent = status.hostGuardMetaText;
      } else {
        hgMeta.hidden = true;
      }
    }
    var hgRecoverBtn = byId(root, 'ag-ns-btn-host-guard-recover');
    if (hgRecoverBtn) {
      hgRecoverBtn.hidden = !status.hostGuardShowRecover;
      hgRecoverBtn.disabled = Boolean(status.hostGuardBusy);
    }
    var hgCheckBtn = byId(root, 'ag-ns-btn-host-guard-check');
    if (hgCheckBtn) hgCheckBtn.disabled = Boolean(status.hostGuardBusy);

    var cacheDesc = byId(root, 'ag-ns-cache-size-desc');
    if (cacheDesc && status.cacheDescText) cacheDesc.textContent = status.cacheDescText;

    if (data.toastMessage) showToast(root, data.toastMessage);
  }

  function buildCompactionProgressPageHtml() {
    return `
<section id="ag-cp-root" class="ag-ns-page">
  <header class="ag-ns-header">
    <div class="ag-ns-title-wrap">
      <h1 class="ag-ns-title" data-i18n="compactProgress.title">压缩进度</h1>
      <p id="ag-cp-subtitle" class="ag-ns-subtitle" data-i18n="compactProgress.subtitle">实时跟踪当前会话上下文压缩阶段、耗时与检查点读数变化</p>
    </div>
    <div class="ag-ns-header-links">
      <button type="button" id="ag-cp-btn-refresh" class="ag-ns-btn" data-i18n="models.btn.refreshStatus">刷新状态</button>
      <button type="button" id="ag-cp-btn-open-settings" class="ag-ns-btn" data-i18n="compactProgress.btnBackSettings">返回压缩设置</button>
    </div>
  </header>

  <div class="ag-ns-group">
    <h2 class="ag-ns-group-title" data-i18n="compactProgress.sec.live">当前压缩任务</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div id="ag-cp-stage-title" class="ag-ns-row-title">--</div>
            <div id="ag-cp-stage-desc" class="ag-ns-row-desc">--</div>
          </div>
          <span id="ag-cp-stage-pill" class="ag-ns-pill">--</span>
        </div>
        <div id="ag-cp-bar-track" class="ag-cp-bar-track" data-indeterminate="false" role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <div id="ag-cp-bar-fill" class="ag-cp-bar-fill"></div>
        </div>
        <div class="ag-ns-grid-2">
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.session">当前会话</span>
            <span id="ag-cp-session" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.source">触发来源</span>
            <span id="ag-cp-source" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.elapsed">已用时间</span>
            <span id="ag-cp-elapsed" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.autoState">自动发送与恢复</span>
            <span id="ag-cp-auto-state" class="ag-ns-v">--</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="ag-ns-group">
    <h2 class="ag-ns-group-title" data-i18n="compactProgress.sec.context">压缩前后可信上下文</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div class="ag-ns-grid-2">
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.before">压缩前实报</span>
            <span id="ag-cp-before" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.after">当前最新读数</span>
            <span id="ag-cp-after" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.checkpoint">检查点序号</span>
            <span id="ag-cp-checkpoint" class="ag-ns-v">--</span>
          </div>
          <div class="ag-ns-kv">
            <span class="ag-ns-k" data-i18n="compactProgress.lbl.rehydrate">压缩后恢复状态</span>
            <span id="ag-cp-rehydrate" class="ag-ns-v">--</span>
          </div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-cp-btn-manual-compact" class="ag-ns-btn" data-i18n="compactProgress.btnManual">手动触发一次压缩</button>
        </div>
      </div>
    </div>
  </div>

  <div class="ag-ns-group">
    <h2 class="ag-ns-group-title" data-i18n="compactProgress.sec.events">阶段记录</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div id="ag-cp-events" class="ag-cp-events" aria-live="polite"></div>
      </div>
    </div>
  </div>
</section>
`.trim();
  }

  function renderCompactionProgressPage(root, data) {
    var container = byId(root, 'ag-cp-root');
    if (!container || !data) return;
    var setText = function (id, val) {
      var node = byId(root, id);
      if (node && node.textContent !== String(val ?? '')) node.textContent = String(val ?? '');
    };
    setText('ag-cp-stage-title', data.stageTitle || '--');
    setText('ag-cp-stage-desc', data.stageDesc || '--');
    var pill = byId(root, 'ag-cp-stage-pill');
    if (pill) {
      pill.textContent = data.stagePill || '--';
      pill.className = 'ag-ns-pill ' + (data.stagePillClass || '');
    }
    var track = byId(root, 'ag-cp-bar-track');
    var fill = byId(root, 'ag-cp-bar-fill');
    if (track && fill) {
      var indeterminate = Boolean(data.indeterminate);
      track.setAttribute('data-indeterminate', indeterminate ? 'true' : 'false');
      if (indeterminate) {
        track.removeAttribute('aria-valuenow');
        fill.style.width = '38%';
      } else {
        var pct = Number.isFinite(Number(data.progressPct)) ? Math.max(0, Math.min(100, Number(data.progressPct))) : 0;
        track.setAttribute('aria-valuenow', String(Math.round(pct)));
        fill.style.width = pct + '%';
      }
    }
    setText('ag-cp-session', data.sessionLabel || '--');
    setText('ag-cp-source', data.sourceLabel || '--');
    setText('ag-cp-elapsed', data.elapsedLabel || '--');
    setText('ag-cp-auto-state', data.autoStateLabel || '--');
    setText('ag-cp-before', data.beforeContextLabel || '--');
    setText('ag-cp-after', data.afterContextLabel || '--');
    setText('ag-cp-checkpoint', data.checkpointLabel || '--');
    setText('ag-cp-rehydrate', data.rehydrateLabel || '--');
    var manualBtn = byId(root, 'ag-cp-btn-manual-compact');
    if (manualBtn) manualBtn.disabled = Boolean(data.active || data.manualDisabled);
    var evBox = byId(root, 'ag-cp-events');
    if (evBox) {
      var list = Array.isArray(data.events) ? data.events : [];
      var sig = JSON.stringify(list);
      if (evBox.getAttribute('data-sig') !== sig) {
        evBox.setAttribute('data-sig', sig);
        if (typeof evBox.replaceChildren === 'function') evBox.replaceChildren();
        else evBox.innerHTML = '';
        var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (doc) {
          if (!list.length) {
            var emptyRow = doc.createElement('div');
            emptyRow.className = 'ag-ns-row-desc';
            emptyRow.textContent = data.emptyEventsText || '--';
            evBox.appendChild(emptyRow);
          } else {
            for (var i = 0; i < list.length; i++) {
              var row = doc.createElement('div');
              row.className = 'ag-cp-event-row';
              var msg = doc.createElement('span');
              msg.textContent = String(list[i].label || '');
              var tm = doc.createElement('span');
              tm.textContent = String(list[i].time || '');
              row.appendChild(msg);
              row.appendChild(tm);
              evBox.appendChild(row);
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // 同级独立「账号与额度」页（高密度三区排版 + 全真实链路 + 退零再充能微动效）
  // =========================================================================
  function buildHostAccountsPageHtml() {
    return `
<section id="ag-ac-root" class="ag-ns-page is-accounts-wide" aria-label="账号与额度">
  <!-- 页首：当前账号与 Google 会员等级紧凑身份卡（搜索、筛选、翻页时常驻可见） -->
  <div id="ag-ac-hero-card" class="ag-ac-hero-card">
    <div class="ag-ac-hero-left">
      <div id="ag-ac-hero-avatar" class="ag-ac-avatar" style="background:#2563eb">?</div>
      <div class="ag-ac-hero-meta">
        <div class="ag-ac-hero-name-row">
          <span id="ag-ac-hero-name" class="ag-ac-hero-name">--</span>
          <span id="ag-ac-hero-active-tag" class="ag-ac-mini-tag is-active" data-i18n="accountsPage.activeUse">当前使用</span>
          <span id="ag-ac-hero-status-tag" class="ag-ac-mini-tag is-danger" hidden></span>
        </div>
        <div id="ag-ac-hero-email" class="ag-ac-hero-email">--</div>
      </div>
    </div>
    <div id="ag-ac-hero-plan-pill" class="ag-ac-plan-pill">套餐未知</div>
  </div>

  <!-- 页头与真实操作按钮区 -->
  <header class="ag-ns-header" style="margin-bottom:14px">
    <div class="ag-ns-title-wrap">
      <h1 class="ag-ns-title">
        <span data-i18n="accountsPage.heading">账号管理与切换</span>
        <span id="ag-ac-total-badge" class="ag-ac-count-badge">0</span>
      </h1>
      <p id="ag-ac-subtitle" class="ag-ns-subtitle" data-i18n="accountsPage.subtitle">管理已登记账号、查看 5H 与 7D 配额快照与共享池对账</p>
    </div>
    <div class="ag-ns-header-links">
      <button type="button" id="ag-ac-btn-refresh" class="ag-ns-btn" data-ag-ac-action="refreshCurrent">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.45-3.72"/><path d="M13.5 2.8v2.7h-2.7"/></svg>
        <span data-i18n="accountsPage.btnRefreshCurrent">刷新当前账号</span>
      </button>
      <button type="button" id="ag-ac-btn-import-current" class="ag-ns-btn" data-ag-ac-action="importCurrent" data-i18n="accounts.importCurrent">导入当前</button>
      <button type="button" id="ag-ac-btn-import-tools" class="ag-ns-btn" data-ag-ac-action="importTools" hidden>
        <span id="ag-ac-btn-import-tools-lbl" data-i18n="accountsPage.btnImportTools">导入 Tools</span>
      </button>
      <button type="button" id="ag-ac-btn-add" class="ag-ns-btn is-primary" data-ag-ac-action="addAccount" data-i18n="accountsPage.btnAddAccount">添加账号</button>
    </div>
  </header>

  <div id="ag-ac-feedback" class="ag-ns-note-box" style="margin-bottom:12px" hidden></div>

  <!-- 搜索、真实套餐筛选胶囊、高余量优先、隐藏邮箱与列表/卡片视图切换 -->
  <div class="ag-ac-toolbar">
    <div class="ag-ac-search-wrap">
      <svg class="ag-ac-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 13.8 13.8"/></svg>
      <input type="search" id="ag-ac-search" class="ag-ac-search-input" data-i18n-placeholder="accountsPage.searchPlaceholder" placeholder="搜索账号名、邮箱或备注" autocomplete="off" />
    </div>
    <div id="ag-ac-plan-filters" class="ag-ac-filter-pills" role="tablist" aria-label="按套餐筛选"></div>
    <button type="button" id="ag-ac-btn-hide-email" class="ag-ns-btn" aria-pressed="false" data-ag-ac-toggle-hide-email="true" title="隐藏邮箱">
      <svg id="ag-ac-eye-icon" class="ag-ac-eye-open" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="1.9"/></svg>
      <span id="ag-ac-btn-hide-email-lbl" data-i18n="accountsPage.hideEmail">隐藏邮箱</span>
    </button>
    <div class="ag-ns-seg" role="radiogroup" id="ag-ac-view-toggle" aria-label="视图切换">
      <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-ac-view="list" data-i18n="accountsPage.viewList">列表</button>
      <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-ac-view="cards" data-i18n="accountsPage.viewCards">卡片</button>
    </div>
  </div>

  <!-- 账号主表格/卡片容器（三区高密度排版） -->
  <div class="ag-ns-group">
    <div class="ag-ns-card">
      <div id="ag-ac-list-header" class="ag-ac-list-header">
        <span data-i18n="accountsPage.colAccount">账号</span>
        <span data-i18n="accountsPage.colQuota">模型配额</span>
        <span class="ag-ac-col-right-head" data-i18n="accountsPage.colActions">操作</span>
      </div>
      <div id="ag-ac-rows" class="ag-ac-rows"></div>
      <div id="ag-ac-pagination" class="ag-ac-pagination" hidden>
        <span id="ag-ac-page-summary"></span>
        <div class="ag-ac-page-btns">
          <button type="button" id="ag-ac-page-prev" class="ag-ac-op-btn" data-i18n="accountsPage.pagePrev">上一页</button>
          <span id="ag-ac-page-num" style="font-variant-numeric:tabular-nums">1 / 1</span>
          <button type="button" id="ag-ac-page-next" class="ag-ac-op-btn" data-i18n="accountsPage.pageNext">下一页</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 页尾独立折叠区 1：历史阈值提醒规则 -->
  <details id="ag-ns-sec-accounts" class="ag-ac-details-section" data-section-id="settings-accounts-card">
    <summary class="ag-ac-details-summary">
      <span data-i18n="accountsPage.secRules">阈值提醒与历史规则</span>
      <span id="ag-ns-autoswitch-pill" class="ag-ns-pill" data-i18n="accountsPage.prodAlertOnlyBadge">本地提醒模式</span>
    </summary>
    <div class="ag-ac-details-body">
      <div class="ag-ns-row ag-ns-row-stack">
        <div id="ag-ns-autoswitch-note" class="ag-ns-note-box" data-i18n="accountsPage.prodAutoSwitchNotice">消费版已停用自动切号后台派发与缓存保活外发，以下规则仅保留本地阈值提醒与离线回归验证</div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="accounts.quotaTargetLabel">监控额度</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoSwitchTarget.desc">仅从 Gemini 或 Claude / GPT 的 5H 与 7D 额度中选择具体监控项</div>
        </div>
        <div class="ag-ns-control">
          <select id="ag-ns-sel-autoSwitchTarget" class="ag-ns-select" data-ag-ns-select="autoSwitchTarget">
            <option id="ag-ns-opt-legacy-target" value="" disabled hidden data-i18n="accounts.target.legacyPlaceholder">旧规则待重选 · 请选择具体监控额度</option>
            <optgroup label="Gemini" data-i18n-label="accounts.target.groupGemini">
              <option value="shared_gemini_main:5h" data-i18n="accounts.target.gemini5h">Gemini 5H 额度</option>
              <option value="shared_gemini_main:7d" data-i18n="accounts.target.gemini7d">Gemini 7D 额度</option>
            </optgroup>
            <optgroup label="Claude / GPT" data-i18n-label="accounts.target.group3p">
              <option value="shared_3p_pool:5h" data-i18n="accounts.target.claude5h">Claude / GPT 5H 额度</option>
              <option value="shared_3p_pool:7d" data-i18n="accounts.target.claude7d">Claude / GPT 7D 额度</option>
            </optgroup>
          </select>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.autoSwitchRule.title">触发口径与阈值百分比</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoSwitchRule.desc">修改规则后请点击保存规则</div>
        </div>
        <div class="ag-ns-control ag-ns-control-pair">
          <select id="ag-ns-sel-autoSwitchMetric" class="ag-ns-select" data-ag-ns-select="autoSwitchMetric">
            <option value="remaining_pct" data-i18n="accounts.modeRemaining">剩余额度低于或等于</option>
            <option value="used_pct" data-i18n="accounts.modeUsed">已用额度达到或超过</option>
          </select>
          <input id="ag-ns-inp-autoSwitchThreshold" class="ag-ns-input ag-ns-input-sm" type="number" min="1" max="95" value="10" data-ag-ns-input="autoSwitchThreshold" />
        </div>
      </div>

      <div class="ag-ns-row ag-ns-row-stack">
        <div id="ag-ns-autoswitch-live-summary" class="ag-ns-note-box"></div>
      </div>

      <div class="ag-ns-row ag-ns-row-stack">
        <div class="ag-ns-row-text">
          <div id="ag-ac-cand-header" class="ag-ns-row-title" data-i18n="accounts.candidatesLabel">已登记账号候选池</div>
          <div id="ag-ns-autoswitch-candidates" class="ag-ns-cand-list"></div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-btn-save-autoswitch" class="ag-ns-btn is-primary" data-ag-ac-action="saveAutoSwitch" data-i18n="accounts.saveRule">保存切号规则</button>
        </div>
      </div>
    </div>
  </details>

  <!-- 页尾独立折叠区 2：本机消耗与共享账号额度对照 -->
  <details id="ag-ac-sec-compare" class="ag-ac-details-section">
    <summary class="ag-ac-details-summary">
      <span data-i18n="accountsPage.secCompare">本机消耗与共享账号额度对照</span>
      <span id="ag-ac-compare-count" class="ag-ac-count-badge">0</span>
    </summary>
    <div class="ag-ac-details-body">
      <div id="ag-ac-compare-list" class="ag-ns-row ag-ns-row-stack"></div>
    </div>
  </details>

  <div id="ag-ac-toast" class="ag-ns-toast" role="status" aria-live="polite" hidden></div>
</section>
`.trim();
  }

  function createAccountsUiLocalState() {
    return {
      searchQuery: '',
      planFilter: 'all',
      sortByHighQuota: false,
      viewMode: 'list', // 'list' | 'cards'
      page: 1,
      pageSize: 8,
      expandedIds: new Set(),
      revealedEmailIds: new Set(),
      pendingConfirm: null, // { type: 'remove', email: string, stableId: string, isActive: boolean, busy: boolean }
      switchingEmail: '',
      refreshingEmails: new Set(),
      refreshMotions: new Map(), // normEmail -> { seq, phase, startedAtMs, drainDoneAtMs, rafId, timerId, prevSnapshots: Map<barKey, {pct, tone, hasVal}>, pendingResult }
      lastData: null,
      lastHeroSig: '',
      lastFiltersSig: '',
      lastRowsSig: '',
      lastCompareSig: '',
      pointerLockUntil: 0,
      deferredRenderTimer: null,
      deferredData: null,
      itemMap: new Map() // stableId -> acc
    };
  }

  function isValidAvatarSrcSafe(url) {
    if (typeof url !== 'string') return false;
    var s = url.trim();
    return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(s) || /^https?:\/\//i.test(s);
  }

  function computePrimaryQuotaScore(acc) {
    if (!acc || acc.suspended) return -2;
    var pools = Array.isArray(acc.quotaSnapshot?.pools) ? acc.quotaSnapshot.pools.filter(Boolean) : [];
    if (!pools.length) return -1;
    var best = -1;
    for (var i = 0; i < pools.length; i++) {
      var pl = pools[i];
      if (!pl || pl.noPermission) continue;
      var bkts = Array.isArray(pl.buckets) ? pl.buckets.filter(Boolean) : [];
      var b5 = bkts.find(function (b) { return b.windowKey === '5h' || b.windowShort === '5h'; });
      var frac = b5?.remainingFraction ?? bkts[0]?.remainingFraction ?? pl.remainingFraction;
      if (frac !== null && frac !== undefined && Number.isFinite(Number(frac))) {
        var score = Number(frac) * 100 + (pl.poolKey === 'shared_gemini_main' ? 0.5 : 0);
        if (score > best) best = score;
      }
    }
    return best;
  }

  function pickAvatarColor(seed) {
    var palette = ['#2563eb', '#059669', '#d97706', '#0891b2', '#db2777', '#4f46e5'];
    var str = String(seed || 'a');
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  function fillAvatarBox(doc, box, acc) {
    if (!box || !doc) return;
    if (typeof box.replaceChildren === 'function') box.replaceChildren();
    else box.innerHTML = '';
    var avatarUrl = isValidAvatarSrcSafe(acc?.profilePictureUrl) ? String(acc.profilePictureUrl).trim() : '';
    var fallbackInit = String(acc?.name || acc?.email || '?').trim().charAt(0).toUpperCase() || '?';
    var fallbackBg = pickAvatarColor(acc?.email || acc?.name);
    if (avatarUrl) {
      var img = doc.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        try { img.remove(); } catch { }
        box.style.background = fallbackBg;
        box.textContent = fallbackInit;
      });
      box.style.background = 'transparent';
      box.appendChild(img);
    } else {
      box.style.background = fallbackBg;
      box.textContent = fallbackInit;
    }
  }

  function prefersReducedMotionSafe(node) {
    try {
      var win = (node && node.ownerDocument && node.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.matchMedia === 'function') {
        return Boolean(win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      }
    } catch { }
    return false;
  }

  function formatAccountLastUsed(acc, labels) {
    if (!acc) return '—';
    if (acc.isActive) return labels.activeUse;
    if (Number.isFinite(Number(acc.lastUsedAtMs)) && Number(acc.lastUsedAtMs) > 0) {
      try {
        var d = new Date(Number(acc.lastUsedAtMs));
        var y = d.getFullYear();
        var mo = String(d.getMonth() + 1).padStart(2, '0');
        var da = String(d.getDate()).padStart(2, '0');
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return y + '/' + mo + '/' + da + ' ' + hh + ':' + mm;
      } catch { }
    }
    return '—';
  }

  function resolvePlanBadgeMeta(acc, labels) {
    var code = String(acc?.tierCode || '').trim().toUpperCase();
    var raw = String(acc?.planLabel || acc?.tierName || acc?.tierId || '').trim();
    var low = raw.toLowerCase();
    if (code === 'ULTRA' || low.includes('ultra')) return { key: 'ultra', badgeText: 'ULTRA', pillText: 'Google AI Ultra', cls: 'is-ultra' };
    if (code === 'PRO' || low.includes('pro')) return { key: 'pro', badgeText: 'PRO', pillText: 'Google AI Pro', cls: 'is-pro' };
    if (code === 'PLUS' || low.includes('plus')) return { key: 'plus', badgeText: 'PLUS', pillText: 'Google AI Plus', cls: 'is-pro' };
    if (code === 'FREE' || low.includes('free') || low.includes('standard') || low.includes('免费') || low.includes('免費')) {
      return { key: 'free', badgeText: 'FREE', pillText: 'Free', cls: 'is-free' };
    }
    if (!raw || raw === '未知' || /^unknown$/i.test(raw)) {
      return { key: 'unknown', badgeText: labels.planUnknown, pillText: labels.planUnknown, cls: 'is-free' };
    }
    return { key: raw.toLowerCase(), badgeText: raw, pillText: raw, cls: '' };
  }

  function resolvePlanFilterKey(acc) {
    return resolvePlanBadgeMeta(acc, { planUnknown: 'unknown' }).key;
  }

  function resolvePlanDisplayName(key, labels) {
    if (key === 'all') return labels.filterAll;
    if (key === 'ultra') return 'Ultra';
    if (key === 'pro') return 'Pro';
    if (key === 'plus') return 'Plus';
    if (key === 'free') return 'Free';
    if (key === 'unknown') return labels.planUnknown;
    return key;
  }

  function formatHumanPoolTitle(poolKey, poolTitle) {
    var pk = String(poolKey || '').trim().toLowerCase();
    var pt = String(poolTitle || '').trim();
    if (pk === 'shared_gemini_main' || pk === 'gemini_generic_main') return 'Gemini';
    if (pk === 'shared_3p_pool' || pk === 'claude_gpt_pool') return 'Claude / GPT';
    if (pk === 'shared_gemini_argon') return 'Gemini 4 Argon';
    if (pk === 'shared_gemini_carbon') return 'Gemini 4 Carbon';
    if (pt && !/^shared_|^group_|_main$|_pool$/i.test(pt)) return pt;
    if (pk.includes('argon')) return 'Gemini 4 Argon';
    if (pk.includes('carbon')) return 'Gemini 4 Carbon';
    if (pk.includes('claude') || pk.includes('3p') || pk.includes('gpt')) return 'Claude / GPT';
    if (pk.includes('gemini')) return 'Gemini';
    return 'Model Pool';
  }

  function formatPoolCountdown(resetTimeIso) {
    if (!resetTimeIso) return '';
    var ms = Date.parse(resetTimeIso);
    if (!Number.isFinite(ms)) return '';
    var diff = ms - Date.now();
    if (diff <= 0) return '';
    var totalMin = Math.floor(diff / 60000);
    var days = Math.floor(totalMin / 1440);
    var hrs = Math.floor((totalMin % 1440) / 60);
    var mins = totalMin % 60;
    if (days > 0) return days + 'd ' + hrs + 'h';
    if (hrs > 0) return hrs + 'h ' + mins + 'm';
    return Math.max(1, mins) + 'm';
  }

  function isCountdownSoon(resetTimeIso) {
    if (!resetTimeIso) return false;
    var ms = Date.parse(resetTimeIso);
    if (!Number.isFinite(ms)) return false;
    var diff = ms - Date.now();
    return diff > 0 && diff <= 2 * 3600 * 1000;
  }

  function resolveQuotaTone(pct, hasVal) {
    if (!hasVal || pct === null || pct === undefined || !Number.isFinite(Number(pct))) return 'muted';
    if (pct <= 15) return 'danger';
    if (pct <= 40) return 'warn';
    return 'ok';
  }

  /**
   * 提取单个账号的标准 2 列紧凑配额胶囊列表：
   * - 第 1 行左：Gemini 5H，第 1 行右：Claude / GPT 5H
   * - 第 2 行左：Gemini 周配额，第 2 行右：Claude / GPT 周配额
   * - 第 3 行通栏：独立高阶池（如 Gemini 4 Argon / Carbon 等）
   */
  function buildAccountQuotaBarsSpec(acc, labels) {
    var pools = Array.isArray(acc?.quotaSnapshot?.pools) ? acc.quotaSnapshot.pools.filter(Boolean) : [];
    if (!pools.length) return [];

    var findPool = function (key) {
      return pools.find(function (p) { return p && p.poolKey === key; }) || null;
    };
    var pickBucket = function (pool, targetWin) {
      if (!pool) return null;
      var bkts = Array.isArray(pool.buckets) ? pool.buckets.filter(Boolean) : [];
      var hit = bkts.find(function (b) {
        var wk = String(b.windowKey || '').toLowerCase();
        var ws = String(b.windowShort || '').toLowerCase();
        var bid = String(b.bucketId || '').toLowerCase();
        if (targetWin === '5h') return wk === '5h' || ws === '5h' || bid.includes('5h') || bid.includes('hour');
        return wk === 'weekly' || ws === '7d' || bid.includes('week') || bid.includes('7d');
      }) || null;
      if (hit) return hit;
      if (bkts.length === 1 && targetWin === 'weekly' && String(bkts[0].windowKey || '').toLowerCase() !== '5h') {
        return bkts[0];
      }
      return null;
    };
    var makeBar = function (barKey, labelText, bucket, pool, extraOpts) {
      var opts = extraOpts || {};
      var frac = bucket ? bucket.remainingFraction : (opts.allowPoolFallback ? pool?.remainingFraction : null);
      var hasVal = frac !== null && frac !== undefined && Number.isFinite(Number(frac)) && !pool?.noPermission;
      var pct = hasVal ? Math.max(0, Math.min(100, Math.round(Number(frac) * 100))) : null;
      var resetIso = (bucket && (bucket.resetTimeIso || bucket.resetTime)) || (opts.allowPoolFallback ? (pool?.resetTimeIso || pool?.resetTime) : null) || null;
      return {
        barKey: barKey,
        label: labelText,
        pct: pct,
        hasVal: hasVal,
        tone: resolveQuotaTone(pct, hasVal),
        resetIso: resetIso,
        countdownText: formatPoolCountdown(resetIso),
        isSoon: isCountdownSoon(resetIso),
        dotKind: opts.dotKind || 'gemini',
        fullRow: Boolean(opts.fullRow),
        isArgon: Boolean(opts.isArgon)
      };
    };

    var gemPool = findPool('shared_gemini_main');
    var p3Pool = findPool('shared_3p_pool');
    var gem5h = pickBucket(gemPool, '5h');
    var gem7d = pickBucket(gemPool, 'weekly');
    var p35h = pickBucket(p3Pool, '5h');
    var p37d = pickBucket(p3Pool, 'weekly');

    var bars = [];
    // 行 1：5H 并排（若双池都无 5H 例如 Free 账号则不伪造 5H 条）
    var hasAny5h = Boolean(gem5h || p35h);
    if (hasAny5h) {
      if (gem5h) {
        bars.push(makeBar('gemini:5h', labels.poolGemini5h || 'Gemini 5H', gem5h, gemPool, { dotKind: 'gemini' }));
      } else if (gemPool && !gem7d) {
        bars.push(makeBar('gemini:5h', labels.poolGemini5h || 'Gemini 5H', null, gemPool, { dotKind: 'gemini', allowPoolFallback: true }));
      }
      if (p35h) {
        bars.push(makeBar('3p:5h', labels.poolClaude5h || 'Claude / GPT 5H', p35h, p3Pool, { dotKind: '3p' }));
      } else if (p3Pool && !p37d) {
        bars.push(makeBar('3p:5h', labels.poolClaude5h || 'Claude / GPT 5H', null, p3Pool, { dotKind: '3p', allowPoolFallback: true }));
      }
    }

    // 行 2：周配额并排
    if (gem7d) {
      bars.push(makeBar('gemini:7d', labels.poolGeminiWeekly || 'Gemini 周配额', gem7d, gemPool, { dotKind: 'gemini' }));
    } else if (gemPool && !gem5h) {
      bars.push(makeBar('gemini:7d', labels.poolGeminiWeekly || 'Gemini 周配额', null, gemPool, { dotKind: 'gemini', allowPoolFallback: true }));
    }
    if (p37d) {
      bars.push(makeBar('3p:7d', labels.poolClaudeWeekly || 'Claude / GPT 周配额', p37d, p3Pool, { dotKind: '3p' }));
    } else if (p3Pool && !p35h) {
      bars.push(makeBar('3p:7d', labels.poolClaudeWeekly || 'Claude / GPT 周配额', null, p3Pool, { dotKind: '3p', allowPoolFallback: true }));
    }

    // 行 3+：独立高阶池（如 Argon / Carbon 等）单独通栏展示
    for (var i = 0; i < pools.length; i++) {
      var pl = pools[i];
      if (!pl || pl.poolKey === 'shared_gemini_main' || pl.poolKey === 'shared_3p_pool') continue;
      if (pl.noPermission) continue;
      var isArgon = pl.poolKey === 'shared_gemini_argon' || String(pl.title || '').toLowerCase().includes('argon');
      var isCarbon = pl.poolKey === 'shared_gemini_carbon' || String(pl.title || '').toLowerCase().includes('carbon');
      var bkt7d = pickBucket(pl, 'weekly') || pickBucket(pl, '5h') || (Array.isArray(pl.buckets) && pl.buckets[0]) || null;
      var hasAnyVal = (bkt7d && bkt7d.remainingFraction !== null && bkt7d.remainingFraction !== undefined)
        || (pl.remainingFraction !== null && pl.remainingFraction !== undefined);
      if (!hasAnyVal) continue;
      var lbl = isArgon
        ? (labels.poolArgonWeekly || 'Gemini 4 Argon 周配额')
        : (isCarbon ? (labels.poolCarbonWeekly || 'Gemini 4 Carbon 周配额') : (formatHumanPoolTitle(pl.poolKey, pl.title) + ' ' + (labels.weeklyShort || '周配额')));
      bars.push(makeBar(pl.poolKey + ':dedicated', lbl, bkt7d, pl, {
        dotKind: isArgon ? 'argon' : 'gemini',
        fullRow: true,
        isArgon: isArgon,
        allowPoolFallback: true
      }));
    }

    return bars;
  }

  function createIconSvg(doc, kind) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', kind === 'clock' ? '10' : '13');
    svg.setAttribute('height', kind === 'clock' ? '10' : '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.55');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var addPath = function (d) {
      var p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    };
    var addCircle = function (cx, cy, r) {
      var c = doc.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(r));
      svg.appendChild(c);
    };
    if (kind === 'refresh') {
      addPath('M13.5 8a5.5 5.5 0 1 1-1.45-3.72');
      addPath('M13.5 2.8v2.7h-2.7');
    } else if (kind === 'switch') {
      addPath('M3 5.5h9.5');
      addPath('M9.8 2.8 12.5 5.5 9.8 8.2');
      addPath('M13 10.5H3.5');
      addPath('M6.2 7.8 3.5 10.5 6.2 13.2');
    } else if (kind === 'check') {
      addPath('M3.2 8.2 6.4 11.4 12.8 4.8');
    } else if (kind === 'detail') {
      addCircle(8, 8, 5.8);
      addPath('M8 7.2v3.6');
      addPath('M8 4.9h.01');
    } else if (kind === 'remove') {
      addPath('M3.2 4.4h9.6');
      addPath('M6 4.4V3.2h4v1.2');
      addPath('M4.6 4.4l.6 8.2a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.2');
    } else if (kind === 'support') {
      addCircle(8, 8, 5.8);
      addPath('M6.4 6.2a1.7 1.7 0 0 1 3.2.8c0 1.1-1.6 1.4-1.6 2.4');
      addPath('M8 11.6h.01');
    } else if (kind === 'clock') {
      addCircle(8, 8, 6);
      addPath('M8 4.8V8l2.2 1.4');
    }
    return svg;
  }

  // =========================================================================
  // 动效 2：配额刷新进度条「先归零 → 纯空换气 → 从零同频充能」状态机
  // =========================================================================
  function cancelMotionTimers(motion) {
    if (!motion) return;
    if (motion.rafId) {
      try { cancelAnimationFrame(motion.rafId); } catch { }
      motion.rafId = 0;
    }
    if (motion.timerId) {
      clearTimeout(motion.timerId);
      motion.timerId = null;
    }
  }

  function findRowElementByEmail(root, email) {
    if (!root || !email) return null;
    var norm = String(email).trim().toLowerCase();
    var container = byId(root, 'ag-ac-root');
    if (!container || typeof container.querySelectorAll !== 'function') return null;
    var rows = container.querySelectorAll('.ag-ac-item[data-account-email]');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-account-email') || '').toLowerCase() === norm) {
        return rows[i];
      }
    }
    return null;
  }

  function setBarVisualState(barEl, pctNum, tone, hasVal, labelFallback) {
    if (!barEl) return;
    var fill = barEl.querySelector('.ag-ac-pool-fill');
    var pctEl = barEl.querySelector('.ag-ac-pool-pct');
    var safePct = hasVal ? Math.max(0, Math.min(100, pctNum)) : 0;
    if (fill) {
      fill.setAttribute('data-tone', hasVal ? tone : 'muted');
      fill.style.width = safePct + '%';
    }
    if (pctEl) {
      pctEl.setAttribute('data-tone', hasVal ? tone : 'muted');
      pctEl.textContent = hasVal ? (Math.round(safePct) + '%') : (labelFallback || '未知');
    }
    barEl.classList.toggle('is-exhausted', Boolean(hasVal && Math.round(safePct) === 0));
  }

  function beginAccountQuotaRefreshMotion(root, email) {
    var container = byId(root, 'ag-ac-root');
    if (!container || !email) return null;
    var localState = container._agAcLocalState;
    if (!localState) return null;
    var norm = String(email).trim().toLowerCase();
    if (!norm) return null;

    var prevMotion = localState.refreshMotions.get(norm);
    if (prevMotion) cancelMotionTimers(prevMotion);

    localState.refreshingEmails.add(norm);
    var reduced = prefersReducedMotionSafe(container);
    var rowEl = findRowElementByEmail(root, norm);
    var rfBtn = rowEl ? rowEl.querySelector('[data-ac-op="refresh"]') : null;
    if (rfBtn) {
      rfBtn.classList.add('is-spinning');
      rfBtn.disabled = true;
    }
    var topBtn = byId(root, 'ag-ac-btn-refresh');
    if (topBtn && localState.lastData?.activeAccount && String(localState.lastData.activeAccount.email || '').toLowerCase() === norm) {
      topBtn.classList.add('is-spinning');
    }

    var prevSnapshots = new Map();
    var barNodes = rowEl ? Array.from(rowEl.querySelectorAll('.ag-ac-pool-capsule[data-bar-key]')) : [];
    for (var i = 0; i < barNodes.length; i++) {
      var bn = barNodes[i];
      var bk = bn.getAttribute('data-bar-key');
      var curPctAttr = bn.getAttribute('data-bar-pct');
      var hasVal = curPctAttr !== null && curPctAttr !== '' && Number.isFinite(Number(curPctAttr));
      var curPct = hasVal ? Number(curPctAttr) : 0;
      var curTone = bn.getAttribute('data-bar-tone') || 'ok';
      prevSnapshots.set(bk, { pct: curPct, tone: curTone, hasVal: hasVal });
    }

    var motion = {
      seq: ((prevMotion && prevMotion.seq) || 0) + 1,
      email: norm,
      phase: reduced ? 'waiting' : 'draining',
      reduced: reduced,
      startedAtMs: Date.now(),
      drainDurationMs: reduced ? 0 : 180,
      pauseDurationMs: reduced ? 0 : 50,
      chargeDurationMs: reduced ? 0 : 420,
      drainDoneAtMs: reduced ? Date.now() : (Date.now() + 180),
      rafId: 0,
      timerId: null,
      prevSnapshots: prevSnapshots,
      pendingResult: null
    };
    localState.refreshMotions.set(norm, motion);

    if (reduced || !barNodes.length) {
      for (var r = 0; r < barNodes.length; r++) {
        barNodes[r].classList.add('is-recharging-wait');
      }
      return motion;
    }

    // 阶段 1：退潮归零（180ms 真实回落到 0%，露出 100% 纯净空槽，右侧百分比同频回落）
    var win = container.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    var rafFn = (win && typeof win.requestAnimationFrame === 'function') ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(() => fn(Date.now()), 16);
    var startTs = Date.now();
    var stepDrain = function () {
      if (localState.refreshMotions.get(norm) !== motion) return;
      var elapsed = Date.now() - startTs;
      var progress = Math.max(0, Math.min(1, elapsed / motion.drainDurationMs));
      // easeInCubic 利落退潮
      var eased = 1 - Math.pow(1 - progress, 2);
      var curRow = findRowElementByEmail(root, norm);
      var curBars = curRow ? Array.from(curRow.querySelectorAll('.ag-ac-pool-capsule[data-bar-key]')) : [];
      for (var j = 0; j < curBars.length; j++) {
        var bNode = curBars[j];
        var key = bNode.getAttribute('data-bar-key');
        var snap = prevSnapshots.get(key);
        if (!snap || !snap.hasVal) continue;
        var val = snap.pct * (1 - eased);
        setBarVisualState(bNode, val, snap.tone, true);
      }
      if (progress < 1) {
        motion.rafId = rafFn(stepDrain);
      } else {
        motion.rafId = 0;
        motion.phase = 'waiting';
        motion.drainDoneAtMs = Date.now();
        for (var k = 0; k < curBars.length; k++) {
          var bn2 = curBars[k];
          var snap2 = prevSnapshots.get(bn2.getAttribute('data-bar-key'));
          if (snap2 && snap2.hasVal) {
            setBarVisualState(bn2, 0, snap2.tone, true);
            bn2.classList.remove('is-exhausted');
          }
          bn2.classList.add('is-recharging-wait');
        }
        if (motion.pendingResult) {
          var resPayload = motion.pendingResult;
          motion.pendingResult = null;
          runChargeFromZero(root, localState, motion, resPayload);
        }
      }
    };
    motion.rafId = rafFn(stepDrain);
    return motion;
  }

  function runChargeFromZero(root, localState, motion, resultPayload) {
    var norm = motion.email;
    if (localState.refreshMotions.get(norm) !== motion) return;

    var container = byId(root, 'ag-ac-root');
    var ok = Boolean(resultPayload && resultPayload.ok);
    var nextData = (resultPayload && resultPayload.data) || localState.lastData;

    // 停转按钮并移除空槽呼吸，但保留 50ms 纯空换气再开始从 0% 上升
    var startCharge = function () {
      if (localState.refreshMotions.get(norm) !== motion) return;
      motion.phase = 'charging';

      // 先以最新真实数据重绘该行（但条宽初态强制锁在 0%），确保新增的池（如 Argon）与最新倒计时立即就位
      localState.refreshingEmails.delete(norm);
      if (nextData) {
        localState.lastData = nextData;
        renderHostAccountsPage(root, nextData, { forceRowEmail: norm, lockZeroForEmail: norm });
      }

      var curRow = findRowElementByEmail(root, norm);
      var curBars = curRow ? Array.from(curRow.querySelectorAll('.ag-ac-pool-capsule[data-bar-key]')) : [];
      var targets = [];
      for (var i = 0; i < curBars.length; i++) {
        var bNode = curBars[i];
        bNode.classList.remove('is-recharging-wait');
        var bk = bNode.getAttribute('data-bar-key');
        var prevSnap = motion.prevSnapshots.get(bk);
        if (!ok && prevSnap && prevSnap.hasVal) {
          targets.push({ node: bNode, targetPct: prevSnap.pct, tone: prevSnap.tone, hasVal: true });
        } else {
          var pctAttr = bNode.getAttribute('data-bar-pct');
          var hasV = pctAttr !== null && pctAttr !== '' && Number.isFinite(Number(pctAttr));
          var tPct = hasV ? Math.max(0, Math.min(100, Number(pctAttr))) : 0;
          var tTone = bNode.getAttribute('data-bar-tone') || resolveQuotaTone(tPct, hasV);
          targets.push({ node: bNode, targetPct: tPct, tone: tTone, hasVal: hasV });
        }
      }

      if (motion.reduced || !targets.length) {
        for (var m = 0; m < targets.length; m++) {
          setBarVisualState(targets[m].node, targets[m].targetPct, targets[m].tone, targets[m].hasVal);
        }
        finishMotionCleanup(root, localState, motion);
        return;
      }

      var win = container && container.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
      var rafFn = (win && typeof win.requestAnimationFrame === 'function') ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(() => fn(Date.now()), 16);
      var chargeStartTs = Date.now();
      var stepCharge = function () {
        if (localState.refreshMotions.get(norm) !== motion) return;
        var elapsed = Date.now() - chargeStartTs;
        var progress = Math.max(0, Math.min(1, elapsed / motion.chargeDurationMs));
        var eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        for (var tIdx = 0; tIdx < targets.length; tIdx++) {
          var item = targets[tIdx];
          if (!item.hasVal) continue;
          // 目标为 0% 时保持纯净空槽不回升
          var val = item.targetPct <= 0 ? 0 : (item.targetPct * eased);
          setBarVisualState(item.node, val, item.tone, true);
        }
        if (progress < 1) {
          motion.rafId = rafFn(stepCharge);
        } else {
          motion.rafId = 0;
          for (var fIdx = 0; fIdx < targets.length; fIdx++) {
            var fin = targets[fIdx];
            setBarVisualState(fin.node, fin.targetPct, fin.tone, fin.hasVal);
          }
          finishMotionCleanup(root, localState, motion);
        }
      };
      motion.rafId = rafFn(stepCharge);
    };

    if (motion.pauseDurationMs > 0) {
      motion.phase = 'pausing';
      motion.timerId = setTimeout(function () {
        motion.timerId = null;
        startCharge();
      }, motion.pauseDurationMs);
    } else {
      startCharge();
    }
  }

  function finishMotionCleanup(root, localState, motion) {
    var norm = motion.email;
    cancelMotionTimers(motion);
    if (localState.refreshMotions.get(norm) === motion) {
      localState.refreshMotions.delete(norm);
    }
    localState.refreshingEmails.delete(norm);
    var topBtn = byId(root, 'ag-ac-btn-refresh');
    if (topBtn && localState.refreshingEmails.size === 0) {
      topBtn.classList.remove('is-spinning');
    }
    var curRow = findRowElementByEmail(root, norm);
    var rfBtn = curRow ? curRow.querySelector('[data-ac-op="refresh"]') : null;
    if (rfBtn) {
      rfBtn.classList.remove('is-spinning');
      rfBtn.disabled = false;
    }
    if (localState.lastData) {
      renderHostAccountsPage(root, localState.lastData);
    }
  }

  function completeAccountQuotaRefreshMotion(root, email, resultPayload) {
    var container = byId(root, 'ag-ac-root');
    if (!container || !email) return false;
    var localState = container._agAcLocalState;
    if (!localState) return false;
    var norm = String(email).trim().toLowerCase();
    var motion = localState.refreshMotions.get(norm);
    if (!motion) {
      localState.refreshingEmails.delete(norm);
      if (resultPayload && resultPayload.data) {
        renderHostAccountsPage(root, resultPayload.data);
      }
      return false;
    }
    if (motion.phase === 'draining') {
      motion.pendingResult = resultPayload || { ok: true };
      return true;
    }
    runChargeFromZero(root, localState, motion, resultPayload || { ok: true });
    return true;
  }

  function initHostAccountsPage(root, callbacks) {
    var container = byId(root, 'ag-ac-root');
    if (!container || container.dataset?.agAcBound === '1') return;
    if (container.dataset) container.dataset.agAcBound = '1';

    var cbs = callbacks || {};
    var localState = createAccountsUiLocalState();
    container._agAcLocalState = localState;
    container._agAcCallbacks = cbs;

    var searchEl = byId(root, 'ag-ac-search');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        localState.searchQuery = String(searchEl.value || '').trim();
        localState.page = 1;
        if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
      });
    }

    var viewToggle = byId(root, 'ag-ac-view-toggle');
    if (viewToggle) {
      viewToggle.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-ac-view]') : null;
        if (!btn) return;
        var nextView = btn.getAttribute('data-ac-view') === 'cards' ? 'cards' : 'list';
        if (nextView === localState.viewMode) return;
        localState.viewMode = nextView;
        if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
      });
    }

    var hideEmailBtn = byId(root, 'ag-ac-btn-hide-email');
    if (hideEmailBtn) {
      hideEmailBtn.addEventListener('click', function () {
        if (typeof cbs.onAction === 'function') {
          cbs.onAction('toggleHideEmail', null);
        }
      });
    }

    var filtersEl = byId(root, 'ag-ac-plan-filters');
    if (filtersEl) {
      filtersEl.addEventListener('click', function (e) {
        var sortBtn = e.target && e.target.closest ? e.target.closest('[data-ac-sort]') : null;
        if (sortBtn) {
          localState.sortByHighQuota = !localState.sortByHighQuota;
          localState.page = 1;
          var lbls = localState.lastData?.labels || {};
          showToast(root, localState.sortByHighQuota ? (lbls.sortHighQuotaOn || '已按最高剩余额度优先排序') : (lbls.sortHighQuotaOff || '已恢复默认排序'));
          if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true, forceFilters: true });
          return;
        }
        var btn = e.target && e.target.closest ? e.target.closest('[data-ac-plan-filter]') : null;
        if (!btn) return;
        localState.planFilter = btn.getAttribute('data-ac-plan-filter') || 'all';
        localState.page = 1;
        if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true, forceFilters: true });
      });
    }

    var prevBtn = byId(root, 'ag-ac-page-prev');
    var nextBtn = byId(root, 'ag-ac-page-next');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (localState.page > 1) {
          localState.page -= 1;
          if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        localState.page += 1;
        if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
      });
    }

    // 交互锁 + 全量稳定事件委托：防止后台轮询/状态推送在点击 mousedown->mouseup 间隙摧毁 DOM 造成死按钮
    var rowsBox = byId(root, 'ag-ac-rows');
    if (rowsBox) {
      var lockPointerWindow = function () {
        localState.pointerLockUntil = Date.now() + 320;
      };
      var releasePointerWindow = function () {
        localState.pointerLockUntil = Date.now() + 120;
        if (localState.deferredData && !localState.deferredRenderTimer) {
          localState.deferredRenderTimer = setTimeout(function () {
            localState.deferredRenderTimer = null;
            var d = localState.deferredData;
            localState.deferredData = null;
            if (d) renderHostAccountsPage(root, d);
          }, 140);
        }
      };
      rowsBox.addEventListener('pointerdown', lockPointerWindow);
      rowsBox.addEventListener('mousedown', lockPointerWindow);
      rowsBox.addEventListener('pointerup', releasePointerWindow);
      rowsBox.addEventListener('mouseup', releasePointerWindow);
      rowsBox.addEventListener('pointercancel', releasePointerWindow);

      rowsBox.addEventListener('click', function (e) {
        var target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        var itemEl = target.closest('.ag-ac-item[data-account-id]');
        var stableId = itemEl ? itemEl.getAttribute('data-account-id') : '';
        var acc = stableId ? localState.itemMap.get(stableId) : null;
        var labels = (localState.lastData && localState.lastData.labels) || {};
        var busy = Boolean(localState.lastData && localState.lastData.busy);

        // 1. 行内确认条：取消
        var cancelBtn = target.closest('[data-ac-confirm-cancel]');
        if (cancelBtn) {
          localState.pendingConfirm = null;
          if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
          return;
        }
        // 2. 行内确认条：确认移除
        var goBtn = target.closest('[data-ac-confirm-go]');
        if (goBtn) {
          var pc = localState.pendingConfirm;
          localState.pendingConfirm = null;
          if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
          if (pc && typeof cbs.onAction === 'function') {
            cbs.onAction('removeAccountConfirm', { email: pc.email, isActive: Boolean(pc.isActive), account: acc });
          }
          return;
        }
        if (!acc) return;

        // 3. 点击邮箱：复制完整邮箱并给即时 toast 反馈（若开启了全局隐藏邮箱则同时临时展开/折叠该行）
        var emailBtn = target.closest('[data-ac-email-btn]');
        if (emailBtn) {
          var fullEmail = String(acc.email || '').trim();
          var globalHidden = Boolean(localState.lastData && localState.lastData.hideEmail);
          if (globalHidden) {
            if (localState.revealedEmailIds.has(stableId)) localState.revealedEmailIds.delete(stableId);
            else localState.revealedEmailIds.add(stableId);
            if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
          }
          if (fullEmail) {
            try { navigator?.clipboard?.writeText?.(fullEmail); } catch { }
            showToast(root, (labels.emailCopied || '已复制邮箱') + ' · ' + fullEmail);
          }
          return;
        }

        // 4. 详情展开/收起：原位切换当前行展开态，不重建整个列表 DOM（零频闪且保留相邻行节点引用）
        var detailBtn = target.closest('[data-ac-toggle-detail]');
        if (detailBtn) {
          var willOpen = !localState.expandedIds.has(stableId);
          if (willOpen) localState.expandedIds.add(stableId);
          else localState.expandedIds.delete(stableId);
          var detailPanel = itemEl.querySelector('.ag-ac-detail');
          if (detailPanel) detailPanel.hidden = !willOpen;
          itemEl.classList.toggle('is-expanded', willOpen);
          detailBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          detailBtn.textContent = willOpen ? (labels.collapse || '收起') : (labels.expand || '详情');
          localState.lastRowsSig = '';
          return;
        }

        // 5. 操作按钮组（刷新 / 切号 / 移除 / 核验 / 支持）
        var opBtn = target.closest('[data-ac-op]');
        if (!opBtn) return;
        var op = opBtn.getAttribute('data-ac-op');
        if (op === 'support') {
          if (typeof cbs.onAction === 'function') {
            cbs.onAction('openSupport', { url: acc.supportUrl || 'https://antigravity.google/support', email: acc.email });
          }
          showToast(root, labels.supportBtn || '官方支持');
          return;
        }
        if (op === 'verify') {
          if (busy) {
            showToast(root, labels.busyBlocked || '已有账号操作进行中，请稍候');
            return;
          }
          if (typeof cbs.onAction === 'function') cbs.onAction('verifyAccount', { email: acc.email });
          return;
        }
        if (op === 'refresh') {
          var canRefresh = Boolean(acc.isActive || acc.hasRefreshToken);
          if (!canRefresh) {
            showToast(root, labels.noRefreshCredHint || '缺少可刷新凭据，请先重新授权或导入');
            return;
          }
          if (busy && !localState.refreshingEmails.has(String(acc.email || '').toLowerCase())) {
            showToast(root, labels.busyBlocked || '已有账号操作进行中，请稍候');
            return;
          }
          if (typeof cbs.onAction === 'function') {
            cbs.onAction('refreshAccount', { email: acc.email, isActive: Boolean(acc.isActive), hasRefreshToken: Boolean(acc.hasRefreshToken) });
          }
          return;
        }
        if (op === 'switch') {
          if (acc.isActive) {
            showToast(root, labels.alreadyActive || '该账号已是当前生效账号');
            return;
          }
          if (acc.suspended) {
            showToast(root, labels.suspendedSwitchBlocked || '该账号已标为服务停用');
            return;
          }
          if (busy) {
            showToast(root, labels.busyBlocked || '已有账号操作进行中，请稍候');
            return;
          }
          if (typeof cbs.onAction === 'function') {
            cbs.onAction('switchAccount', { email: acc.email, account: acc });
          }
          return;
        }
        if (op === 'remove') {
          if (busy) {
            showToast(root, labels.busyBlocked || '已有账号操作进行中，请稍候');
            return;
          }
          var hideEmail = Boolean(localState.lastData && localState.lastData.hideEmail);
          localState.pendingConfirm = {
            type: 'remove',
            email: acc.email,
            displayEmail: hideEmail ? (acc.maskedEmail || acc.email) : (acc.email || acc.maskedEmail),
            stableId: stableId,
            isActive: Boolean(acc.isActive)
          };
          if (localState.lastData) renderHostAccountsPage(root, localState.lastData, { forceRows: true });
        }
      });
    }

    // 复用增强下拉与规则输入事件（确保 #123 同步作用于独立账号页规则区）
    var selects = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-select]') : [];
    for (var k = 0; k < selects.length; k++) {
      (function (sel) {
        var key = sel.getAttribute('data-ag-ns-select');
        enhanceNativeSelect(container, sel);
        sel.addEventListener('change', function () {
          if (sel._agNsDdCtrl && typeof sel._agNsDdCtrl.sync === 'function') sel._agNsDdCtrl.sync();
          if (typeof cbs.onChange === 'function') cbs.onChange(key, sel.value, { sourceEl: sel });
        });
      })(selects[k]);
    }

    container.addEventListener('click', function (e) {
      if (!e.target?.closest?.('.ag-ns-dd-wrap')) {
        closeAllNativeDropdowns(container, null);
      }
    });

    var ownerDoc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (ownerDoc && typeof ownerDoc.addEventListener === 'function') {
      if (!ownerDoc._agNsActiveContainers) ownerDoc._agNsActiveContainers = new Set();
      ownerDoc._agNsActiveContainers.add(container);
      if (!ownerDoc._agNsDdOutsideBound) {
        ownerDoc._agNsDdOutsideBound = true;
        ownerDoc.addEventListener('click', function (e) {
          var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
          for (var p = 0; p < path.length; p++) {
            if (path[p]?.classList?.contains?.('ag-ns-dd-wrap')) return;
          }
          for (var box of ownerDoc._agNsActiveContainers) {
            if (box && box.isConnected) closeAllNativeDropdowns(box, null);
          }
        });
      }
    }

    var thInp = byId(root, 'ag-ns-inp-autoSwitchThreshold');
    if (thInp) {
      thInp.addEventListener('input', function () {
        if (typeof cbs.onChange === 'function') cbs.onChange('autoSwitchThreshold', thInp.value, { sourceEl: thInp });
      });
    }

    var candWrap = byId(root, 'ag-ns-autoswitch-candidates');
    if (candWrap) {
      candWrap.addEventListener('change', function (e) {
        var chk = e.target;
        if (!chk || chk.type !== 'checkbox') return;
        var chip = chk.closest ? chk.closest('.ag-ns-cand-chip') : chk.parentNode;
        if (chip && chip.classList) chip.classList.toggle('is-checked', Boolean(chk.checked));
        var checkedEmails = [];
        var allChks = candWrap.querySelectorAll ? candWrap.querySelectorAll('input[type="checkbox"]') : [];
        for (var ci = 0; ci < allChks.length; ci++) {
          if (allChks[ci].checked && allChks[ci].value) checkedEmails.push(allChks[ci].value);
        }
        if (typeof cbs.onChange === 'function') {
          cbs.onChange('autoSwitchCandidates', checkedEmails, { sourceEl: chk });
        }
      });
    }

    var actionBtns = container.querySelectorAll ? container.querySelectorAll('[data-ag-ac-action]') : [];
    for (var a = 0; a < actionBtns.length; a++) {
      (function (btn) {
        var act = btn.getAttribute('data-ag-ac-action');
        btn.addEventListener('click', function () {
          if (typeof cbs.onAction === 'function') cbs.onAction(act, null);
        });
      })(actionBtns[a]);
    }
  }

  function renderHostAccountsPage(root, data, renderOpts) {
    var container = byId(root, 'ag-ac-root');
    if (!container || !data) return;
    var localState = container._agAcLocalState || createAccountsUiLocalState();
    container._agAcLocalState = localState;
    localState.lastData = data;
    var opts = renderOpts || {};
    var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    var hideEmail = Boolean(data.hideEmail);
    var busy = Boolean(data.busy);
    if (!busy && localState.switchingEmail) {
      localState.switchingEmail = '';
    }

    var labels = Object.assign({
      activeUse: '当前使用',
      planUnknown: '套餐未知',
      unknown: '未知',
      filterAll: '全部',
      sortHighQuota: '高余量优先',
      sortHighQuotaOn: '已按最高剩余额度优先排序',
      sortHighQuotaOff: '已恢复默认排序',
      hideEmail: '隐藏邮箱',
      showEmail: '显示邮箱',
      emptyAccounts: '暂无已登记账号',
      noMatches: '无匹配账号',
      expand: '展开详情',
      collapse: '收起详情',
      switchBtn: '切换账号',
      refreshBtn: '刷新配额',
      removeBtn: '移除账号',
      verifyBtn: '手动核验',
      supportBtn: '联系支持',
      statusSuspended: '服务停用',
      statusReauth: '需重新授权',
      quotaUnsynced: '未同步',
      quotaUnknown: '未知',
      quotaFailed: '刷新失败',
      updatedAt: '更新于',
      pageSummary: '显示第 {start} 到 {end} 条 · 共 {total} 条',
      emptyCompare: '暂无本机消耗对照记录',
      currentTag: '当前',
      importToolsBtn: '导入 Tools',
      poolGemini5h: 'Gemini 5H',
      poolGeminiWeekly: 'Gemini 周配额',
      poolClaude5h: 'Claude / GPT 5H',
      poolClaudeWeekly: 'Claude / GPT 周配额',
      poolArgonWeekly: 'Gemini 4 Argon 周配额',
      poolCarbonWeekly: 'Gemini 4 Carbon 周配额',
      weeklyShort: '周配额',
      confirmSwitchBody: '确认切换当前账号至 {email} 吗',
      confirmRemoveBody: '确认移除账号 {email} 吗，历史用量记录会保留',
      confirmRemoveActiveBody: '确认移除当前活跃账号 {email} 吗，不会自动退出客户端登录',
      confirmRemoveBtn: '确认移除',
      confirmSwitchBtn: '确认切换',
      cancelBtn: '取消',
      revealEmailHint: '点击复制完整邮箱',
      emailCopied: '已复制邮箱',
      noRefreshCredHint: '缺少可刷新凭据，请先重新授权或导入',
      alreadyActive: '该账号已是当前生效账号',
      busyBlocked: '已有账号操作进行中，请稍候',
      suspendedSwitchBlocked: '该账号已标为服务停用'
    }, data.labels || {});

    var accounts = Array.isArray(data.accounts) ? data.accounts : [];
    var activeAcc = accounts.find(function (a) { return a && a.isActive; }) || data.activeAccount || null;

    var formatEmailText = function (acc, stableId) {
      if (!acc) return '--';
      if (hideEmail && !localState.revealedEmailIds.has(stableId)) {
        return acc.maskedEmail || acc.email || '--';
      }
      return acc.email || acc.maskedEmail || '--';
    };

    // 1. 页首当前账号与 Google 会员等级卡片（细粒度脏检查，无变化不重建头像 DOM）
    var heroAv = byId(root, 'ag-ac-hero-avatar');
    var heroName = byId(root, 'ag-ac-hero-name');
    var heroEmail = byId(root, 'ag-ac-hero-email');
    var heroActiveTag = byId(root, 'ag-ac-hero-active-tag');
    var heroStatusTag = byId(root, 'ag-ac-hero-status-tag');
    var heroPlan = byId(root, 'ag-ac-hero-plan-pill');
    var heroPlanMeta = resolvePlanBadgeMeta(activeAcc, labels);
    var heroEmailText = activeAcc ? (hideEmail ? (activeAcc.maskedEmail || activeAcc.email || '--') : (activeAcc.email || activeAcc.maskedEmail || '--')) : '--';
    var heroSig = JSON.stringify([
      activeAcc?.accountId || activeAcc?.email || '',
      activeAcc?.name || '',
      heroEmailText,
      activeAcc?.profilePictureUrl ? String(activeAcc.profilePictureUrl).slice(0, 64) : '',
      Boolean(activeAcc?.suspended),
      Boolean(activeAcc?.authInvalid),
      heroPlanMeta.pillText,
      heroPlanMeta.cls,
      labels.activeUse,
      labels.statusSuspended,
      labels.statusReauth
    ]);
    if (heroSig !== localState.lastHeroSig) {
      localState.lastHeroSig = heroSig;
      if (heroAv) fillAvatarBox(doc, heroAv, activeAcc);
      if (heroName) heroName.textContent = activeAcc ? (activeAcc.name || heroEmailText) : labels.emptyAccounts;
      if (heroEmail) heroEmail.textContent = heroEmailText;
      if (heroActiveTag) {
        heroActiveTag.hidden = !activeAcc;
        heroActiveTag.textContent = labels.activeUse;
      }
      if (heroStatusTag) {
        if (activeAcc && activeAcc.suspended) {
          heroStatusTag.hidden = false;
          heroStatusTag.textContent = labels.statusSuspended;
          heroStatusTag.className = 'ag-ac-mini-tag is-danger';
        } else if (activeAcc && activeAcc.authInvalid) {
          heroStatusTag.hidden = false;
          heroStatusTag.textContent = labels.statusReauth;
          heroStatusTag.className = 'ag-ac-mini-tag is-warn';
        } else {
          heroStatusTag.hidden = true;
        }
      }
      if (heroPlan) {
        heroPlan.textContent = heroPlanMeta.pillText;
        heroPlan.className = 'ag-ac-plan-pill' + (heroPlanMeta.cls ? (' ' + heroPlanMeta.cls) : '');
      }
    }

    var totalBadge = byId(root, 'ag-ac-total-badge');
    if (totalBadge && totalBadge.textContent !== String(accounts.length)) {
      totalBadge.textContent = String(accounts.length);
    }

    var fbBox = byId(root, 'ag-ac-feedback');
    if (fbBox) {
      if (data.feedbackText) {
        fbBox.hidden = false;
        if (fbBox.textContent !== data.feedbackText) fbBox.textContent = data.feedbackText;
        var nextFbCls = 'ag-ns-note-box ' + (data.feedbackTone === 'error' ? 'is-error' : (data.feedbackTone === 'success' ? 'is-ok' : ''));
        if (fbBox.className !== nextFbCls) fbBox.className = nextFbCls;
      } else {
        fbBox.hidden = true;
      }
    }

    var btnRef = byId(root, 'ag-ac-btn-refresh');
    var btnAdd = byId(root, 'ag-ac-btn-add');
    var btnImp = byId(root, 'ag-ac-btn-import-current');
    var btnTools = byId(root, 'ag-ac-btn-import-tools');
    var btnToolsLbl = byId(root, 'ag-ac-btn-import-tools-lbl');
    var activeRefreshing = Boolean(activeAcc && localState.refreshingEmails.has(String(activeAcc.email || '').toLowerCase()));
    if (btnRef) {
      btnRef.disabled = busy || activeRefreshing;
      btnRef.classList.toggle('is-spinning', activeRefreshing);
    }
    if (btnAdd) btnAdd.disabled = busy;
    if (btnImp) btnImp.disabled = busy;
    if (btnTools) {
      btnTools.hidden = !data.toolsAvailable;
      btnTools.disabled = busy;
      if (btnToolsLbl && data.toolsCount > 0) {
        btnToolsLbl.textContent = labels.importToolsBtn + ' (' + data.toolsCount + ')';
      }
    }

    var hideEmailBtn = byId(root, 'ag-ac-btn-hide-email');
    if (hideEmailBtn) {
      hideEmailBtn.setAttribute('aria-pressed', hideEmail ? 'true' : 'false');
      hideEmailBtn.classList.toggle('is-toggle-on', hideEmail);
      hideEmailBtn.title = hideEmail ? labels.showEmail : labels.hideEmail;
      var eyeIcon = byId(root, 'ag-ac-eye-icon') || hideEmailBtn.querySelector('svg');
      var hideLbl = byId(root, 'ag-ac-btn-hide-email-lbl');
      if (eyeIcon) {
        var nextEyeState = hideEmail ? 'closed' : 'open';
        if (eyeIcon.getAttribute('data-eye-state') !== nextEyeState) {
          eyeIcon.setAttribute('data-eye-state', nextEyeState);
          eyeIcon.setAttribute('class', hideEmail ? 'ag-ac-eye-closed' : 'ag-ac-eye-open');
          eyeIcon.innerHTML = hideEmail
            ? '<path d="M2 2l12 12"/><path d="M6.4 6.4a2 2 0 0 0 3.2 3.2"/><path d="M4.2 4.9C2.6 6 1.5 8 1.5 8s2.4 4 6.5 4c1.3 0 2.5-.3 3.5-.9"/><path d="M11.8 11.1C13.4 10 14.5 8 14.5 8s-2.4-4-6.5-4c-.7 0-1.4.1-2 .3"/>'
            : '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="1.9"/>';
        }
      }
      if (hideLbl) hideLbl.textContent = hideEmail ? labels.showEmail : labels.hideEmail;
    }

    // 2. 套餐筛选胶囊 + 「高余量优先」排序胶囊（脏检查）
    var countsByPlan = new Map();
    for (var i = 0; i < accounts.length; i++) {
      var pk = resolvePlanFilterKey(accounts[i]);
      countsByPlan.set(pk, (countsByPlan.get(pk) || 0) + 1);
    }
    var filterOrder = ['all'];
    ['ultra', 'pro', 'plus', 'free', 'unknown'].forEach(function (k) {
      if (countsByPlan.has(k)) filterOrder.push(k);
    });
    countsByPlan.forEach(function (_cnt, k) {
      if (!filterOrder.includes(k)) filterOrder.push(k);
    });
    if (!filterOrder.includes(localState.planFilter)) localState.planFilter = 'all';

    var filtersSig = JSON.stringify([
      filterOrder.map(function (fk) { return fk + ':' + (fk === 'all' ? accounts.length : (countsByPlan.get(fk) || 0)); }),
      localState.planFilter,
      localState.sortByHighQuota,
      labels.filterAll,
      labels.planUnknown,
      labels.sortHighQuota
    ]);
    var filtersEl = byId(root, 'ag-ac-plan-filters');
    if (filtersEl && (opts.forceFilters || filtersSig !== localState.lastFiltersSig)) {
      localState.lastFiltersSig = filtersSig;
      if (typeof filtersEl.replaceChildren === 'function') filtersEl.replaceChildren();
      else filtersEl.innerHTML = '';
      for (var f = 0; f < filterOrder.length; f++) {
        var fk = filterOrder[f];
        var cnt = fk === 'all' ? accounts.length : (countsByPlan.get(fk) || 0);
        var fBtn = doc.createElement('button');
        fBtn.type = 'button';
        fBtn.className = 'ag-ac-filter-btn' + (localState.planFilter === fk ? ' is-active' : '');
        fBtn.setAttribute('data-ac-plan-filter', fk);
        fBtn.setAttribute('role', 'tab');
        fBtn.setAttribute('aria-selected', localState.planFilter === fk ? 'true' : 'false');
        fBtn.textContent = resolvePlanDisplayName(fk, labels) + ' ' + cnt;
        filtersEl.appendChild(fBtn);
      }
      var sortPill = doc.createElement('button');
      sortPill.type = 'button';
      sortPill.id = 'ag-ac-sort-high-quota';
      sortPill.className = 'ag-ac-filter-btn' + (localState.sortByHighQuota ? ' is-active' : '');
      sortPill.setAttribute('data-ac-sort', 'high_quota');
      sortPill.setAttribute('aria-pressed', localState.sortByHighQuota ? 'true' : 'false');
      sortPill.textContent = labels.sortHighQuota;
      filtersEl.appendChild(sortPill);
    }

    var viewBtns = container.querySelectorAll ? container.querySelectorAll('[data-ac-view]') : [];
    for (var vb = 0; vb < viewBtns.length; vb++) {
      var isV = viewBtns[vb].getAttribute('data-ac-view') === localState.viewMode;
      viewBtns[vb].classList?.toggle?.('is-active', isV);
      viewBtns[vb].setAttribute?.('aria-checked', isV ? 'true' : 'false');
    }

    // 3. 搜索 + 套餐过滤 + 高余量优先排序 + 分页
    var kw = localState.searchQuery.toLowerCase();
    var filtered = accounts.filter(function (acc) {
      if (!acc) return false;
      if (localState.planFilter !== 'all' && resolvePlanFilterKey(acc) !== localState.planFilter) return false;
      if (!kw) return true;
      var hay = [acc.name, acc.email, acc.maskedEmail, acc.note, acc.planLabel, acc.tierName, acc.tierCode].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });

    if (localState.sortByHighQuota) {
      filtered = filtered.slice().sort(function (a, b) {
        return computePrimaryQuotaScore(b) - computePrimaryQuotaScore(a);
      });
    }

    var totalPages = Math.max(1, Math.ceil(filtered.length / localState.pageSize));
    if (localState.page > totalPages) localState.page = totalPages;
    if (localState.page < 1) localState.page = 1;
    var startIdx = (localState.page - 1) * localState.pageSize;
    var pageItems = filtered.slice(startIdx, startIdx + localState.pageSize);

    // 刷新动效中或用户正在按下交互锁定窗口内，延迟整表重绘防止吞掉 click 与引发频闪
    var hasActiveMotion = localState.refreshMotions.size > 0;
    var isPointerLocked = Date.now() < localState.pointerLockUntil && !opts.forceRows && !opts.forceRowEmail;
    if (isPointerLocked) {
      localState.deferredData = data;
    }

    var listHeader = byId(root, 'ag-ac-list-header');
    if (listHeader) listHeader.style.display = localState.viewMode === 'cards' ? 'none' : '';

    var rowsSig = JSON.stringify({
      viewMode: localState.viewMode,
      hideEmail: hideEmail,
      busy: busy,
      page: localState.page,
      sortByHighQuota: localState.sortByHighQuota,
      switchingEmail: localState.switchingEmail,
      lockZeroForEmail: opts.lockZeroForEmail || '',
      pendingConfirm: localState.pendingConfirm ? [localState.pendingConfirm.type, localState.pendingConfirm.stableId] : null,
      expanded: Array.from(localState.expandedIds).sort(),
      revealed: Array.from(localState.revealedEmailIds).sort(),
      refreshing: Array.from(localState.refreshingEmails).sort(),
      lang: labels.colActions + '|' + labels.activeUse,
      items: pageItems.map(function (acc) {
        var bars = buildAccountQuotaBarsSpec(acc, labels);
        return [
          acc.accountId || acc.accountScopeKey || acc.email,
          acc.email,
          acc.name,
          acc.isActive,
          acc.hasRefreshToken,
          acc.authInvalid,
          acc.suspended,
          acc.suspendedReason || '',
          acc.tierCode || acc.tierName || acc.planLabel || '',
          acc.profilePictureUrl ? String(acc.profilePictureUrl).slice(0, 48) : '',
          acc.lastUsedAtMs || 0,
          acc.lastQuotaUpdatedAtMs || 0,
          acc.lastQuotaError || '',
          (acc.capabilities || []).join(','),
          bars.map(function (b) { return b.barKey + ':' + (b.hasVal ? b.pct : 'u') + ':' + b.countdownText; }).join('|')
        ];
      })
    });

    var skipRowsRebuild = (hasActiveMotion && !opts.forceRowEmail)
      || isPointerLocked
      || (!opts.forceRows && !opts.forceRowEmail && rowsSig === localState.lastRowsSig);

    // 始终更新 itemMap，确保委托点击能拿到最新账号对象
    localState.itemMap.clear();
    for (var mi = 0; mi < pageItems.length; mi++) {
      var mAcc = pageItems[mi];
      var mId = String(mAcc.accountId || mAcc.accountScopeKey || mAcc.email || '');
      localState.itemMap.set(mId, mAcc);
    }

    var rowsBox = byId(root, 'ag-ac-rows');
    if (rowsBox && !skipRowsRebuild) {
      localState.lastRowsSig = rowsSig;
      rowsBox.className = 'ag-ac-rows' + (localState.viewMode === 'cards' ? ' is-cards' : '');
      if (typeof rowsBox.replaceChildren === 'function') rowsBox.replaceChildren();
      else rowsBox.innerHTML = '';

      if (pageItems.length === 0) {
        var emp = doc.createElement('div');
        emp.className = 'ag-ns-row-desc';
        emp.style.padding = '20px 16px';
        emp.style.textAlign = 'center';
        emp.textContent = accounts.length === 0 ? labels.emptyAccounts : labels.noMatches;
        rowsBox.appendChild(emp);
      } else {
        for (var r = 0; r < pageItems.length; r++) {
          (function (acc) {
            var stableId = String(acc.accountId || acc.accountScopeKey || acc.email || '');
            var normEmail = String(acc.email || '').trim().toLowerCase();
            var isExpanded = localState.expandedIds.has(stableId);
            var isRowRefreshing = localState.refreshingEmails.has(normEmail);
            var isRowSwitching = Boolean(localState.switchingEmail && localState.switchingEmail === normEmail);
            var lockZero = opts.lockZeroForEmail && String(opts.lockZeroForEmail).toLowerCase() === normEmail;

            var item = doc.createElement('div');
            item.className = 'ag-ac-item' + (acc.isActive ? ' is-active' : '') + (isRowSwitching ? ' is-switching' : '');
            item.setAttribute('data-account-id', stableId);
            item.setAttribute('data-account-email', normEmail);

            var summary = doc.createElement('div');
            summary.className = 'ag-ac-item-summary';

            // ===== 左区：真实头像 + 邮箱（默认完整，点击复制） + 真实会员等级徽标 + 精简可用模型能力标签 =====
            var idCell = doc.createElement('div');
            idCell.className = 'ag-ac-id-cell';

            var rowAv = doc.createElement('div');
            rowAv.className = 'ag-ac-avatar is-xs';
            fillAvatarBox(doc, rowAv, acc);
            idCell.appendChild(rowAv);

            var idInfo = doc.createElement('div');
            idInfo.className = 'ag-ac-id-info';

            var emailBtn = doc.createElement('button');
            emailBtn.type = 'button';
            emailBtn.className = 'ag-ac-id-email-btn';
            emailBtn.setAttribute('data-ac-email-btn', stableId);
            emailBtn.title = labels.revealEmailHint;
            var emailTextSpan = doc.createElement('span');
            emailTextSpan.className = 'ag-ac-id-email-text';
            emailTextSpan.textContent = formatEmailText(acc, stableId);
            emailBtn.appendChild(emailTextSpan);
            idInfo.appendChild(emailBtn);

            var tagRow = doc.createElement('div');
            tagRow.className = 'ag-ac-tag-row';

            if (acc.isActive) {
              var actTag = doc.createElement('span');
              actTag.className = 'ag-ac-mini-tag is-active';
              actTag.textContent = labels.currentTag;
              tagRow.appendChild(actTag);
            }

            var planMeta = resolvePlanBadgeMeta(acc, labels);
            var pTag = doc.createElement('span');
            pTag.className = 'ag-ac-mini-tag' + (planMeta.cls ? (' ' + planMeta.cls) : '');
            pTag.textContent = planMeta.badgeText;
            tagRow.appendChild(pTag);

            if (acc.suspended) {
              var susTag = doc.createElement('span');
              susTag.className = 'ag-ac-mini-tag is-danger';
              susTag.textContent = labels.statusSuspended;
              tagRow.appendChild(susTag);
            } else if (acc.authInvalid) {
              var reTag = doc.createElement('span');
              reTag.className = 'ag-ac-mini-tag is-warn';
              reTag.textContent = labels.statusReauth;
              tagRow.appendChild(reTag);
            }

            var caps = Array.isArray(acc.capabilities) ? acc.capabilities.slice(0, 3) : [];
            for (var capIdx = 0; capIdx < caps.length; capIdx++) {
              var capName = String(caps[capIdx] || '').trim();
              if (!capName) continue;
              var capTag = doc.createElement('span');
              var capCls = capName.toLowerCase().includes('argon')
                ? ' is-cap-argon'
                : (capName.toLowerCase().includes('claude') ? ' is-cap-claude' : (capName.toLowerCase().includes('gpt') ? ' is-cap-gpt' : ''));
              capTag.className = 'ag-ac-mini-tag' + capCls;
              capTag.textContent = capName;
              tagRow.appendChild(capTag);
            }

            idInfo.appendChild(tagRow);
            idCell.appendChild(idInfo);

            // ===== 中区：2 列紧凑多池配额条 =====
            var poolsCell = doc.createElement('div');
            poolsCell.className = 'ag-ac-pools-cell';
            var bars = buildAccountQuotaBarsSpec(acc, labels);

            if (acc.suspended) {
              var susBanner = doc.createElement('div');
              susBanner.className = 'ag-ac-pool-empty-banner is-danger';
              var susMsg = doc.createElement('span');
              susMsg.textContent = acc.suspendedReason ? (labels.statusSuspended + ' · ' + acc.suspendedReason) : labels.statusSuspended;
              susBanner.appendChild(susMsg);
              poolsCell.appendChild(susBanner);
            } else if (bars.length === 0) {
              var emptyBanner = doc.createElement('div');
              emptyBanner.className = 'ag-ac-pool-empty-banner';
              emptyBanner.textContent = acc.lastQuotaError ? (labels.quotaFailed + ' · ' + acc.lastQuotaError) : labels.quotaUnsynced;
              poolsCell.appendChild(emptyBanner);
            } else {
              for (var bIdx = 0; bIdx < bars.length; bIdx++) {
                var bSpec = bars[bIdx];
                var capEl = doc.createElement('div');
                capEl.className = 'ag-ac-pool-capsule'
                  + (bSpec.fullRow ? ' is-full-row' : '')
                  + (bSpec.isArgon ? ' is-argon' : '')
                  + (!lockZero && bSpec.hasVal && bSpec.pct === 0 ? ' is-exhausted' : '');
                capEl.setAttribute('data-bar-key', bSpec.barKey);
                capEl.setAttribute('data-bar-pct', bSpec.hasVal ? String(bSpec.pct) : '');
                capEl.setAttribute('data-bar-tone', bSpec.tone);
                capEl.title = bSpec.label + ' · ' + (bSpec.hasVal ? (bSpec.pct + '%') : labels.quotaUnknown) + (bSpec.countdownText ? (' · ' + bSpec.countdownText) : '');

                var pLeft = doc.createElement('span');
                pLeft.className = 'ag-ac-pool-left';
                var dot = doc.createElement('span');
                dot.className = 'ag-ac-pool-dot' + (bSpec.dotKind === '3p' ? ' is-3p' : (bSpec.dotKind === 'argon' ? ' is-argon' : ''));
                pLeft.appendChild(dot);
                var pName = doc.createElement('span');
                pName.className = 'ag-ac-pool-name';
                pName.textContent = bSpec.label;
                pLeft.appendChild(pName);
                capEl.appendChild(pLeft);

                var pReset = doc.createElement('span');
                pReset.className = 'ag-ac-pool-reset' + (bSpec.isSoon ? ' is-soon' : '');
                if (bSpec.countdownText) {
                  pReset.appendChild(createIconSvg(doc, 'clock'));
                  var cdTxt = doc.createElement('span');
                  cdTxt.textContent = bSpec.countdownText;
                  pReset.appendChild(cdTxt);
                } else {
                  pReset.textContent = '—';
                }
                capEl.appendChild(pReset);

                var initPct = lockZero ? 0 : (bSpec.hasVal ? bSpec.pct : 0);
                var pPct = doc.createElement('span');
                pPct.className = 'ag-ac-pool-pct';
                pPct.setAttribute('data-tone', bSpec.hasVal ? bSpec.tone : 'muted');
                pPct.textContent = bSpec.hasVal ? (initPct + '%') : labels.quotaUnknown;
                capEl.appendChild(pPct);

                var track = doc.createElement('div');
                track.className = 'ag-ac-pool-track';
                var fill = doc.createElement('div');
                fill.className = 'ag-ac-pool-fill';
                fill.setAttribute('data-tone', bSpec.hasVal ? bSpec.tone : 'muted');
                fill.style.width = bSpec.hasVal ? (initPct + '%') : '0%';
                track.appendChild(fill);
                capEl.appendChild(track);

                poolsCell.appendChild(capEl);
              }
              if (acc.lastQuotaError) {
                var staleErrBanner = doc.createElement('div');
                staleErrBanner.className = 'ag-ac-pool-empty-banner is-danger';
                staleErrBanner.setAttribute('data-ac-stale-error', 'true');
                var staleUpdStr = acc.lastQuotaUpdatedAtMs ? new Date(acc.lastQuotaUpdatedAtMs).toLocaleTimeString() : '';
                staleErrBanner.textContent = labels.quotaFailed + ' · ' + acc.lastQuotaError + (staleUpdStr ? (' · ' + labels.updatedAt + ' ' + staleUpdStr) : '');
                poolsCell.appendChild(staleErrBanner);
              }
            }

            // ===== 右区（卡片视图位于底部）：最后使用时间 + 完整可点击操作按钮组 =====
            var rightCell = doc.createElement('div');
            rightCell.className = 'ag-ac-right-cell';

            var lastCell = doc.createElement('div');
            lastCell.className = 'ag-ac-last-cell';
            lastCell.textContent = formatAccountLastUsed(acc, labels);
            rightCell.appendChild(lastCell);

            var opsCell = doc.createElement('div');
            opsCell.className = 'ag-ac-ops-cell';

            if (acc.suspended) {
              var supBtn = doc.createElement('button');
              supBtn.type = 'button';
              supBtn.className = 'ag-ac-icon-btn';
              supBtn.setAttribute('data-ac-op', 'support');
              supBtn.title = labels.supportBtn;
              supBtn.setAttribute('aria-label', labels.supportBtn);
              supBtn.appendChild(createIconSvg(doc, 'support'));
              opsCell.appendChild(supBtn);

              var verBtn = doc.createElement('button');
              verBtn.type = 'button';
              verBtn.className = 'ag-ac-icon-btn' + (isRowRefreshing ? ' is-spinning' : '');
              verBtn.setAttribute('data-ac-op', 'verify');
              verBtn.title = labels.verifyBtn;
              verBtn.setAttribute('aria-label', labels.verifyBtn);
              verBtn.appendChild(createIconSvg(doc, 'refresh'));
              opsCell.appendChild(verBtn);
            } else {
              // 1. 刷新图标按钮（保留可点击以便无凭据时给出清晰 toast 反馈，绝不做无反馈死按钮）
              var canRefresh = Boolean(acc.isActive || acc.hasRefreshToken);
              var rfBtn = doc.createElement('button');
              rfBtn.type = 'button';
              rfBtn.className = 'ag-ac-icon-btn' + (isRowRefreshing ? ' is-spinning' : '');
              rfBtn.setAttribute('data-ac-op', 'refresh');
              rfBtn.setAttribute('data-can-refresh', canRefresh ? 'true' : 'false');
              rfBtn.title = canRefresh ? labels.refreshBtn : labels.noRefreshCredHint;
              rfBtn.setAttribute('aria-label', labels.refreshBtn);
              if (isRowRefreshing) rfBtn.disabled = true;
              rfBtn.appendChild(createIconSvg(doc, 'refresh'));
              opsCell.appendChild(rfBtn);

              // 2. 切号图标按钮（非当前号单击直接发起平滑切换；无凭据时点击弹出原因提示）
              var swBtn = doc.createElement('button');
              swBtn.type = 'button';
              swBtn.className = 'ag-ac-icon-btn' + (acc.isActive ? ' is-active-mark' : '') + (isRowSwitching ? ' is-spinning' : '');
              swBtn.setAttribute('data-ac-op', 'switch');
              var canSwitch = !acc.isActive && Boolean(acc.hasRefreshToken) && !Boolean(acc.authInvalid);
              swBtn.setAttribute('data-can-switch', canSwitch ? 'true' : 'false');
              swBtn.title = acc.isActive ? labels.activeUse : (canSwitch ? labels.switchBtn : labels.noRefreshCredHint);
              swBtn.setAttribute('aria-label', acc.isActive ? labels.activeUse : labels.switchBtn);
              swBtn.appendChild(createIconSvg(doc, isRowSwitching ? 'refresh' : (acc.isActive ? 'check' : 'switch')));
              opsCell.appendChild(swBtn);
            }

            // 3. 详情展开图标按钮
            var expBtn = doc.createElement('button');
            expBtn.type = 'button';
            expBtn.className = 'ag-ac-icon-btn' + (isExpanded ? ' is-expanded' : '');
            expBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
            expBtn.setAttribute('data-ac-toggle-detail', stableId);
            expBtn.title = isExpanded ? labels.collapse : labels.expand;
            expBtn.setAttribute('aria-label', isExpanded ? labels.collapse : labels.expand);
            expBtn.appendChild(createIconSvg(doc, 'detail'));
            opsCell.appendChild(expBtn);

            // 4. 移除图标按钮（页内直接展开确认条，绝不依赖宿主底层弹窗）
            var rmBtn = doc.createElement('button');
            rmBtn.type = 'button';
            rmBtn.className = 'ag-ac-icon-btn is-danger';
            rmBtn.setAttribute('data-ac-op', 'remove');
            rmBtn.title = labels.removeBtn;
            rmBtn.setAttribute('aria-label', labels.removeBtn);
            rmBtn.appendChild(createIconSvg(doc, 'remove'));
            opsCell.appendChild(rmBtn);

            rightCell.appendChild(opsCell);

            summary.appendChild(idCell);
            summary.appendChild(poolsCell);
            summary.appendChild(rightCell);
            item.appendChild(summary);

            // 页内行级移除二次确认条
            if (localState.pendingConfirm && localState.pendingConfirm.stableId === stableId) {
              var pc = localState.pendingConfirm;
              var confirmBar = doc.createElement('div');
              confirmBar.className = 'ag-ac-inline-confirm is-danger';
              confirmBar.setAttribute('data-ac-confirm-type', 'remove');
              var cText = doc.createElement('span');
              cText.className = 'ag-ac-inline-confirm-text';
              var tpl = pc.isActive ? labels.confirmRemoveActiveBody : labels.confirmRemoveBody;
              cText.textContent = String(tpl).replace('{email}', pc.displayEmail || pc.email);

              var cActs = doc.createElement('div');
              cActs.className = 'ag-ac-inline-confirm-actions';
              var btnCancel = doc.createElement('button');
              btnCancel.type = 'button';
              btnCancel.className = 'ag-ac-op-btn';
              btnCancel.setAttribute('data-ac-confirm-cancel', stableId);
              btnCancel.textContent = labels.cancelBtn;
              btnCancel.disabled = busy;

              var btnGo = doc.createElement('button');
              btnGo.type = 'button';
              btnGo.className = 'ag-ac-op-btn is-danger';
              btnGo.setAttribute('data-ac-confirm-go', stableId);
              btnGo.textContent = labels.confirmRemoveBtn;
              btnGo.disabled = busy;

              cActs.appendChild(btnCancel);
              cActs.appendChild(btnGo);
              confirmBar.appendChild(cText);
              confirmBar.appendChild(cActs);
              item.appendChild(confirmBar);
            }

            // 展开后的完整逐账号详情面板
            var detail = doc.createElement('div');
            detail.className = 'ag-ac-detail';
            detail.hidden = !isExpanded;
            if (isExpanded) {
              var pools = Array.isArray(acc.quotaSnapshot?.pools) ? acc.quotaSnapshot.pools : [];
              var dGrid = doc.createElement('div');
              dGrid.className = 'ag-ac-detail-grid';
              if (pools.length === 0) {
                var emptyCard = doc.createElement('div');
                emptyCard.className = 'ag-ac-detail-card';
                emptyCard.textContent = acc.lastQuotaError ? (labels.quotaFailed + ' · ' + acc.lastQuotaError) : labels.quotaUnsynced;
                dGrid.appendChild(emptyCard);
              } else {
                for (var dp = 0; dp < pools.length; dp++) {
                  var poolObj = pools[dp];
                  var dCard = doc.createElement('div');
                  dCard.className = 'ag-ac-detail-card';
                  var dTitle = doc.createElement('div');
                  dTitle.style.fontWeight = '600';
                  dTitle.style.fontSize = '12px';
                  dTitle.textContent = formatHumanPoolTitle(poolObj.poolKey, poolObj.title || poolObj.poolTitle);
                  dCard.appendChild(dTitle);

                  var bList = Array.isArray(poolObj.buckets) ? poolObj.buckets.filter(Boolean) : [];
                  if (bList.length === 0) {
                    var singleLine = doc.createElement('div');
                    singleLine.className = 'ag-ns-row-desc';
                    var sFrac = poolObj.remainingFraction;
                    singleLine.textContent = poolObj.noPermission
                      ? labels.unknown
                      : (sFrac != null && Number.isFinite(Number(sFrac)) ? (Math.round(Number(sFrac) * 100) + '%') : labels.quotaUnknown);
                    dCard.appendChild(singleLine);
                  } else {
                    for (var bi = 0; bi < bList.length; bi++) {
                      var bk = bList[bi];
                      var winTag = (bk.windowKey === 'weekly' || String(bk.windowShort || '').toLowerCase() === '7d') ? '7D' : '5H';
                      var bFrac = bk.remainingFraction;
                      var bText = (bFrac != null && Number.isFinite(Number(bFrac))) ? (Math.round(Number(bFrac) * 100) + '%') : labels.quotaUnknown;
                      var cd = formatPoolCountdown(bk.resetTimeIso || bk.resetTime);
                      var bLine = doc.createElement('div');
                      bLine.className = 'ag-ns-row-desc';
                      bLine.textContent = winTag + ' · ' + bText + (cd ? (' · ' + cd) : ' · —');
                      dCard.appendChild(bLine);
                    }
                  }
                  dGrid.appendChild(dCard);
                }
              }
              detail.appendChild(dGrid);

              var dMeta = doc.createElement('div');
              dMeta.className = 'ag-ac-detail-meta';
              var updStr = acc.lastQuotaUpdatedAtMs ? new Date(acc.lastQuotaUpdatedAtMs).toLocaleTimeString() : '—';
              var metaLeft = doc.createElement('span');
              var emailPart = formatEmailText(acc, stableId);
              var sourcePart = acc.quotaTargetHost
                ? String(acc.quotaTargetHost)
                : (acc.quotaSource ? String(acc.quotaSource) : '');
              var metaParts = [
                emailPart && emailPart !== '未知' && emailPart !== labels.unknown ? emailPart : '',
                sourcePart,
                updStr !== '—' ? (labels.updatedAt + ' ' + updStr) : '',
                acc.lastQuotaError ? String(acc.lastQuotaError) : ''
              ].filter(Boolean);
              metaLeft.textContent = metaParts.join(' · ') || '—';
              dMeta.appendChild(metaLeft);
              detail.appendChild(dMeta);
            }
            item.appendChild(detail);
            rowsBox.appendChild(item);
          })(pageItems[r]);
        }
      }
    }

    // 4. 分页栏
    var pagBox = byId(root, 'ag-ac-pagination');
    if (pagBox) {
      var showPag = filtered.length > localState.pageSize;
      pagBox.hidden = !showPag;
      if (showPag) {
        var sumEl = byId(root, 'ag-ac-page-summary');
        var numEl = byId(root, 'ag-ac-page-num');
        var pPrev = byId(root, 'ag-ac-page-prev');
        var pNext = byId(root, 'ag-ac-page-next');
        var endNum = Math.min(filtered.length, startIdx + pageItems.length);
        if (sumEl) {
          sumEl.textContent = String(labels.pageSummary)
            .replace('{start}', String(startIdx + 1))
            .replace('{end}', String(endNum))
            .replace('{total}', String(filtered.length));
        }
        if (numEl) numEl.textContent = localState.page + ' / ' + totalPages;
        if (pPrev) pPrev.disabled = localState.page <= 1;
        if (pNext) pNext.disabled = localState.page >= totalPages;
      }
    }

    // 5. 页尾折叠区 1：历史阈值提醒规则 + 全量候选账号
    var rules = data.rules || {};
    var targetSel = byId(root, 'ag-ns-sel-autoSwitchTarget');
    var metricSel = byId(root, 'ag-ns-sel-autoSwitchMetric');
    var thInput = byId(root, 'ag-ns-inp-autoSwitchThreshold');
    if (targetSel) {
      var legacyOpt = byId(root, 'ag-ns-opt-legacy-target');
      var isLegacy = !rules.autoSwitchTarget;
      if (legacyOpt) legacyOpt.hidden = !isLegacy;
      if (isLegacy) targetSel.setAttribute('data-legacy-placeholder', 'true');
      else targetSel.removeAttribute('data-legacy-placeholder');
      if (rules.autoSwitchTarget !== undefined && targetSel.value !== String(rules.autoSwitchTarget) && root.activeElement !== targetSel) {
        targetSel.value = String(rules.autoSwitchTarget);
      }
    }
    if (metricSel && rules.autoSwitchMetric !== undefined && metricSel.value !== String(rules.autoSwitchMetric) && root.activeElement !== metricSel) {
      metricSel.value = String(rules.autoSwitchMetric);
    }
    if (thInput && rules.autoSwitchThreshold !== undefined && root.activeElement !== thInput) {
      var thVal = String(rules.autoSwitchThreshold);
      if (thInput.value !== thVal) thInput.value = thVal;
    }
    syncAllNativeSelectDropdowns(container);

    var asPill = byId(root, 'ag-ns-autoswitch-pill');
    if (asPill && rules.badgeText) {
      asPill.textContent = rules.badgeText;
      asPill.className = 'ag-ns-pill ' + (rules.badgeClass || '');
    }
    var asNote = byId(root, 'ag-ns-autoswitch-note');
    if (asNote && rules.noteText !== undefined) {
      asNote.textContent = rules.noteText;
      asNote.className = 'ag-ns-note-box ' + (rules.noteTone === 'error' ? 'is-error' : '');
    }
    var asSummary = byId(root, 'ag-ns-autoswitch-live-summary');
    if (asSummary) {
      if (rules.liveSummaryText) {
        asSummary.hidden = false;
        asSummary.textContent = rules.liveSummaryText;
        asSummary.className = 'ag-ns-note-box ' + (rules.liveSummaryTone === 'warn' ? 'is-error' : '');
      } else {
        asSummary.hidden = true;
      }
    }

    var candWrap = byId(root, 'ag-ns-autoswitch-candidates');
    if (candWrap && Array.isArray(rules.candidates)) {
      var candSig = JSON.stringify(rules.candidates);
      if (candWrap.getAttribute('data-cand-sig') !== candSig) {
        candWrap.setAttribute('data-cand-sig', candSig);
        if (typeof candWrap.replaceChildren === 'function') candWrap.replaceChildren();
        else candWrap.innerHTML = '';
        if (rules.candidates.length === 0) {
          var empCand = doc.createElement('span');
          empCand.className = 'ag-ns-row-desc';
          empCand.textContent = rules.emptyCandidatesText || labels.emptyAccounts;
          candWrap.appendChild(empCand);
        } else {
          for (var ci = 0; ci < rules.candidates.length; ci++) {
            var cItem = rules.candidates[ci];
            var lbl = doc.createElement('label');
            lbl.className = 'ag-ns-cand-chip' + (cItem.selected ? ' is-checked' : '');
            lbl.setAttribute('data-account-id', cItem.accountId || cItem.email || '');
            var chk = doc.createElement('input');
            chk.type = 'checkbox';
            chk.value = cItem.email;
            chk.checked = Boolean(cItem.selected);
            var span = doc.createElement('span');
            span.textContent = cItem.label || (hideEmail ? (cItem.maskedEmail || cItem.email) : (cItem.email || cItem.maskedEmail));
            lbl.appendChild(chk);
            lbl.appendChild(span);
            if (cItem.isActive) {
              var curBadge = doc.createElement('span');
              curBadge.className = 'ag-ns-cand-active-tag';
              curBadge.textContent = labels.currentTag;
              lbl.appendChild(curBadge);
            }
            candWrap.appendChild(lbl);
          }
        }
      }
    }

    // 6. 页尾折叠区 2：本机消耗与共享账号额度对照（脏检查）
    var intervals = Array.isArray(data.quotaIntervals) ? data.quotaIntervals : [];
    var cmpCountEl = byId(root, 'ag-ac-compare-count');
    if (cmpCountEl && cmpCountEl.textContent !== String(intervals.length)) cmpCountEl.textContent = String(intervals.length);
    var cmpSig = JSON.stringify([intervals, labels.emptyCompare]);
    var cmpBox = byId(root, 'ag-ac-compare-list');
    if (cmpBox && cmpSig !== localState.lastCompareSig) {
      localState.lastCompareSig = cmpSig;
      if (typeof cmpBox.replaceChildren === 'function') cmpBox.replaceChildren();
      else cmpBox.innerHTML = '';
      if (intervals.length === 0) {
        var ec = doc.createElement('div');
        ec.className = 'ag-ns-row-desc';
        ec.textContent = labels.emptyCompare;
        cmpBox.appendChild(ec);
      } else {
        for (var ivIdx = 0; ivIdx < intervals.length; ivIdx++) {
          var iv = intervals[ivIdx];
          var rowEl = doc.createElement('div');
          rowEl.className = 'ag-ns-kv';
          var topL = doc.createElement('span');
          topL.className = 'ag-ns-v';
          topL.textContent = iv.titleLine || '';
          var botL = doc.createElement('span');
          botL.className = 'ag-ns-k';
          botL.textContent = iv.detailLine || '';
          rowEl.appendChild(topL);
          rowEl.appendChild(botL);
          cmpBox.appendChild(rowEl);
        }
      }
    }

    if (data.toastMessage) showToast(root, data.toastMessage);
  }

  return {
    buildNativeSettingsPageCss,
    buildNativeSettingsPageHtml,
    initContextSettingsUI,
    renderContextSettingsUI,
    buildCompactionProgressPageHtml,
    renderCompactionProgressPage,
    buildHostAccountsPageHtml,
    initHostAccountsPage,
    renderHostAccountsPage,
    beginAccountQuotaRefreshMotion,
    completeAccountQuotaRefreshMotion,
    buildAccountQuotaBarsSpec,
    formatHumanPoolTitle
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildNativeSettingsPageCss,
    buildNativeSettingsPageHtml,
    initContextSettingsUI,
    renderContextSettingsUI,
    buildCompactionProgressPageHtml,
    renderCompactionProgressPage,
    buildHostAccountsPageHtml,
    initHostAccountsPage,
    renderHostAccountsPage,
    beginAccountQuotaRefreshMotion,
    completeAccountQuotaRefreshMotion,
    buildAccountQuotaBarsSpec,
    formatHumanPoolTitle
  };
}
