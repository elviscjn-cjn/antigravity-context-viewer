/**
 * Antigravity Chinese Localization Engine (Runtime v3.4.0)
 * 整合 Antigravity-Chinese-Localization (MIT, v2.34.0) 词典与动态规则 + ContextMeter 原生安全增强
 * 上游仓库: https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization
 *
 * Copyright (c) 2026 aabbWei
 * Copyright (c) 2026 antigravity-cn-community contributors
 * Licensed under the MIT License (详见项目根目录 THIRD_PARTY_NOTICES.md)。
 *
 * 核心保障:
 * 1. 基于 Issue #58 的全祖先链物理隔离: 助手正文、Markdown、代码块、用户输入、思考链正文、终端及工具输出保持原文
 * 2. 支持 Antigravity 2.34.0 设置、Issue #68 权限审批、分屏、Side Question、Orchestrator 与思考深度规则
 * 3. 兼容 Node.js vm 沙盒测试与 Electron preload 同步/离线配置门禁，保留品牌三态控制与低频保底扫描
 */
(function (root) {
  'use strict';

  if (!root) {
    root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  }
  if (!root) return;

  var DEFAULT_SELF_HEAL_MAP = {
    'Replace With 新建': '替换为新建',
    '移除 From Split': '从分屏中移除',
    'Split 终端': '拆分终端',
    '新建 Group': '新建分组',
    '创建 Group': '创建分组',
    '移动到 Group': '移动到分组',
    '重命名 Group': '重命名分组',
    '删除 Group': '删除分组',
    '从 Group 中移除': '从分组中移除',
    '向右 Split': '向右分屏',
    '向下 Split': '向下分屏',
    'Advanced 设置': '高级设置',
    'advanced 设置': '高级设置',
    'Developer 工具': '开发者工具',
    'Custom 智能体': '自定义智能体',
    'Ran 命令': '已运行命令',
    'Running 命令': '正在运行命令',
    'No 自动化 yet': '暂无自动化',
    '搜索 shortcuts...': '搜索快捷键...',
    '搜索 shortcuts': '搜索快捷键',
    '清除 and friendly': '清晰友好',
    '清除 and friendly.': '清晰友好。',
    '工具 Permissions': '工具权限',
    '命令 Palette': '命令面板',
    '命令 palette': '命令面板',
    '命令palette': '命令面板'
  };

  var VOICE_NAMES = {
    arlo: 1, cleo: 1, finn: 1, fola: 1, gero: 1, lora: 1, neno: 1, olin: 1, tari: 1,
    aoede: 1, charon: 1, fenrir: 1, kore: 1, leda: 1, orus: 1, puck: 1, zephyr: 1,
    orbit: 1, vale: 1, pegasus: 1, nova: 1, dipper: 1, ursa: 1, vega: 1, capella: 1, sirius: 1
  };

  function formatDurationCn(str) {
    return String(str).trim()
      .replace(/^<\s*1\s*m(?:in(?:ute)?s?)?$/i, '不到 1 分钟')
      .replace(/(\d+)\s*d(?:ays?)?\b/gi, '$1 天 ')
      .replace(/(\d+)\s*h(?:(?:ou)?rs?)?\b/gi, '$1 小时 ')
      .replace(/(\d+)\s*m(?:in(?:ute)?s?)?\b(?!\s*o)/gi, '$1 分钟 ')
      .replace(/(\d+)\s*s(?:ec(?:ond)?s?)?\b/gi, '$1 秒 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatShortcut(sc) {
    if (!sc) return '';
    return String(sc).split('+').map(function (part) {
      var lp = part.toLowerCase();
      if (lp === 'ctrl') return 'Ctrl';
      if (lp === 'cmd') return 'Cmd';
      if (lp === 'shift') return 'Shift';
      if (lp === 'alt' || lp === 'opt') return part.charAt(0).toUpperCase() + lp.slice(1);
      return part.toUpperCase();
    }).join('+');
  }

  function looksLikeFilePathOrUrl(str) {
    if (!str || /\s/.test(str)) return false;
    if (/^(?:https?|wss?|file|vscode|antigravity):\/\//i.test(str)) return true;
    if (/^[a-zA-Z0-9_.\-@]+\/[a-zA-Z0-9_.\-\/]+$/.test(str)) return true;
    if (/^[a-zA-Z]:\\[^\s]+$/.test(str)) return true;
    if (/^[a-zA-Z0-9_\-]+\.(?:js|ts|tsx|jsx|mjs|cjs|json|md|py|sh|bat|ps1|css|html|yml|yaml|asar|exe|png|svg|txt|log)$/i.test(str)) return true;
    return false;
  }

  /**
   * 构建界面翻译引擎实例 (同时供 Electron 预加载脚本与 Node 单元测试调用)
   */
  function createI18nEngine(dictData) {
    var data = dictData || {};
    var exactDict = data.exact || {};
    var coreWords = data.coreWords || {};
    var selfHealMap = Object.assign({}, DEFAULT_SELF_HEAL_MAP, data.selfHealMap || {});
    var allPatterns = (data.patterns || []).concat(data.rules || []);
    var patterns = allPatterns.map(function (p) {
      return {
        regex: new RegExp(p.regex),
        replacement: p.replacement
      };
    });

    var hasOwn = Object.prototype.hasOwnProperty;
    var translatedValues = {};
    var lowerDictionary = typeof Map !== 'undefined' ? new Map() : null;

    for (var k in exactDict) {
      if (hasOwn.call(exactDict, k)) {
        translatedValues[exactDict[k]] = true;
        if (lowerDictionary) {
          var lk = k.toLowerCase();
          if (lk !== 'end' && !lowerDictionary.has(lk)) {
            lowerDictionary.set(lk, exactDict[k]);
          }
        }
      }
    }

    var translationCache = typeof Map !== 'undefined' ? new Map() : null;
    var MAX_CACHE_SIZE = 10000;

    function cacheAndReturn(key, value) {
      if (translationCache) {
        if (translationCache.size >= MAX_CACHE_SIZE) {
          var iter = translationCache.keys();
          for (var ci = 0; ci < 1000; ci++) {
            var oldK = iter.next().value;
            if (oldK !== undefined) {
              translationCache.delete(oldK);
            } else {
              break;
            }
          }
        }
        translationCache.set(key, value);
      }
      return value;
    }

    function normalizeWhitespace(str) {
      return str.replace(/\s+/g, ' ').trim();
    }

    function lookupLower(keyStr) {
      if (!keyStr) return undefined;
      if (hasOwn.call(exactDict, keyStr)) return exactDict[keyStr];
      if (!lowerDictionary) return undefined;
      return lowerDictionary.get(String(keyStr).toLowerCase());
    }

    /**
     * 运行 Antigravity 2.34.0 动态规则管线（权限审批、Orchestrator、Side Question、分屏、设置、SSH、Computer Use）
     */
    function applyUpstreamDynamicRules(trimmed) {
      // 首页问候语
      if (/^(?:Hey|Welcome back|Good to see you)/i.test(trimmed)) {
        var greetingRules = [
          [/^Hey there,\s*what should we build today\?$/i, function () { return '嘿，今天想构建点什么？'; }],
          [/^Hey\s+(.+?),\s*what should we build today\?$/i, function (_m, n) { return '嘿，' + n + '，今天想构建点什么？'; }],
          [/^Welcome back,\s*(.+?)\.\s*Where should we pick up\?$/i, function (_m, n) { return '欢迎回来，' + n + '。我们从哪里继续？'; }],
          [/^Welcome back\.\s*Where should we pick up\?$/i, function () { return '欢迎回来。我们从哪里继续？'; }],
          [/^Good to see you,\s*(.+?)\.\s*What's next\?$/i, function (_m, n) { return '很高兴见到你，' + n + '。接下来做什么？'; }],
          [/^Good to see you\.\s*What's next\?$/i, function () { return '很高兴见到你。接下来做什么？'; }]
        ];
        for (var gi = 0; gi < greetingRules.length; gi++) {
          if (greetingRules[gi][0].test(trimmed)) {
            return trimmed.replace(greetingRules[gi][0], greetingRules[gi][1]);
          }
        }
      }

      // Issue #68: 终端高危命令 / 沙盒跨区拦截 / 运行时权限审批卡片
      if (/^Yes,\s+allow downloads from (.+?) for this run$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+allow downloads from (.+?) for this run$/i, '是，本次运行允许从 $1 下载');
      }
      if (/^Yes,\s+save rule for (.+?) in this conversation$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+save rule for (.+?) in this conversation$/i, '是，在当前对话中为 $1 保存规则');
      }
      if (/^Yes,\s+allow downloads from (.+?) in this conversation$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+allow downloads from (.+?) in this conversation$/i, '是，在当前对话中允许从 $1 下载');
      }
      if (/^Yes,\s+and always allow (.+?) in this conversation$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+and always allow (.+?) in this conversation$/i, '是，并在当前对话中始终允许 $1');
      }
      if (/^Yes,\s+allow (.+?) in this conversation$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+allow (.+?) in this conversation$/i, '是，在当前对话中允许 $1');
      }
      if (/^Yes,\s+save rule for (.+?) globally$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+save rule for (.+?) globally$/i, '是，全局保存 $1 的规则');
      }
      if (/^Yes,\s+always allow downloads from (.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+always allow downloads from (.+)$/i, '是，始终允许从 $1 下载');
      }
      if (/^Yes,\s+always allow (.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+always allow (.+)$/i, '是，始终允许 $1');
      }
      if (/^Yes,\s+and always allow (.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Yes,\s+and always allow (.+)$/i, '是，并始终允许 $1');
      }
      if (/^Conflicts with your configured Ask permission:\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Conflicts with your configured Ask permission:\s*(.+)$/i, '与您配置的询问权限冲突：$1');
      }
      if (/^Requires manual confirmation:\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Requires manual confirmation:\s*(.+)$/i, '需要人工确认：$1');
      }
      if (/^Save rule to always allow (.+?)\?$/i.test(trimmed)) {
        var actionMap = {
          'running this command': '运行此命令',
          'running this command outside the sandbox': '在沙盒外运行此命令',
          'using this mcp tool': '使用此 MCP 工具',
          'a one-time administrator (uac) elevation': '一次性管理员 (UAC) 提权',
          'access to this resource': '访问此资源'
        };
        return trimmed.replace(/^Save rule to always allow (.+?)\?$/i, function (_m, act) {
          var actCn = actionMap[act.trim().toLowerCase()] || act;
          return '保存规则以始终允许' + actCn + '？';
        });
      }
      if (/^Allow ([^?\r\n]{2,120})\?$/i.test(trimmed)) {
        var allowActionMap = {
          'running this command': '运行此命令',
          'running this command outside the sandbox': '在沙盒外运行此命令',
          'using this mcp tool': '使用此 MCP 工具',
          'a one-time administrator (uac) elevation': '一次性管理员 (UAC) 提权',
          'access to this resource': '访问此资源',
          'the browser agent to download a file': '浏览器智能体下载文件'
        };
        return trimmed.replace(/^Allow ([^?\r\n]{2,120})\?$/i, function (_m, act) {
          var actCn = allowActionMap[act.trim().toLowerCase()] || act;
          return '是否允许 ' + actCn + '？';
        }).replace(/^是否允许 (运行此命令|在沙盒外运行此命令|使用此 MCP 工具|一次性管理员 \(UAC\) 提权|访问此资源|浏览器智能体下载文件)？$/, '是否允许$1？');
      }
      if (/^Recursively\s+deleting\s+the\s+pre-existing\s+directory\s+(.+?)\s+permanently\s+destroys\s+files\s+outside\s+the\s+workspace\s+that\s+cannot\s+be\s+locally\s+recovered\.?$/i.test(trimmed)) {
        return trimmed.replace(
          /^Recursively\s+deleting\s+the\s+pre-existing\s+directory\s+(.+?)\s+permanently\s+destroys\s+files\s+outside\s+the\s+workspace\s+that\s+cannot\s+be\s+locally\s+recovered\.?$/i,
          '递归删除已有目录 $1 将永久销毁工作区外且无法在本地恢复的文件。'
        );
      }
      if (/^Requesting permission to (access|execute|run|read|write|edit|modify|delete|use|download)\s+(.+)$/i.test(trimmed)) {
        var verbMap = {
          access: '访问', execute: '执行', run: '运行', read: '读取',
          write: '写入', edit: '编辑', modify: '修改', delete: '删除',
          use: '使用', download: '下载'
        };
        return trimmed.replace(
          /^Requesting permission to (access|execute|run|read|write|edit|modify|delete|use|download)\s+(.+)$/i,
          function (_m, verb, target) { return '正在请求' + (verbMap[verb.toLowerCase()] || verb) + '权限：' + target; }
        );
      }

      // Orchestrator 原生保护 + 思考档位组合 (修复 Extra High 拼字问题)
      if (/^(Low|Medium|High|Extra\s+High|Extra|Max)\s*·\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^(Low|Medium|High|Extra\s+High|Extra|Max)\s*·\s*(.+)$/i, function (_m, tier, ctx) {
          var tierMap = { low: '低', medium: '中', high: '高', xhigh: '极高', 'extra high': '极高', extra: '极高', max: '最高' };
          return (tierMap[tier.trim().toLowerCase()] || tier) + ' · ' + ctx;
        });
      }

      // Side Question 与排队消息
      if (/^Side question \(conversation ([^)]+)\):\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Side question \(conversation ([^)]+)\):\s*(.+)$/i, '侧边提问（对话 $1）：$2');
      }
      if (/^Edit side question title:\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Edit side question title:\s*(.+)$/i, function (_m, t) { return '编辑侧边提问标题：' + t.trim(); });
      }
      if (/^Reply to\s+(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Reply to\s+(.+)$/i, function (_m, t) { return '回复 ' + t; });
      }
      if (/^Send\s+all\s*\((\d+)\)$/i.test(trimmed)) {
        return trimmed.replace(/^Send\s+all\s*\((\d+)\)$/i, '全部发送 ($1)');
      }
      if (/^Send\s+all$/i.test(trimmed)) return '全部发送';
      if (/^(\d+)\s+models\s+selected$/i.test(trimmed)) {
        return trimmed.replace(/^(\d+)\s+models\s+selected$/i, '已选择 $1 个模型');
      }
      if (/^\+(\d+)\s+attachments?$/i.test(trimmed)) {
        return trimmed.replace(/^\+(\d+)\s+attachments?$/i, '+$1 个附件');
      }
      if (/^Send\s+now:\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Send\s+now:\s*(.+)$/i, function (_m, v) { return '立即发送：' + v; });
      }
      if (/^View\s+Diff\s+for\s+(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^View\s+Diff\s+for\s+(.+)$/i, function (_m, v) { return '查看 ' + v + ' 的差异'; });
      }
      if (/^There was an error determining the code changes that this undo action will make:\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^There was an error determining the code changes that this undo action will make:\s*(.+)$/i, function (_m, v) { return '确定此撤销操作将产生的代码更改时出错：' + v; });
      }
      if (/^(.+?)\s+Queues after the turn$/.test(trimmed)) {
        return trimmed.replace(/^(.+?)\s+Queues after the turn$/, '$1 在当前回合结束后排队');
      }
      if (/^(.+?)\s+Sends immediately$/.test(trimmed)) {
        return trimmed.replace(/^(.+?)\s+Sends immediately$/, '$1 立即发送');
      }
      if (/^(.+?)\s+On empty prompt, sends next in queue$/.test(trimmed)) {
        return trimmed.replace(/^(.+?)\s+On empty prompt, sends next in queue$/, '$1 输入框为空时，发送队列中的下一条');
      }

      // 引用与 /btw 浮动按钮
      if (/^Quote(?:\s+((?:Ctrl|Cmd)(?:\+[a-zA-Z0-9]+)+))?$/i.test(trimmed)) {
        return trimmed.replace(/^Quote(?:\s+((?:Ctrl|Cmd)(?:\+[a-zA-Z0-9]+)+))?$/i, function (_m, sc) {
          return sc ? ('引用 ' + formatShortcut(sc)) : '引用';
        });
      }
      if (/^Ask(?:\s+|\s*\/\s*)btw(?:\s+((?:Ctrl|Cmd)(?:\+[a-zA-Z0-9]+)+))?$/i.test(trimmed)) {
        return trimmed.replace(/^Ask(?:\s+|\s*\/\s*)btw(?:\s+((?:Ctrl|Cmd)(?:\+[a-zA-Z0-9]+)+))?$/i, function (_m, sc) {
          return sc ? ('通过 /btw 提问 ' + formatShortcut(sc)) : '通过 /btw 提问';
        });
      }

      // v2.34.0 设置、快捷键录制、项目外设置、侧边栏与内联卡片
      if (/^Telemetry is turned off for your account\.\s+This means\s+(.+?)\s+does not collect any of your prompts,\s*content,\s*or model responses,\s*but will still collect general usage patterns\s*\(e\.g\.,\s*feature adoption,\s*active user counts\)\.?$/i.test(trimmed)) {
        return trimmed.replace(
          /^Telemetry is turned off for your account\.\s+This means\s+(.+?)\s+does not collect any of your prompts,\s*content,\s*or model responses,\s*but will still collect general usage patterns\s*\(e\.g\.,\s*feature adoption,\s*active user counts\)\.?$/i,
          '您的账号已关闭遥测功能。这意味着 $1 不会收集您的任何提示词、内容或模型回复，但仍会收集常规使用模式（例如功能采用率、活跃用户数）。'
        );
      }
      if (/^Recording shortcut for (.+)\. Press keys to bind, Enter to save, Escape to cancel\.$/.test(trimmed)) {
        return trimmed.replace(/^Recording shortcut for (.+)\. Press keys to bind, Enter to save, Escape to cancel\.$/, '正在为 $1 录制快捷键。按下按键绑定，Enter 保存，Escape 取消。');
      }
      if (/^Settings for conversations outside of (.+)\.$/.test(trimmed)) {
        var nounMap1 = { projects: '项目', workspaces: '工作区', folders: '文件夹', conversations: '对话' };
        return trimmed.replace(/^Settings for conversations outside of (.+)\.$/, function (_m, noun) {
          return (nounMap1[String(noun).trim().toLowerCase()] || noun) + '之外对话的设置。';
        });
      }
      if (/^Agent settings and permissions for conversations outside of (.+)\.$/.test(trimmed)) {
        var nounMap2 = { projects: '项目', workspaces: '工作区', folders: '文件夹', conversations: '对话' };
        return trimmed.replace(/^Agent settings and permissions for conversations outside of (.+)\.$/, function (_m, noun) {
          return (nounMap2[String(noun).trim().toLowerCase()] || noun) + '之外对话的智能体设置与权限。';
        });
      }
      if (/\bModified\s+in\s+([a-zA-Z0-9_\-/.]+)/i.test(trimmed)) {
        return trimmed.replace(/\bModified\s+in\s+([a-zA-Z0-9_\-/.]+)/gi, '已在 $1 中修改');
      }
      if (/^(.{1,60}) setting$/.test(trimmed)) {
        var scopeKey = trimmed.slice(0, -8).trim();
        var scopeCommon = /^(?:proxy|system|display|environment|network|keyboard|editor|terminal|audio|video|browser|privacy|appearance|notification|account|billing|search|default|project|security|session|cookie|user|local|global|custom|theme|font|language|timezone|timeout|color|tab|spacing|indent|scale|cursor|permissions?|this|that|your|my|our|their|his|her|its|the|an?|some|any|each|every|one|same|other|new|old|current|previous|next|first|last)s?$/i;
        var scopeProse = /^(?:configure|enable|disable|change|update|reset|set|use|keep|edit|select|choose|check|override|follow|apply|increase|decrease|adjust|modify|save|clear|delete|remove|find|see|try|need|want|make|too|no|not|all|any|some|each|every|your|this|that|the|an?|our|their|his|her|its)\b/i;
        if (scopeKey === 'Your This Computer') return '沿用你在「本机」的设置';
        if (scopeKey === 'Your Remote') return '沿用你在「远程」的设置';
        if (scopeKey && !scopeCommon.test(scopeKey)) {
          var hasCjk = /[\u4e00-\u9fa5]/.test(scopeKey);
          var isSingle = !/\s/.test(scopeKey);
          var isSlug = isSingle && (/^[A-Z]/.test(scopeKey) || /[-_.\d]/.test(scopeKey));
          var isTitlePhrase = /\s/.test(scopeKey) && !scopeProse.test(scopeKey) &&
            scopeKey.split(/\s+/).every(function (tok) { return /^[A-Z0-9]/.test(tok) || /^(?:of|for|and|in|on|to|v\d+)$/i.test(tok); });
          if (hasCjk || isSlug || isTitlePhrase) {
            return '沿用「' + scopeKey + '」的设置';
          }
        }
      }
      if (/^Please retry:\s*(.+)$/.test(trimmed)) return trimmed.replace(/^Please retry:\s*(.+)$/, '请重试：$1');
      if (/^Sent response:\s*(.+)$/.test(trimmed)) return trimmed.replace(/^Sent response:\s*(.+)$/, '已发送回复：$1');
      if (/^Skipped:\s*(.+)$/.test(trimmed)) return trimmed.replace(/^Skipped:\s*(.+)$/, '已跳过：$1');
      if (/^Skipped\s+(.+)$/.test(trimmed)) return trimmed.replace(/^Skipped\s+(.+)$/, '已跳过：$1');
      if (/^Open Subagent:\s*(.+)$/.test(trimmed)) return trimmed.replace(/^Open Subagent:\s*(.+)$/, '打开子智能体：$1');
      if (/^(Pin Entire|Unpin) (Workspace|Project|Repo)$/i.test(trimmed)) {
        return trimmed.replace(/^(Pin Entire|Unpin) (Workspace|Project|Repo)$/i, function (_m, act, target) {
          var actCn = /^Unpin/i.test(act) ? '取消置顶' : '置顶整个';
          var targetCn = /^Workspace$/i.test(target) ? '工作区' : (/^Project$/i.test(target) ? '项目' : '代码库');
          return actCn + targetCn;
        });
      }
      if (/^Opens the New Conversation screen for this (workspace|project)$/i.test(trimmed)) {
        return trimmed.replace(/^Opens the New Conversation screen for this (workspace|project)$/i, function (_m, t) {
          return '为此' + (/^workspace$/i.test(t) ? '工作区' : '项目') + '打开新建对话界面';
        });
      }
      if (/^No messages in last (\d+) steps\s*(?:—|,|·)\s*(load older|Load more)$/i.test(trimmed)) {
        return trimmed.replace(/^No messages in last (\d+) steps\s*(?:—|,|·)\s*(load older|Load more)$/i, function (_m, n, tail) {
          if (/Load more/i.test(tail)) return '最近 ' + n + ' 步中无消息 · 加载更多';
          if (trimmed.indexOf(',') !== -1) return '最近 ' + n + ' 步中无消息，加载更早内容';
          return '最近 ' + n + ' 步中无消息 — 加载更早内容';
        });
      }
      if (/^No visible messages in last (\d+) steps\. Activate Load older messages to continue\.$/i.test(trimmed)) {
        return trimmed.replace(/^No visible messages in last (\d+) steps\. Activate Load older messages to continue\.$/i, '最近 $1 步中没有可见消息，激活“加载更早的消息”以继续。');
      }
      if (/^(.+),\s*showing (\d+) of (\d+)$/i.test(trimmed)) {
        return trimmed.replace(/^(.+),\s*showing (\d+) of (\d+)$/i, function (_m, prefix, shown, total) {
          var prefixCn = lookupLower(prefix.trim()) || prefix;
          return prefixCn + '，已显示 ' + shown + ' / ' + total + ' 条';
        });
      }
      if (/^Select Sidebar Item (\d+)$/i.test(trimmed)) return trimmed.replace(/^Select Sidebar Item (\d+)$/i, '选择侧边栏第 $1 项');
      if (/^(UI Plugin|Automation) (\d+)$/i.test(trimmed)) {
        return trimmed.replace(/^(UI Plugin|Automation) (\d+)$/i, function (_m, kind, n) {
          return (/^UI Plugin$/i.test(kind) ? 'UI 插件 ' : '自动化 ') + n;
        });
      }
      if (/^More options for (.+)$/.test(trimmed)) return trimmed.replace(/^More options for (.+)$/, '$1 的更多选项');
      if (/^Open image (\d+) of (\d+)$/i.test(trimmed)) return trimmed.replace(/^Open image (\d+) of (\d+)$/i, '打开第 $1 张图片（共 $2 张）');
      if (/^Image (\d+)$/i.test(trimmed)) return trimmed.replace(/^Image (\d+)$/i, '图片 $1');
      if (/^Show (\d+) More$/i.test(trimmed)) return trimmed.replace(/^Show (\d+) More$/i, '显示其余 $1 项');
      if (/^(.+) \(experimental\)$/i.test(trimmed)) return trimmed.replace(/^(.+) \(experimental\)$/i, '$1（实验性）');
      if (/^Line (\d+) → (\d+)$/.test(trimmed)) return trimmed.replace(/^Line (\d+) → (\d+)$/, '第 $1 → $2 行');
      if (/^(?:(\d+)s left|(?:(\d+)d\s+)?(?:(\d+)h\s+)?(\d+)m left|(\d+)h left)$/.test(trimmed)) {
        var mLeft = trimmed.match(/^(?:(\d+)s left|(?:(\d+)d\s+)?(?:(\d+)h\s+)?(\d+)m left|(\d+)h left)$/);
        if (mLeft[1] !== undefined) return '剩余 ' + mLeft[1] + ' 秒';
        if (mLeft[5] !== undefined) return '剩余 ' + mLeft[5] + ' 小时';
        var parts = [];
        if (mLeft[2] !== undefined) parts.push(mLeft[2] + ' 天');
        if (mLeft[3] !== undefined) parts.push(mLeft[3] + ' 小时');
        if (mLeft[4] !== undefined) parts.push(mLeft[4] + ' 分钟');
        return '剩余 ' + parts.join(' ');
      }
      if (/^(.+?) \(opens in (external browser|a new tab)\)$/i.test(trimmed)) {
        return trimmed.replace(/^(.+?) \(opens in (external browser|a new tab)\)$/i, function (_m, prefix, kind) {
          return prefix + (/external/i.test(kind) ? '（在外部浏览器中打开）' : '（在新标签页中打开）');
        });
      }
      if (/^Conflicts with "/i.test(trimmed)) {
        var cParts = trimmed.split(/;\s*/);
        var mappedParts = [];
        for (var cIdx = 0; cIdx < cParts.length; cIdx++) {
          var cp = cParts[cIdx];
          if (/^Conflicts with "(.+)" \(press Enter to replace\)$/i.test(cp)) {
            mappedParts.push(cp.replace(/^Conflicts with "(.+)" \(press Enter to replace\)$/i, '与“$1”冲突（按 Enter 替换）'));
          } else if (/^Conflicts with "(.+)" \(managed by application menu\)$/i.test(cp)) {
            mappedParts.push(cp.replace(/^Conflicts with "(.+)" \(managed by application menu\)$/i, '与“$1”冲突（由应用程序菜单管理）'));
          } else if (/^Conflicts with "(.+)" \(reserved for sidebar switching\)$/i.test(cp)) {
            mappedParts.push(cp.replace(/^Conflicts with "(.+)" \(reserved for sidebar switching\)$/i, '与“$1”冲突（保留用于侧栏切换）'));
          } else if (/^Conflicts with "(.+)" \((.+)\)$/i.test(cp)) {
            mappedParts.push(cp.replace(/^Conflicts with "(.+)" \((.+)\)$/i, '与“$1”冲突（$2）'));
          } else if (/^Conflicts with "(.+)"$/i.test(cp)) {
            mappedParts.push(cp.replace(/^Conflicts with "(.+)"$/i, '与“$1”冲突'));
          } else {
            mappedParts.push(cp);
          }
        }
        return mappedParts.join('；');
      }

      // 侧边栏 / 归档 / 排序 / 计划步骤 / 配额与倒计时
      if (/^View archived in the sidebar \($/.test(trimmed)) return '已归档内容可在侧边栏（';
      if (/^menu\)\.$/.test(trimmed)) return '菜单）中查看。';
      if (/^Customize Sidebar\)\.$/.test(trimmed)) return '自定义侧边栏）中查看。';
      if (/^\? This action cannot be undone\.$/.test(trimmed)) return '吗？此操作无法撤销。';
      if (/^Marked\s+(\d+)\s+conversations?\s+as\s+read$/i.test(trimmed)) return trimmed.replace(/^Marked\s+(\d+)\s+conversations?\s+as\s+read$/i, '已将 $1 个对话标为已读');
      if (/^(\d+)\s+pinned\s+conversations?$/i.test(trimmed)) return trimmed.replace(/^(\d+)\s+pinned\s+conversations?$/i, '$1 个置顶对话');
      if (/^Plan,\s*(\d+)\s+of\s+(\d+)\s+steps done$/i.test(trimmed)) return trimmed.replace(/^Plan,\s*(\d+)\s+of\s+(\d+)\s+steps done$/i, '计划：已完成 $1 / $2 步');
      if (/^(\d+)\/(\d+)\s+steps(?:\s*·\s*(\d+)\s+failed)?(?:\s*·\s*(\d+)\s+skipped)?(?:\.\s*(Show|Hide)\s+plan)?$/i.test(trimmed)) {
        return trimmed.replace(/^(\d+)\/(\d+)\s+steps(?:\s*·\s*(\d+)\s+failed)?(?:\s*·\s*(\d+)\s+skipped)?(?:\.\s*(Show|Hide)\s+plan)?$/i, function (_m, d, tot, f, s, tog) {
          var r = d + '/' + tot + ' 步';
          if (f) r += ' · ' + f + ' 失败';
          if (s) r += ' · ' + s + ' 已跳过';
          if (tog) r += '。' + (/hide/i.test(tog) ? '隐藏计划' : '显示计划');
          return r;
        });
      }
      if (/^Compacting\s*·\s*(.+)$/i.test(trimmed)) return trimmed.replace(/^Compacting\s*·\s*(.+)$/i, '正在压缩上下文 · $1');
      if (/^Model unavailable,\s*retrying(?:\s+in\s+(\d+s))?(?:\s*\(attempt\s+(\d+)\/(\d+)\))?$/i.test(trimmed)) {
        return trimmed.replace(/^Model unavailable,\s*retrying(?:\s+in\s+(\d+s))?(?:\s*\(attempt\s+(\d+)\/(\d+)\))?$/i, function (_m, w, c, mx) {
          var base = w ? ('模型暂不可用，将在 ' + w + ' 后重试') : '模型暂不可用，正在重试';
          return (c && mx) ? (base + '（第 ' + c + '/' + mx + ' 次尝试）') : base;
        });
      }
      if (/^(.+?),\s*resets?\s+in\s+(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^(.+?),\s*resets?\s+in\s+(.+)$/i, function (_m, label, t) {
          var lMap = {
            'weekly limit': '每周限额', 'daily limit': '每日限额', 'hourly limit': '每小时限额',
            'monthly limit': '每月限额', '5-hour limit': '5 小时限额', 'five-hour limit': '5 小时限额', 'five hour limit': '5 小时限额'
          };
          var lCn = lMap[label.trim().toLowerCase()] || lookupLower(label.trim()) || label.trim();
          return lCn + '，' + formatDurationCn(t) + '后重置';
        });
      }
      if (/^Resets?\s+in\s+(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Resets?\s+in\s+(.+)$/i, function (_m, t) { return formatDurationCn(t) + '后重置'; });
      }
      if (/^(\d+(?:\.\d+)?)%\s*left$/i.test(trimmed)) return trimmed.replace(/^(\d+(?:\.\d+)?)%\s*left$/i, '$1% 可用');
      if (/^Your Plan:\s*(.+)$/i.test(trimmed)) return trimmed.replace(/^Your Plan:\s*(.+)$/i, '您的计划：$1');
      if (/^(Open |Reopen )?(Accessibility|Screen Recording) settings$/i.test(trimmed)) {
        return trimmed.replace(/^(Open |Reopen )?(Accessibility|Screen Recording) settings$/i, function (_m, act, perm) {
          var actCn = act ? (/^Reopen/i.test(act) ? '重新打开' : '打开') : '';
          return actCn + (/^Accessibility$/i.test(perm) ? '辅助功能' : '屏幕录制') + '设置';
        });
      }
      if (/^(.+?) needs (Accessibility|Screen Recording|both) to use your computer\.$/i.test(trimmed)) {
        return trimmed.replace(/^(.+?) needs (Accessibility|Screen Recording|both) to use your computer\.$/i, function (_m, app, perm) {
          var pCn = /^both$/i.test(perm) ? '辅助功能和屏幕录制权限' : (/^Accessibility$/i.test(perm) ? '辅助功能权限' : '屏幕录制权限');
          return app + ' 需要' + pCn + '才能控制您的电脑。';
        });
      }
      if (/^(\d+)\s+agents?\s+working,\s*live preview unavailable$/i.test(trimmed)) {
        return trimmed.replace(/^(\d+)\s+agents?\s+working,\s*live preview unavailable$/i, '$1 个智能体正在工作，实时预览不可用');
      }
      if (/^Live preview unavailable\s*·\s*(.+)$/i.test(trimmed)) {
        return trimmed.replace(/^Live preview unavailable\s*·\s*(.+)$/i, function (_m, d) {
          return '实时预览不可用 · ' + (d === 'not installed' ? '未安装' : d);
        });
      }
      if (/^Show\s+(\d+)\s+more\s+subagents?$/i.test(trimmed)) return trimmed.replace(/^Show\s+(\d+)\s+more\s+subagents?$/i, '显示其余 $1 个子智能体');
      if (/^Use\s+([A-Za-z0-9_-]+)$/i.test(trimmed)) {
        var voiceCand = trimmed.replace(/^Use\s+/i, '');
        if (VOICE_NAMES[voiceCand.toLowerCase()]) return '使用 ' + voiceCand;
      }
      if (trimmed === 'Use') return '使用';
      if (trimmed === 'End') return '结束';
      return null;
    }

    /**
     * 严守 coreWords 单词边界的轻量短词拼接回退（全英文词 100% 命中才生效，零夹生漏拼）
     */
    function tryCoreWordsFallback(normalized) {
      if (!coreWords || !normalized || normalized.length > 80) return null;
      if (/[\u4e00-\u9fa5]/.test(normalized) || /[-_\\/.]/.test(normalized)) return null;
      // 保留 Orchestrator 与含型号数字词条不被拼译
      if (/\bOrchestrator\b/.test(normalized)) return null;

      var trailPunc = '';
      var matchPunc = '';
      var core = normalized;
      var pMatch = core.match(/(\.\.\.|…|\.|\?|!|:|：|？|！|。)$/);
      if (pMatch) {
        matchPunc = pMatch[0];
        core = core.slice(0, -matchPunc.length).trim();
        if (matchPunc === '.') trailPunc = '。';
        else if (matchPunc === '?') trailPunc = '？';
        else if (matchPunc === '!') trailPunc = '！';
        else if (matchPunc === ':') trailPunc = '：';
        else trailPunc = matchPunc;
      }
      if (!core) return null;
      var directCore = lookupLower(core);
      if (directCore !== undefined && directCore !== '') return directCore + trailPunc;

      var words = core.split(/\s+/).filter(Boolean);
      if (words.length === 0 || words.length > 3) return null;

      var replacedAny = false;
      var out = [];
      for (var i = 0; i < words.length; i++) {
        var tok = words[i];
        if (!/[a-zA-Z]/.test(tok)) {
          // 含数字/版本号的组合（如 Gemini 4 Neon Extra High）拒绝拼凑
          return null;
        }
        if (!/^[a-zA-Z]+$/.test(tok)) return null;
        var lw = tok.toLowerCase();
        var wCn = hasOwn.call(coreWords, lw)
          ? coreWords[lw]
          : (hasOwn.call(exactDict, tok) ? exactDict[tok] : (lowerDictionary ? lowerDictionary.get(lw) : undefined));
        if (wCn === undefined) return null;
        if (wCn !== tok) replacedAny = true;
        out.push(wCn);
      }
      if (!replacedAny) return null;

      var finalStr = out.join(' ')
        .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
        .replace(/^Ran\s*命令$/i, '已运行命令')
        .replace(/^Running\s*命令$/i, '正在运行命令')
        .replace(/^Run\s*命令$/i, '运行命令')
        .replace(/Advanced\s*设置/gi, '高级设置')
        .replace(/继承\s*Global/gi, '继承全局');
      return finalStr + trailPunc;
    }

    function translateSingleUnit(rawStr) {
      if (!rawStr || typeof rawStr !== 'string') return null;
      var normalized = normalizeWhitespace(rawStr);
      if (!normalized) return null;

      // 保留 Orchestrator 原生模式名与文件路径/URL 原样
      if (normalized === 'Orchestrator' || looksLikeFilePathOrUrl(normalized)) {
        return normalized;
      }

      if (translationCache && translationCache.has(normalized)) {
        return translationCache.get(normalized);
      }

      // 超长段落文本绝非 UI 菜单或按钮标签，快速短路避免进入 338 条正则及分句双重循环
      if (normalized.length > 280) {
        return cacheAndReturn(normalized, null);
      }

      if (hasOwn.call(exactDict, normalized)) {
        return cacheAndReturn(normalized, exactDict[normalized]);
      }

      if (normalized === 'NEW') {
        return cacheAndReturn(normalized, '新');
      }

      if (hasOwn.call(selfHealMap, normalized)) {
        return cacheAndReturn(normalized, selfHealMap[normalized]);
      }

      if (!/[a-zA-Z]/.test(normalized)) {
        return cacheAndReturn(normalized, null);
      }

      if (hasOwn.call(translatedValues, normalized)) {
        return cacheAndReturn(normalized, null);
      }

      if (/[\u4e00-\u9fa5]/.test(normalized) && !/[a-zA-Z]{2,}/.test(normalized)) {
        return cacheAndReturn(normalized, null);
      }

      var dynamicHit = applyUpstreamDynamicRules(normalized);
      if (dynamicHit !== null && dynamicHit !== normalized) {
        return cacheAndReturn(normalized, dynamicHit);
      }

      for (var i = 0; i < patterns.length; i++) {
        var p = patterns[i];
        if (p.regex.test(normalized)) {
          var result = normalized.replace(p.regex, p.replacement);
          for (var pi = 0; pi < patterns.length; pi++) {
            if (patterns[pi].regex.test(result)) {
              result = result.replace(patterns[pi].regex, patterns[pi].replacement);
            }
          }
          p.regex.lastIndex = 0;
          return cacheAndReturn(normalized, result);
        }
      }

      var punctuationMatch = normalized.match(/^([\w\s\-\/]+)([:：…\.？\?!！]+)$/);
      if (punctuationMatch) {
        var base = punctuationMatch[1].trim();
        var punc = punctuationMatch[2];
        if (hasOwn.call(exactDict, base)) {
          return cacheAndReturn(normalized, exactDict[base] + (punc === ':' ? '：' : punc));
        }
      }

      var hotkeyMatch = normalized.match(/^([\w\s\-\/]+?)\s*(\((?:Ctrl|Cmd|Alt|Shift)\+[^\s\)]+\)|\b(?:Ctrl|Cmd|Alt|Shift)\+[\w;:,\\/+\-]+)$/i);
      if (hotkeyMatch) {
        var cmdBase = hotkeyMatch[1].trim();
        var hotkey = hotkeyMatch[2].trim();
        if (hasOwn.call(exactDict, cmdBase)) {
          return cacheAndReturn(normalized, exactDict[cmdBase] + ' ' + hotkey);
        }
      }

      if (normalized.indexOf('. ') !== -1 || normalized.indexOf('! ') !== -1 || normalized.indexOf('? ') !== -1 || normalized.indexOf('。') !== -1) {
        var sentences = normalized.split(/([.!?]\s+|[。！？]\s*)/);
        var anyTranslated = false;
        var allTranslated = true;
        var translatedParts = [];
        for (var sIdx = 0; sIdx < sentences.length; sIdx++) {
          var part = sentences[sIdx];
          var trimmedPart = part.trim();
          if (!trimmedPart || /^[.!?。！？\s]+$/.test(part)) {
            translatedParts.push(part.replace(/\.\s*/g, '。 '));
            continue;
          }
          var transPart = (hasOwn.call(exactDict, trimmedPart) ? exactDict[trimmedPart] : null) ||
            (hasOwn.call(exactDict, trimmedPart + '.') ? exactDict[trimmedPart + '.'] : null) ||
            applyUpstreamDynamicRules(trimmedPart);
          if (!transPart) {
            for (var pIdx = 0; pIdx < patterns.length; pIdx++) {
              if (patterns[pIdx].regex.test(trimmedPart)) {
                transPart = trimmedPart.replace(patterns[pIdx].regex, patterns[pIdx].replacement);
                for (var pi2 = 0; pi2 < patterns.length; pi2++) {
                  if (patterns[pi2].regex.test(transPart)) {
                    transPart = transPart.replace(patterns[pi2].regex, patterns[pi2].replacement);
                  }
                }
                break;
              }
            }
          }
          if (!transPart) {
            var pMatch2 = trimmedPart.match(/^([\w\s\-\/]+)([:：…\.？\?!！]+)$/);
            if (pMatch2 && hasOwn.call(exactDict, pMatch2[1].trim())) {
              transPart = exactDict[pMatch2[1].trim()] + (pMatch2[2] === ':' ? '：' : pMatch2[2]);
            }
          }
          if (transPart) {
            anyTranslated = true;
            translatedParts.push(transPart);
          } else {
            allTranslated = false;
            translatedParts.push(part);
          }
        }
        if (anyTranslated && allTranslated) {
          return cacheAndReturn(normalized, translatedParts.join('').replace(/([。！？])[。！？.]*\s*/g, '$1 ').trim());
        }
      }

      if (lowerDictionary) {
        var ciHit = lowerDictionary.get(normalized.toLowerCase());
        if (ciHit !== undefined) {
          return cacheAndReturn(normalized, ciHit);
        }
      }

      var coreHit = tryCoreWordsFallback(normalized);
      if (coreHit !== null && coreHit !== normalized) {
        return cacheAndReturn(normalized, coreHit);
      }

      return cacheAndReturn(normalized, null);
    }

    return {
      translate: translateSingleUnit,
      exactDict: exactDict,
      patterns: patterns,
      coreWords: coreWords,
      cache: translationCache,
      normalizeWhitespace: normalizeWhitespace
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createI18nEngine: createI18nEngine
    };
  }

  if (root && root.__AGY_I18N_INITIALIZED__) return;
  if (root) root.__AGY_I18N_INITIALIZED__ = true;

  var doc = root ? (root.document || (typeof document !== 'undefined' ? document : null)) : null;

  var I18N_DATA = (root && (root.__AGY_I18N_DATA__ || root.__AGY_I18N_DICT__)) || { exact: {}, patterns: [] };
  var I18N_CONFIG = (root && root.__AGY_I18N_CONFIG__) || { enabled: true, language: 'zh-CN', brandTitle: 'english' };
  var i18nEnabled = I18N_CONFIG.enabled !== false && I18N_CONFIG.language !== 'en';
  function getBrandTitleMode() {
    var cfg = (root && root.__AGY_I18N_CONFIG__) || I18N_CONFIG;
    if (cfg && (cfg.brandTitle === 'hidden' || cfg.brandTitle === 'translated')) {
      return cfg.brandTitle;
    }
    return 'english';
  }

  var defaultEngine = createI18nEngine(I18N_DATA);
  var translateSingleUnit = defaultEngine.translate;

  var IGNORED_TAGS = {
    SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, KBD: 1, SAMP: 1, VAR: 1,
    SVG: 1, PATH: 1, CANVAS: 1, MATH: 1, 'MJX-CONTAINER': 1,
    IFRAME: 1, VIDEO: 1, AUDIO: 1
  };

  var IGNORED_CLASSES = [
    'monaco-editor',
    'view-lines',
    'view-line',
    'monaco-mouse-cursor-text',
    'xterm',
    'xterm-rows',
    'xterm-screen',
    'xterm-accessibility',
    'terminal',
    'token',
    'hljs',
    'shiki',
    'prism',
    'codemirror',
    'line-content',
    'gutter',
    'codeblock',
    'code-block',
    'code-line',
    'editor-instance',
    'markdown-body',
    'prose',
    'thought-content',
    'thinking-content',
    'thought-box',
    'cursor-edit',
    'cursor-text',
    'katex',
    'mjx-container',
    'group/user-input-step',
    'user-message',
    'input-area',
    'chat-input',
    'ag-cm-turn-footer'
  ];

  var PROTECTED_ID_SET = {
    'context-meter-root': 1,
    'ag-context-meter': 1,
    'ag-composer-status-bar': 1,
    'token-five-line-card': 1
  };

  var PROTECTED_TESTID_PATTERNS = [
    'message-content',
    'assistant-message',
    'user-message',
    'tool-output',
    'command-output',
    'terminal-output'
  ];

  var PROTECTED_CLASS_SUBSTRS = [
    'markdown',
    'prose',
    'chat-message',
    'message-body',
    'artifact-content',
    'tool-output',
    'command-output',
    'terminal-output',
    'stdout',
    'stderr'
  ];

  function escapeRegExpList(items) {
    return items.map(function (s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|');
  }

  var IGNORED_CLASS_CS_RE = new RegExp(escapeRegExpList(IGNORED_CLASSES));
  var PROTECTED_CLASS_CI_RE = new RegExp(escapeRegExpList(PROTECTED_CLASS_SUBSTRS), 'i');
  var PROTECTED_TESTID_RE = new RegExp(escapeRegExpList(PROTECTED_TESTID_PATTERNS));
  var CORE_CLASS_RE = /monaco-editor|xterm|hljs|markdown-body|tool-output|command-output|terminal-output|thought-content|thinking-content/;
  var CORE_PROTECTED_TAGS = { CODE: 1, PRE: 1, SVG: 1, MATH: 1, 'MJX-CONTAINER': 1, SCRIPT: 1, STYLE: 1 };

  var MENTION_CATEGORIES = {
    Rules: 1, '规则': 1,
    Conversation: 1, '对话': 1,
    'PDF Document': 1, 'PDF 文档': 1,
    'MCP Resource': 1, 'MCP 资源': 1,
    'Browser Page': 1, '浏览器页面': 1,
    'Browser Text': 1, '浏览器文本': 1,
    Directory: 1, '目录': 1,
    'Git Commit': 1, 'Git 提交': 1,
    'Git Diff': 1, 'Git 差异': 1
  };

  var TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label', 'data-tooltip', 'alt', 'aria-description'];

  function isModelSelectorBoundary(elem) {
    if (!elem || elem.nodeType !== 1) return false;
    var testId = elem.getAttribute ? elem.getAttribute('data-testid') : null;
    if (testId) {
      if (testId === 'model-selector-trigger' ||
        testId === 'model-selector-item' ||
        testId === 'model-selector-effort-option' ||
        testId === 'model-selector-effort-group' ||
        testId === 'model-selector-list') {
        return true;
      }
    }
    if (elem.hasAttribute && elem.hasAttribute('data-effort')) {
      return true;
    }
    return false;
  }

  function hasProtectedCoreOwnMarkers(cur, checkInputSelf) {
    if (!cur || cur.nodeType !== 1) return false;
    var tag = cur.tagName ? String(cur.tagName).toUpperCase() : '';
    if (CORE_PROTECTED_TAGS[tag]) return true;
    if (checkInputSelf && (tag === 'INPUT' || tag === 'TEXTAREA')) return true;
    if (cur.id && PROTECTED_ID_SET[cur.id]) return true;
    if (cur.hasAttribute && (
        cur.hasAttribute('data-markdown-root') ||
        cur.hasAttribute('data-markdown-virtualized') ||
        cur.hasAttribute('data-markdown-block-index') ||
        cur.hasAttribute('data-quotable') ||
        cur.hasAttribute('data-quotable-inline') ||
        cur.hasAttribute('data-md-table') ||
        cur.hasAttribute('data-diff-type') ||
        cur.hasAttribute('data-cos-artifact')
    )) {
      return true;
    }
    if (cur.getAttribute) {
      if (cur.getAttribute('data-testid') === 'user-message-content' ||
          cur.getAttribute('data-testid') === 'code-gutter' ||
          cur.getAttribute('data-testid') === 'code-gutter-diff' ||
        cur.getAttribute('contenteditable') === 'true' ||
        cur.getAttribute('role') === 'textbox' ||
        cur.getAttribute('data-lexical-editor') === 'true' ||
        cur.getAttribute('data-language') ||
        cur.getAttribute('data-code')) {
        return true;
      }
    }
    var cls = typeof cur.className === 'string' ? cur.className : '';
    return Boolean(cls && CORE_CLASS_RE.test(cls));
  }

  function hasProtectedNodeOwnMarkers(cur) {
    if (!cur || cur.nodeType !== 1) return false;
    if (cur.id && PROTECTED_ID_SET[cur.id]) return true;
    var tag = cur.tagName ? String(cur.tagName).toUpperCase() : '';
    if (IGNORED_TAGS[tag] || tag === 'ARTICLE' || tag === 'BLOCKQUOTE') return true;
    if (cur.isContentEditable) return true;
    if (isModelSelectorBoundary(cur)) return true;

    if (cur.hasAttribute && (
        cur.hasAttribute('data-markdown-root') ||
        cur.hasAttribute('data-markdown-virtualized') ||
        cur.hasAttribute('data-markdown-block-index') ||
        cur.hasAttribute('data-quotable') ||
        cur.hasAttribute('data-quotable-inline') ||
        cur.hasAttribute('data-md-table') ||
        cur.hasAttribute('data-diff-type') ||
        cur.hasAttribute('data-cos-artifact')
    )) {
      return true;
    }

    if (cur.getAttribute) {
      if (cur.getAttribute('contenteditable') === 'true' ||
        cur.getAttribute('role') === 'textbox' ||
        cur.getAttribute('role') === 'code' ||
        cur.getAttribute('data-lexical-editor') === 'true' ||
        cur.getAttribute('data-language') ||
        cur.getAttribute('data-code') ||
        cur.getAttribute('data-line') ||
        cur.getAttribute('data-line-number') ||
        cur.getAttribute('data-message-id')) {
        return true;
      }
      var role = cur.getAttribute('role') || '';
      var dataRole = cur.getAttribute('data-role') || '';
      if (dataRole === 'assistant' || dataRole === 'user' || role === 'code') return true;
      var dtid = cur.getAttribute('data-testid') || '';
      if (dtid === 'code-gutter' || dtid === 'code-gutter-diff' || dtid === 'mcp-tool-step') return true;
      if (dtid && PROTECTED_TESTID_RE.test(dtid)) return true;
    }

    var cls = typeof cur.className === 'string' ? cur.className : '';
    if (cls) {
      if (IGNORED_CLASS_CS_RE.test(cls)) return true;
      if (PROTECTED_CLASS_CI_RE.test(cls)) return true;
    }
    return false;
  }

  function isSafeActionBarNode(cur) {
    if (!cur || cur.nodeType !== 1 || !cur.getAttribute) return false;
    var dtid = cur.getAttribute('data-testid');
    if (dtid === 'queued-decorators' || dtid === 'user-message-actions') return true;
    if (dtid === 'thinking-collapsible-trigger' && cur.tagName && String(cur.tagName).toUpperCase() === 'BUTTON') return true;
    return false;
  }

  /**
   * Issue #58: 严密隔离聊天正文、Markdown、代码块、用户输入、思考链正文、终端及工具输出容器，杜绝正文中单词被 UI 词典误替换
   */
  function isChatOrMarkdownContent(elem) {
    if (!elem || elem.nodeType !== 1) return false;
    var cur = elem;
    var steps = 0;
    while (cur && steps < 64) {
      if (cur.nodeType === 1 && hasProtectedNodeOwnMarkers(cur)) {
        return true;
      }
      cur = cur.parentElement || cur.parentNode;
      if (doc && cur === doc.body) break;
      steps++;
    }
    return false;
  }

  function hasProtectedCoreAncestor(el) {
    var cur = el;
    var depth = 0;
    while (cur && depth < 64) {
      if (cur.nodeType === 1 && hasProtectedCoreOwnMarkers(cur, cur !== el)) {
        return true;
      }
      cur = cur.parentElement || cur.parentNode;
      if (doc && cur === doc.body) break;
      depth++;
    }
    return false;
  }

  // 返回状态：0 = 放行；1 = 忽略；2 = 处于安全白名单控制条内放行
  function inspectIgnoreState(el) {
    if (!el || el.nodeType !== 1) return 0;
    var cur = el;
    var depth = 0;
    var menuOpt = null;
    var inSafeBar = false;
    var inProtected = false;
    while (cur && depth < 64) {
      if (cur.nodeType === 1) {
        if (hasProtectedCoreOwnMarkers(cur, cur !== el)) return 1;
        if (!menuOpt && cur.getAttribute && cur.getAttribute('data-testid') === 'menu-option-label') {
          menuOpt = cur;
        }
        if (!inSafeBar && isSafeActionBarNode(cur)) {
          inSafeBar = true;
        }
        if (!inProtected && hasProtectedNodeOwnMarkers(cur)) {
          inProtected = true;
        }
      }
      cur = cur.parentElement || cur.parentNode;
      if (doc && cur === doc.body) break;
      depth++;
    }
    if (menuOpt) {
      var optTxt = (menuOpt.innerText || menuOpt.textContent || '').trim();
      if (!Object.prototype.hasOwnProperty.call(MENTION_CATEGORIES, optTxt)) return 1;
      return inSafeBar ? 2 : 0;
    }
    if (inSafeBar) return 2;
    return inProtected ? 1 : 0;
  }

  function resolveOwnIgnoreState(el, ancestorSafeBar) {
    if (!el || el.nodeType !== 1) return ancestorSafeBar ? 2 : 0;
    if (hasProtectedCoreOwnMarkers(el, false)) return 1;
    if (el.getAttribute && el.getAttribute('data-testid') === 'menu-option-label') {
      var optTxt = (el.innerText || el.textContent || '').trim();
      if (!Object.prototype.hasOwnProperty.call(MENTION_CATEGORIES, optTxt)) return 1;
      return (ancestorSafeBar || isSafeActionBarNode(el)) ? 2 : 0;
    }
    var safeNow = ancestorSafeBar || isSafeActionBarNode(el);
    if (safeNow) return 2;
    if (hasProtectedNodeOwnMarkers(el)) return 1;
    return 0;
  }

  var ignoreElementCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  var PLUGIN_OWNED_SELECTORS = [
    '#ag-context-meter',
    '#context-meter-root',
    '#ag-context-meter-radial-host',
    '[data-ag-radial-top-layer]',
    '#ag-composer-status-bar',
    '#token-five-line-card',
    '#cli-launch-toast'
  ];

  /**
   * PR #90：插件自有节点判定（宿主层 + 顶层径向挂载 + 底栏状态条）。
   * 命中后悬停入口立即返回，不再触发任何翻译扫描。
   */
  function isPluginOwnedNode(el) {
    if (!el || el.nodeType !== 1) return false;
    var cur = el;
    var steps = 0;
    while (cur && cur.nodeType === 1 && steps < 24) {
      if (cur.id && PROTECTED_ID_SET[cur.id]) return true;
      if (cur.hasAttribute) {
        try {
          if (cur.hasAttribute('data-ag-radial-top-layer')) return true;
        } catch (e) { }
      }
      cur = cur.parentElement || cur.parentNode;
      steps++;
    }
    if (!el.closest) return false;
    try {
      return Boolean(el.closest(PLUGIN_OWNED_SELECTORS.join(',')));
    } catch (e) {
      return false;
    }
  }

  /**
   * PR #90：受保护正文判定（消息正文 / 代码块 / 工具输出 / 终端输出）。
   * 与 shouldIgnoreElement 共用同一批受保护标记，但这里给悬停入口一个零成本短路。
   */
  function isProtectedContentNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (CORE_PROTECTED_TAGS[el.tagName]) return true;
    var testId = el.getAttribute ? el.getAttribute('data-testid') : '';
    if (testId && PROTECTED_TESTID_RE.test(String(testId))) return true;
    var cls = (el.className && typeof el.className === 'string') ? el.className : '';
    if (cls && PROTECTED_CLASS_CI_RE.test(cls)) return true;
    if (cls && CORE_CLASS_RE.test(cls)) return true;
    if (!el.closest) return false;
    try {
      return Boolean(el.closest('pre, code, .markdown-body, [class*="markdown"], [data-testid*="message-content"], [data-testid*="assistant-message"], [class*="terminal-output"], [class*="tool-output"]'));
    } catch (e) {
      return false;
    }
  }

  function shouldIgnoreElement(el) {    if (!el || el.nodeType !== 1) return false;
    if (ignoreElementCache && ignoreElementCache.has(el)) {
      return ignoreElementCache.get(el);
    }
    var res = inspectIgnoreState(el) === 1;
    if (ignoreElementCache && (res === true || el.isConnected === true)) {
      ignoreElementCache.set(el, res);
    }
    return res;
  }

  var MARK_ATTR = '_agyDone';
  var currentScanId = 0;

  function formatBrandDocumentTitle(rawTitle) {
    return rawTitle;
  }

  function applyBrandTitleToText(trimmed, parentEl) {
    if (
      trimmed !== 'Antigravity' &&
      trimmed !== 'Google Antigravity' &&
      trimmed !== '反重力' &&
      trimmed !== 'Google 反重力'
    ) {
      return null;
    }
    var mode = getBrandTitleMode();
    if (!parentEl || !parentEl.tagName) return null;
    var tag = parentEl.tagName;
    if (tag === 'CODE' || tag === 'PRE' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE') return null;

    if (parentEl.closest) {
      try {
        if (parentEl.closest('p, pre, code, blockquote, [class*="message"], [class*="chat"], [class*="content"], [class*="markdown"], [class*="artifact"]')) {
          return null;
        }
      } catch (e) { }
    }

    var isExactBrandItem = Boolean(
      (parentEl.getAttribute && (parentEl.getAttribute('data-agy-brand-item') === 'true' || parentEl.getAttribute('data-testid') === 'title-menu-bar-item')) ||
      (parentEl.closest && parentEl.closest('[data-agy-brand-item="true"], [data-testid="title-menu-bar-item"]'))
    );

    var cls = typeof parentEl.className === 'string' ? parentEl.className.toLowerCase() : '';
    var isTopLeftViewport = false;
    try {
      if (typeof parentEl.getBoundingClientRect === 'function') {
        var rect = parentEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top <= 70 && rect.left <= 300) {
          isTopLeftViewport = true;
        }
      }
    } catch (e) { }

    var isTitleOrDragBar = Boolean(
      isExactBrandItem ||
      isTopLeftViewport ||
      cls.indexOf('window-title') !== -1 ||
      cls.indexOf('titlebar') !== -1 ||
      cls.indexOf('top-bar') !== -1 ||
      cls.indexOf('app-bar') !== -1 ||
      cls.indexOf('drag') !== -1 ||
      cls.indexOf('brand') !== -1 ||
      cls.indexOf('logo') !== -1 ||
      (parentEl.closest && parentEl.closest(
        '.window-title, .titlebar-container, .part.titlebar, .titlebar-left, .titlebar-center, .titlebar-right, .titlebar, [class*="titlebar"], [class*="top-bar"], [class*="app-bar"], [class*="sidebar-header"], [style*="-webkit-app-region: drag"], [style*="-webkit-app-region:drag"]'
      ))
    );

    if (!isTitleOrDragBar) return null;

    if (trimmed === 'Antigravity' || trimmed === 'Google Antigravity') {
      if (mode === 'hidden') return '';
      if (mode === 'translated') return trimmed === 'Google Antigravity' ? 'Google 反重力' : '反重力';
      return null;
    }
    if (trimmed === '反重力' || trimmed === 'Google 反重力') {
      if (mode === 'english') return trimmed === 'Google 反重力' ? 'Google Antigravity' : 'Antigravity';
      if (mode === 'hidden') return '';
      if (mode === 'translated') return trimmed === 'Google 反重力' ? 'Google 反重力' : '反重力';
      return null;
    }
    return null;
  }

  function isNewBadgeTextNode(node) {
    var parent = node && (node.parentElement || node.parentNode);
    if (!parent || !parent.closest) return false;
    try {
      var badgeEl = parent.closest('.rounded-full, .bg-secondary.rounded');
      if (!badgeEl) return false;
      var role = badgeEl.getAttribute ? badgeEl.getAttribute('role') : null;
      return role !== 'button' && badgeEl.tagName !== 'BUTTON';
    } catch (e) {
      return false;
    }
  }

  function translateTextNode(node, parentChecked) {
    if (!node || node.nodeType !== 3) return;
    var parent = node.parentElement || node.parentNode;
    if (parent) {
      var pTag = parent.tagName ? String(parent.tagName).toUpperCase() : '';
      if (pTag === 'INPUT' || pTag === 'TEXTAREA') return;
      if (!parentChecked && (shouldIgnoreElement(parent) || hasProtectedCoreAncestor(parent))) return;
    }

    var original = node.nodeValue;
    if ((!original || !original.trim()) && node._agyHiddenOrigBrand) {
      var modeNow = getBrandTitleMode();
      if (modeNow !== 'hidden') {
        var restoredText = applyBrandTitleToText(node._agyHiddenOrigBrand, parent) || node._agyHiddenOrigBrand;
        var hLead = node._agyHiddenLead || '';
        var hTrail = node._agyHiddenTrail || '';
        node.nodeValue = hLead + restoredText + hTrail;
        node._agyOriginal = node.nodeValue;
        delete node._agyHiddenOrigBrand;
        delete node._agyHiddenLead;
        delete node._agyHiddenTrail;
      } else {
        node._agyOriginal = original || '';
      }
      return;
    }
    if (!original) return;

    if (node._agyOriginal === original && !node._agyIsBrandNode) return;

    var trimmed = original.trim();
    if (!trimmed) {
      node._agyOriginal = original;
      return;
    }

    var brandMapped = applyBrandTitleToText(trimmed, parent);
    if (brandMapped !== null) {
      node._agyIsBrandNode = true;
      var bLead = original.match(/^\s*/)[0];
      var bTrail = original.match(/\s*$/)[0];
      if (brandMapped === '') {
        node._agyHiddenOrigBrand = trimmed;
        node._agyHiddenLead = bLead;
        node._agyHiddenTrail = bTrail;
        node.nodeValue = '';
      } else {
        delete node._agyHiddenOrigBrand;
        delete node._agyHiddenLead;
        delete node._agyHiddenTrail;
        node.nodeValue = bLead + brandMapped + bTrail;
      }
      node._agyOriginal = node.nodeValue;
      if (parent) {
        var isExactBrandItem = Boolean(
          (parent.getAttribute && (parent.getAttribute('data-agy-brand-item') === 'true' || parent.getAttribute('data-testid') === 'title-menu-bar-item')) ||
          (parent.closest && parent.closest('[data-agy-brand-item="true"], [data-testid="title-menu-bar-item"]'))
        );
        if (isExactBrandItem && parent.setAttribute) {
          try {
            parent.setAttribute('data-agy-brand-item', 'true');
            parent.style.display = '';
          } catch (e) { }
        }
      }
      return;
    }

    if (!i18nEnabled) {
      node._agyOriginal = original;
      return;
    }

    if (trimmed === '.' && node.previousSibling && /[\u4e00-\u9fa5]/.test(node.previousSibling.textContent || '')) {
      node.nodeValue = original.replace('.', '。');
      node._agyOriginal = node.nodeValue;
      return;
    }

    var translated = (trimmed === 'New' && isNewBadgeTextNode(node)) ? '新' : translateSingleUnit(trimmed);
    if (translated !== null && translated !== trimmed) {
      var leadingSpace = original.match(/^\s*/)[0];
      var trailingSpace = original.match(/\s*$/)[0];
      if (!leadingSpace && node.previousSibling) {
        var prevText = (node.previousSibling.textContent || '').trim();
        if (/[a-zA-Z0-9]$/.test(prevText) && /^[\u4e00-\u9fa5]/.test(translated)) {
          leadingSpace = ' ';
        }
      }
      node.nodeValue = leadingSpace + translated + trailingSpace;
      node._agyOriginal = node.nodeValue;
    } else {
      node._agyOriginal = original;
    }
  }

  function getFirstDirectTextNode(n) {
    var cur = n;
    while (cur) {
      if (cur.nodeType === 3) return cur;
      if (cur.nodeType === 1 && cur.childNodes && cur.childNodes.length === 1) {
        cur = cur.firstChild;
      } else {
        break;
      }
    }
    return null;
  }

  function translateElement(el, scanId, ancestorState, budget) {
    if (!el || el.nodeType !== 1) return;
    if (scanId && el._agyScanId === scanId) return;
    if (budget) {
      if (budget.remaining <= 0 || budget.skipNode === el) return;
      if (isHeavyTranslatedDialog(el)) return;
      var subCount = typeof el.childElementCount === 'number'
        ? el.childElementCount
        : (el.children ? el.children.length : 0);
      if (subCount > 12) return;
      budget.remaining--;
    }
    var ignoreState = ancestorState === undefined
      ? inspectIgnoreState(el)
      : resolveOwnIgnoreState(el, ancestorState === 2);
    if (ignoreState === 1) return;
    if (scanId) el._agyScanId = scanId;

    if (i18nEnabled && el.getAttribute && el.getAttribute('data-testid') === 'plan-command-fyi-alert') {
      var alertSpan = el.querySelector ? el.querySelector('span') : null;
      if (alertSpan && !alertSpan._agyAlertDone) {
        var alertChild = alertSpan.firstChild;
        while (alertChild) {
          if (alertChild.nodeType === 3 && alertChild.nodeValue && alertChild.nodeValue.trim() === 'Type') {
            alertChild.nodeValue = alertChild.nodeValue.replace('Type', '输入');
            alertChild._agyOriginal = alertChild.nodeValue;
          }
          alertChild = alertChild.nextSibling;
        }
        alertSpan._agyAlertDone = true;
      }
    }

    if (i18nEnabled) {
      for (var i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
        var attr = TRANSLATABLE_ATTRS[i];
        if (el.hasAttribute && el.hasAttribute(attr)) {
          var val = el.getAttribute(attr);
          if (val) {
            var markKey = MARK_ATTR + '_' + attr;
            if (el[markKey] === val) continue;

            var trans = translateSingleUnit(val);
            if (trans !== null && trans !== val) {
              el.setAttribute(attr, trans);
              el[markKey] = trans;
            } else {
              el[markKey] = val;
            }
          }
        }
      }
    }

    // 表单输入控件只翻译上述属性，绝不遍历其内部文本或子节点
    var elTagUpper = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (elTagUpper === 'INPUT' || elTagUpper === 'TEXTAREA') {
      return;
    }

    // 空状态多节点混合残片收敛 (如 "No 自动化 yet" -> "暂无自动化")
    if (i18nEnabled && el.childNodes && el.childNodes.length >= 2 && el.childNodes.length <= 5) {
      var leafTexts = [];
      var allSimple = true;
      for (var li = 0; li < el.childNodes.length; li++) {
        var ln = el.childNodes[li];
        if (ln.nodeType === 3) {
          leafTexts.push(ln);
        } else if (ln.nodeType === 1 && ln.childNodes && ln.childNodes.length === 1 && ln.firstChild.nodeType === 3) {
          leafTexts.push(ln.firstChild);
        } else {
          allSimple = false;
          break;
        }
      }
      if (allSimple && leafTexts.length >= 2) {
        var joinedLeaf = '';
        for (var jIdx = 0; jIdx < leafTexts.length; jIdx++) joinedLeaf += leafTexts[jIdx].nodeValue || '';
        var emptyMatch = joinedLeaf.trim().match(/^No\s+(automations?|自动化|conversations?|对话|groups?|分组)\s+yet$/i);
        if (emptyMatch) {
          var eMap = {
            automation: '暂无自动化', automations: '暂无自动化', '自动化': '暂无自动化',
            conversation: '暂无对话', conversations: '暂无对话', '对话': '暂无对话',
            group: '暂无分组', groups: '暂无分组', '分组': '暂无分组'
          };
          var eTarget = eMap[emptyMatch[1].toLowerCase()] || '暂无自动化';
          leafTexts[0].nodeValue = eTarget;
          leafTexts[0]._agyOriginal = eTarget;
          for (var cClr = 1; cClr < leafTexts.length; cClr++) {
            leafTexts[cClr].nodeValue = '';
            leafTexts[cClr]._agyOriginal = '';
          }
          return;
        }
      }
    }

    var first = el.firstChild;
    if (i18nEnabled && first && first.nextSibling) {
      var allText = true;
      var cur = first;
      while (cur) {
        if (cur.nodeType !== 3) {
          allText = false;
          break;
        }
        cur = cur.nextSibling;
      }
      if (allText) {
        var combinedText = el.textContent;
        if (combinedText) {
          var combinedTrans = translateSingleUnit(combinedText);
          if (combinedTrans !== null && combinedTrans !== combinedText) {
            first.nodeValue = combinedTrans;
            first._agyOriginal = combinedTrans;
            var other = first.nextSibling;
            while (other) {
              other.nodeValue = '';
              other._agyOriginal = '';
              other = other.nextSibling;
            }
            return;
          }
        }
      } else if (!el.childNodes || el.childNodes.length <= 16) {
        var alsoNode = null;
        var whenNode = null;
        var scanCur = first;
        while (scanCur) {
          var tn = getFirstDirectTextNode(scanCur);
          if (tn && tn.nodeValue) {
            var tVal = tn.nodeValue.trim();
            if (/^(?:Also\s+includes|Includes|也包含|包含)$/i.test(tVal)) {
              alsoNode = tn;
            } else if (alsoNode && (tVal.indexOf('when working in this project') !== -1 || tVal.indexOf('在此项目中工作时') !== -1)) {
              whenNode = tn;
              break;
            }
          }
          scanCur = scanCur.nextSibling;
        }
        if (alsoNode && whenNode) {
          var alsoText = alsoNode.nodeValue.trim();
          var prefix = (alsoText.indexOf('也') !== -1 || alsoText.indexOf('Also') !== -1) ? '在此项目中工作时，也包含' : '在此项目中工作时包含';
          alsoNode.nodeValue = prefix;
          alsoNode._agyOriginal = alsoNode.nodeValue;

          var alsoContainer = alsoNode.parentNode === el ? alsoNode : alsoNode.parentNode;
          var whenContainer = whenNode.parentNode === el ? whenNode : whenNode.parentNode;
          var between = alsoContainer.nextSibling;
          while (between && between !== whenContainer) {
            if (between.nodeType === 3 && !between.nodeValue.trim()) {
              between.nodeValue = '';
              between._agyOriginal = '';
            }
            between = between.nextSibling;
          }

          var cleanedWhen = whenNode.nodeValue.replace(/when\s+working\s+in\s+this\s+project[。.]?/gi, '').replace(/在此项目中工作时[。.]?/g, '').trim();
          whenNode.nodeValue = cleanedWhen ? ('。 ' + cleanedWhen) : '。';
          whenNode._agyOriginal = whenNode.nodeValue;
        }
      }
    }

    var child = el.firstChild;
    while (child) {
      if (child.nodeType === 3) {
        translateTextNode(child, true);
      } else if (child.nodeType === 1) {
        translateElement(child, scanId, ignoreState, budget);
      }
      child = child.nextSibling;
    }
  }

  var observer = null;
  var observing = false;

  function disconnectObserver() {
    if (observer && observing) {
      observer.disconnect();
      observing = false;
    }
  }

  function reconnectObserver() {
    if (observer && !observing && doc && doc.documentElement) {
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      observing = true;
    }
  }

  function safeFullScan() {
    if (!doc || !doc.documentElement) return;
    currentScanId++;
    disconnectObserver();
    try {
      translateElement(doc.documentElement, currentScanId);
    } catch (e) { }
    reconnectObserver();
  }

  var pendingNodes = [];
  var pendingNodeSet = typeof Set !== 'undefined' ? new Set() : null;
  var rafScheduled = false;

  function enqueueNode(node) {
    if (!node) return;
    var checkEl = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
    if (checkEl && checkEl.nodeType === 1 && shouldIgnoreElement(checkEl)) return;
    if (pendingNodeSet) {
      if (pendingNodeSet.has(node)) return;
      pendingNodes.push(node);
      pendingNodeSet.add(node);
    } else {
      pendingNodes.push(node);
    }
  }

  function isAncestorInBatchSet(node, batchSet) {
    var cur = node.parentElement || node.parentNode;
    var steps = 0;
    while (cur && steps < 64) {
      if (batchSet.has(cur)) return true;
      if (doc && cur === doc.body) break;
      cur = cur.parentElement || cur.parentNode;
      steps++;
    }
    return false;
  }

  function flushPendingNodes() {
    rafScheduled = false;
    if (pendingNodes.length === 0) return;
    var getNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? function () { return performance.now(); }
      : Date.now;
    var startMs = getNow();
    var limit = Math.min(pendingNodes.length, 500);
    var batch = pendingNodes.slice(0, limit);
    var batchSet = typeof Set !== 'undefined' ? new Set(batch) : null;
    var flushScanId = ++currentScanId;
    var processed = 0;
    disconnectObserver();
    try {
      for (var i = 0; i < batch.length; i++) {
        var node = batch[i];
        if (pendingNodeSet) pendingNodeSet.delete(node);
        processed++;
        if (!node || node.isConnected === false) continue;
        if (node.nodeType === 1) {
          if (node._agyScanId === flushScanId) continue;
          if (batchSet && isAncestorInBatchSet(node, batchSet)) continue;
          translateElement(node, flushScanId);
          if (node.getAttribute && node.getAttribute('role') === 'dialog') {
            node._agyDialogTranslatedAt = Date.now ? Date.now() : (+new Date());
          }
        } else if (node.nodeType === 3) {
          var p = node.parentElement || node.parentNode;
          if (p && (p._agyScanId === flushScanId || (batchSet && (batchSet.has(p) || isAncestorInBatchSet(p, batchSet))))) {
            continue;
          }
          translateTextNode(node);
        }
        if (processed >= 1 && i + 1 < batch.length && (getNow() - startMs) >= 6) {
          break;
        }
      }
    } catch (e) { } finally {
      if (processed > 0) pendingNodes.splice(0, processed);
      reconnectObserver();
    }
    if (pendingNodes.length > 0) scheduleFlush();
  }

  function scheduleFlush() {
    if (!rafScheduled) {
      rafScheduled = true;
      if (root.requestAnimationFrame) {
        root.requestAnimationFrame(flushPendingNodes);
      } else {
        setTimeout(flushPendingNodes, 16);
      }
    }
  }

  function startObserver() {
    if (!doc || !doc.documentElement) return;
    safeFullScan();

    var MutationObserverClass = root.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (MutationObserverClass) {
      observer = new MutationObserverClass(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'childList') {
            var added = mutation.addedNodes;
            for (var j = 0; j < added.length; j++) {
              enqueueNode(added[j]);
            }
          } else if (mutation.type === 'characterData') {
            if (mutation.target) {
              mutation.target._agyOriginal = undefined;
              enqueueNode(mutation.target);
            }
          }
        }
        if (pendingNodes.length > 0) scheduleFlush();
      });
      reconnectObserver();
    }

    // 首屏全量翻译后由 MutationObserver 增量处理新增节点。
    // 不再每 15 秒递归整棵 DOM；长会话及复杂插件页的全树扫描会阻塞主线程数秒。
  }

  function isFloatingElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (doc && (el === doc.body || el === doc.documentElement)) return false;
    if (el.id === 'workbench') return false;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (cls && cls.indexOf('monaco-workbench') !== -1) return false;
    if (el.matches) {
      try {
        if (el.matches('[role="tooltip"], [role="menu"], [role="dialog"], [data-floating-ui-portal], [data-radix-popper-content-wrapper], .popover, .tooltip, .context-view, .monaco-hover')) {
          return true;
        }
      } catch (e) { }
    }
    var role = el.getAttribute ? el.getAttribute('role') : '';
    if (role === 'tooltip' || role === 'menu' || role === 'dialog') return true;
    if (el.hasAttribute && (el.hasAttribute('data-floating-ui-portal') || el.hasAttribute('data-radix-popper-content-wrapper'))) return true;
    if (cls) {
      if (cls.indexOf('popover') !== -1 || cls.indexOf('tooltip') !== -1 || cls.indexOf('context-view') !== -1 || cls.indexOf('monaco-hover') !== -1) {
        return true;
      }
    }
    return false;
  }

  function isWorkbenchOrRoot(el) {
    if (!el || el.nodeType !== 1) return true;
    if (doc && (el === doc.body || el === doc.documentElement)) return true;
    if (el.id === 'workbench') return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    return Boolean(cls && cls.indexOf('monaco-workbench') !== -1);
  }

  if (doc) {
    try {
      var proto = typeof Document !== 'undefined' ? Document.prototype : null;
      var titleDesc = proto ? Object.getOwnPropertyDescriptor(proto, 'title') : null;
      if (titleDesc && titleDesc.set && titleDesc.get) {
        var origSetter = titleDesc.set;
        var origGetter = titleDesc.get;
        Object.defineProperty(doc, 'title', {
          configurable: true,
          enumerable: true,
          get: function () { return origGetter.call(this); },
          set: function (val) { origSetter.call(this, formatBrandDocumentTitle(String(val || ''))); }
        });
      }
      if (doc.title) {
        var formatted = formatBrandDocumentTitle(doc.title);
        if (formatted !== doc.title) doc.title = formatted;
      }
    } catch (e) { }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', startObserver);
    } else {
      startObserver();
    }

    try {
      var lastHoverTime = 0;

      function isHeavyTranslatedDialog(el) {
        if (!el || el.nodeType !== 1) return false;
        var role = el.getAttribute ? el.getAttribute('role') : '';
        if (role !== 'dialog') return false;
        if (el._agyDialogTranslatedAt) return true;
        return Boolean(el.className && typeof el.className === 'string' && el.className.indexOf('settings-modal-container') !== -1 && el.childElementCount > 40);
      }

      var onHoverAction = function (e) {
        var target = e && e.target;
        if (!target || target.nodeType !== 1) return;
        // PR #90：插件自身节点与受保护正文在悬停入口最前面直接返回，
        // 连节流计时器都不消耗，彻底杜绝插件面板与正文气泡被反复扫描
        if (isPluginOwnedNode(target)) return;
        if (isProtectedContentNode(target)) return;
        if (target.id && PROTECTED_ID_SET[target.id]) return;
        var now = Date.now ? Date.now() : (+new Date());
        if (now - lastHoverTime < 120) return;
        if (shouldIgnoreElement(target)) return;
        lastHoverTime = now;

        var hScanId = ++currentScanId;
        disconnectObserver();
        try {
          var childCount = typeof target.childElementCount === 'number'
            ? target.childElementCount
            : (target.children ? target.children.length : 0);
          if (childCount <= 12 && !isHeavyTranslatedDialog(target)) {
            translateElement(target, hScanId, undefined, { remaining: 24 });
            var pEl = target.parentElement;
            if (pEl && !isWorkbenchOrRoot(pEl) && !isHeavyTranslatedDialog(pEl) && !shouldIgnoreElement(pEl)) {
              var pCount = typeof pEl.childElementCount === 'number'
                ? pEl.childElementCount
                : (pEl.children ? pEl.children.length : 0);
              if (pCount <= 12) {
                translateElement(pEl, hScanId, undefined, { remaining: 16, skipNode: target });
              }
            }
          }
        } catch (e) { } finally {
          lastHoverTime = Date.now ? Date.now() : (+new Date());
          reconnectObserver();
        }

      };

      doc.addEventListener('pointerenter', onHoverAction, { capture: true, passive: true });
      doc.addEventListener('contextmenu', onHoverAction, { capture: true, passive: true });
    } catch (e) { }
  }

  if (root) {
    root.__AGY_CREATE_ENGINE__ = createI18nEngine;
    root.__AGY_TRANSLATE_UNIT__ = translateSingleUnit;
    root.__AGY_TRANSLATE_EL__ = translateElement;
    root.__AGY_RUN_FULL_SCAN__ = safeFullScan;
    root.__AGY_CACHE__ = defaultEngine.cache;
    root.__AGY_IS_FLOATING__ = isFloatingElement;
    root.__AGY_IS_CHAT_OR_MARKDOWN__ = isChatOrMarkdownContent;
    root.__AGY_SHOULD_IGNORE__ = shouldIgnoreElement;
    root.__AGY_FORMAT_BRAND_TITLE__ = formatBrandDocumentTitle;
    root.__AGY_APPLY_BRAND_TEXT__ = applyBrandTitleToText;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
