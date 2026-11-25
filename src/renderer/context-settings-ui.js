/**
 * Context Meter 原生设置页 UI 模块（整合用户原生设置 UI 与全部真实配置分组 · Shadow DOM 安全）
 */
const {
  buildNativeSettingsPageCss,
  buildNativeSettingsPageHtml,
  initContextSettingsUI,
  renderContextSettingsUI
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

  function showToast(root, message) {
    var toastEl = byId(root, 'ag-ns-toast');
    if (!toastEl || !message) return;
    toastEl.textContent = String(message);
    toastEl.hidden = false;
    if (toastEl._agNsTimer) {
      clearTimeout(toastEl._agNsTimer);
    }
    toastEl._agNsTimer = setTimeout(function () {
      toastEl.hidden = true;
    }, 2400);
  }

  function buildNativeSettingsPageCss() {
    return `
/* =========================================================
 * Context Meter 原生设置页样式（遵循用户 UI 源码与中性宿主变量）
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
  --ag-ns-bg-content: var(--background, #1C1C1C);
  --ag-ns-bg-card: var(--card, #222222);
  --ag-ns-bg-inset: var(--muted, #191919);
  --ag-ns-bg-seg-track: var(--secondary, #141414);
  --ag-ns-bg-seg-active: var(--card, #2E2E2E);
  --ag-ns-bg-btn: var(--secondary, #262626);
  --ag-ns-bg-btn-hover: var(--accent, #303030);
  --ag-ns-bg-input: var(--input, #151515);
  --ag-ns-switch-off: rgba(255, 255, 255, 0.20);
  --ag-ns-switch-off-border: rgba(255, 255, 255, 0.14);
  --ag-ns-switch-knob: #FFFFFF;
  --ag-ns-border-card: var(--border, #2E2E2E);
  --ag-ns-border-divider: var(--border, #2A2A2A);
  --ag-ns-border-control: var(--border, #383838);
  --ag-ns-text-primary: var(--foreground, #F4F4F4);
  --ag-ns-text-secondary: var(--secondary-foreground, #D4D4D4);
  --ag-ns-text-muted: var(--muted-foreground, #8E8E8E);
  --ag-ns-seg-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  --ag-ns-accent: var(--ag-host-accent, #7748CF);
  --ag-ns-accent-soft: #a78bfa;
  --ag-ns-accent-ring: rgba(167, 139, 250, 0.25);
  --ag-ns-accent-selected-bg: rgba(167, 139, 250, 0.14);
  --ag-ns-dd-menu-bg: #1e1e24;
  --ag-ns-dd-menu-border: rgba(255, 255, 255, 0.14);
  --ag-ns-dd-menu-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.4);
  --ag-ns-dd-item-hover: rgba(255, 255, 255, 0.08);
  --ag-ns-cand-checked-bg: rgba(168, 85, 247, 0.14);
  --ag-ns-cand-checked-border: rgba(192, 132, 252, 0.50);
  --ag-ns-danger: #EF4444;
  --ag-ns-ok: #10B981;
  --ag-ns-warn: #F59E0B;
}

:host([data-theme="light"]),
:host([data-panel-tone="light"]) {
  --ag-ns-bg-content: var(--background, #FFFFFF);
  --ag-ns-bg-card: var(--card, #FAFAFA);
  --ag-ns-bg-inset: var(--muted, #F3F3F3);
  --ag-ns-bg-seg-track: var(--secondary, #EFEFEF);
  --ag-ns-bg-seg-active: var(--background, #FFFFFF);
  --ag-ns-bg-btn: var(--background, #FFFFFF);
  --ag-ns-bg-btn-hover: var(--muted, #F3F3F3);
  --ag-ns-bg-input: var(--background, #FFFFFF);
  --ag-ns-switch-off: #D1D1D1;
  --ag-ns-switch-off-border: #C4C4C4;
  --ag-ns-switch-knob: #FFFFFF;
  --ag-ns-border-card: var(--border, #E5E5E5);
  --ag-ns-border-divider: var(--border, #ECECEC);
  --ag-ns-border-control: var(--border, #D4D4D4);
  --ag-ns-text-primary: var(--foreground, #141414);
  --ag-ns-text-secondary: var(--secondary-foreground, #303030);
  --ag-ns-text-muted: var(--muted-foreground, #6A6A6A);
  --ag-ns-seg-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04);
  --ag-ns-accent: var(--ag-host-accent, #7748CF);
  --ag-ns-accent-soft: #7748CF;
  --ag-ns-accent-ring: rgba(119, 72, 207, 0.20);
  --ag-ns-accent-selected-bg: rgba(119, 72, 207, 0.10);
  --ag-ns-dd-menu-bg: #FFFFFF;
  --ag-ns-dd-menu-border: rgba(0, 0, 0, 0.12);
  --ag-ns-dd-menu-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.08);
  --ag-ns-dd-item-hover: rgba(0, 0, 0, 0.05);
  --ag-ns-cand-checked-bg: #FAF5FF;
  --ag-ns-cand-checked-border: #C084FC;
  --ag-ns-danger: #DC2626;
  --ag-ns-ok: #059669;
  --ag-ns-warn: #D97706;
}

:host::-webkit-scrollbar {
  width: 8px;
}

:host::-webkit-scrollbar-track {
  background: transparent;
}

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

.ag-ns-page {
  position: relative;
  width: 100%;
  max-width: 720px;
  margin: 0;
  padding: 28px 32px 60px;
  color: var(--ag-ns-text-primary);
  background: transparent;
  font-family: inherit;
}

.ag-ns-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0 0 22px;
  padding-right: 42px;
}

.ag-ns-title-wrap {
  min-width: 0;
  flex: 1 1 220px;
}

.ag-ns-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.015em;
  color: var(--ag-ns-text-primary);
}

.ag-ns-subtitle {
  margin: 5px 0 0;
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
  margin: 0 0 22px;
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
  border-radius: 10px;
  border: 1px solid var(--ag-ns-border-card);
  background: var(--ag-ns-bg-card);
  overflow: visible;
}

.ag-ns-card.is-dropdown-open {
  z-index: 60;
}

.ag-ns-row:first-child {
  border-top: none;
  border-top-left-radius: 9px;
  border-top-right-radius: 9px;
}

.ag-ns-row:last-child,
.ag-ns-collapse-body:last-child {
  border-bottom-left-radius: 9px;
  border-bottom-right-radius: 9px;
}

.ag-ns-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 16px;
  border-top: 1px solid var(--ag-ns-border-divider);
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

.ag-ns-inline-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ag-ns-row-desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ag-ns-text-muted);
  word-break: break-word;
}

.ag-ns-row-desc.is-error {
  color: var(--ag-ns-danger);
}

.ag-ns-row-desc.is-ok {
  color: var(--ag-ns-ok);
}

.ag-ns-control {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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

.ag-ns-seg {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  padding: 2px;
  gap: 2px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-seg-track);
}

.ag-ns-seg-btn {
  border: none;
  background: transparent;
  color: var(--ag-ns-text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.ag-ns-seg-btn:hover {
  color: var(--ag-ns-text-primary);
}

.ag-ns-seg-btn.is-active {
  background: var(--ag-ns-bg-seg-active);
  color: var(--ag-ns-text-primary);
  box-shadow: var(--ag-ns-seg-shadow);
}

.ag-ns-switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ag-ns-switch-state {
  font-size: 11.5px;
  color: var(--ag-ns-text-muted);
  white-space: nowrap;
}

.ag-ns-switch-state[data-tone="busy"] {
  color: var(--ag-ns-accent);
}

.ag-ns-switch-state[data-tone="error"] {
  color: var(--ag-ns-danger);
}

/* 对齐 Antigravity 原生开关视觉语义并实时绑定宿主 --ag-host-accent */
.ag-ns-switch {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--ag-ns-switch-off-border);
  background: var(--ag-ns-switch-off);
  padding: 0;
  margin: 0;
  cursor: pointer;
  flex: 0 0 auto;
  transition: background-color 160ms ease, border-color 160ms ease, opacity 140ms ease;
}

.ag-ns-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--ag-ns-switch-knob);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transform: translateX(0);
  transition: transform 160ms cubic-bezier(0.22, 1.2, 0.36, 1);
}

.ag-ns-switch.is-on,
.ag-ns-switch[aria-checked="true"] {
  background: var(--ag-ns-accent);
  border-color: transparent;
}

.ag-ns-switch.is-on::after,
.ag-ns-switch[aria-checked="true"]::after {
  transform: translateX(16px);
  background: #ffffff;
}

.ag-ns-switch:disabled,
.ag-ns-switch[aria-busy="true"] {
  opacity: 0.62;
  cursor: wait;
}

.ag-ns-btn,
.ag-ns-select,
.ag-ns-input {
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-btn);
  color: var(--ag-ns-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1;
  outline: none;
}

.ag-ns-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  white-space: nowrap;
  font-weight: 500;
}

.ag-ns-btn[hidden] {
  display: none !important;
}

.ag-ns-btn:hover {
  background: var(--ag-ns-bg-btn-hover);
}

.ag-ns-btn.is-primary {
  background: var(--ag-ns-accent);
  border-color: var(--ag-ns-accent);
  color: #ffffff;
}

.ag-ns-btn.is-primary:hover {
  filter: brightness(1.08);
}

.ag-ns-btn:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.ag-ns-btn-danger:hover {
  color: var(--ag-ns-danger);
  border-color: var(--ag-ns-danger);
}

.ag-ns-select {
  cursor: pointer;
  padding-right: 22px;
}

.ag-ns-select.is-enhanced {
  display: none !important;
}

/* 原生设置页统一自定义下拉组件（对齐设计语言参考图） */
.ag-ns-dd-wrap {
  position: relative;
  display: inline-block;
  min-width: 148px;
  max-width: 100%;
  box-sizing: border-box;
}

.ag-ns-dd-wrap[data-dd-key="autoSwitchTarget"] {
  min-width: 210px;
}

.ag-ns-dd-wrap[data-dd-key="autoSwitchMetric"] {
  min-width: 168px;
}

.ag-ns-dd-wrap[data-dd-key="planTier"] {
  min-width: 176px;
}

.ag-ns-dd-wrap[data-dd-key="billingRegion"] {
  min-width: 152px;
}

.ag-ns-dd-wrap[data-dd-key="displayCurrency"] {
  min-width: 96px;
}

.ag-ns-dd-wrap.is-open {
  z-index: 200;
}

.ag-ns-dd-trigger {
  width: 100%;
  min-height: 32px;
  padding: 5px 10px 5px 11px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-input);
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
  transition: background-color 150ms cubic-bezier(0.16, 1, 0.3, 1), border-color 150ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ag-ns-dd-trigger:hover {
  background: var(--ag-ns-bg-btn-hover);
  border-color: rgba(255, 255, 255, 0.24);
}

:host([data-theme="light"]) .ag-ns-dd-trigger:hover,
:host([data-panel-tone="light"]) .ag-ns-dd-trigger:hover {
  border-color: rgba(0, 0, 0, 0.24);
}

.ag-ns-dd-trigger:focus-visible,
.ag-ns-dd-wrap.is-open .ag-ns-dd-trigger {
  border-color: var(--ag-ns-accent-soft);
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
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), color 150ms ease;
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
  transition: opacity 150ms cubic-bezier(0.16, 1, 0.3, 1), transform 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ag-ns-dd-wrap.align-right .ag-ns-dd-menu {
  left: auto;
  right: 0;
}

.ag-ns-dd-wrap.open-up .ag-ns-dd-menu {
  top: auto;
  bottom: calc(100% + 5px);
  transform-origin: bottom center;
  transform: translateY(4px) scale(0.98);
}

.ag-ns-dd-wrap.is-open .ag-ns-dd-menu {
  display: block;
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.ag-ns-dd-menu::-webkit-scrollbar {
  width: 5px;
}

.ag-ns-dd-menu::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.32);
  border-radius: 999px;
}

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

.ag-ns-dd-search-input:focus {
  border-color: var(--ag-ns-accent-soft);
}

.ag-ns-dd-group {
  padding: 6px 9px 3px;
  margin-top: 3px;
  border-top: 1px solid var(--ag-ns-border-divider);
  font-size: 11px;
  font-weight: 600;
  color: var(--ag-ns-text-muted);
  user-select: none;
}

.ag-ns-dd-group:first-child {
  margin-top: 0;
  border-top: none;
}

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
  transition: background-color 120ms ease, color 120ms ease;
}

.ag-ns-dd-item:hover,
.ag-ns-dd-item.is-focus {
  background: var(--ag-ns-dd-item-hover);
  color: var(--ag-ns-text-primary);
}

.ag-ns-dd-item.is-selected {
  background: var(--ag-ns-accent-selected-bg);
  color: var(--ag-ns-accent-soft);
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
  color: var(--ag-ns-accent-soft);
  opacity: 0;
}

.ag-ns-dd-item.is-selected .ag-ns-dd-check {
  opacity: 1;
}

.ag-ns-dd-empty {
  padding: 10px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--ag-ns-text-muted);
}

.ag-ns-input {
  width: 210px;
  background: var(--ag-ns-bg-input);
  color: var(--ag-ns-text-primary);
}

.ag-ns-input-sm {
  width: 82px;
}

.ag-ns-input::placeholder {
  color: var(--ag-ns-text-muted);
}

.ag-ns-input:focus,
.ag-ns-select:focus,
.ag-ns-btn:focus-visible,
.ag-ns-switch:focus-visible,
.ag-ns-seg-btn:focus-visible {
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
  border-color: rgba(119, 72, 207, 0.38);
  background: rgba(119, 72, 207, 0.14);
}

.ag-ns-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

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

.ag-ns-k {
  font-size: 11px;
  color: var(--ag-ns-text-muted);
}

.ag-ns-v {
  font-size: 12px;
  font-weight: 600;
  color: var(--ag-ns-text-primary);
  word-break: break-word;
}

.ag-ns-cand-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ag-ns-cand-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 11px 5px 7px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-inset);
  font-size: 12px;
  font-weight: 500;
  color: var(--ag-ns-text-primary);
  cursor: pointer;
  user-select: none;
  transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

.ag-ns-cand-chip:hover {
  border-color: var(--ag-ns-cand-checked-border);
}

.ag-ns-cand-chip.is-checked,
.ag-ns-cand-chip:has(input[type="checkbox"]:checked) {
  background: var(--ag-ns-cand-checked-bg);
  border-color: var(--ag-ns-cand-checked-border);
}

.ag-ns-cand-chip input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 30px;
  height: 17px;
  min-width: 30px;
  min-height: 17px;
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
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--ag-ns-switch-knob);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transform: translateX(0);
  transition: transform 160ms cubic-bezier(0.22, 1.2, 0.36, 1);
}

.ag-ns-cand-chip input[type="checkbox"]:checked {
  background: var(--ag-ns-accent);
  border-color: transparent;
}

.ag-ns-cand-chip input[type="checkbox"]:checked::after {
  transform: translateX(13px);
  background: #ffffff;
}

.ag-ns-cand-chip input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--ag-ns-accent-soft);
  outline-offset: 2px;
}

.ag-ns-collapse-body {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-inset);
}

.ag-ns-collapse-body[hidden] {
  display: none;
}

.ag-ns-color-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.ag-ns-color-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-divider);
  background: var(--ag-ns-bg-card);
  cursor: pointer;
}

.ag-ns-color-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ag-ns-color-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--ag-ns-text-primary);
}

.ag-ns-color-hex {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--ag-ns-text-muted);
}

.ag-ns-color-input {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--ag-ns-border-control);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.ag-ns-color-actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}

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

.ag-ns-note-box[hidden] {
  display: none;
}

.ag-ns-note-box.is-error {
  border-color: rgba(239, 68, 68, 0.35);
  color: var(--ag-ns-danger);
}

.ag-ns-note-box.is-ok {
  border-color: rgba(16, 185, 129, 0.35);
  color: var(--ag-ns-ok);
}

.ag-ns-toast {
  position: sticky;
  bottom: 16px;
  margin: 14px auto 0;
  width: fit-content;
  max-width: 90%;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--ag-ns-border-control);
  background: var(--ag-ns-bg-card);
  color: var(--ag-ns-text-primary);
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
  z-index: 5;
}

.ag-ns-toast[hidden] {
  display: none;
}

.ag-ns-btn.is-busy .ag-ns-icon {
  animation: ag-ns-spin 800ms linear infinite;
}

@keyframes ag-ns-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .ag-ns-switch,
  .ag-ns-switch::after,
  .ag-ns-chevron,
  .ag-ns-btn.is-busy .ag-ns-icon {
    transition: none !important;
    animation: none !important;
  }
}

@media (max-width: 640px) {
  .ag-ns-page {
    padding: 20px 16px 44px;
  }

  .ag-ns-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .ag-ns-control {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .ag-ns-input {
    width: 100%;
    max-width: 260px;
  }

  .ag-ns-color-grid,
  .ag-ns-grid-2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 440px) {
  .ag-ns-color-grid,
  .ag-ns-grid-2 {
    grid-template-columns: 1fr;
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
      <p id="ag-ns-subtitle" class="ag-ns-subtitle" data-i18n="hostSettings.subtitle">上下文统计、界面偏好、免 TUN 代理与本地数据配置</p>
    </div>
    <div class="ag-ns-header-links">
      <button id="ag-hs-btn-open-accounts" class="ag-ns-btn" type="button" data-ag-ns-action="openAccountsTab" data-i18n="tab.accounts">账号与共享池</button>
      <button id="ag-hs-btn-open-quota" class="ag-ns-btn" type="button" data-ag-ns-action="openQuotaBoard" data-i18n="hostSettings.btn.quota">模型额度</button>
      <button id="ag-hs-btn-open-tokens" class="ag-ns-btn" type="button" data-ag-ns-action="openTokensBoard" data-i18n="hostSettings.btn.tokens">Token 用量</button>
    </div>
  </header>

  <!-- 1. 外观、停靠位置与顶栏偏好 -->
  <div id="ag-ns-sec-appearance" class="ag-ns-group" data-section-id="ui-slim-prefs-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.appearance">外观、停靠位置与顶栏偏好</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.themeMode.title">插件主题外观</div>
          <div class="ag-ns-row-desc" data-i18n="ns.themeMode.desc">控制面板深浅配色模式，默认跟随宿主自动切换</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="themeMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="auto" data-i18n="ns.themeMode.auto">跟随宿主</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="light" data-i18n="ns.themeMode.light">浅色</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="dark" data-i18n="ns.themeMode.dark">深色</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.topbarMode.title">顶栏入口形态</div>
          <div class="ag-ns-row-desc" data-i18n="ns.topbarMode.desc">控制顶栏常驻状态入口的展示形式</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="topbarMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="full" data-i18n="settings.topbarMode.full">完整显示</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="compact" data-i18n="settings.topbarMode.compact">精简圆环</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="hidden" data-i18n="settings.topbarMode.hidden">隐藏</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.panelDockMode.title">面板显示位置</div>
          <div class="ag-ns-row-desc" data-i18n="ns.panelDockMode.desc">切换详情面板打开时的承载容器</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="panelDockMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="popover" data-i18n="settings.panelDockMode.popover">顶栏浮层</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="aux" data-i18n="settings.panelDockMode.aux">右侧辅助栏</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="page" data-i18n="settings.panelDockMode.page">独立页面</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.quotaBadgeMode.label">顶栏额度窗口</div>
          <div class="ag-ns-row-desc" data-i18n="settings.quotaBadgeMode.desc">支持右键或 Alt 加点击切换</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-seg" role="radiogroup" data-ag-ns-seg="quotaWindowMode">
            <button type="button" class="ag-ns-seg-btn is-active" role="radio" aria-checked="true" data-val="auto" data-i18n="settings.quotaBadgeMode.auto">自动最紧缩</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="5h" data-i18n="settings.quotaBadgeMode.5h">5h 窗口</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="weekly" data-i18n="settings.quotaBadgeMode.weekly">周额度</button>
            <button type="button" class="ag-ns-seg-btn" role="radio" aria-checked="false" data-val="both" data-i18n="settings.quotaBadgeMode.both">5h 与周双显</button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.autoHideTopbarOnDock.title">辅助栏与独立页展开时自动隐藏顶栏入口</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoHideTopbarOnDock.desc">展开停靠面板时自动收起顶栏冗余入口</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="autoHideTopbarOnDock" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-autoHideTopbarOnDock" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoHideTopbarOnDock"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row ag-ns-row-stack">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.quickActions.title">当前会话快捷操作条</div>
          <div id="ag-ns-dock-feedback" class="ag-ns-row-desc" data-i18n="settings.quickActions.desc">一行完成打开、复制与跳转，同一入口不再重复</div>
        </div>
        <div class="ag-ns-control">
          <button type="button" class="ag-ns-btn is-primary" data-ag-ns-action="openRight" data-i18n="settings.dock.openRightBtn">在右侧打开</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openPage" data-i18n="settings.dock.fbPage">独立页面</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="copyUrl" data-i18n="settings.dock.fbCopyUrl">复制链接</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openExternal" data-i18n="settings.dock.openExternalBtn">外部浏览器</button>
        </div>
      </div>

      <!-- 折叠配色区 -->
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title ag-ns-inline-title">
            <svg class="ag-ns-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5h.75a1.5 1.5 0 0 0 1.06-2.56 1.5 1.5 0 0 1 1.06-2.56h1.38a2 2 0 0 0 2-2A5.38 5.38 0 0 0 8 1.75Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
              <circle cx="5.25" cy="7.25" r=".85" fill="currentColor"/>
              <circle cx="7.5" cy="4.85" r=".85" fill="currentColor"/>
              <circle cx="10.5" cy="5.5" r=".85" fill="currentColor"/>
            </svg>
            <span data-i18n="ns.colors.title">指标与背景颜色自定义</span>
          </div>
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
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="ns.colors.panelBg">面板背景</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="panelBg">#181818</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="panelBg" value="#181818" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.ringUsed">圆环已用部分</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="ringUsed">#E6E6EB</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="ringUsed" value="#e6e6eb" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.ringTrack">圆环轨道</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="ringTrack">#52525B</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="ringTrack" value="#52525b" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.contextText">上下文用量文字</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="contextText">#ECECEF</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="contextText" value="#ececef" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.speedText">输出速度</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="speedText">#38BDF8</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="speedText" value="#38bdf8" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.tokenTotal">累计 token 用量</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="tokenTotal">#C084FC</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="tokenTotal" value="#c084fc" />
          </label>
          <label class="ag-ns-color-item">
            <span class="ag-ns-color-meta">
              <span class="ag-ns-color-name" data-i18n="settings.colors.tokenAccent">其他 token 指标</span>
              <span class="ag-ns-color-hex" data-ag-ns-color-hex="tokenAccent">#A78BFA</span>
            </span>
            <input type="color" class="ag-ns-color-input" data-ag-ns-color="tokenAccent" value="#a78bfa" />
          </label>
        </div>
        <div class="ag-ns-color-actions">
          <button type="button" id="ag-ns-reset-colors" class="ag-ns-btn" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 交互与显示偏好 -->
  <div id="ag-ns-sec-interaction" class="ag-ns-group" data-section-id="ctx-prefs-group-display">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.interaction">交互与显示偏好</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.radial.orb.title">悬浮圆环</div>
          <div class="ag-ns-row-desc" data-i18n="ns.radialOrb.desc">窗口顶层可拖拽悬浮球，点击展开 360° 六瓣花环</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="radialOrb" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-radialOrb" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialOrb"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.radial.topbar.title">顶栏径向展开</div>
          <div class="ag-ns-row-desc" data-i18n="ns.radialTopbar.desc">点击顶栏上下文圆环原地收缩为正圆并向下展开 180° 扇形</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="radialTopbar" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-radialTopbar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialTopbar"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.radial.bottombar.title">底栏径向展开</div>
          <div class="ag-ns-row-desc" data-i18n="ns.radialBottombar.desc">点击输入框下方上下文入口原地收缩为正圆并向上展开 180° 扇形</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="radialBottombar" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-radialBottombar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="radialBottombar"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.showComposerBar.title">输入框下方显示底栏状态摘要</div>
          <div class="ag-ns-row-desc" data-i18n="ns.showComposerBar.desc">在输入框底部展示当前上下文、速率、缓存命中与额度摘要</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="showComposerBar" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-showComposerBar" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="showComposerBar"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.turnFooter.label">每轮回复尾部统计</div>
          <div class="ag-ns-row-desc" data-i18n="ns.turnFooter.desc">在助手回复操作栏末尾显示本轮模型、用量与耗时微标</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="showTurnFooter" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-showTurnFooter" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="showTurnFooter"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="settings.nextPrompt.label">下一句预测建议</div>
          <div class="ag-ns-row-desc" data-i18n="ns.nextPrompt.desc">默认关闭 · 开启后每轮结束会调用当前账号模型并消耗额外额度，按 Tab 填入草稿</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="nextPromptEnabled" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-nextPromptEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="nextPromptEnabled"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. 阈值自动切号 -->
  <div id="ag-ns-sec-accounts" class="ag-ns-group" data-section-id="settings-accounts-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.accounts">多账号与阈值自动切号</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="accounts.autoSwitchEnable">启用阈值自动切号，默认关闭</div>
          <div id="ag-ns-autoswitch-note" class="ag-ns-row-desc" data-i18n="ns.autoSwitch.desc">达阈值后等待当前生成空闲且单窗口时切往备选账号</div>
        </div>
        <div class="ag-ns-control">
          <span id="ag-ns-autoswitch-pill" class="ag-ns-pill" data-i18n="accounts.status.disabled">已关闭</span>
          <button type="button" id="ag-ns-sw-autoSwitchEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoSwitchEnabled"></button>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="accounts.quotaTargetLabel">监控额度</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoSwitchTarget.desc">仅从 Gemini 或 Claude / GPT 的 5 小时与周额度中选择具体监控项</div>
        </div>
        <div class="ag-ns-control">
          <select id="ag-ns-sel-autoSwitchTarget" class="ag-ns-select" data-ag-ns-select="autoSwitchTarget">
            <option id="ag-ns-opt-legacy-target" value="" disabled hidden data-i18n="accounts.target.legacyPlaceholder">旧规则待重选 · 请选择具体监控额度</option>
            <optgroup label="Gemini" data-i18n-label="accounts.target.groupGemini">
              <option value="shared_gemini_main:5h" data-i18n="accounts.target.gemini5h">Gemini 5 小时额度</option>
              <option value="shared_gemini_main:7d" data-i18n="accounts.target.gemini7d">Gemini 周额度</option>
            </optgroup>
            <optgroup label="Claude / GPT" data-i18n-label="accounts.target.group3p">
              <option value="shared_3p_pool:5h" data-i18n="accounts.target.claude5h">Claude / GPT 5 小时额度</option>
              <option value="shared_3p_pool:7d" data-i18n="accounts.target.claude7d">Claude / GPT 周额度</option>
            </optgroup>
          </select>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.autoSwitchRule.title">触发口径与阈值百分比</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoSwitchRule.desc">修改规则后请点击保存切号规则，再拨动总开关</div>
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
          <div class="ag-ns-row-title" data-i18n="accounts.candidatesLabel">允许切入的候选账号：</div>
          <div id="ag-ns-autoswitch-candidates" class="ag-ns-cand-list"></div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-btn-save-autoswitch" class="ag-ns-btn is-primary" data-ag-ns-action="saveAutoSwitch" data-i18n="accounts.saveRule">保存切号规则</button>
          <button type="button" class="ag-ns-btn" data-ag-ns-action="openAccountsTab" data-i18n="accountsTab.openPoolsBtn">打开账号与共享池</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 4. 客户端界面语言与品牌 -->
  <div id="ag-ns-sec-i18n" class="ag-ns-group" data-section-id="client-brand-lang-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.i18n">客户端界面语言与品牌</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row ag-ns-row-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div class="ag-ns-row-text">
            <div class="ag-ns-row-title" data-i18n="ns.clientLang.title">Antigravity 客户端界面语言</div>
            <div id="ag-ns-i18n-desc" class="ag-ns-row-desc" data-i18n="settings.clientLang.detecting">正在检测桌面端汉化运行状态…</div>
          </div>
          <span id="ag-ns-i18n-badge" class="ag-ns-pill">English</span>
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

  <!-- 5. 压缩恢复与回答规则 -->
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
          <button type="button" id="ag-ns-btn-rehydrate-enable" class="ag-ns-btn is-primary" data-ag-ns-action="rehydrateEnable" data-i18n="rehydrate.btn.enable">开启</button>
          <button type="button" id="ag-ns-btn-rehydrate-disable" class="ag-ns-btn" data-ag-ns-action="rehydrateDisable" data-i18n="rehydrate.btn.disable">停用</button>
          <button type="button" id="ag-ns-btn-rehydrate-refresh" class="ag-ns-btn" data-ag-ns-action="rehydrateRefresh" data-i18n="models.btn.refreshStatus">刷新状态</button>
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

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="enhance.titlePatch.label">自动生成简体中文会话标题</div>
          <div class="ag-ns-row-desc" data-i18n="ns.enhanceTitle.desc">等长替换会话命名提示词，支持随时恢复英文</div>
        </div>
        <div class="ag-ns-control">
          <button type="button" id="ag-ns-sw-enhanceChineseTitle" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="enhanceChineseTitle"></button>
        </div>
      </div>
    </div>
  </div>

  <!-- 6. 免 TUN 代理与网络 -->
  <div id="ag-ns-sec-proxy" class="ag-ns-group" data-section-id="proxy-notun-drawer">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.proxy">免 TUN 代理与网络</h2>
    <div class="ag-ns-card">
      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.proxyEnabled.title">启用本地免 TUN 代理</div>
          <div id="ag-ns-proxy-desc" class="ag-ns-row-desc" data-i18n="ns.proxyEnabled.desc">无需开启系统级虚拟网卡即可接管模型请求</div>
        </div>
        <div class="ag-ns-control">
          <span id="ag-ns-proxy-badge" class="ag-ns-pill" data-i18n="settings.common.reading">读取中…</span>
          <button type="button" id="ag-ns-sw-proxyEnabled" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="proxyEnabled"></button>
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

  <!-- 7. 订阅与费用估算 -->
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

  <!-- 8. 版本更新 -->
  <div id="ag-ns-sec-update" class="ag-ns-group" data-section-id="settings-about-update-card">
    <h2 class="ag-ns-group-title" data-i18n="ns.group.update">版本更新</h2>
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
          <button type="button" id="ag-hs-btn-check-update" class="ag-ns-btn is-primary" data-ag-ns-action="checkUpdate" data-i18n="hostSettings.btn.check">检查更新</button>
          <button type="button" id="ag-hs-btn-apply-update" class="ag-ns-btn is-primary" hidden data-ag-ns-action="applyUpdate" data-i18n="update.applyNow">立即下载更新</button>
          <button type="button" id="ag-hs-btn-restart-host" class="ag-ns-btn is-primary" hidden data-ag-ns-action="restartHost" data-i18n="update.restartBtn">重启客户端生效</button>
          <button type="button" id="ag-hs-btn-verify-runtime" class="ag-ns-btn" data-ag-ns-action="verifyRuntime" data-i18n="hostSettings.btn.verify">校验运行态</button>
          <button type="button" id="ag-hs-btn-release-page" class="ag-ns-btn" data-ag-ns-action="openReleasePage" data-i18n="update.viewRelease">查看更新日志</button>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="ns.autoCheckUpdate.title">启动时自动检查更新但不自动安装</div>
          <div class="ag-ns-row-desc" data-i18n="ns.autoCheckUpdate.desc">发现新版本时仅在界面内提示</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="autoCheckUpdate" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-autoCheckUpdate" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="autoCheckUpdate"></button>
          </div>
        </div>
      </div>

      <div class="ag-ns-row">
        <div class="ag-ns-row-text">
          <div class="ag-ns-row-title" data-i18n="hostSettings.beta.label">接收预发布测试版本</div>
          <div class="ag-ns-row-desc" data-i18n="hostSettings.beta.desc">开启后检查更新可获取 Beta 通道版本</div>
        </div>
        <div class="ag-ns-control">
          <div class="ag-ns-switch-wrap">
            <span class="ag-ns-switch-state" data-ag-ns-sw-status="betaChannel" aria-live="polite"></span>
            <button type="button" id="ag-ns-sw-betaChannel" class="ag-ns-switch" role="switch" aria-checked="false" data-ag-ns-switch="betaChannel"></button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 9. 本地数据与诊断 -->
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

  <!-- Shadow DOM 内联轻提示 -->
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
    var raised = container.querySelectorAll('.ag-ns-card.is-dropdown-open, .ag-ns-group.is-dropdown-open');
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

  function resolveNativeSelectLabel(sel) {
    if (!sel) return '';
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

    function focusTriggerNoScroll() {
      if (typeof trigger.focus !== 'function') return;
      try {
        trigger.focus({ preventScroll: true });
      } catch {
        trigger.focus();
      }
    }

    function getUiLangHint() {
      var activeSeg = container.querySelector ? container.querySelector('[data-ag-ns-seg="panelLanguage"] .ag-ns-seg-btn.is-active') : null;
      return activeSeg?.getAttribute?.('data-val') || 'zh-CN';
    }

    function closeMenu(restoreFocus) {
      wrap.classList?.remove?.('is-open', 'open-up', 'align-right');
      trigger.setAttribute('aria-expanded', 'false');
      var card = wrap.closest ? wrap.closest('.ag-ns-card') : null;
      var group = wrap.closest ? wrap.closest('.ag-ns-group') : null;
      if (card) card.classList?.remove?.('is-dropdown-open');
      if (group) group.classList?.remove?.('is-dropdown-open');
      focusIdx = -1;
      if (restoreFocus) focusTriggerNoScroll();
    }

    function selectEntry(entry) {
      if (!entry) return;
      var changed = String(sel.value ?? '') !== String(entry.value ?? '');
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

    function renderMenuItems(filterKw) {
      var listBox = menu.querySelector ? menu.querySelector('.ag-ns-dd-list') : null;
      if (!listBox) return;
      if (typeof listBox.replaceChildren === 'function') listBox.replaceChildren();
      else listBox.innerHTML = '';

      var kw = String(filterKw || '').trim().toLowerCase();
      var allEntries = collectNativeSelectEntries(sel);
      var curVal = String(sel.value ?? '');
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
        (function (optEntry, optIdx) {
          var isSel = optEntry.value === curVal;
          var itemEl = doc.createElement('div');
          itemEl.className = 'ag-ns-dd-item' + (isSel ? ' is-selected' : '');
          itemEl.setAttribute('role', 'option');
          itemEl.setAttribute('aria-selected', isSel ? 'true' : 'false');
          itemEl.setAttribute('data-value', optEntry.value);
          itemEl.setAttribute('data-index', String(optIdx));
          itemEl.title = optEntry.label;

          var txt = doc.createElement('span');
          txt.className = 'ag-ns-dd-item-text';
          txt.textContent = optEntry.label;

          var chk = doc.createElement('span');
          chk.className = 'ag-ns-dd-check';
          chk.setAttribute('aria-hidden', 'true');
          chk.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 6.3 4.9 9l4.9-5.8"/></svg>';

          itemEl.appendChild(txt);
          itemEl.appendChild(chk);
          itemEl.addEventListener('click', function (ev) {
            ev?.stopPropagation?.();
            selectEntry(optEntry);
          });
          listBox.appendChild(itemEl);
          if (isSel) focusIdx = optIdx;
        })(it, optCursor++);
      }
    }

    function buildMenu() {
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      else menu.innerHTML = '';

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
          renderMenuItems(ev.target ? ev.target.value : '');
        });
        searchInput.addEventListener('keydown', handleOpenKeydown);
        sWrap.appendChild(searchInput);
        menu.appendChild(sWrap);
      }

      var listBox = doc.createElement('div');
      listBox.className = 'ag-ns-dd-list';
      menu.appendChild(listBox);

      renderMenuItems('');
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
          if (spaceBelow < 240 && spaceAbove > spaceBelow) {
            wrap.classList?.add?.('open-up');
          } else {
            wrap.classList?.remove?.('open-up');
          }
          if (rect.left + Math.max(rect.width, 200) > viewRight - 10) {
            wrap.classList?.add?.('align-right');
          } else {
            wrap.classList?.remove?.('align-right');
          }
        }
      } catch {
        wrap.classList?.remove?.('open-up', 'align-right');
      }

      var card = wrap.closest ? wrap.closest('.ag-ns-card') : null;
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
        if (focusIdx >= 0 && visibleOpts[focusIdx]) {
          selectEntry(visibleOpts[focusIdx]);
        } else if (visibleOpts.length === 1) {
          selectEntry(visibleOpts[0]);
        }
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
        renderMenuItems('');
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

    var switches = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-switch]') : [];
    for (var j = 0; j < switches.length; j++) {
      (function (sw) {
        var key = sw.getAttribute('data-ag-ns-switch');
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
      ownerDoc._agNsActiveContainer = container;
      if (!ownerDoc._agNsDdOutsideBound) {
        ownerDoc._agNsDdOutsideBound = true;
        ownerDoc.addEventListener('click', function (e) {
          var activeBox = ownerDoc._agNsActiveContainer;
          if (!activeBox || !activeBox.isConnected) return;
          var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
          for (var p = 0; p < path.length; p++) {
            if (path[p]?.classList?.contains?.('ag-ns-dd-wrap')) return;
          }
          closeAllNativeDropdowns(activeBox, null);
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
          if (allChks[ci].checked && allChks[ci].value) {
            checkedEmails.push(allChks[ci].value);
          }
        }
        if (typeof cbs.onChange === 'function') {
          cbs.onChange('autoSwitchCandidates', checkedEmails, { sourceEl: chk });
        }
      });
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
          if (hexLabel) {
            hexLabel.textContent = hexUpper;
          }
          if (typeof cbs.onColorChange === 'function') {
            cbs.onColorChange(colorKey, input.value);
          }
        });
      })(colorInputs[m]);
    }

    var resetColorsBtn = byId(root, 'ag-ns-reset-colors');
    if (resetColorsBtn) {
      resetColorsBtn.addEventListener('click', function () {
        if (typeof cbs.onResetColors === 'function') {
          cbs.onResetColors();
        }
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

    var segGroups = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-seg]') : [];
    for (var i = 0; i < segGroups.length; i++) {
      var group = segGroups[i];
      var segKey = group.getAttribute('data-ag-ns-seg');
      var curVal = settings[segKey] !== undefined ? String(settings[segKey]) : '';
      var btns = group.querySelectorAll ? group.querySelectorAll('.ag-ns-seg-btn') : [];
      for (var b = 0; b < btns.length; b++) {
        var isActive = btns[b].getAttribute('data-val') === curVal;
        btns[b].classList?.toggle?.('is-active', isActive);
        btns[b].setAttribute?.('aria-checked', isActive ? 'true' : 'false');
      }
    }

    var switches = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-switch]') : [];
    for (var j = 0; j < switches.length; j++) {
      var sw = switches[j];
      var swKey = sw.getAttribute('data-ag-ns-switch');
      var fb = swFbMap[swKey] || null;
      var isOn = Boolean(settings[swKey]);
      var isBusy = Boolean(fb && fb.busy);
      sw.classList?.toggle?.('is-on', isOn);
      sw.setAttribute?.('aria-checked', isOn ? 'true' : 'false');
      sw.disabled = Boolean(isBusy || (fb && fb.disabled));
      if (isBusy) sw.setAttribute?.('aria-busy', 'true');
      else sw.removeAttribute?.('aria-busy');

      var stEl = container.querySelector ? container.querySelector('[data-ag-ns-sw-status="' + swKey + '"]') : null;
      if (stEl) {
        if (fb && fb.text) {
          stEl.textContent = String(fb.text);
          stEl.setAttribute('data-tone', fb.tone || 'idle');
        } else {
          stEl.textContent = '';
          stEl.setAttribute('data-tone', 'idle');
        }
      }
    }

    var selects = container.querySelectorAll ? container.querySelectorAll('[data-ag-ns-select]') : [];
    for (var k = 0; k < selects.length; k++) {
      var sel = selects[k];
      var selKey = sel.getAttribute('data-ag-ns-select');
      if (selKey === 'autoSwitchTarget') {
        var legacyOpt = byId(root, 'ag-ns-opt-legacy-target');
        if (legacyOpt) {
          var isLegacy = !settings.autoSwitchTarget;
          legacyOpt.hidden = !isLegacy;
        }
      }
      if (settings[selKey] !== undefined && sel.value !== String(settings[selKey]) && root.activeElement !== sel) {
        sel.value = String(settings[selKey]);
      }
    }
    syncAllNativeSelectDropdowns(container);

    var proxyInput = byId(root, 'ag-ns-input-proxyUrl');
    if (proxyInput && typeof settings.proxyUrl === 'string' && root.activeElement !== proxyInput) {
      if (proxyInput.value !== settings.proxyUrl) proxyInput.value = settings.proxyUrl;
    }

    var thInput = byId(root, 'ag-ns-inp-autoSwitchThreshold');
    if (thInput && settings.autoSwitchThreshold !== undefined && root.activeElement !== thInput) {
      var thStr = String(settings.autoSwitchThreshold);
      if (thInput.value !== thStr) thInput.value = thStr;
    }

    var colorKeys = ['panelBg', 'ringUsed', 'ringTrack', 'contextText', 'speedText', 'tokenTotal', 'tokenAccent'];
    for (var c = 0; c < colorKeys.length; c++) {
      var ck = colorKeys[c];
      if (!colors[ck]) continue;
      var colorInput = container.querySelector ? container.querySelector('[data-ag-ns-color="' + ck + '"]') : null;
      var colorHex = container.querySelector ? container.querySelector('[data-ag-ns-color-hex="' + ck + '"]') : null;
      if (colorInput && String(colorInput.value || '').toLowerCase() !== String(colors[ck]).toLowerCase()) {
        colorInput.value = colors[ck];
      }
      if (colorHex) {
        colorHex.textContent = String(colors[ck]).toUpperCase();
      }
    }

    // 候选账号列表增量渲染，避免打断当前滚动与焦点
    var candWrap = byId(root, 'ag-ns-autoswitch-candidates');
    if (candWrap && Array.isArray(status.autoSwitchCandidates)) {
      var candSig = JSON.stringify(status.autoSwitchCandidates);
      if (candWrap.getAttribute('data-cand-sig') !== candSig) {
        candWrap.setAttribute('data-cand-sig', candSig);
        if (typeof candWrap.replaceChildren === 'function') {
          candWrap.replaceChildren();
        } else {
          candWrap.innerHTML = '';
        }
        var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (status.autoSwitchCandidates.length === 0 && doc) {
          var emptySpan = doc.createElement('span');
          emptySpan.className = 'ag-ns-row-desc';
          emptySpan.textContent = status.autoSwitchEmptyCandidatesText || '暂无可切入的备选账号';
          candWrap.appendChild(emptySpan);
        } else if (doc) {
          for (var ci = 0; ci < status.autoSwitchCandidates.length; ci++) {
            var item = status.autoSwitchCandidates[ci];
            var lbl = doc.createElement('label');
            lbl.className = 'ag-ns-cand-chip' + (item.selected ? ' is-checked' : '');
            var chk = doc.createElement('input');
            chk.type = 'checkbox';
            chk.value = item.email;
            chk.checked = Boolean(item.selected);
            var span = doc.createElement('span');
            span.textContent = item.label || item.maskedEmail || item.email;
            lbl.appendChild(chk);
            lbl.appendChild(span);
            candWrap.appendChild(lbl);
          }
        }
      }
    }

    var asPill = byId(root, 'ag-ns-autoswitch-pill');
    if (asPill && status.autoSwitchLabel) {
      asPill.textContent = status.autoSwitchLabel;
      asPill.className = 'ag-ns-pill ' + (status.autoSwitchToneClass || '');
    }
    var asNote = byId(root, 'ag-ns-autoswitch-note');
    if (asNote && status.autoSwitchNote !== undefined) {
      asNote.textContent = status.autoSwitchNote || '';
      asNote.classList?.toggle?.('is-error', status.autoSwitchNoteTone === 'error');
    }
    var asLiveSummary = byId(root, 'ag-ns-autoswitch-live-summary');
    if (asLiveSummary) {
      if (status.autoSwitchLiveSummary) {
        asLiveSummary.hidden = false;
        asLiveSummary.textContent = status.autoSwitchLiveSummary;
        asLiveSummary.className = 'ag-ns-note-box ' + (status.autoSwitchLiveSummaryTone === 'warn' ? 'is-error' : '');
      } else {
        asLiveSummary.hidden = true;
      }
    }

    var i18nBadge = byId(root, 'ag-ns-i18n-badge');
    if (i18nBadge && status.clientLangBadgeText) {
      i18nBadge.textContent = status.clientLangBadgeText;
      i18nBadge.className = 'ag-ns-pill ' + (status.clientLangBadgeClass || '');
    }
    var i18nDesc = byId(root, 'ag-ns-i18n-desc');
    if (i18nDesc && status.clientLangDescText) {
      i18nDesc.textContent = status.clientLangDescText;
    }
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
    if (btnRehydrateEn) btnRehydrateEn.disabled = Boolean(status.rehydrateBusy || status.rehydrateDisableEnable);
    if (btnRehydrateDis) btnRehydrateDis.disabled = Boolean(status.rehydrateBusy || status.rehydrateDisableDisable);

    var enhBadge = byId(root, 'ag-ns-enhance-badge');
    if (enhBadge && status.enhanceBadgeText) {
      enhBadge.textContent = status.enhanceBadgeText;
      enhBadge.className = 'ag-ns-pill ' + (status.enhanceBadgeClass || '');
    }

    var proxyBadge = byId(root, 'ag-ns-proxy-badge');
    if (proxyBadge) {
      proxyBadge.textContent = status.proxyBadgeText || (settings.proxyEnabled ? '已启用' : '未启用');
      proxyBadge.className = 'ag-ns-pill ' + (status.proxyBadgeClass || (settings.proxyEnabled ? 'is-accent' : ''));
    }
    var proxyDesc = byId(root, 'ag-ns-proxy-desc');
    if (proxyDesc && status.proxyDescText) {
      proxyDesc.textContent = status.proxyDescText;
    }

    var rateDesc = byId(root, 'ag-ns-billing-rate-desc');
    if (rateDesc && status.billingHint) {
      rateDesc.textContent = status.billingHint;
    }

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

    var cacheDesc = byId(root, 'ag-ns-cache-size-desc');
    if (cacheDesc && status.cacheDescText) {
      cacheDesc.textContent = status.cacheDescText;
    }

    if (data.toastMessage) {
      showToast(root, data.toastMessage);
    }
  }

  return {
    buildNativeSettingsPageCss,
    buildNativeSettingsPageHtml,
    initContextSettingsUI,
    renderContextSettingsUI
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildNativeSettingsPageCss,
    buildNativeSettingsPageHtml,
    initContextSettingsUI,
    renderContextSettingsUI
  };
}
