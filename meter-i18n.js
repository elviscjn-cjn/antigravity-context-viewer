'use strict';
/**
 * Antigravity 客户端界面中文汉化引擎模块 (meter-i18n.js)
 *
 * 完整融合 antigravity2-cn (V12 物理隔离汉化引擎，来源 https://github.com/qqxpee/antigravity2-cn)：
 * 1. 支持 简体中文 (zh-CN) / 繁體中文 (zh-TW) / 官方英文 (en) 一键切换与完整无痕还原。
 * 2. 支持左上角品牌名三种显示策略：保留英文 Antigravity / 隐藏品牌名 / 汉化为反重力。
 * 3. 覆盖五大模块：preload.js (DOM + ShadowDOM + 原生右键菜单 + MCP 市场探针)、
 *    menu.js (系统顶栏菜单)、tray.js (托盘菜单与双击唤醒)、loadingOverlay.js、updater.js。
 * 4. 内置 #ag-context-meter 物理隔离与原文快照 WeakMap，与上下文查看器零冲突协同。
 * 5. 兼容可选 proxy_config/ 免 TUN 代理模块自动同步。
 */

const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./asar-engine');

const SIGNATURE_START = '/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */';
const SIGNATURE_END = '/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */';

const LOCALE_META = {
  'zh-CN': { locale: 'zh-CN', label: '简体中文', shortLabel: '简中汉化', dictsFolder: 'dicts', useTw: false },
  'zh-TW': { locale: 'zh-TW', label: '繁體中文', shortLabel: '繁中漢化', dictsFolder: 'dicts_tw', useTw: true },
  en: { locale: 'en', label: '官方英文 (关闭汉化)', shortLabel: '官方英文', dictsFolder: null, useTw: false }
};

const BRAND_TITLE_META = {
  english: { mode: 'english', label: '保留英文 Antigravity (推荐)', shortLabel: 'Antigravity' },
  hidden: { mode: 'hidden', label: '隐藏左上角品牌名', shortLabel: '隐藏品牌' },
  translated: { mode: 'translated', label: '中文品牌名 (反重力)', shortLabel: '中文品牌' }
};

const PRELOAD_RUNTIME_TEMPLATE = "(() => {\n    // V12.0 终极隔离版：基于容器回溯的物理隔离引擎\n    // 逻辑：不再仅仅检查当前标签，而是向上回溯父级，识别“代码/编辑器”禁区\n    try {\n        if (typeof window !== \"undefined\" && window.top && window.self && window.top !== window.self) return;\n        if (typeof location !== \"undefined\" && location && /^https?:$/i.test(location.protocol || \"\") && location.hostname && location.hostname !== \"127.0.0.1\" && location.hostname !== \"localhost\") return;\n    } catch (e) {}\n    const USE_TW = __USE_TW_PLACEHOLDER__;\n    const BRAND_TITLE_MODE = __BRAND_TITLE_PLACEHOLDER__;\n    let disposed = false;\n    if (typeof window !== \"undefined\" && window.__AGLocalization?.dispose) { try { window.__AGLocalization.dispose(); } catch (e) {} }\n    const map = new Map(Object.entries(DICT_PLACEHOLDER));\n    const lowerMap = new Map();\n    const LOWER_WORDS_EXCLUDE = new Set(['on', 'in', 'to', 'at', 'by', 'for', 'with', 'as', 'system', 'review', 'active', 'browser', 'global', 'including', 'and', 'or', 'file', 'files', 'help', 'app', 'plan', 'search']);\n    for (const [k, v] of map.entries()) {\n        const lowerK = k.toLowerCase();\n        if (LOWER_WORDS_EXCLUDE.has(lowerK) && k !== lowerK) {\n            continue;\n        }\n        lowerMap.set(lowerK, v);\n    }\n    \n    const longEntries = Array.from(map.entries())\n        .filter(([k]) => k.length > 15 && k.includes(' '))\n        .sort((a, b) => b[0].length - a[0].length);\n    const translatedValues = new WeakMap();\n    const origTextValues = (typeof window !== \"undefined\" && window.__AGOrigTextValues) || new WeakMap();\n    const origAttrValues = (typeof window !== \"undefined\" && window.__AGOrigAttrValues) || new WeakMap();\n    if (typeof window !== \"undefined\") { window.__AGOrigTextValues = origTextValues; window.__AGOrigAttrValues = origAttrValues; }\n\n    // 轻量级安全隔离：跳过脚本、样式、代码块(pre/code)\n    const SKIP_TAGS = ['SCRIPT', 'STYLE', 'PRE', 'CODE'];\n\n    // 代码、富文本输入框及对话内容隔离选择器：排除 Lexical 输入框、用户消息、AI 响应正文、思考内容、代码块、终端及文件路径\n    const CODE_ISOLATION_SELECTOR = '#ag-context-meter, pre, code, .monaco-editor, .cm-editor, .cm-line, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [contenteditable=\"\"], [data-lexical-editor], .terminal, .xterm, .code-line, .code-block, .line-content, [aria-label=\"File Viewer\"], [data-file-uri], [data-uri], [class*=\"diffEditor\"], .token, .hljs, [class*=\"mtk\"], .font-mono, [data-quotable-inline=\"true\"], .context-scope-mention, [data-testid=\"file-title-name\"], [data-testid=\"entity-pill\"], [data-project-card=\"true\"], [data-testid=\"conversation-row-sidebar\"] span.truncate, [translate=\"no\"], .notranslate, .md-divider-spacing, .cursor-edit, [data-testid=\"user-input-step\"] [data-quotable=\"true\"], [data-testid=\"user-input-step\"] .whitespace-pre-wrap, [data-testid=\"planner-response-text\"], [data-testid=\"thinking-collapsible-trigger\"] + div, [data-testid=\"thinking-collapsible-trigger\"] ~ div';\n\n    function isCodeOrEditor(node) {\n        try {\n            if (!node) return false;\n            let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;\n            if (!el && typeof node.getRootNode === 'function') {\n                el = node.getRootNode().host || null;\n            }\n            if (!el) return false;\n            if (el.isContentEditable) return true;\n            if (node.nodeType === Node.TEXT_NODE && el) {\n                if (el.tagName === 'TEXTAREA') return true;\n                if (el.tagName === 'OPTION' && !el.hasAttribute('value')) return true;\n            }\n            const active = document.activeElement;\n            if (active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active.getAttribute && active.getAttribute('data-lexical-editor') === 'true')) && (active === el || active.contains(el))) {\n                return true;\n            }\n            while (el) {\n                if (el.isContentEditable) return true;\n                if (typeof el.closest === 'function' && el.closest(CODE_ISOLATION_SELECTOR)) {\n                    return true;\n                }\n                const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;\n                el = (root && root.host) ? root.host : null;\n            }\n            return false;\n        } catch (e) {\n            return false;\n        }\n    }\n\n    function norm(s) {\n        if (!s) return '';\n        return s.replace(/\\s+/g, ' ').replace(/[‘’]/g, \"'\").replace(/[“”]/g, '\"').replace(/…/g, '...').trim();\n    }\n\n    function translateWithShortcut(val) {\n        if (!val) return null;\n        const match = val.match(/^(.+?)\\s*\\(((?:Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\\+?[^)]*|Enter|Escape|Esc|Space|Tab|Backspace|Delete|⏎|Aa|ab|\\.\\*|-|0|[a-zA-Z0-9])\\)$/i);\n        if (match) {\n            const prefix = match[1].trim();\n            const normPref = norm(prefix);\n            const lowerPref = normPref.toLowerCase();\n            let transPref = null;\n            if (map.has(normPref)) {\n                transPref = map.get(normPref);\n            } else if (lowerMap.has(lowerPref)) {\n                transPref = lowerMap.get(lowerPref);\n            }\n            if (transPref) {\n                return transPref + \" (\" + match[2] + \")\";\n            }\n        }\n        return null;\n    }\n\n    // ==========================================\n    // 原生系统右键菜单 (Native Context Menu) 汉化拦截\n    // ==========================================\n    function translateContextMenuLabel(label) {\n        if (!label || typeof label !== 'string') return label;\n        let trimmed = norm(label);\n        if (!trimmed) return label;\n\n        let isDefault = false;\n        if (/\\s*\\((?:Default|預設|默认)\\)$/i.test(trimmed)) {\n            trimmed = trimmed.replace(/\\s*\\((?:Default|預設|默认)\\)$/i, '').trim();\n            isDefault = true;\n        }\n\n        let translated = null;\n        const shortcutTrans = translateWithShortcut(trimmed);\n        if (shortcutTrans) {\n            translated = shortcutTrans;\n        } else if (map.has(trimmed)) {\n            translated = map.get(trimmed);\n        } else if (lowerMap.has(trimmed.toLowerCase())) {\n            translated = lowerMap.get(trimmed.toLowerCase());\n        }\n\n        if (translated) {\n            return isDefault ? (translated + (USE_TW ? \" (預設)\" : \" (默认)\")) : translated;\n        } else if (isDefault) {\n            return trimmed + (USE_TW ? \" (預設)\" : \" (默认)\");\n        }\n        return label;\n    }\n\n    function translateContextMenuItems(items) {\n        if (!Array.isArray(items)) return items;\n        return items.map(item => {\n            if (!item || typeof item !== 'object') return item;\n            const newItem = Object.assign({}, item);\n            if (newItem.label) {\n                newItem.label = translateContextMenuLabel(newItem.label);\n            }\n            if (Array.isArray(newItem.submenu)) {\n                newItem.submenu = translateContextMenuItems(newItem.submenu);\n            }\n            if (Array.isArray(newItem.items)) {\n                newItem.items = translateContextMenuItems(newItem.items);\n            }\n            return newItem;\n        });\n    }\n\n    function hookNativeContextMenu() {\n        globalThis.__agMenuTranslator = (items) => disposed ? items : translateContextMenuItems(items);\n        try {\n            const electronModule = typeof electron_1 !== 'undefined' ? electron_1 : (typeof require === 'function' ? require('electron') : null);\n            if (electronModule && electronModule.ipcRenderer && !electronModule.ipcRenderer._cnContextMenuHooked) {\n                electronModule.ipcRenderer._cnContextMenuHooked = true;\n                const origInvoke = electronModule.ipcRenderer.invoke.bind(electronModule.ipcRenderer);\n                electronModule.ipcRenderer.invoke = function(channel, ...args) {\n                    if (channel === 'window:show-context-menu' && Array.isArray(args[0]) && typeof globalThis.__agMenuTranslator === 'function') {\n                        try {\n                            args[0] = globalThis.__agMenuTranslator(args[0]);\n                        } catch (e) {}\n                    }\n                    return origInvoke(channel, ...args);\n                };\n            }\n        } catch (e) {}\n\n        try {\n            if (typeof window !== 'undefined' && window.electronNative && !window.electronNative._cnContextMenuHooked) {\n                const origShow = window.electronNative.showContextMenu;\n                if (typeof origShow === 'function') {\n                    window.electronNative._cnContextMenuHooked = true;\n                    window.electronNative.showContextMenu = function(items) {\n                        if (typeof globalThis.__agMenuTranslator === 'function') {\n                            try {\n                                items = globalThis.__agMenuTranslator(items);\n                            } catch (e) {}\n                        }\n                        return origShow.call(this, items);\n                    };\n                }\n            }\n        } catch (e) {}\n    }\n\n    hookNativeContextMenu();\n\n    function isFilePathOrUri(s) {\n        if (!s) return false;\n        return /^[a-zA-Z]:[\\\\/]/.test(s) || /^[\\\\/~].*[\\\\/]/.test(s) || /[\\\\/]SKILL\\.md/i.test(s) || /[\\\\/]\\.gemini[\\\\/]/i.test(s) || /^file:\\/\\//i.test(s);\n    }\n\n    function formatUsageDuration(value) {\n        const text = value.trim();\n        const tokens = /([0-9]+(?:\\.[0-9]+)?)\\s*(years?|yr|months?|mo|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|sec|s)(?![a-z])/gi;\n        const parts = [];\n        let end = 0;\n        for (const match of text.matchAll(tokens)) {\n            const gap = text.slice(end, match.index);\n            if (!/^[\\s,]*$/.test(gap) && !(end === 0 && gap.trim() === '<')) return null;\n            const unit = match[2].toLowerCase();\n            const name = /^(year|yr)/.test(unit) ? '年'\n                : /^(month|mo)/.test(unit) ? (USE_TW ? '個月' : '个月')\n                : /^(week|w)/.test(unit) ? (USE_TW ? '週' : '周')\n                : /^(day|d)/.test(unit) ? '天'\n                : /^(hour|h)/.test(unit) ? (USE_TW ? '小時' : '小时')\n                : /^(minute|min|m)$/.test(unit) || /^minutes$/.test(unit) ? (USE_TW ? '分鐘' : '分钟') : '秒';\n            parts.push((end === 0 && gap.trim() === '<' ? '<' : '') + match[1] + ' ' + name);\n            end = match.index + match[0].length;\n        }\n        return parts.length && !text.slice(end).trim() ? parts.join(' ') : null;\n    }\n\n    function translateUsageText(value) {\n        const limit = value.match(/^([0-9]+)(?:h|[- ]hours?)\\s+limit$/i);\n        if (limit) return limit[1] + (USE_TW ? ' 小時上限' : ' 小时限额');\n        const remaining = value.match(/^([0-9]+(?:\\.[0-9]+)?\\s*%|%)\\s+left$/i);\n        if (remaining) return remaining[1] + (USE_TW ? ' 剩餘' : ' 剩余');\n        const reset = value.match(/^(?:Resets|Refreshes)\\s+in\\s+(.+)$/i);\n        if (reset) {\n            const duration = formatUsageDuration(reset[1]);\n            if (duration) return duration + (USE_TW ? ' 後重設' : ' 后重置');\n        }\n        return null;\n    }\n\n    function isModelMenuText(node) {\n        const menu = node.parentElement && node.parentElement.closest('[role=\"menu\"]');\n        if (!menu) return false;\n        let label = menu.getAttribute('aria-label');\n        if (!label) {\n            const root = menu.getRootNode();\n            label = (menu.getAttribute('aria-labelledby') || '').trim().split(/\\s+/).map(id => {\n                const target = (root.getElementById && root.getElementById(id)) || document.getElementById(id);\n                return target ? (target.getAttribute('aria-label') || target.textContent || '') : '';\n            }).join(' ');\n        }\n        return /^(Select model|选择模型|選擇模型)/i.test(norm(label || ''));\n    }\n\n    function refreshMenusLabelledBy(target) {\n        if (!target.id) return;\n        const roots = new Set([document, target.getRootNode()]);\n        for (const root of roots) {\n            if (!root.querySelectorAll) continue;\n            for (const menu of root.querySelectorAll('[role=\"menu\"][aria-labelledby]')) {\n                if ((menu.getAttribute('aria-labelledby') || '').split(/\\s+/).includes(target.id)) {\n                    translateNode(menu);\n                }\n            }\n        }\n    }\n\n    function translateNode(node) {\n        try {\n            if (!node) return;\n\n            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {\n                if (node.host && isCodeOrEditor(node.host)) return;\n                for (const child of node.childNodes) translateNode(child);\n                return;\n            }\n            \n            if (node.nodeType === Node.ELEMENT_NODE) {\n                const tag = node.tagName.toUpperCase();\n                if (SKIP_TAGS.includes(tag)) return;\n                // Check before translating attributes used as isolation markers.\n                // Form values and user content must not depend on focus state.\n                if (isCodeOrEditor(node)) return;\n\n                // 翻译属性：placeholder, title, aria-label\n                for (const attr of ['placeholder', 'title', 'aria-label']) {\n                    const v = node.getAttribute(attr);\n                    if (v) {\n                        const t = norm(v);\n                        if (isFilePathOrUri(t)) continue;\n                        let newAttr = null;\n                        const shortcutTrans = translateWithShortcut(t);\n                        const usageTrans = translateUsageText(t);\n                        if (usageTrans) newAttr = usageTrans;\n                        else if (shortcutTrans) newAttr = shortcutTrans;\n                        else if (map.has(t)) newAttr = map.get(t);\n                        else if (lowerMap.has(t.toLowerCase())) newAttr = lowerMap.get(t.toLowerCase());\n                        else if (/^Show\\s+(\\d+)\\s+more/i.test(t)) {\n                            newAttr = t.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (m, num, p2, type) => {\n                                if (type) {\n                                    if (/result/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個結果...\") : (\"显示另外 \" + num + \" 个结果...\");\n                                    if (/command/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個命令...\") : (\"显示另外 \" + num + \" 个命令...\");\n                                    if (/item/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個項目...\") : (\"显示另外 \" + num + \" 个项目...\");\n                                    if (/option/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個選項...\") : (\"显示另外 \" + num + \" 个选项...\");\n                                }\n                                return USE_TW ? (\"顯示另外 \" + num + \" 個...\") : (\"显示另外 \" + num + \" 个...\");\n                            });\n                        } else if (/^Show\\s+(\\d+)\\s+breakdown(s)?$/i.test(t)) {\n                            newAttr = t.replace(/^Show\\s+(\\d+)\\s+breakdown(s)?$/i, (m, num) => {\n                                return USE_TW ? (\"顯示 \" + num + \" 項明細\") : (\"显示 \" + num + \" 项细目\");\n                            });\n                        } else if (/^Hide\\s+breakdown(s)?$/i.test(t)) {\n                            newAttr = USE_TW ? \"收起明細\" : \"收起细目\";\n                        } else if (/^See\\s+(\\d+)\\s+more(?:\\s+(.+))?$/i.test(t)) {\n                            newAttr = t.replace(/^See\\s+(\\d+)\\s+more(?:\\s+(.+))?$/i, (m, num) => {\n                                return USE_TW ? (\"展開另外 \" + num + \" 項\") : (\"展开另外 \" + num + \" 项\");\n                            });\n                        } else if (/^See\\s+more\\s+in\\s+(.+)$/i.test(t)) {\n                            newAttr = t.replace(/^See\\s+more\\s+in\\s+(.+)$/i, (m, name) => {\n                                return USE_TW ? (\"在 \" + name + \" 中展開更多\") : (\"在 \" + name + \" 中展开更多\");\n                            });\n                        } else if (/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(t)) {\n                            newAttr = t.replace(/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, del, name, count, dot) => {\n                                const delPrefix = del ? (USE_TW ? \"永久刪除 \" : \"永久删除 \") : \"\";\n                                const suffix = dot ? \"。\" : \"\";\n                                return delPrefix + name + (USE_TW ? (\"（包含 \" + count + \" 個活躍對話）\") : (\"（包含 \" + count + \" 个活跃会话）\")) + suffix;\n                            });\n                        } else if (/^Hi\\s+(.+?),\\s+what can we get done today\\??$/i.test(t)) {\n                            newAttr = t.replace(/^Hi\\s+(.+?),\\s+what can we get done today\\??$/i, (m, name) => {\n                                return USE_TW ? (\"嗨 \" + name + \"，今天有什麼我們可以一起完成的？\") : (\"嗨 \" + name + \"，今天有什么我们可以一起完成的？\");\n                            });\n                        } else if (/^(.+?),\\s+voice\\s+(\\d+)\\s+of\\s+(\\d+)$/i.test(t)) {\n                            newAttr = t.replace(/^(.+?),\\s+voice\\s+(\\d+)\\s+of\\s+(\\d+)$/i, (m, name, curr, total) => {\n                                return USE_TW ? (name + \"，聲音 \" + curr + \" / \" + total) : (name + \"，音色 \" + curr + \" / \" + total);\n                            });\n                        } else if (/^Voice\\s+speed,\\s+([0-9.]+x)$/i.test(t)) {\n                            newAttr = t.replace(/^Voice\\s+speed,\\s+([0-9.]+x)$/i, (m, spd) => {\n                                return USE_TW ? (\"語速，\" + spd) : (\"语速，\" + spd);\n                            });\n                        }\n                        if (newAttr && newAttr !== v) {\n                            let attrBag = origAttrValues.get(node);\n                            if (!attrBag) { attrBag = {}; origAttrValues.set(node, attrBag); }\n                            if (!(attr in attrBag)) attrBag[attr] = v;\n                            node.setAttribute(attr, newAttr);\n                        }\n                    }\n                }\n\n                if (tag === 'INPUT' || tag === 'TEXTAREA') return;\n                if (tag === 'OPTION' && !node.hasAttribute('value')) return;\n\n                if (node.isContentEditable) return;\n                if (node.classList && (node.classList.contains('monaco-editor') || node.classList.contains('terminal') || node.classList.contains('xterm'))) return;\n\n                // 处理 FastPick / 列表底部的 \"Show <N> more...\" 复合节点\n                const elText = node.textContent ? node.textContent.trim() : '';\n                if (/^Show\\s+\\d+\\s+more(?:\\.\\.\\.|…)?$/i.test(elText)) {\n                    const textChildren = Array.from(node.childNodes).filter(c => c.nodeType === Node.TEXT_NODE);\n                    if (textChildren.length >= 2) {\n                        for (const tc of textChildren) {\n                            const v = tc.nodeValue;\n                            if (v === 'Show ' || norm(v) === 'Show') {\n                                tc.nodeValue = USE_TW ? '顯示另外 ' : '显示另外 ';\n                                translatedValues.set(tc, tc.nodeValue);\n                            } else if (v === ' more...' || v === ' more…' || norm(v) === 'more...') {\n                                tc.nodeValue = USE_TW ? ' 個...' : ' 个...';\n                                translatedValues.set(tc, tc.nodeValue);\n                            }\n                        }\n                    } else if (textChildren.length === 1) {\n                        const m = elText.match(/^Show\\s+(\\d+)\\s+more(?:\\.\\.\\.|…)?$/i);\n                        if (m) {\n                            textChildren[0].nodeValue = USE_TW ? ('顯示另外 ' + m[1] + ' 個...') : ('显示另外 ' + m[1] + ' 个...');\n                            translatedValues.set(textChildren[0], textChildren[0].nodeValue);\n                        }\n                    }\n                }\n\n                // 处理语音助手选择器底部 \"Use <VoiceName>\" 复合按钮\n                if (node.getAttribute && node.getAttribute('data-testid') === 'voice-picker-use') {\n                    const textChildren = Array.from(node.childNodes).filter(c => c.nodeType === Node.TEXT_NODE);\n                    for (const tc of textChildren) {\n                        const v = tc.nodeValue;\n                        if (v === 'Use ' || norm(v) === 'Use') {\n                            tc.nodeValue = USE_TW ? '使用 ' : '使用 ';\n                            translatedValues.set(tc, tc.nodeValue);\n                        }\n                    }\n                }\n\n                if (node.shadowRoot) {\n                    observeRoot(node.shadowRoot);\n                    translateNode(node.shadowRoot);\n                }\n                for (const child of node.childNodes) translateNode(child);\n\n            } else if (node.nodeType === Node.TEXT_NODE) {\n                if (isCodeOrEditor(node)) return;\n\n                let originalVal = node.nodeValue;\n                if (!originalVal || originalVal.trim().length < 1) return;\n\n                // 处理 FastPick / 列表底部由于 React 节点拆分导致的 \"Show \", num, \" more...\" 分段文本\n                const parentText = node.parentElement && node.parentElement.textContent ? node.parentElement.textContent.trim() : '';\n                if (isFilePathOrUri(originalVal.trim()) || isFilePathOrUri(parentText)) return;\n                if (parentText && (\n                    /^(?:Show|显示另外|顯示另外)\\s+\\d+\\s+(?:more|个|個)(?:\\.\\.\\.|…)?$/i.test(parentText) ||\n                    (node.parentElement.getAttribute && node.parentElement.getAttribute('value')?.startsWith('fastpick-show-more:'))\n                )) {\n                    if (originalVal === 'Show ' || norm(originalVal) === 'Show') {\n                        node.nodeValue = USE_TW ? '顯示另外 ' : '显示另外 ';\n                        translatedValues.set(node, node.nodeValue);\n                        return;\n                    }\n                    if (originalVal === ' more...' || originalVal === ' more…' || norm(originalVal) === 'more...') {\n                        node.nodeValue = USE_TW ? ' 個...' : ' 个...';\n                        translatedValues.set(node, node.nodeValue);\n                        return;\n                    }\n                }\n\n                // 核心：如果是 skeleton 骨架占位文本，强制打上不翻译标记，防止自动翻译（例如 Google Translate 网页翻译）将其翻译为“装。资料。包装。资料。”\n                if (originalVal.toLowerCase().includes('pack.info')) {\n                    const parent = node.parentElement;\n                    if (parent) {\n                        if (parent.getAttribute('translate') !== 'no') {\n                            parent.setAttribute('translate', 'no');\n                        }\n                        try {\n                            if (!parent.classList.contains('notranslate')) {\n                                parent.classList.add('notranslate');\n                            }\n                        } catch (e) {}\n                    }\n                    return;\n                }\n\n                const valNorm = norm(originalVal);\n                const cachedValue = translatedValues.get(node);\n                // Base UI can attach its accessible name after the badge was translated.\n                // Correct our own generic New translation before the value-cache shortcut.\n                if ((valNorm === 'New' || (cachedValue === originalVal && valNorm === map.get('New'))) && isModelMenuText(node)) {\n                    if (originalVal !== '新') {\n                        translatedValues.set(node, '新');\n                        node.nodeValue = '新';\n                    }\n                    return;\n                }\n                if (cachedValue === originalVal) return;\n\n                let newVal = originalVal;\n                const valLower = valNorm.toLowerCase();\n                \n                // 1. 精确匹配（含大小写自动纠正与快捷键检测）\n                const shortcutTrans = translateWithShortcut(valNorm);\n                const usageTrans = translateUsageText(valNorm);\n                if (usageTrans) {\n                    newVal = usageTrans;\n                } else if (shortcutTrans) {\n                    newVal = shortcutTrans;\n                } else if (map.has(valNorm)) {\n                    newVal = map.get(valNorm);\n                } else if (lowerMap.has(valLower)) {\n                    newVal = lowerMap.get(valLower);\n                } else if (/^Send message\\s+(Enter|⏎|\\u23ce)$/i.test(valNorm)) {\n                    newVal = (USE_TW ? \"發送消息 \" : \"发送消息 \") + valNorm.replace(/^Send message\\s+/i, '');\n                } else if (/^Queue message\\s+(Enter|⏎|\\u23ce)$/i.test(valNorm)) {\n                    newVal = (USE_TW ? \"排隊發送消息 \" : \"排队发送消息 \") + valNorm.replace(/^Queue message\\s+/i, '');\n                } else if (/^Hi\\s+(.+?),\\s+what can we get done today\\??$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Hi\\s+(.+?),\\s+what can we get done today\\??$/i, (m, name) => {\n                        return USE_TW ? (\"嗨 \" + name + \"，今天有什麼我們可以一起完成的？\") : (\"嗨 \" + name + \"，今天有什么我们可以一起完成的？\");\n                    });\n                } else if (/^What can we get done today\\??$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"今天有什麼我們可以一起完成的？\" : \"今天有什么我们可以一起完成的？\";\n                } else if (/^Select all in$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"全選 \" : \"全选 \";\n                } else if (/^Uses your local clone,$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"使用本機複製版本，\" : \"使用本地克隆版本，\";\n                } else if ((valNorm === 'Card' || valNorm === 'of') && node.parentElement && (\n                    (typeof node.parentElement.closest === 'function' && node.parentElement.closest('[data-testid=\"card-deck-counter\"]')) ||\n                    (node.parentElement.getAttribute && node.parentElement.getAttribute('data-testid') === 'card-deck-counter')\n                )) {\n                    if (valNorm === 'Card') newVal = USE_TW ? \"卡片 \" : \"卡片 \";\n                    else if (valNorm === 'of') newVal = \" / \";\n                } else if (node.parentElement && node.parentElement.textContent && node.parentElement.textContent.includes('For corp passwords (such as')) {\n                    if (valNorm === 'For corp passwords (such as') {\n                        newVal = USE_TW ? \"如需使用公司密碼（例如 \" : \"如需使用公司密码（例如 \";\n                    } else if (valNorm === 'or') {\n                        newVal = USE_TW ? \" 或 \" : \" 或 \";\n                    } else if (valNorm.startsWith('), use an external SSH session')) {\n                        newVal = valNorm.replace(/^\\), use an external SSH session/i, USE_TW ? \"），請使用外部 SSH 工作階段\" : \"），请使用外部 SSH 会话\");\n                    } else if (valNorm.startsWith('. For non-corp passwords')) {\n                        newVal = USE_TW ? \"。對於非公司密碼或 SSH 密碼複雜密碼，請允許下一次提示並重新執行指令。\" : \"。对于非公司密码或 SSH 密码短语，请允许下一次提示并重新运行命令。\";\n                    }\n                } else if (/^to have the agent generate a plan\\.?$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"讓代理生成計劃。\" : \"让智能体生成计划。\";\n                } else if ((valNorm === 'Type' || valNorm === 'and select') && node.parentElement && (\n                    (typeof node.parentElement.closest === 'function' && node.parentElement.closest('[data-testid=\"plan-command-fyi-alert\"]')) ||\n                    (node.parentElement.textContent && node.parentElement.textContent.includes('generate a plan'))\n                )) {\n                    if (valNorm === 'Type') newVal = USE_TW ? \"輸入\" : \"输入\";\n                    else if (valNorm === 'and select') newVal = USE_TW ? \"並選取\" : \"并选择\";\n                } else if (valNorm === 'and' && node.parentElement && (\n                    node.parentElement.textContent && (\n                        node.parentElement.textContent.includes('Privacy Policy') ||\n                        node.parentElement.textContent.includes('Terms of Service') ||\n                        node.parentElement.textContent.includes('隐私政策') ||\n                        node.parentElement.textContent.includes('隱私權政策')\n                    )\n                )) {\n                    newVal = USE_TW ? \"以及\" : \"以及\";\n                } else if ((valNorm === 'Search conversations with' || valNorm === 'in the top left.') && node.parentElement && (\n                    node.parentElement.textContent && node.parentElement.textContent.includes('in the top left')\n                )) {\n                    newVal = (valNorm === 'Search conversations with')\n                        ? (USE_TW ? \"使用左上角的\" : \"可通过左上角的\")\n                        : (USE_TW ? \"搜尋對話。\" : \"搜索对话。\");\n                } else if ((valNorm === 'View archived in the sidebar' || valNorm === 'menu)') && node.parentElement && (\n                    node.parentElement.textContent && node.parentElement.textContent.includes('View archived in the sidebar')\n                )) {\n                    newVal = (valNorm === 'View archived in the sidebar')\n                        ? (USE_TW ? \"已歸檔對話可在側邊欄\" : \"已归档对话可在侧边栏\")\n                        : (USE_TW ? \"選單中查看。\" : \"菜单中查看。\");\n                } else if ((valNorm === 'For help, visit' || valNorm === 'or join the' || valNorm === 'chat space') && node.parentElement && (\n                    node.parentElement.textContent && node.parentElement.textContent.includes('chat space')\n                )) {\n                    if (valNorm === 'For help, visit') newVal = USE_TW ? \"如需協助，請造訪\" : \"如需帮助，请访问\";\n                    else if (valNorm === 'or join the') newVal = USE_TW ? \"或加入\" : \"或加入\";\n                    else if (valNorm === 'chat space') newVal = USE_TW ? \"聊天空間\" : \"聊天空间\";\n                } else if ((valNorm === 'when working' || valNorm === 'in this project' || valNorm === 'in these conversations') && node.parentElement && (\n                    node.parentElement.textContent && (\n                        node.parentElement.textContent.includes('when working') ||\n                        node.parentElement.textContent.includes('Global Permissions') ||\n                        node.parentElement.textContent.includes('全局权限') ||\n                        node.parentElement.textContent.includes('全域權限') ||\n                        node.parentElement.textContent.includes('Global Settings') ||\n                        node.parentElement.textContent.includes('全局设置') ||\n                        node.parentElement.textContent.includes('全域設定')\n                    )\n                )) {\n                    if (valNorm === 'when working') {\n                        const isProj = node.parentElement.textContent.includes('in this project');\n                        if (isProj) {\n                            newVal = USE_TW ? \"（在此專案中工作時）\" : \"（在此项目中工作时）\";\n                        } else {\n                            newVal = USE_TW ? \"（在這些對話中工作時）\" : \"（在这些会话中工作时）\";\n                        }\n                    } else {\n                        newVal = \"\";\n                    }\n                } else if ((valNorm === 'Use' || originalVal === 'Use ') && node.parentElement && (\n                    (typeof node.parentElement.closest === 'function' && node.parentElement.closest('[data-testid=\"voice-picker-use\"]')) ||\n                    (node.parentElement.getAttribute && node.parentElement.getAttribute('data-testid') === 'voice-picker-use')\n                )) {\n                    newVal = USE_TW ? \"使用 \" : \"使用 \";\n                } else if ((valNorm === 'Change' || valNorm === 'Change…' || valNorm === 'Change...') && node.parentElement && (\n                    (typeof node.parentElement.closest === 'function' && (\n                        node.parentElement.closest('[data-testid=\"voice-settings-change\"]') ||\n                        node.parentElement.closest('[data-testid=\"builtin-browser-download-dir-change\"]')\n                    )) ||\n                    (node.parentElement.getAttribute && (\n                        node.parentElement.getAttribute('data-testid') === 'voice-settings-change' ||\n                        node.parentElement.getAttribute('data-testid') === 'builtin-browser-download-dir-change')\n                    ))\n                ) {\n                    const hasEllipsis = valNorm.includes('…') || valNorm.includes('...');\n                    newVal = USE_TW ? (hasEllipsis ? \"變更…\" : \"變更\") : (hasEllipsis ? \"更改…\" : \"更改\");\n                } else if (node.parentElement && (\n                    (typeof node.parentElement.closest === 'function' && node.parentElement.closest('[data-testid=\"voice-picker\"]')) ||\n                    (node.parentElement.querySelector && node.parentElement.querySelector('[data-testid=\"voice-picker-settings-link\"]'))\n                )) {\n                    if (valNorm.startsWith('Powered by Gemini Live')) {\n                        newVal = USE_TW ? \"由 Gemini Live 提供技術支援 · \" : \"由 Gemini Live 提供技术支持 · \";\n                    } else if (valNorm === 'You can change this in') {\n                        newVal = USE_TW ? \"您稍後可在 \" : \"您稍后可在 \";\n                    } else if (valNorm === 'later.') {\n                        newVal = USE_TW ? \" 中變更。\" : \" 中更改。\";\n                    }\n                } else if (/^The AlloyDB for PostgreSQL remote/i.test(valNorm)) {\n                    newVal = USE_TW ? \"AlloyDB for PostgreSQL 遠端 MCP 伺服器可讓您存取並執行 AlloyDB 工具，用於管理 AlloyDB 叢集及執行個體、管理使用者，以及建立和復原資料備份。\" : \"AlloyDB for PostgreSQL 远程 MCP 服务器可让您访问并运行 AlloyDB 工具，用于管理 AlloyDB 集群及实例、管理用户，以及创建和恢复数据备份。\";\n                } else if (/^The Cloud SQL remote/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Cloud SQL 遠端 MCP 伺服器可讓您存取並執行 Cloud SQL 工具，用於管理 Cloud SQL 執行個體、管理使用者、建立和復原資料備份及資料庫維運。\" : \"Cloud SQL 远程 MCP 服务器可让您访问并运行 Cloud SQL 工具，用于管理 Cloud SQL 实例、管理用户、创建和恢复数据备份及数据库运维。\";\n                } else if (/^The Spanner remote/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Spanner 遠端 MCP 伺服器可讓您從 AI 開發環境中存取並執行 Spanner 工具，以建立、管理和查詢分散式資料庫資源。\" : \"Spanner 远程 MCP 服务器可让您从 AI 开发环境中访问并运行 Spanner 工具，以创建、管理和查询分布式数据库资源。\";\n                } else if (/^Ask questions\\.\\s*Get answers\\.\\s*This MCP is a server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"提問，即得答案。該 MCP 是供您的程式設計代理呼叫的伺服器。用英語提出問題，它會針對您的 PostHog 資料執行查詢，結果將直接呈現在您的編輯器中。\" : \"提问，即得答案。该 MCP 是供您的编程智能体调用的服务器。用英语提出问题，它会针对您的 PostHog 数据运行查询，结果将直接呈现在您的编辑器中。\";\n                } else if (/^The GKE remote MCP server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"GKE 遠端 MCP 伺服器提供對 GKE Kubernetes 資源的讀寫存取權限。允許 AI 代理檢查並監控您的執行環境。\" : \"GKE 远程 MCP 服务器提供对 GKE Kubernetes 资源的读写权限。允许 AI 智能体检查并监控您的运行环境。\";\n                } else if (/^Cloud CLI MCP Server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Cloud CLI MCP 伺服器提供在遠端沙箱環境中執行 gcloud 與 bq CLI 指令的工具集。\" : \"Cloud CLI MCP 服务器提供在远程沙箱环境中运行 gcloud 与 bq CLI 命令的工具集。\";\n                } else if (/^The Apigee API hub remote MCP server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Apigee API hub 遠端 MCP 伺服器可讓您管理註冊在 Apigee API hub 中的 API、版本、規格、操作、部署、屬性、外部 API 以及相依性。\" : \"Apigee API hub 远程 MCP 服务器可让您管理注册在 Apigee API hub 中的 API、版本、规范、操作、部署、属性、外部 API 以及依赖项。\";\n                } else if (/^The Google Home Developer MCP server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Google Home Developer MCP 伺服器支援檢索 Google Home 文件、OpenThread 與 Matter 規格文件。\" : \"Google Home Developer MCP 服务器支持检索 Google Home 文档、OpenThread 与 Matter 规范文档。\";\n                } else if (/^The Cloud Quotas MCP server/i.test(valNorm)) {\n                    newVal = USE_TW ? \"Cloud Quotas MCP 伺服器支援檢視配額分配、申請提升配額以及管理 Quota Adjuster 自動調整設定。\" : \"Cloud Quotas MCP 服务器支持查看配额分配、申请提升配额以及管理 Quota Adjuster 自动调整配置。\";\n                } else if (/^Build, edit, deploy, and manage full-stack web apps with Lovable/i.test(valNorm)) {\n                    newVal = USE_TW ? \"使用自然語言，藉助 AI 應用程式建構工具 Lovable 建構、編輯、部署和管理全端 Web 應用程式。該 MCP 伺服器將您的 AI 用戶端連接至 Lovable，允許您的 AI 代理直接在偏好的編輯器或助手內互動、建立和管理 Lovable 專案。\" : \"使用自然语言，借助 AI 应用构建工具 Lovable 构建、编辑、部署和管理全栈 Web 应用。该 MCP 服务器将您的 AI 客户端连接至 Lovable，允许您的 AI 智能体直接在偏好的编辑器或助手中交互、创建和管理 Lovable 项目。\";\n                } else if (/^Build applications with the Gemini Interactions API and Live API/i.test(valNorm)) {\n                    newVal = USE_TW ? \"使用 Gemini Interactions API 與 Live API 建構應用程式，涵蓋文字生成、多輪對話、串流、函式呼叫、託管代理及即時音訊與視訊互動。\" : \"使用 Gemini Interactions API 和 Live API 构建应用，涵盖文本生成、多轮对话、流式传输、函数调用、托管智能体以及实时音视频交互。\";\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i, (match, d, h) => {\n                        return USE_TW ? (d + \" 天 \" + h + \" 小時後更新\") : (d + \" 天 \" + h + \" 小时后刷新\");\n                    });\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i, (match, h, m) => {\n                        return USE_TW ? (h + \" 小時 \" + m + \" 分鐘後更新\") : (h + \" 小时 \" + m + \" 分钟后刷新\");\n                    });\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i, (match, d) => {\n                        return USE_TW ? (d + \" 天後更新\") : (d + \" 天后刷新\");\n                    });\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i, (match, h) => {\n                        return USE_TW ? (h + \" 小時後更新\") : (h + \" 小时后刷新\");\n                    });\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i, (match, m) => {\n                        return USE_TW ? (m + \" 分鐘後更新\") : (m + \" 分钟后刷新\");\n                    });\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in less than a minute\\.?$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"不到 1 分鐘後更新\" : \"不到 1 分钟后刷新\";\n                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in a few seconds\\.?$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"幾秒後更新\" : \"几秒后刷新\";\n                } else if (/^Learn more about$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"瞭解更多關於\" : \"了解更多关于\";\n                } else if (/^Learn more about (.+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Learn more about (.+)$/i, (match, p) => {\n                        let translatedPreset = p;\n                        const pLow = p.toLowerCase();\n                        if (pLow === 'default' || pLow.includes('默认') || pLow.includes('預設')) translatedPreset = USE_TW ? \"預設 (Default)\" : \"默认 (Default)\";\n                        else if (pLow === 'inherit global' || pLow.includes('继承全局') || pLow.includes('繼承全域')) translatedPreset = USE_TW ? \"繼承全域 (Inherit Global)\" : \"继承全局 (Inherit Global)\";\n                        else if (pLow === 'full machine' || pLow.includes('全机') || pLow.includes('全機')) translatedPreset = USE_TW ? \"全機存取 (Full Machine)\" : \"全机访问 (Full Machine)\";\n                        else if (pLow === 'turbo mode' || pLow.includes('极速') || pLow.includes('極速')) translatedPreset = USE_TW ? \"極速模式 (Turbo Mode)\" : \"极速模式 (Turbo Mode)\";\n                        else if (pLow === 'custom' || pLow.includes('自定义') || pLow.includes('自訂')) translatedPreset = USE_TW ? \"自訂 (Custom)\" : \"自定义 (Custom)\";\n                        return USE_TW ? (\"瞭解更多關於 \" + translatedPreset + \" 的詳細資訊\") : (\"了解更多关于 \" + translatedPreset + \" 的信息\");\n                    });\n                } else if (/^Yes, and always allow '(.+)' in this project$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Yes, and always allow '(.+)' in this project$/i, (match, cmd) => {\n                        return USE_TW ? (\"是，且在此專案中一律允許執行 '\" + cmd + \"'\") : (\"是，且在此项目中始终允许运行 '\" + cmd + \"'\");\n                    });\n                } else if (/^Yes, and always allow '(.+)'$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Yes, and always allow '(.+)'$/i, (match, cmd) => {\n                        return USE_TW ? (\"是，且一律允許執行 '\" + cmd + \"'\") : (\"是，且始终允许运行 '\" + cmd + \"'\");\n                    });\n                } else if (/^(\\d+) tools? enabled$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+) tools? enabled$/i, (match, num) => {\n                        return USE_TW ? (num + \" 個工具已啟用\") : (num + \" 个工具已启用\");\n                    });\n                } else if (/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (match, num, p2, type) => {\n                        if (type) {\n                            if (/result/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個結果...\") : (\"显示另外 \" + num + \" 个结果...\");\n                            if (/command/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個指令...\") : (\"显示另外 \" + num + \" 个命令...\");\n                            if (/item/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個項目...\") : (\"显示另外 \" + num + \" 个项目...\");\n                            if (/option/i.test(type)) return USE_TW ? (\"顯示另外 \" + num + \" 個選項...\") : (\"显示另外 \" + num + \" 个选项...\");\n                        }\n                        return USE_TW ? (\"顯示另外 \" + num + \" 個...\") : (\"显示另外 \" + num + \" 个...\");\n                    });\n                } else if (/^Show\\s+(\\d+)\\s+breakdown(s)?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Show\\s+(\\d+)\\s+breakdown(s)?$/i, (match, num) => {\n                        return USE_TW ? (\"顯示 \" + num + \" 項明細\") : (\"显示 \" + num + \" 项细目\");\n                    });\n                } else if (/^Hide\\s+breakdown(s)?$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"收起明細\" : \"收起细目\";\n                } else if (/^Show\\s+breakdown(s)?$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"顯示明細\" : \"显示细目\";\n                } else if (/^Hide\\s+tools$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"收起工具\" : \"收起工具\";\n                } else if (/^(\\d+)\\s+tools$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)\\s+tools$/i, (match, num) => {\n                        return num + (USE_TW ? \" 個工具\" : \" 个工具\");\n                    });\n                } else if (/^(\\d+)\\s+tools?\\s+excluded$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)\\s+tools?\\s+excluded$/i, (match, num) => {\n                        return num + (USE_TW ? \" 個工具已排除\" : \" 个工具已排除\");\n                    });\n                } else if (/^Exceeded the rules token budget\\.\\s+Full rule content\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+was replaced with a lightweight file-path pointer in context\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Exceeded the rules token budget\\.\\s+Full rule content\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+was replaced with a lightweight file-path pointer in context\\.$/i, (match, num) => {\n                        return USE_TW ? (\"已超出規則 Token 預算。完整規則內容 (\" + num + \" 個 Token) 已在上下文中替換為輕量級檔案路徑指標。\") : (\"已超出规则 Token 预算。完整规则内容 (\" + num + \" 个 Token) 已在上下文中替换为轻量级文件路径指针。\");\n                    });\n                } else if (/^All tools in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^All tools in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i, (match, num) => {\n                        return USE_TW ? (\"此 MCP 伺服器中的所有工具 (\" + num + \" 個 Token) 均已超出自訂項預算，並已從上下文中排除。\") : (\"此 MCP 服务器中的所有工具 (\" + num + \" 个 Token) 均已超出自定义项预算，并已从上下文中排除。\");\n                    });\n                } else if (/^(\\d+)\\s+tools?\\s+in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)\\s+tools?\\s+in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i, (match, tCount, num) => {\n                        return USE_TW ? (\"此 MCP 伺服器中有 \" + tCount + \" 個工具 (\" + num + \" 個 Token) 超出自訂項預算，並已從上下文中排除。\") : (\"此 MCP 服务器中有 \" + tCount + \" 个工具 (\" + num + \" 个 Token) 超出自定义项预算，并已从上下文中排除。\");\n                    });\n                } else if (/^Exceeded the customization token budget\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+and was excluded from context\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Exceeded the customization token budget\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+and was excluded from context\\.$/i, (match, num) => {\n                        return USE_TW ? (\"超出自訂項 Token 預算 (\" + num + \" 個 Token)，已從上下文中排除。\") : (\"超出自定义项 Token 预算 (\" + num + \" 个 Token)，已从上下文中排除。\");\n                    });\n                } else if (/^See all\\s*\\((\\d+)\\)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^See all\\s*\\((\\d+)\\)$/i, (match, num) => {\n                        return USE_TW ? (\"顯示全部 (\" + num + \")\") : (\"显示全部 (\" + num + \")\");\n                    });\n                } else if (/^(?:\\+\\s*)?See\\s+(\\d+)\\s+more(?:\\s+(.+))?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:\\+\\s*)?See\\s+(\\d+)\\s+more(?:\\s+(.+))?$/i, (match, num) => {\n                        const hasPlus = /^\\+/.test(valNorm);\n                        return (hasPlus ? \"+ \" : \"\") + (USE_TW ? (\"展開另外 \" + num + \" 項\") : (\"展开另外 \" + num + \" 项\"));\n                    });\n                } else if (/^Available AI Credits: (\\d+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Available AI Credits: (\\d+)$/i, (match, num) => {\n                        return USE_TW ? (\"可用 AI 額度: \" + num) : (\"可用 AI 额度: \" + num);\n                    });\n                } else if (/^Version\\s+([\\d\\.]+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Version\\s+([\\d\\.]+)$/i, (match, v) => {\n                        return \"版本 \" + v;\n                    });\n                } else if (/^(\\d+)(s|m|h|d|w|mo|yr)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)(s|m|h|d|w|mo|yr)$/i, (match, num, unit) => {\n                        const unitLower = unit.toLowerCase();\n                        let unitStr = \"\";\n                        // Bare durations can be countdown fragments, not elapsed timestamps.\n                        const elapsed = node.parentElement && node.parentElement.closest('[data-testid=\"conversation-row-sidebar\"]');\n                        if (unitLower === \"s\") unitStr = \"秒\";\n                        else if (unitLower === \"m\") unitStr = USE_TW ? \"分鐘\" : \"分钟\";\n                        else if (unitLower === \"h\") unitStr = USE_TW ? \"小時\" : \"小时\";\n                        else if (unitLower === \"d\") unitStr = \"天\";\n                        else if (unitLower === \"w\") unitStr = USE_TW ? \"週\" : \"周\";\n                        else if (unitLower === \"mo\") unitStr = USE_TW ? \"個月\" : \"个月\";\n                        else if (unitLower === \"yr\") unitStr = \"年\";\n                        if (elapsed) unitStr += \"前\";\n                        return num + unitStr;\n                    });\n                } else if (/^just now$/i.test(valNorm)) {\n                    newVal = USE_TW ? \"剛剛\" : \"刚刚\";\n                } else if (/^(\\d+)(s|m|h|d|w|mo|yr)\\s+ago$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)(s|m|h|d|w|mo|yr)\\s+ago$/i, (match, num, unit) => {\n                        const unitLower = unit.toLowerCase();\n                        let unitStr = \"\";\n                        if (unitLower === \"s\") unitStr = USE_TW ? \"秒前\" : \"秒前\";\n                        else if (unitLower === \"m\") unitStr = USE_TW ? \"分鐘前\" : \"分钟前\";\n                        else if (unitLower === \"h\") unitStr = USE_TW ? \"小時前\" : \"小时前\";\n                        else if (unitLower === \"d\") unitStr = USE_TW ? \"天前\" : \"天前\";\n                        else if (unitLower === \"w\") unitStr = USE_TW ? \"週前\" : \"周前\";\n                        else if (unitLower === \"mo\") unitStr = USE_TW ? \"個月前\" : \"个月前\";\n                        else if (unitLower === \"yr\") unitStr = USE_TW ? \"年前\" : \"年前\";\n                        return num + unitStr;\n                    });\n                } else if (/^(.+?): context deadline exceeded$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(.+?): context deadline exceeded$/i, (match, prefix) => {\n                        return prefix + (USE_TW ? \": 要求逾時 (context deadline exceeded)\" : \": 请求超时 (context deadline exceeded)\");\n                    });\n                } else if (/^(.+?): i\\/o timeout$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(.+?): i\\/o timeout$/i, (match, prefix) => {\n                        return prefix + (USE_TW ? \": I/O 逾時 (i/o timeout)\" : \": I/O 超时 (i/o timeout)\");\n                    });\n                } else if (/^Your plan's baseline quota will refresh on (.+?)\\.?\\s*To continue using this model now, enable AI Credit overages\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Your plan's baseline quota will refresh on (.+?)\\.?\\s*To continue using this model now, enable AI Credit overages\\.?$/i, (match, when) => {\n                        return USE_TW ? (\"您方案的基準配額將於 \" + when + \" 刷新。如需立即繼續使用此模型，請啟用 AI 點數超額使用。\") : (\"您方案的基础配额将于 \" + when + \" 刷新。如需立即继续使用此模型，请启用 AI 额度超量使用。\");\n                    });\n                } else if (/^You have hit your weekly limit, it refreshes in (.+?)\\. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^You have hit your weekly limit, it refreshes in (.+?)\\. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier\\.$/i, (match, when) => {\n                        return USE_TW ? (\"您已達到每週額度限制，將於 \" + when + \" 刷新。若您使用受支援的付費方案，可在此期間使用 AI 點數，或升級至更高層級。\") : (\"您已达到每周额度限制，将于 \" + when + \" 刷新。若您使用受支持的付费计划，可在此期间使用 AI 额度，或升级至更高层级。\");\n                    });\n                } else if (/^You have hit your weekly limit, the (\\d+)-hour limit does not currently apply\\. Your weekly limit will fully refresh in (.+?)\\.$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^You have hit your weekly limit, the (\\d+)-hour limit does not currently apply\\. Your weekly limit will fully refresh in (.+?)\\.$/i, (match, h, when) => {\n                        return USE_TW ? (\"您已達到每週額度限制，\" + h + \" 小時限制目前不適用。您的每週額度限制將於 \" + when + \" 完全更新。\") : (\"您已达到每周额度限制，\" + h + \" 小时限制目前不适用。您的每周额度限制将于 \" + when + \" 完全刷新。\");\n                    });\n                } else if (/^(Rules|Skills|Mcp Tools): ([\\d,]+) tokens$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(Rules|Skills|Mcp Tools): ([\\d,]+) tokens$/i, (match, kind, num) => {\n                        const kindMap = { \"Rules\": USE_TW ? \"規則\" : \"规则\", \"Skills\": \"技能\", \"Mcp Tools\": \"MCP 工具\" };\n                        return (kindMap[kind] || kind) + \"：\" + num + \" Token\";\n                    });\n                } else if (/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i, (match, article, name) => {\n                        return USE_TW ? (\"您確定要刪除專案 \" + name + \" 嗎？\") : (\"您确定要删除项目 \" + name + \" 吗？\");\n                    });\n                } else if (/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, del, name, count, dot) => {\n                        const delPrefix = del ? (USE_TW ? \"永久刪除 \" : \"永久删除 \") : \"\";\n                        const suffix = dot ? \"。\" : \"\";\n                        return delPrefix + name + (USE_TW ? (\"（包含 \" + count + \" 個活躍對話）\") : (\"（包含 \" + count + \" 个活跃会话）\")) + suffix;\n                    });\n                } else if (/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, count, dot) => {\n                        const suffix = dot ? \"。\" : \"\";\n                        return (USE_TW ? (\"包含 \" + count + \" 個活躍對話\") : (\"包含 \" + count + \" 个活跃会话\")) + suffix;\n                    });\n                } else if (/^(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(\\d+)\\s+active conversations?([.。])?$/i, (match, count, dot) => {\n                        const suffix = dot ? \"。\" : \"\";\n                        return (USE_TW ? (count + \" 個活躍對話\") : (count + \" 个活跃会话\")) + suffix;\n                    });\n                } else if (/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i, (match, name, tools, action) => {\n                        return name + (USE_TW ? \" 遠端 MCP 伺服器可讓您存取並執行 \" : \" 远程 MCP 服务器可让您访问并运行 \") + tools + (USE_TW ? \" 工具以進行管理與操作。\" : \" 工具以进行管理与操作。\");\n                    });\n                } else if (/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i, (match, name, res) => {\n                        return name + (USE_TW ? \" 遠端 MCP 伺服器可讓您管理 \" : \" 远程 MCP 服务器可让您管理 \") + res + (USE_TW ? \" 資源。\" : \" 资源。\");\n                    });\n                } else if (/^The (.+?) remote MCP server (allows you to|lets you) (.+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^The (.+?) remote MCP server (allows you to|lets you) (.+)$/i, (match, name, verb, rest) => {\n                        let text = rest;\n                        text = text.replace(/enroll projects/gi, USE_TW ? \"註冊專案\" : \"注册项目\")\n                                   .replace(/generate audit and scope reports/gi, USE_TW ? \"產生稽核與範圍報告\" : \"生成审计与范围报告\")\n                                   .replace(/check resource enrollment statuses/gi, USE_TW ? \"檢查資源註冊狀態\" : \"检查资源注册状态\")\n                                   .replace(/in the (.+?) region/gi, (m, r) => (USE_TW ? \"在 \" + r + \" 區域\" : \"在 \" + r + \" 区域\"));\n                        return name + (USE_TW ? \" 遠端 MCP 伺服器允許您 \" : \" 远程 MCP 服务器允许您 \") + text;\n                    });\n                } else if (/^Send feedback as(\\s+(.+))?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Send feedback as(\\s+(.+))?$/i, (match, p1, email) => {\n                        if (email) {\n                            return \"以 \" + email + (USE_TW ? \" 身分傳送意見回饋\" : \" 身份发送反馈\");\n                        }\n                        return USE_TW ? \"以此身分傳送意見回饋：\" : \"以如下身份发送反馈：\";\n                    });\n                } else if (/^(Thought|Thinking|Worked) for\\s+(.+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^(Thought|Thinking|Worked) for\\s+(.+)$/i, (match, verb, dur) => {\n                        const vZh = /^Thought/i.test(verb) ? \"已思考 \" : (/^Thinking/i.test(verb) ? \"正在思考 \" : \"已工作 \");\n                        const dZh = dur.trim().replace(/(\\d+)\\s*h(?:ours?|r)?/gi, USE_TW ? \"$1 小時\" : \"$1 小时\").replace(/(\\d+)\\s*m(?:inutes?|in)?/gi, USE_TW ? \"$1 分鐘\" : \"$1 分钟\").replace(/(\\d+)\\s*s(?:econds?|ec)?/gi, \"$1 秒\");\n                        return vZh + dZh;\n                    });\n                } else if (/^No more older messages,\\s*showing\\s+(\\d+)\\s+of\\s+(\\d+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^No more older messages,\\s*showing\\s+(\\d+)\\s+of\\s+(\\d+)$/i, (match, a, b) => {\n                        return USE_TW ? (\"沒有更多歷史訊息，目前顯示 \" + a + \" / \" + b + \" 則\") : (\"没有更多历史消息，当前显示 \" + a + \" / \" + b + \" 条\");\n                    });\n                } else if (/^Low contrast ratio \\(([^)]+)\\)\\.\\s*Text may be hard to read\\.?$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Low contrast ratio \\(([^)]+)\\)\\.\\s*Text may be hard to read\\.?$/i, (match, ratio) => {\n                        return USE_TW ? (\"對比度過低 (\" + ratio + \")，文字可能難以閱讀。\") : (\"对比度过低 (\" + ratio + \")，文字可能难以阅读。\");\n                    });\n                } else if (/^Marked\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Marked\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i, (match, count) => {\n                        return USE_TW ? (\"已將 \" + count + \" 個對話標記為已讀\") : (\"已将 \" + count + \" 个会话标记为已读\");\n                    });\n                } else if (/^Preview unavailable\\s*[—–-]\\s*(.+)$/i.test(valNorm)) {\n                    newVal = valNorm.replace(/^Preview unavailable\\s*[—–-]\\s*(.+)$/i, (match, reason) => {\n                        return (USE_TW ? \"預覽不可用 — \" : \"预览不可用 — \") + reason;\n                    });\n                } else if (/^(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?)(?:,\\s*(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?))*$/i.test(valNorm)) {\n                    const verbMap = USE_TW\n                        ? { exploring: '正在探索', explored: '已探索', editing: '正在編輯', edited: '已編輯', running: '正在執行', ran: '已執行' }\n                        : { exploring: '正在探索', explored: '已探索', editing: '正在编辑', edited: '已编辑', running: '正在运行', ran: '已运行' };\n                    const nounMap = USE_TW\n                        ? { file: '個檔案', files: '個檔案', folder: '個資料夾', folders: '個資料夾', search: '次搜尋', searches: '次搜尋', command: '個指令', commands: '個指令', task: '個任務', tasks: '個任務', page: '個網頁', pages: '個網頁', browser: '次瀏覽器操作', browsers: '次瀏覽器操作', image: '張圖片', images: '張圖片', action: '項操作', actions: '項操作', artifact: '個產物', artifacts: '個產物' }\n                        : { file: '个文件', files: '个文件', folder: '个文件夹', folders: '个文件夹', search: '次搜索', searches: '次搜索', command: '个命令', commands: '个命令', task: '个任务', tasks: '个任务', page: '个网页', pages: '个网页', browser: '次浏览器操作', browsers: '次浏览器操作', image: '张图片', images: '张图片', action: '项操作', actions: '项操作', artifact: '个工件', artifacts: '个工件' };\n                    newVal = valNorm.split(/\\s*,\\s*/).map(part => {\n                        const pm = part.match(/^(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?)$/i);\n                        if (!pm) return part;\n                        const v = pm[1] ? (verbMap[pm[1].toLowerCase()] || pm[1]) + ' ' : '';\n                        const n = nounMap[pm[3].toLowerCase()] || pm[3];\n                        return v + pm[2] + ' ' + n;\n                    }).join('，');\n                } else if (valNorm.length > 15 && valNorm.includes(' ')) {\n                    // 2. 长句子串滑动替换与末尾截断智能匹配 (仅当原句带有省略号截断时，才允许基于长前缀匹配；不含空格的标识符不进行子串替换)\n                    const isTruncated = (valNorm.endsWith('...') || valNorm.endsWith('…')) && valNorm.length >= 35;\n                    const cleanVal = isTruncated ? valNorm.replace(/(\\.\\.\\.|…)$/, '').trim().toLowerCase() : '';\n                    for (const [key, translated] of longEntries) {\n                        if (key.length <= valNorm.length && valNorm.includes(key)) {\n                            newVal = newVal.split(key).join(translated);\n                            break;\n                        } else if (isTruncated && cleanVal.length >= 30 && key.toLowerCase().startsWith(cleanVal)) {\n                            newVal = translated;\n                            break;\n                        }\n                    }\n                }\n\n                if (newVal !== originalVal) {\n                    if (!origTextValues.has(node)) origTextValues.set(node, originalVal);\n                    translatedValues.set(node, newVal);\n                    node.nodeValue = newVal;\n                }\n            }\n        } catch (e) {}\n    }\n\n    let mcpSnifferTimer = null;\n    let lastCapturedDump = null;\n    function scheduleMcpSniffer() {\n        if (mcpSnifferTimer) clearTimeout(mcpSnifferTimer);\n        mcpSnifferTimer = setTimeout(runMcpSniffer, 600);\n    }\n\n    function extractMcpCatalog(screen) {\n        if (!screen) return null;\n        let templates = null;\n        try {\n            const findFiber = (dom) => {\n                if (!dom) return null;\n                const k = Object.keys(dom).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));\n                return k ? dom[k] : null;\n            };\n\n            const candidates = [\n                screen,\n                screen.querySelector('.divide-y'),\n                screen.querySelector('.divide-y > div')\n            ].filter(Boolean);\n\n            for (const dom of candidates) {\n                let fiber = findFiber(dom);\n                let queue = [fiber];\n                let visited = new Set();\n                let depth = 0;\n                while (queue.length > 0 && depth < 300) {\n                    depth++;\n                    const cur = queue.shift();\n                    if (!cur || visited.has(cur)) continue;\n                    visited.add(cur);\n\n                    if (cur.memoizedProps && Array.isArray(cur.memoizedProps.mcpTemplates) && cur.memoizedProps.mcpTemplates.length > 0) {\n                        templates = cur.memoizedProps.mcpTemplates;\n                        break;\n                    }\n                    if (cur.child) queue.push(cur.child);\n                    if (cur.sibling) queue.push(cur.sibling);\n                    if (cur.return) queue.push(cur.return);\n                }\n                if (templates) break;\n            }\n        } catch (e) {}\n\n        if (!templates || templates.length === 0) {\n            try {\n                const rows = screen.querySelectorAll('.divide-y > div');\n                if (rows && rows.length > 0) {\n                    const domItems = [];\n                    for (const row of rows) {\n                        const titleEl = row.querySelector('a, span.font-medium, .text-sm.font-medium');\n                        const descEl = row.querySelector('.line-clamp-2, .text-xs.text-muted-foreground.mt-1');\n                        const title = titleEl ? (titleEl.childNodes[0]?.textContent || titleEl.textContent || '').trim() : '';\n                        const desc = descEl ? (descEl.textContent || '').trim() : '';\n                        if (title || desc) {\n                            domItems.push({\n                                id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),\n                                title: title,\n                                description: desc\n                            });\n                        }\n                    }\n                    if (domItems.length > 0) {\n                        templates = domItems;\n                    }\n                }\n            } catch (e) {}\n        }\n\n        return templates;\n    }\n\n    function renderBadge(screen, catalog) {\n        try {\n            if (!screen) return;\n            let badge = document.getElementById('__antigravity_mcp_badge__');\n            const searchRow = screen.querySelector('.relative.flex.items-center');\n            if (!badge && searchRow && searchRow.parentNode) {\n                badge = document.createElement('div');\n                badge.id = '__antigravity_mcp_badge__';\n                badge.className = 'text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded flex items-center justify-between cursor-pointer select-none transition-all';\n                badge.style.marginTop = '6px';\n                badge.style.marginBottom = '2px';\n                searchRow.parentNode.insertBefore(badge, searchRow.nextSibling);\n            }\n            if (badge) {\n                const scText = '✓ 已自动捕获 ' + catalog.length + ' 个 MCP 服务器（点击复制 JSON）';\n                const tcText = '✓ 已自動捕獲 ' + catalog.length + ' 個 MCP 伺服器（點擊複製 JSON）';\n                badge.innerHTML = '<span>' + (USE_TW ? tcText : scText) + '</span><span style=\"opacity:0.75; font-size:11px;\">' + (USE_TW ? '點擊複製' : '点击复制') + '</span>';\n                badge.onclick = () => {\n                    try {\n                        navigator.clipboard.writeText(JSON.stringify(catalog, null, 2));\n                        badge.innerHTML = '<span>' + (USE_TW ? '✓ 已複製 JSON 到剪貼簿！' : '✓ 已复制 JSON 到剪贴板！') + '</span>';\n                        setTimeout(() => {\n                            if (badge) badge.innerHTML = '<span>' + (USE_TW ? tcText : scText) + '</span><span style=\"opacity:0.75; font-size:11px;\">' + (USE_TW ? '點擊複製' : '点击复制') + '</span>';\n                        }, 2000);\n                    } catch (err) {}\n                };\n            }\n        } catch (e) {}\n    }\n\n    function runMcpSniffer(retryCount = 0) {\n        try {\n            const screen = document.querySelector('[data-testid=\"add-mcp-screen\"]');\n            if (!screen) return;\n            const items = extractMcpCatalog(screen);\n            if (!items || items.length === 0) {\n                if (retryCount < 12) {\n                    setTimeout(() => runMcpSniffer(retryCount + 1), 500);\n                }\n                return;\n            }\n\n            const catalog = items.map(item => ({\n                id: item.id || '',\n                title: item.title || '',\n                description: item.description || '',\n                link: item.link || '',\n                trustLevel: item.trustLevel || ''\n            }));\n\n            const dumpStr = JSON.stringify(catalog, null, 2);\n            if (dumpStr === lastCapturedDump) {\n                renderBadge(screen, catalog);\n                return;\n            }\n            lastCapturedDump = dumpStr;\n\n            try {\n                localStorage.setItem('__antigravity_mcp_dump__', dumpStr);\n            } catch (e) {}\n\n            window.__antigravity_mcp_dump__ = catalog;\n            window.__exportMcpCatalog = function() {\n                console.log(dumpStr);\n                return catalog;\n            };\n\n            try {\n                const req = typeof require === 'function' ? require : null;\n                if (req) {\n                    const fs = req('fs');\n                    const path = req('path');\n                    const os = req('os');\n                    if (fs && path) {\n                        const filePaths = [\n                            os ? path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_catalog_dump.json') : null\n                        ].filter(Boolean);\n                        for (const fp of filePaths) {\n                            try {\n                                const dir = path.dirname(fp);\n                                if (fs.existsSync(dir)) {\n                                    fs.writeFileSync(fp, dumpStr, 'utf-8');\n                                    console.log('[Antigravity CN] MCP Catalog saved to: ' + fp);\n                                }\n                            } catch (err) {}\n                        }\n                    }\n                }\n            } catch (e) {}\n\n            console.log('%c[Antigravity CN] 已自动捕获 ' + catalog.length + ' 个 MCP 服务器！', 'color: #10b981; font-weight: bold;', catalog);\n            console.log('[Antigravity CN] 如需查看/导出 JSON，可在控制台执行: copy(window.__exportMcpCatalog())');\n\n            renderBadge(screen, catalog);\n        } catch (e) {}\n    }\n\n    const observer = new MutationObserver(mutations => {\n        let hasMcpModal = false;\n        for (const m of mutations) {\n            if (m.type === 'childList') {\n                for (const n of m.addedNodes) {\n                    translateNode(n);\n                    if (!hasMcpModal && n.nodeType === 1) {\n                        if (n.getAttribute && n.getAttribute('data-testid') === 'add-mcp-screen') {\n                            hasMcpModal = true;\n                        } else if (n.querySelector && n.querySelector('[data-testid=\"add-mcp-screen\"]')) {\n                            hasMcpModal = true;\n                        }\n                    }\n                }\n            } else if (m.type === 'characterData') {\n                translateNode(m.target);\n            } else if (m.type === 'attributes') {\n                translateNode(m.target);\n                if (m.attributeName === 'aria-label' || m.attributeName === 'aria-labelledby') {\n                    refreshMenusLabelledBy(m.target);\n                }\n            }\n        }\n        if (hasMcpModal) scheduleMcpSniffer();\n    });\n\n    const obsOpts = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label', 'aria-labelledby', 'role'] };\n    const observedRoots = new WeakSet();\n\n    function observeRoot(root) {\n        if (!root || observedRoots.has(root)) return;\n        observer.observe(root, obsOpts);\n        observedRoots.add(root);\n    }\n\n    const markDomLocale = () => {\n        try {\n            if (!disposed && document && document.documentElement && document.documentElement.setAttribute) {\n                document.documentElement.setAttribute('data-ag-i18n-locale', USE_TW ? 'zh-TW' : 'zh-CN');\n                document.documentElement.setAttribute('data-ag-i18n-brand', BRAND_TITLE_MODE);\n            }\n        } catch (e) {}\n    };\n    markDomLocale();\n\n    const startEngine = () => {\n        if (disposed) return;\n        markDomLocale();\n        const target = document.body || document.documentElement;\n        if (target) {\n            try {\n                observeRoot(target);\n                translateNode(target);\n                if (document.querySelector('[data-testid=\"add-mcp-screen\"]')) {\n                    scheduleMcpSniffer();\n                }\n            } catch (e) {}\n        }\n    };\n\n    if (!Element.prototype.__agOrigAttachShadow) {\n        Element.prototype.__agOrigAttachShadow = Element.prototype.attachShadow;\n    }\n    Element.prototype.attachShadow = function() {\n        const sr = Element.prototype.__agOrigAttachShadow.apply(this, arguments);\n        try {\n            if (!disposed && !(this && this.id === 'ag-context-meter')) {\n                observeRoot(sr);\n            }\n        } catch (e) {}\n        return sr;\n    };\n\n    // 强力多阶段触发绑定\n    if (document.readyState === 'loading') {\n        document.addEventListener?.('DOMContentLoaded', startEngine);\n    } else {\n        startEngine();\n    }\n    window.addEventListener?.('load', startEngine);\n    setTimeout(startEngine, 100);\n    setTimeout(startEngine, 300);\n    setTimeout(startEngine, 1000);\n    setTimeout(startEngine, 3000);\n    setTimeout(startEngine, 6000);\n\n    function revertTreeToOriginal(node) {\n        try {\n            if (!node) return;\n            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {\n                for (const c of node.childNodes) revertTreeToOriginal(c);\n                return;\n            }\n            if (node.nodeType === Node.ELEMENT_NODE) {\n                if (node.id === 'ag-context-meter') return;\n                const attrBag = origAttrValues.get(node);\n                if (attrBag) {\n                    for (const [k, origV] of Object.entries(attrBag)) {\n                        if (origV != null) node.setAttribute(k, origV);\n                    }\n                    origAttrValues.delete(node);\n                }\n                if (node.shadowRoot) revertTreeToOriginal(node.shadowRoot);\n                for (const c of node.childNodes) revertTreeToOriginal(c);\n            } else if (node.nodeType === Node.TEXT_NODE) {\n                if (origTextValues.has(node)) {\n                    node.nodeValue = origTextValues.get(node);\n                    origTextValues.delete(node);\n                    translatedValues.delete(node);\n                }\n            }\n        } catch (e) {}\n    }\n\n    const clearDomLocale = () => {\n        try {\n            if (document && document.documentElement && document.documentElement.removeAttribute) {\n                document.documentElement.removeAttribute('data-ag-i18n-locale');\n                document.documentElement.removeAttribute('data-ag-i18n-brand');\n            }\n        } catch (e) {}\n    };\n    const onCrossWorldDispose = () => {\n        try { if (typeof window !== 'undefined') window.__AGLocalization?.revertAndDispose?.(); } catch (e) {}\n    };\n    try {\n        if (typeof document !== 'undefined' && document.addEventListener) {\n            document.addEventListener('__ag_i18n_dispose__', onCrossWorldDispose);\n        }\n    } catch (e) {}\n\n    if (typeof window !== 'undefined') {\n        window.__AGLocalization = {\n            locale: USE_TW ? 'zh-TW' : 'zh-CN',\n            brandTitle: BRAND_TITLE_MODE,\n            rescan() {\n                if (!disposed) startEngine();\n            },\n            revertAndDispose() {\n                disposed = true;\n                globalThis.__agMenuTranslator = null;\n                clearDomLocale();\n                try { if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('__ag_i18n_dispose__', onCrossWorldDispose); } catch (e) {}\n                try { observer.disconnect(); } catch (e) {}\n                try {\n                    const b = document.getElementById('__antigravity_mcp_badge__');\n                    if (b) b.remove();\n                } catch (e) {}\n                revertTreeToOriginal(document.documentElement || document.body);\n            },\n            dispose() {\n                disposed = true;\n                globalThis.__agMenuTranslator = null;\n                clearDomLocale();\n                try { if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('__ag_i18n_dispose__', onCrossWorldDispose); } catch (e) {}\n                try { observer.disconnect(); } catch (e) {}\n            }\n        };\n    }\n})();";

function normalizeLocale(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s === 'zh-cn' || s === 'cn' || s === 'zh' || s === 'hans' || s === 'sc' || s === 'simplified') return 'zh-CN';
  if (s === 'zh-tw' || s === 'tw' || s === 'hk' || s === 'hant' || s === 'tc' || s === 'traditional') return 'zh-TW';
  if (s === 'en' || s === 'en-us' || s === 'off' || s === 'none' || s === 'stock' || s === 'english' || s === 'restore') return 'en';
  return undefined;
}

function normalizeBrandTitle(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s === 'english' || s === 'en' || s === 'default') return 'english';
  if (s === 'hidden' || s === 'hide' || s === 'none') return 'hidden';
  if (s === 'translated' || s === 'chinese' || s === 'cn' || s === 'zh') return 'translated';
  return undefined;
}

function normalizeDictKey(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u2026/g, '...');
}

function getI18nConfigPath(stateDir = getStateDir()) {
  return path.join(stateDir, 'i18n-config.json');
}

function readI18nConfig(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const cfgPath = getI18nConfigPath(stateDir);
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const locale = normalizeLocale(parsed?.locale) || 'zh-CN';
      const brandTitle = normalizeBrandTitle(parsed?.brandTitle) || 'english';
      return {
        exists: true,
        locale,
        brandTitle,
        pluginSourceDir: parsed?.pluginSourceDir || null,
        updatedAt: parsed?.updatedAt || null
      };
    } catch {}
  }
  return {
    exists: false,
    locale: options.defaultLocale || 'zh-CN',
    brandTitle: options.defaultBrandTitle || 'english',
    pluginSourceDir: null,
    updatedAt: null
  };
}

function saveI18nConfig(config = {}, options = {}) {
  const stateDir = options.stateDir || getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const prev = readI18nConfig({ stateDir });
  const locale = normalizeLocale(config.locale) || prev.locale || 'zh-CN';
  const brandTitle = normalizeBrandTitle(config.brandTitle) || prev.brandTitle || 'english';
  const pluginSourceDir = config.pluginSourceDir || prev.pluginSourceDir || (fs.existsSync(path.join(__dirname, 'dicts')) ? __dirname : null);

  const next = {
    locale,
    brandTitle,
    pluginSourceDir,
    updatedAt: new Date().toISOString()
  };
  const cfgPath = getI18nConfigPath(stateDir);
  const tmpPath = cfgPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, cfgPath);
  return next;
}

function resolveDictsDirectory(dictsFolder, options = {}) {
  const candidates = [];
  if (options.dictsBaseDir) {
    candidates.push(path.join(options.dictsBaseDir, dictsFolder));
  }
  candidates.push(path.join(__dirname, dictsFolder));

  const stateDir = options.stateDir || getStateDir();
  const savedCfg = readI18nConfig({ stateDir });
  if (savedCfg.pluginSourceDir) {
    candidates.push(path.join(savedCfg.pluginSourceDir, dictsFolder));
  }
  try {
    const manifestPath = path.join(stateDir, 'installation.json');
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m?.pluginSourceDir) {
        candidates.push(path.join(m.pluginSourceDir, dictsFolder));
      }
    }
  } catch {}

  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) {
      try {
        if (fs.statSync(dir).isDirectory()) return dir;
      } catch {}
    }
  }
  return null;
}

function cacheMergedDictionariesToState(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  for (const folder of ['dicts', 'dicts_tw']) {
    const dir = resolveDictsDirectory(folder, options);
    if (!dir) continue;
    const map = readRawDictMapFromDir(dir);
    if (Object.keys(map).length > 0) {
      const cacheFile = path.join(stateDir, `cached-${folder}.json`);
      fs.writeFileSync(cacheFile, JSON.stringify(map), 'utf8');
    }
  }
}

function readRawDictMapFromDir(dictsDir) {
  const totalMap = {};
  const files = fs.readdirSync(dictsDir).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dictsDir, file), 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        const normK = normalizeDictKey(k);
        if (normK) totalMap[normK] = v;
      }
    } catch {}
  }
  return totalMap;
}

function loadDictionary(options = {}) {
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return {};
  const meta = LOCALE_META[locale] || LOCALE_META['zh-CN'];
  const brandTitle = normalizeBrandTitle(options.brandTitle) || 'english';
  const stateDir = options.stateDir || getStateDir();

  let totalMap = {};
  const liveDir = resolveDictsDirectory(meta.dictsFolder, options);
  if (liveDir) {
    totalMap = readRawDictMapFromDir(liveDir);
  } else {
    const cacheFile = path.join(stateDir, `cached-${meta.dictsFolder}.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        totalMap = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
      } catch {}
    }
  }

  const brandKey = normalizeDictKey('Antigravity');
  if (brandTitle === 'english') {
    delete totalMap[brandKey];
  } else if (brandTitle === 'hidden') {
    totalMap[brandKey] = '';
  }
  return totalMap;
}

function generatePreloadI18nScript(options = {}) {
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return '';
  const brandTitle = normalizeBrandTitle(options.brandTitle) || 'english';
  const useTw = locale === 'zh-TW';
  const fullDict = loadDictionary({ ...options, locale, brandTitle });
  const dictJson = JSON.stringify(fullDict);

  const body = PRELOAD_RUNTIME_TEMPLATE
    .replace('__USE_TW_PLACEHOLDER__', useTw ? 'true' : 'false')
    .replace('__BRAND_TITLE_PLACEHOLDER__', JSON.stringify(brandTitle))
    .replace('DICT_PLACEHOLDER', () => dictJson);

  return `${SIGNATURE_START}\n${body}\n${SIGNATURE_END}`;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// 五大模块双向幂等清理 (strip*) 与注入 (inject*)
// ============================================================================

function stripPreloadI18n(content) {
  const regex = new RegExp('\\n?' + escapeRegExp(SIGNATURE_START) + '[\\s\\S]*?' + escapeRegExp(SIGNATURE_END) + '\\n?', 'g');
  return String(content || '').replace(regex, '\n').replace(/\n{3,}$/, '\n');
}

function injectPreloadI18n(content, options = {}) {
  const cleaned = stripPreloadI18n(content);
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return cleaned;
  const addon = generatePreloadI18nScript(options);
  return cleaned.replace(/\s*$/, '') + '\n' + addon + '\n';
}

function stripMenuI18n(content) {
  let out = String(content || '');
  out = out.replace(/(?:\r?\n[ \t]*)?\/\* --- MENU TRANSLATION START --- \*\/[\s\S]*?\/\* --- MENU TRANSLATION END --- \*\/\r?\n[ \t]*/g, '');
  const startMark = '// ==========================================\n    // Antigravity Native Menu Chinese Translation';
  const endMark = 'translateMenu(menu.items);';
  const startIdx = out.indexOf(startMark);
  const endIdx = out.indexOf(endMark);
  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    out = out.substring(0, startIdx) + out.substring(endIdx + endMark.length);
  }
  return out;
}

function injectMenuI18n(content, options = {}) {
  const cleaned = stripMenuI18n(content);
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return cleaned;
  const useTw = locale === 'zh-TW';

  const translationsObj = useTw ? `{
        'File': '檔案',
        'Edit': '編輯',
        'View': '檢視',
        'Window': '視窗',
        'Help': '說明',
        'New Window': '開新視窗',
        'Create Project': '建立專案',
        'Command Palette': '命令選擇區',
        'Docs': '說明文件',
        'Check for Updates': '檢查更新',
        'Toggle Developer Tools': '切換開發人員工具',
        'Undo': '復原',
        'Redo': '重做',
        'Cut': '剪下',
        'Copy': '複製',
        'Paste': '貼上',
        'Select All': '全選',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '關閉',
        'Zoom': '縮放',
        'Reset Zoom': '重設縮放',
        'Zoom In': '放大',
        'Zoom Out': '縮小',
        'Toggle Full Screen': '切換全螢幕',
        'Toggle Between Light/Dark Themes': '切換淺色/深色佈景主題',
        'Split Terminal': '分割終端機',
        'Split Conversation Horizontally': '水平分割對話',
        'Split Conversation Vertically': '垂直分割對話',
        'Split': '分割',
        'Split Right': '向右分割',
        'Split Down': '向下分割',
        'Replace With New': '替換為新對話',
        'Show in File Explorer': '在檔案總管中顯示',
        'Reveal in Finder': '在 Finder 中顯示',
        'Find in conversation': '在對話中尋找',
        'Connect to WSL': '連線至 WSL',
        'Reopen Locally': '在本機重新開啟',
        'About Antigravity': '關於 Antigravity',
        'Settings...': '設定...',
        'Preferences...': '偏好設定...',
        'Services': '服務',
        'Hide Antigravity': '隱藏 Antigravity',
        'Hide Others': '隱藏其他',
        'Show All': '顯示全部',
        'Quit Antigravity': '結束 Antigravity',
        'Quit': '結束',
        'Paste and Match Style': '貼上並符合樣式',
        'Delete': '刪除',
        'Bring All to Front': '將此程式所有視窗移至最前',
        'Close Window': '關閉視窗',
        'Version': '版本'
    }` : `{
        'File': '文件',
        'Edit': '编辑',
        'View': '视图',
        'Window': '窗口',
        'Help': '帮助',
        'New Window': '新建窗口',
        'Create Project': '创建项目',
        'Command Palette': '命令面板',
        'Docs': '文档',
        'Check for Updates': '检查更新',
        'Toggle Developer Tools': '切换开发者工具',
        'Undo': '撤销',
        'Redo': '重做',
        'Cut': '剪切',
        'Copy': '复制',
        'Paste': '粘贴',
        'Select All': '全选',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '关闭',
        'Zoom': '缩放',
        'Reset Zoom': '重置缩放',
        'Zoom In': '放大',
        'Zoom Out': '缩小',
        'Toggle Full Screen': '切换全屏',
        'Toggle Between Light/Dark Themes': '切换浅色/深色主题',
        'Split Terminal': '拆分终端',
        'Split Conversation Horizontally': '水平拆分会话',
        'Split Conversation Vertically': '垂直拆分会话',
        'Split': '拆分',
        'Split Right': '向右拆分',
        'Split Down': '向下拆分',
        'Replace With New': '替换为新会话',
        'Show in File Explorer': '在文件资源管理器中显示',
        'Reveal in Finder': '在访达中显示',
        'Find in conversation': '在会话中查找',
        'Connect to WSL': '连接到 WSL',
        'Reopen Locally': '在本地重新打开',
        'About Antigravity': '关于 Antigravity',
        'Settings...': '设置...',
        'Preferences...': '首选项...',
        'Services': '服务',
        'Hide Antigravity': '隐藏 Antigravity',
        'Hide Others': '隐藏其他',
        'Show All': '全部显示',
        'Quit Antigravity': '退出 Antigravity',
        'Quit': '退出',
        'Paste and Match Style': '粘贴并匹配样式',
        'Delete': '删除',
        'Bring All to Front': '前置全部窗口',
        'Close Window': '关闭窗口',
        'Version': '版本'
    }`;

  const menuBlock = `    /* --- MENU TRANSLATION START --- */
    const translations = ${translationsObj};
    function translateMenu(items) {
        for (const item of items) {
            let label = item.label || '';
            let mnemonic = '';
            let cleanLabel = label;
            const m = label.match(/&([a-zA-Z])/);
            if (m) {
                mnemonic = "(&" + m[1] + ")";
                cleanLabel = label.replace('&', '');
            }
            if (!item._origCleanLabel) item._origCleanLabel = cleanLabel;
            if (translations[cleanLabel]) {
                item.label = translations[cleanLabel] + mnemonic;
            } else if (translations[label]) {
                item.label = translations[label];
            } else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? "版本 " + v : "版本");
            }
            if (item.submenu && item.submenu.items) {
                translateMenu(item.submenu.items);
            }
        }
    }
    if (menu && Array.isArray(menu.items) && !menu.items._cnFindHooked) {
        menu.items._cnFindHooked = true;
        const origFind = menu.items.find.bind(menu.items);
        menu.items.find = function(pred, thisArg) {
            return origFind((it, idx, arr) => {
                if (pred.call(thisArg, it, idx, arr)) return true;
                if (it && it._origCleanLabel && pred.call(thisArg, { ...it, label: it._origCleanLabel }, idx, arr)) return true;
                return false;
            });
        };
    }
    if (!electron_1.Menu._cnHooked) {
        electron_1.Menu._cnHooked = true;
        const origSetAppMenu = electron_1.Menu.setApplicationMenu.bind(electron_1.Menu);
        electron_1.Menu.setApplicationMenu = function(m) {
            if (m && m.items) translateMenu(m.items);
            return origSetAppMenu(m);
        };
    }
    translateMenu(menu.items);
    /* --- MENU TRANSLATION END --- */`;

  const targetStr = 'electron_1.Menu.setApplicationMenu(menu);';
  const idx = cleaned.indexOf(targetStr);
  if (idx === -1) return cleaned;
  return cleaned.substring(0, idx) + '\n' + menuBlock + '\n    ' + cleaned.substring(idx);
}

const BT = String.fromCharCode(96);
const STOCK_TRAY_COUNT_EXPR = "countItem.label =\n                (count > 0 ? " + BT + "$" + "{count}" + BT + " : 'No') +\n                    ' agent' +\n                    (count === 1 ? '' : 's') +\n                    ' running';";

function stripTrayI18n(content) {
  let out = String(content || '');
  out = out.replace(/\n[ \t]*\/\* --- TRAY TRANSLATION START --- \*\/[\s\S]*?\/\* --- TRAY TRANSLATION END --- \*\//g, '');
  out = out.replace(/\n[ \t]*\/\* --- TRAY DOUBLE CLICK START --- \*\/[\s\S]*?\/\* --- TRAY DOUBLE CLICK END --- \*\//g, '');
  out = out.replace(
    /countItem\.label\s*=\s*count\s*>\s*0\s*\?\s*\x60\$\{count\}\s*(?:个智能体运行中|個代理執行中)\x60\s*:\s*'(?:无运行中的智能体|無執行中的代理)';/g,
    STOCK_TRAY_COUNT_EXPR
  );
  return out;
}

function injectTrayI18n(content, options = {}) {
  const cleaned = stripTrayI18n(content);
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return cleaned;
  const useTw = locale === 'zh-TW';

  const openPrefix = useTw ? "'開啟 '" : "'打开 '";
  const quitText = useTw ? "'結束'" : "'退出'";
  const transObj = useTw ? `{
        'No agents running': '無執行中的代理',
        'Open Antigravity': '開啟 Antigravity',
        'Quit': '結束'
    }` : `{
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开 Antigravity',
        'Quit': '退出'
    }`;

  const targetCreate = /function\s+createTray\s*\(([^)]*)\)\s*\{/;
  let patched = cleaned.replace(targetCreate, (match, args) => `function createTray(${args}) {
    /* --- TRAY TRANSLATION START --- */
    const translations = ${transObj};
    for (const item of actions) {
        if (!item || !item.label) continue;
        if (translations[item.label]) {
            item.label = translations[item.label];
        } else if (item.label.startsWith('Open ')) {
            item.label = ${openPrefix} + item.label.slice(5);
        } else if (item.label === 'Quit') {
            item.label = ${quitText};
        }
    }
    /* --- TRAY TRANSLATION END --- */`);

  const dblClickTarget = /tray\.setContextMenu\(contextMenu\);/;
  patched = patched.replace(dblClickTarget, `tray.setContextMenu(contextMenu);
    /* --- TRAY DOUBLE CLICK START --- */
    const openAction = actions.find(item => item && typeof item.click === 'function' && !['Quit', '退出', '結束'].includes(item.label));
    if (openAction) {
        tray.on('double-click', () => {
            const wins = typeof utils_1 !== 'undefined' && typeof utils_1.getHubWindows === 'function'
                ? utils_1.getHubWindows()
                : electron_1.BrowserWindow.getAllWindows();
            if (wins.length > 0 && wins[0].isMinimized?.()) {
                wins[0].restore?.();
            }
            openAction.click();
        });
    }
    /* --- TRAY DOUBLE CLICK END --- */`);

  const countRegex = /countItem\.label\s*=\s*\([\s\S]*?' running';/g;
  const replacementCount = useTw
    ? ("countItem.label = count > 0 ? " + BT + "$" + "{count} 個代理執行中" + BT + " : '無執行中的代理';")
    : ("countItem.label = count > 0 ? " + BT + "$" + "{count} 个智能体运行中" + BT + " : '无运行中的智能体';");
  patched = patched.replace(countRegex, replacementCount);
  return patched;
}

function stripLoadingI18n(content) {
  return String(content || '')
    .replace('<div class="text">正在載入 Antigravity…</div>', '<div class="text">Loading Antigravity</div>')
    .replace('<div class="text">正在加载 Antigravity…</div>', '<div class="text">Loading Antigravity</div>')
    .replace('<div class="text">反重力引擎已啟動，正在努力擺脫地心引力...</div>', '<div class="text">Loading Antigravity</div>')
    .replace('<div class="text">反重力引擎已启动，正在努力摆脱地心引力...</div>', '<div class="text">Loading Antigravity</div>');
}

function injectLoadingI18n(content, options = {}) {
  const cleaned = stripLoadingI18n(content);
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return cleaned;
  const replacementText = locale === 'zh-TW'
    ? '<div class="text">正在載入 Antigravity…</div>'
    : '<div class="text">正在加载 Antigravity…</div>';
  return cleaned.replace('<div class="text">Loading Antigravity</div>', replacementText);
}

const STOCK_UPDATER_OPTIONS = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;

const ZH_CN_UPDATER_OPTIONS = `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`;

const ZH_TW_UPDATER_OPTIONS = `                title: '檢查更新',
                message: '目前沒有可用的更新',
                buttons: ['好'],`;

function stripUpdaterI18n(content) {
  return String(content || '')
    .replace(ZH_CN_UPDATER_OPTIONS, STOCK_UPDATER_OPTIONS)
    .replace(ZH_TW_UPDATER_OPTIONS, STOCK_UPDATER_OPTIONS);
}

function injectUpdaterI18n(content, options = {}) {
  const cleaned = stripUpdaterI18n(content);
  const locale = normalizeLocale(options.locale) || 'zh-CN';
  if (locale === 'en') return cleaned;
  const target = locale === 'zh-TW' ? ZH_TW_UPDATER_OPTIONS : ZH_CN_UPDATER_OPTIONS;
  return cleaned.replace(STOCK_UPDATER_OPTIONS, target);
}

/**
 * 对解包出来的 staging 目录统一应用（或剥离）汉化补丁
 * 返回被实际处理的 dist/* 相对路径数组，供 install.js 纳入完整性白名单
 */
function applyI18nToStagingDir(stagingDir, options = {}) {
  const locale = normalizeLocale(options.locale) || 'en';
  const brandTitle = normalizeBrandTitle(options.brandTitle) || 'english';
  const touchedFiles = [];

  const fileHandlers = [
    { rel: 'dist/preload.js', fn: injectPreloadI18n },
    { rel: 'dist/menu.js', fn: injectMenuI18n },
    { rel: 'dist/tray.js', fn: injectTrayI18n },
    { rel: 'dist/loadingOverlay.js', fn: injectLoadingI18n },
    { rel: 'dist/updater.js', fn: injectUpdaterI18n }
  ];

  for (const item of fileHandlers) {
    const fullPath = path.join(stagingDir, ...item.rel.split('/'));
    if (!fs.existsSync(fullPath)) continue;
    const before = fs.readFileSync(fullPath, 'utf8');
    const after = item.fn(before, { ...options, locale, brandTitle });
    if (after !== before) {
      fs.writeFileSync(fullPath, after, 'utf8');
    }
    touchedFiles.push(item.rel);
  }

  return {
    locale,
    brandTitle,
    touchedFiles
  };
}

function inspectPreloadI18nState(preloadContent) {
  const src = String(preloadContent || '');
  const hasSig = src.includes(SIGNATURE_START);
  if (!hasSig) {
    return { active: false, locale: 'en', brandTitle: 'english' };
  }
  const isTw = src.includes('const USE_TW = true;');
  const locale = isTw ? 'zh-TW' : 'zh-CN';
  let brandTitle = 'english';
  const brandMatch = src.match(/const BRAND_TITLE_MODE = "(english|hidden|translated)";/);
  if (brandMatch) {
    brandTitle = brandMatch[1];
  } else if (src.includes('"Antigravity": ""') || src.includes('"Antigravity":""')) {
    brandTitle = 'hidden';
  } else if (src.includes('"Antigravity": "反重力') || src.includes('"Antigravity":"反重力')) {
    brandTitle = 'translated';
  }
  return { active: true, locale, brandTitle };
}

function syncOptionalProxyFiles(installDir, pluginRoot = __dirname) {
  if (process.platform !== 'win32' || !installDir) return [];
  const proxyConfigDir = path.join(pluginRoot, 'proxy_config');
  if (!fs.existsSync(proxyConfigDir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(proxyConfigDir).filter(f => {
      const full = path.join(proxyConfigDir, f);
      return fs.statSync(full).isFile();
    });
  } catch {
    return [];
  }
  const copied = [];
  for (const file of files) {
    try {
      fs.copyFileSync(path.join(proxyConfigDir, file), path.join(installDir, file));
      copied.push(file);
    } catch {}
  }
  return copied;
}

function getI18nStatus(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const saved = readI18nConfig({ stateDir });
  let installedState = null;

  if (typeof options.preloadContent === 'string') {
    installedState = inspectPreloadI18nState(options.preloadContent);
  } else if (options.asarPath && fs.existsSync(options.asarPath)) {
    try {
      const { builtinAsar } = require('./asar-engine');
      const preloadStr = builtinAsar.extractFile(options.asarPath, 'dist/preload.js').toString('utf8');
      installedState = inspectPreloadI18nState(preloadStr);
    } catch {}
  }

  const effectiveLocale = installedState ? installedState.locale : saved.locale;
  const effectiveBrand = installedState ? (installedState.active ? installedState.brandTitle : saved.brandTitle) : saved.brandTitle;
  const dictSample = loadDictionary({ locale: effectiveLocale === 'en' ? 'zh-CN' : effectiveLocale, brandTitle: effectiveBrand, stateDir });
  const dictEntryCount = Object.keys(dictSample).length;

  return {
    ok: true,
    locale: effectiveLocale,
    localeLabel: LOCALE_META[effectiveLocale]?.label || LOCALE_META['zh-CN'].label,
    localeShortLabel: LOCALE_META[effectiveLocale]?.shortLabel || '简中汉化',
    brandTitle: effectiveBrand,
    brandTitleLabel: BRAND_TITLE_META[effectiveBrand]?.label || BRAND_TITLE_META.english.label,
    brandTitleShortLabel: BRAND_TITLE_META[effectiveBrand]?.shortLabel || 'Antigravity',
    savedConfig: saved,
    installedState,
    dictEntryCount
  };
}

module.exports = {
  SIGNATURE_START,
  SIGNATURE_END,
  LOCALE_META,
  BRAND_TITLE_META,
  normalizeLocale,
  normalizeBrandTitle,
  normalizeDictKey,
  readI18nConfig,
  saveI18nConfig,
  cacheMergedDictionariesToState,
  loadDictionary,
  generatePreloadI18nScript,
  stripPreloadI18n,
  injectPreloadI18n,
  stripMenuI18n,
  injectMenuI18n,
  stripTrayI18n,
  injectTrayI18n,
  stripLoadingI18n,
  injectLoadingI18n,
  stripUpdaterI18n,
  injectUpdaterI18n,
  applyI18nToStagingDir,
  inspectPreloadI18nState,
  syncOptionalProxyFiles,
  getI18nStatus
};
