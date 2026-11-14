'use strict';
// Preserve Electron ASAR support in the host process.

/**
 * Antigravity 内核提示词精简、防幻觉护栏与中文会话标题模块 (meter-enhance.js)
 *
 * 贡献来源与致敬：
 * 核心 Go embed.FS 系统提示词槽位解析、0~4 档提示词精简架构、v2.29+ applyEdits 校验绕过、
 * 以及等长 ASCII 中文标题补丁来自 GitHub PR #4 贡献者 Jia131313。
 * 本模块在融合时将上下文窗口修改统一委托给 meter-context-unlock.js，避免双补丁器互相覆盖，
 * 并针对 Antigravity 真实工具契约与工程纪律对 Tier 3 / Tier 4 防幻觉载荷做了适配。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const contextUnlock = require('./meter-context-unlock');

// ============================================================================
// 提示词载荷定义（严格控制在 Desktop / CLI / IDE 最小槽位字节上限内）
// 兼容旧版最小容量限制：guidelines <= 691B, function_call <= 605B, communication_style <= 2034B
// ============================================================================

const TIER3_GUIDELINES = [
  'Follow these core engineering mandates at all times:',
  '- **Evidence-First Grounding**: Never treat caller call-sites, comments, summaries, or mocks as proof an API or symbol exists. Before modifying or explaining unfamiliar behavior, inspect the source via `read_file` or `run_command`. If unverified, state it explicitly.',
  '- **Surgical Minimal Scope**: Keep edits tight to the stated task. Reuse existing mechanisms; avoid speculative abstractions or unrequested defensive bloat. Clarify genuine ambiguities with `ask_question`.',
  '- **Boundary Integrity**: Never bypass access controls, permissions, or sandbox limits; if blocked, report and stop.'
].join('\n');

const TIER3_FUNCTION_CALL = [
  '- **Clean Tool Turns**: Emit tool calls directly without filler preambles or trailing colons (do not write "Let me read the file:" before a tool call).',
  '- **Parallel Reads, Sequential Edits**: Batch independent `read_file` or read-only `run_command` calls in one turn; edit a file sequentially across turns after reading the target block.',
  '- **Reactive Wakeup (No Polling)**: Background `run_command` and `invoke_subagent` tasks wake you on completion. NEVER run shell `sleep` or polling loops.'
].join('\n');

const TIER3_COMMUNICATION_STYLE = [
  '## Intent & Execution Discipline',
  '- Distinguish **Inquiries** (questions, reviews, RCA) from **Directives** (requests to change files or run commands):',
  '  - **Inquiries**: Answer cleanly in chat; do NOT edit workspace files.',
  '  - **Directives**: Execute end-to-end (inspect -> edit -> verify with `run_command`) without asking permission on reversible steps.',
  '',
  '## Native Tool Contracts',
  '- **Direct Delivery First**: Deliver explanations, diffs, and short reports directly in chat; create artifacts only when structured long-form reports or user deliverables genuinely benefit.',
  '- **`edit_file` Exactness**: `edit_file` replaces every match of `Target`. Include 3-5 lines of surrounding context so `Target` matches one unique location.',
  '- **Native File Tools First**: Prefer `read_file`, `edit_file`, and `write_file` over shell `cat`, `sed`, `awk`, or redirection.',
  '- **Subagents**: Give `invoke_subagent` open, neutral prompts with clear completion checks, and verify cited paths/lines directly.',
  '',
  '## Verification & Formatting',
  '- Run the narrowest targeted build, typecheck, or test via `run_command` after edits. Never fabricate tool output or report skipped/partial runs as full passes.',
  '- Lead with the direct conclusion in sentence 1. Cite files/symbols as clickable `[name](file:///abs/path#L10-L20)` links (forward slashes on Windows) and escape literal `$` in prose as `\\$`.'
].join('\n');

const TIER4_GUIDELINES = [
  'Follow these behavioral guidelines at all times:',
  '- Maintain documentation integrity: preserve unrelated comments and docstrings. Never bypass access controls, permissions, or sandbox limits.',
  '- **Evidence-First Grounding**: Never guess unread file contents, API signatures, or unexecuted outputs; inspect with `read_file` or `run_command` first and mark anything unverified.',
  '- **Surgical Minimal Scope**: Keep edits scoped to the actual requirement without over-engineering or unrequested abstractions; ask via `ask_question` only when intent is genuinely ambiguous.'
].join('\n');

const TIER4_FUNCTION_CALL = [
  'You support parallel tool calling. Batch independent `read_file` or read-only `run_command` calls in one turn; keep sequential dependencies across turns.',
  '- **Clean Tool Turns**: Call tools directly without filler preambles before tool calls.',
  '- **Reactive Wakeup (No Polling)**: Wait naturally when async `run_command` or `invoke_subagent` runs; never poll with shell `sleep`.'
].join('\n');

const TIER4_COMMUNICATION_STYLE = [
  '- Keep responses concise, structured, and formatted in github-style markdown.',
  '- LaTeX math (KaTeX) is supported: inline \\(...\\) or $...$, display \\[...\\] or $$...$$. Escape literal `$` in prose as `\\$`.',
  '- Cite modified or inspected files/symbols with clickable links: `[symbol](file:///abs/path#L10-L20)` (forward slashes on Windows).',
  '',
  '## Anti-Hallucination & Engineering Guardrails',
  '- **Inquiry vs. Directive**: Treat pure questions/reviews as Inquiries (read-only, no workspace edits). Execute coding requests end-to-end (read -> edit -> targeted `run_command` verification) cleanly.',
  '- **Direct Delivery First**: Deliver concise diffs and explanations in chat; use artifacts selectively when structured long reports are needed.',
  '- **`edit_file` Uniqueness Guard**: Always include 3-5 unique context lines in `Target` so edits apply once and deterministically; inspect before editing.',
  '- **Honest Verification**: Run the narrowest test, lint, or build command that proves your change after the final edit. Never fabricate tool logs, extrapolate unseen fields, or claim skipped/mocked runs as full passes.'
].join('\n');

const AD_SLOTS = [
  'system_prompts/slash_commands.tmpl',
  'system_prompts/plugins.tmpl'
];

const BLOAT_SLOTS = [
  'system_prompts/artifacts.tmpl',
  'system_prompts/persistent_context.tmpl',
  'system_prompts/knowledge_items.tmpl',
  'system_prompts/planning_mode_artifacts.tmpl',
  'system_prompts/conversation_transcript.tmpl',
  'system_prompts/slash_commands.tmpl',
  'system_prompts/plugins.tmpl'
];

// 各档位保留 / 清空 / 替换透明清单（供 UI 展示与测试核验）
const PROMPT_TIER_META = {
  0: {
    tier: 0,
    key: '0',
    label: '0档 · 官方原版',
    shortLabel: '0档原版',
    keeps: ['全部系统提示词模板与原生工具定义（100% 原始状态）'],
    clears: [],
    replaces: [],
    desc: '从原版备份完整还原所有官方系统提示词模板'
  },
  1: {
    tier: 1,
    key: '1',
    label: '1档 · 仅去推销',
    shortLabel: '1档去推销',
    keeps: ['identity.tmpl', 'guidelines.tmpl', 'function_call.tmpl', 'communication_style.tmpl', 'artifacts/transcript 等全部其余原版模板'],
    clears: ['slash_commands.tmpl', 'plugins.tmpl'],
    replaces: [],
    desc: '仅清空 slash_commands / plugins 推销模板，其余保持官方原版'
  },
  2: {
    tier: 2,
    key: '2',
    label: '2档 · 原版精简',
    shortLabel: '2档精简',
    keeps: ['identity.tmpl', 'guidelines.tmpl', 'function_call.tmpl', 'communication_style.tmpl（4份核心模板保持官方原版未修改）'],
    clears: ['artifacts.tmpl', 'persistent_context.tmpl', 'knowledge_items.tmpl', 'planning_mode_artifacts.tmpl', 'conversation_transcript.tmpl', 'slash_commands.tmpl', 'plugins.tmpl'],
    replaces: [],
    desc: '清空 7 个冗余与推销模板，身份与 3 个核心行为模板保持官方原版未修改'
  },
  3: {
    tier: 3,
    key: '3',
    label: '3档 · 核心重写',
    shortLabel: '3档重写',
    keeps: ['identity.tmpl（官方原版身份未修改）', '全部原生工具定义'],
    clears: ['artifacts.tmpl', 'persistent_context.tmpl', 'knowledge_items.tmpl', 'planning_mode_artifacts.tmpl', 'conversation_transcript.tmpl', 'slash_commands.tmpl', 'plugins.tmpl'],
    replaces: ['guidelines.tmpl', 'function_call.tmpl', 'communication_style.tmpl（重写为精简工程规范）'],
    desc: '清空 7 个冗余模板，并将 3 个核心行为模板重写为高密度精简规范'
  },
  4: {
    tier: 4,
    key: '4',
    label: '4档 · 精简+防幻觉 (推荐)',
    shortLabel: '4档推荐',
    keeps: ['identity.tmpl（官方原版身份未修改）', '全部原生工具定义', '核心原版格式要求'],
    clears: ['artifacts.tmpl', 'persistent_context.tmpl', 'knowledge_items.tmpl', 'planning_mode_artifacts.tmpl', 'conversation_transcript.tmpl', 'slash_commands.tmpl', 'plugins.tmpl'],
    replaces: ['guidelines.tmpl', 'function_call.tmpl', 'communication_style.tmpl（精简工程规范 + 未读禁猜 + edit_file 唯一锚点 + 实测验证护栏）'],
    desc: '清空 7 个冗余模板，结合适配后防幻觉护栏（说明：仅校验模板已写入，不保证模型零失误）'
  }
};

// 会话与章节自动中文命名等长特征表（来自 PR #4 / agy-chinese-title-patch，100% 严格 ASCII 字节等长双向可逆）
const CHINESE_TITLE_RULES = [
  {
    id: 'conversation_title',
    name: '会话主标题生成指令 (Conversation Title)',
    oldText: "Respond with ONLY a short conversation title (3-5 words, title-cased, no prefix) describing the USER's intent.",
    newText: "Respond with ONLY a Simplified Chinese title (4-10 Chinese chars, NEVER English) describing the USER's intent."
  },
  {
    id: 'chapter_sentence',
    name: '章节标题生成句式 (Chapter Title - 句式)',
    oldText: 'Reply with only a plain 3 to 6 word title in sentence case',
    newText: 'Reply with only a concise Simplified Chinese chapter title'
  },
  {
    id: 'chapter_example',
    name: '章节标题生成示例 (Chapter Title - 示例)',
    oldText: 'For example: Fixing the login redirect bug, or Planning the websocket rollout.',
    newText: ' ALWAYS reply in Simplified Chinese (4-10 Chinese chars, NEVER English words).'
  }
];

for (const rule of CHINESE_TITLE_RULES) {
  const oldLen = Buffer.byteLength(rule.oldText, 'ascii');
  const newLen = Buffer.byteLength(rule.newText, 'ascii');
  if (oldLen !== newLen) {
    throw new Error(`中文标题补丁内部等长校验失败 [${rule.id}]: ${oldLen} != ${newLen}`);
  }
}

const CHINESE_TITLE_META = {
  zh: { mode: 'zh', enabled: true, label: '自动中文标题 (4~10字)', shortLabel: '中文标题' },
  en: { mode: 'en', enabled: false, label: '官方英文标题', shortLabel: '英文标题' },
  unsupported: { mode: 'unsupported', enabled: false, label: '当前内核无标题特征', shortLabel: '未匹配' }
};

function normalizePromptTier(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s === '0' || s === 'restore' || s === 'stock' || s === 'reset') return 0;
  if (s === '1' || s === 'tier1') return 1;
  if (s === '2' || s === 'tier2') return 2;
  if (s === '3' || s === 'tier3') return 3;
  if (s === '4' || s === 'tier4') return 4;
  return undefined;
}

function normalizeChineseTitleMode(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'on' || s === 'zh' || s === 'cn' || s === 'zh-cn' || s === 'enable' || s === 'enabled') {
    return true;
  }
  if (s === 'false' || s === '0' || s === 'off' || s === 'en' || s === 'stock' || s === 'restore' || s === 'reset' || s === 'disable' || s === 'disabled') {
    return false;
  }
  return undefined;
}

const standalonePathCache = new Map();

function resolveStandaloneAgyPath(localAppData, homeDir) {
  const home = homeDir || os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'bin', 'agy.exe'),
    path.join(localAppData, 'agy', 'bin', 'agy.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const cacheKey = `${String(localAppData || '').toLowerCase()}|${String(home).toLowerCase()}`;
  if (standalonePathCache.has(cacheKey)) {
    const cached = standalonePathCache.get(cacheKey);
    if (cached && fs.existsSync(cached)) return cached;
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['agy.exe'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      for (const line of String(out || '').split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate && fs.existsSync(candidate)) {
          standalonePathCache.set(cacheKey, candidate);
          return candidate;
        }
      }
    } catch {}
  }
  standalonePathCache.set(cacheKey, candidates[0]);
  return candidates[0];
}

function resolveTargetBinaries(options = {}) {
  if (Array.isArray(options.targets)) {
    return options.targets.map((t) => ({
      id: String(t.id || 'custom'),
      label: String(t.label || path.basename(t.path || '')),
      path: path.resolve(t.path)
    }));
  }

  // 测试/隔离环境若未显式传入 targets 且未成对指定隔离目录，拒绝探测真实系统目录与 where.exe
  const hasIsolationSignal = Boolean(
    options.backupDir ||
    options.enhanceBackupDir ||
    options.stateDir ||
    options.skipProcessCheck ||
    process.env.NODE_TEST_CONTEXT
  );
  if (hasIsolationSignal && !(options.homeDir && options.localAppData)) {
    return [];
  }

  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return [];
  }

  const home = options.homeDir || os.homedir();
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const desktopPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
  const standalonePath = resolveStandaloneAgyPath(localAppData, home);
  const ideExtPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe');

  const targets = [
    { id: 'desktop', label: 'Antigravity 桌面端内核 (language_server)', path: desktopPath },
    { id: 'cli', label: 'Antigravity 独立 CLI 内核 (agy.exe)', path: standalonePath }
  ];
  if (fs.existsSync(ideExtPath)) {
    targets.push({ id: 'ide', label: 'Antigravity IDE 扩展语言服务', path: ideExtPath });
  }
  return targets;
}

// ============================================================================
// Go embed.FS 系统提示词槽位解析 (PE64)
// ============================================================================

function computeActiveBytes(rawStr) {
  const idx = rawStr.indexOf('{{- /*');
  if (idx !== -1 && rawStr.trimEnd().endsWith('*/ -}}')) {
    return { activeBytes: idx, isStripped: idx === 0 };
  }
  return { activeBytes: Buffer.byteLength(rawStr, 'utf8'), isStripped: false };
}

function parsePeEmbedTemplates(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('不是有效的 Windows PE64 可执行文件');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\x00\x00') {
    throw new Error('无效的 PE 文件头');
  }
  const machine = buf.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error('当前仅支持 x64 (AMD64) PE 二进制文件');
  }
  const numSections = buf.readUInt16LE(peOffset + 6);
  const optSize = buf.readUInt16LE(peOffset + 20);
  const optStart = peOffset + 24;
  if (optSize < 32 || optStart + optSize > buf.length) {
    throw new Error('PE Optional Header 损坏');
  }
  const imageBase = buf.readBigUInt64LE(optStart + 24);
  const sectionTableStart = optStart + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = sectionTableStart + i * 40;
    if (off + 40 > buf.length) break;
    sections.push({
      vSize: buf.readUInt32LE(off + 8),
      vAddr: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20)
    });
  }

  const fileOffsetToVA = (foff) => {
    for (const s of sections) {
      if (foff >= s.rawPtr && foff < s.rawPtr + s.rawSize) {
        return imageBase + BigInt(s.vAddr + (foff - s.rawPtr));
      }
    }
    return 0n;
  };

  const vaToFileOffset = (va) => {
    if (va < imageBase) return -1;
    const rva = Number(va - imageBase);
    for (const s of sections) {
      const span = Math.max(s.vSize, s.rawSize);
      if (rva >= s.vAddr && rva < s.vAddr + span) {
        const off = s.rawPtr + (rva - s.vAddr);
        return off >= 0 && off <= buf.length ? off : -1;
      }
    }
    return -1;
  };

  const anchorName = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/identity.tmpl';
  const foff = buf.indexOf(anchorName);
  if (foff === -1) {
    throw new Error('未在二进制中找到 identity.tmpl 模板锚点');
  }
  const va = fileOffsetToVA(foff);
  if (va === 0n) {
    throw new Error('无法将 identity.tmpl 偏移映射为虚拟地址');
  }

  const needle = Buffer.alloc(16);
  needle.writeBigUInt64LE(va, 0);
  needle.writeBigUInt64LE(BigInt(anchorName.length), 8);

  const entryOff = buf.indexOf(needle);
  if (entryOff === -1) {
    throw new Error('无法定位 Go embed.FS 的 identity.tmpl 切片入口');
  }

  const basePrefix = 'google3/third_party/jetski/prompt/template_provider/templates/';
  const sysPrefix = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';
  const templates = new Map();

  for (let k = -24; k <= 28; k++) {
    const e = entryOff + k * 48;
    if (e < 0 || e + 48 > buf.length) continue;
    const nVa = buf.readBigUInt64LE(e);
    const nLen = Number(buf.readBigUInt64LE(e + 8));
    const dVa = buf.readBigUInt64LE(e + 16);
    const dLen = Number(buf.readBigUInt64LE(e + 24));
    if (nLen <= 0 || nLen >= 240 || dLen < 0 || dLen > 512 * 1024) continue;

    const nOff = vaToFileOffset(nVa);
    if (nOff <= 0 || nOff + nLen > buf.length) continue;

    const fullName = buf.subarray(nOff, nOff + nLen).toString('utf8');
    if (!fullName.startsWith(sysPrefix) || fullName.endsWith('/')) continue;

    const dOff = dLen > 0 ? vaToFileOffset(dVa) : 0;
    if (dLen > 0 && (dOff <= 0 || dOff + dLen > buf.length)) continue;

    const shortName = fullName.slice(basePrefix.length);
    const rawStr = dLen > 0 ? buf.subarray(dOff, dOff + dLen).toString('utf8') : '';
    const { activeBytes, isStripped } = computeActiveBytes(rawStr);

    templates.set(shortName, {
      shortName,
      fullName,
      entryOffset: e,
      dataOffset: dOff,
      dataLength: dLen,
      activeBytes,
      isStripped,
      isModified: activeBytes !== dLen
    });
  }

  if (templates.size === 0 || !templates.has('system_prompts/identity.tmpl')) {
    throw new Error('解析 Go embed.FS 系统提示词槽位失败');
  }

  return templates;
}

function writePaddedTemplate(buf, slot, newText) {
  const encoded = Buffer.from(String(newText || ''), 'utf8');
  if (encoded.length > slot.dataLength) {
    throw new Error(`模板 ${slot.shortName} 超出槽位容量上限：新内容 ${encoded.length}B > 容量 ${slot.dataLength}B`);
  }
  const padLen = slot.dataLength - encoded.length;
  const padding = padLen >= 12
    ? Buffer.from('{{- /*' + ' '.repeat(padLen - 12) + '*/ -}}', 'utf8')
    : Buffer.from(' '.repeat(padLen), 'utf8');

  encoded.copy(buf, slot.dataOffset);
  padding.copy(buf, slot.dataOffset + encoded.length);
  return encoded.length;
}

function detectPromptTier(templates, buf) {
  const slashSlot = templates.get('system_prompts/slash_commands.tmpl');
  const artSlot = templates.get('system_prompts/artifacts.tmpl');
  const slashStripped = Boolean(slashSlot && slashSlot.isStripped);
  const artStripped = Boolean(artSlot && artSlot.isStripped);

  if (slashStripped && !artStripped) {
    return 1;
  }
  if (artStripped) {
    const guideSlot = templates.get('system_prompts/guidelines.tmpl');
    const styleSlot = templates.get('system_prompts/communication_style.tmpl');
    const gTxt = (guideSlot && guideSlot.dataLength > 0)
      ? buf.subarray(guideSlot.dataOffset, guideSlot.dataOffset + guideSlot.dataLength).toString('utf8')
      : '';
    const cTxt = (styleSlot && styleSlot.dataLength > 0)
      ? buf.subarray(styleSlot.dataOffset, styleSlot.dataOffset + styleSlot.dataLength).toString('utf8')
      : '';
    if (gTxt.includes('core engineering mandates')) return 3;
    if (cTxt.includes('Anti-Hallucination')) return 4;
    return 2;
  }
  return 0;
}

function applyPromptTierToBuffer(buf, bakBuf, tierNum) {
  const curTemplates = parsePeEmbedTemplates(buf);
  const bakTemplates = parsePeEmbedTemplates(bakBuf);

  // 先从备份还原全部系统提示词槽位，确保任意档位切换无残留
  for (const [name, bakSlot] of bakTemplates.entries()) {
    const curSlot = curTemplates.get(name);
    if (curSlot && bakSlot.dataOffset === curSlot.dataOffset && bakSlot.dataLength === curSlot.dataLength && bakSlot.dataLength > 0) {
      bakBuf.copy(buf, curSlot.dataOffset, bakSlot.dataOffset, bakSlot.dataOffset + bakSlot.dataLength);
    }
  }

  // 兼容 v2.29+ genericsystemprompt.applyEdits 启动子串强校验（v2.31+ 已移除该校验则自动跳过）
  const applyEditsPrefix = Buffer.from('488b71104889742458488b711848897424384889d1', 'hex');
  const applyEditsTailStock = Buffer.from('4883f8010f8474ffffff', 'hex');
  const applyEditsTailBypass = Buffer.from('4883f801e975ffffff90', 'hex');
  const prefixOff = bakBuf.indexOf(applyEditsPrefix);

  let strippedBytes = 0;
  let strippedCount = 0;

  if (tierNum === 0) {
    if (prefixOff !== -1) {
      const tailOff = prefixOff + applyEditsPrefix.length + 5;
      if (tailOff + 10 <= bakBuf.length) {
        const curTail = bakBuf.subarray(tailOff, tailOff + 10);
        if (curTail.equals(applyEditsTailStock) || curTail.equals(applyEditsTailBypass)) {
          applyEditsTailStock.copy(buf, tailOff);
        }
      }
    }
  } else if (tierNum === 1) {
    for (const name of AD_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '');
        strippedBytes += slot.dataLength;
        strippedCount++;
      }
    }
  } else if (tierNum === 2 || tierNum === 3 || tierNum === 4) {
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '');
        strippedBytes += slot.dataLength;
        strippedCount++;
      }
    }
    if (tierNum === 3 || tierNum === 4) {
      const gSlot = curTemplates.get('system_prompts/guidelines.tmpl');
      const fSlot = curTemplates.get('system_prompts/function_call.tmpl');
      const cSlot = curTemplates.get('system_prompts/communication_style.tmpl');
      if (!gSlot || !fSlot || !cSlot) {
        throw new Error('核心提示词槽位缺失（guidelines / function_call / communication_style）');
      }
      writePaddedTemplate(buf, gSlot, tierNum === 3 ? TIER3_GUIDELINES : TIER4_GUIDELINES);
      writePaddedTemplate(buf, fSlot, tierNum === 3 ? TIER3_FUNCTION_CALL : TIER4_FUNCTION_CALL);
      writePaddedTemplate(buf, cSlot, tierNum === 3 ? TIER3_COMMUNICATION_STYLE : TIER4_COMMUNICATION_STYLE);
    }
  } else {
    throw new Error(`不支持的提示词档位: ${tierNum}`);
  }

  if (tierNum !== 0 && prefixOff !== -1) {
    const tailOff = prefixOff + applyEditsPrefix.length + 5;
    if (tailOff + 10 <= bakBuf.length) {
      const curTail = bakBuf.subarray(tailOff, tailOff + 10);
      if (curTail.equals(applyEditsTailStock) || curTail.equals(applyEditsTailBypass)) {
        applyEditsTailBypass.copy(buf, tailOff);
      }
    }
  }

  // 强制校验 identity.tmpl 完整性
  const idSlot = curTemplates.get('system_prompts/identity.tmpl');
  if (!idSlot) {
    throw new Error('安全校验失败：缺少 identity.tmpl 槽位');
  }
  const idText = buf.subarray(idSlot.dataOffset, idSlot.dataOffset + idSlot.dataLength).toString('utf8');
  if (!idText.includes('You are Antigravity')) {
    throw new Error('安全校验失败：identity.tmpl 身份校验区完整性异常，已中止写入');
  }

  return {
    tier: tierNum,
    label: PROMPT_TIER_META[tierNum].label,
    strippedCount,
    strippedBytes
  };
}

function isSamePeBuild(bufA, bufB) {
  try {
    if (!Buffer.isBuffer(bufA) || !Buffer.isBuffer(bufB)) return false;
    if (bufA.length !== bufB.length || bufA.length < 0x100) return false;
    const peA = bufA.readUInt32LE(0x3c);
    const peB = bufB.readUInt32LE(0x3c);
    if (peA !== peB || peA + 24 + 64 > bufA.length) return false;
    if (bufA.readUInt32LE(peA + 8) !== bufB.readUInt32LE(peB + 8)) return false;
    if (bufA.readUInt32LE(peA + 24 + 56) !== bufB.readUInt32LE(peB + 24 + 56)) return false;
    const tA = parsePeEmbedTemplates(bufA);
    const tB = parsePeEmbedTemplates(bufB);
    const idA = tA.get('system_prompts/identity.tmpl');
    const idB = tB.get('system_prompts/identity.tmpl');
    return Boolean(idA && idB && idA.dataOffset === idB.dataOffset && idA.dataLength === idB.dataLength);
  } catch {
    return false;
  }
}

// ============================================================================
// 自动中文标题等长识别与替换
// ============================================================================

function inspectChineseTitleRules(buf) {
  const details = [];
  let enCount = 0;
  let zhCount = 0;

  for (const rule of CHINESE_TITLE_RULES) {
    const oldBuf = Buffer.from(rule.oldText, 'ascii');
    const newBuf = Buffer.from(rule.newText, 'ascii');
    const oldOff = buf.indexOf(oldBuf);
    const newOff = buf.indexOf(newBuf);

    if (newOff !== -1) {
      zhCount++;
      details.push({ id: rule.id, name: rule.name, state: 'zh', offset: newOff });
    } else if (oldOff !== -1) {
      enCount++;
      details.push({ id: rule.id, name: rule.name, state: 'en', offset: oldOff });
    }
  }

  let mode = 'unsupported';
  if (zhCount > 0 && enCount === 0) mode = 'zh';
  else if (zhCount > 0 && enCount > 0) mode = 'zh';
  else if (enCount > 0) mode = 'en';

  return {
    mode,
    enabled: mode === 'zh',
    matchedCount: zhCount + enCount,
    zhCount,
    enCount,
    details
  };
}

function applyChineseTitlePatchToBuffer(buf, enableZh) {
  const matched = [];
  for (const rule of CHINESE_TITLE_RULES) {
    const oldBuf = Buffer.from(rule.oldText, 'ascii');
    const newBuf = Buffer.from(rule.newText, 'ascii');
    const src = enableZh ? oldBuf : newBuf;
    const dst = enableZh ? newBuf : oldBuf;

    let pos = 0;
    while (true) {
      const idx = buf.indexOf(src, pos);
      if (idx === -1) break;
      dst.copy(buf, idx);
      matched.push({ id: rule.id, offset: idx, enabled: Boolean(enableZh) });
      pos = idx + dst.length;
    }

    if (buf.indexOf(dst) !== -1 && !matched.some((m) => m.id === rule.id)) {
      matched.push({ id: rule.id, offset: buf.indexOf(dst), enabled: Boolean(enableZh) });
    }
  }
  return matched;
}

// ============================================================================
// 增量原位写入与 Windows 运行期安全替换（备份外置在 stateDir 中）
// ============================================================================

function writeChangedRangesInPlace(targetPath, oldBuf, newBuf) {
  if (oldBuf.length !== newBuf.length) {
    throw new Error('原位补丁要求前后二进制字节长度严格一致');
  }
  const fd = fs.openSync(targetPath, 'r+');
  let totalWritten = 0;
  try {
    let i = 0;
    const len = newBuf.length;
    while (i < len) {
      if (oldBuf[i] !== newBuf[i]) {
        const start = i;
        i++;
        while (i < len && oldBuf[i] !== newBuf[i]) i++;
        const slice = newBuf.subarray(start, i);
        fs.writeSync(fd, slice, 0, slice.length, start);
        totalWritten += slice.length;
      } else {
        i++;
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return totalWritten;
}

function countChangedBytes(oldBuf, newBuf) {
  const len = Math.min(oldBuf.length, newBuf.length);
  let diff = Math.abs(oldBuf.length - newBuf.length);
  for (let i = 0; i < len; i++) {
    if (oldBuf[i] !== newBuf[i]) diff++;
  }
  return diff;
}

function writeBinarySafely(targetPath, oldBuf, newBuf) {
  if (Buffer.compare(oldBuf, newBuf) === 0) {
    return { writtenBytes: 0, method: 'unchanged' };
  }

  try {
    const writtenBytes = writeChangedRangesInPlace(targetPath, oldBuf, newBuf);
    return { writtenBytes, method: 'in-place' };
  } catch (inPlaceErr) {
    if (process.platform !== 'win32') {
      throw inPlaceErr;
    }
  }

  const stalePath = `${targetPath}.old_run`;
  const tmpNewPath = `${targetPath}.new_${process.pid}`;
  try {
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  } catch {}

  let renamedOld = false;
  try {
    fs.writeFileSync(tmpNewPath, newBuf);
    fs.renameSync(targetPath, stalePath);
    renamedOld = true;
    fs.renameSync(tmpNewPath, targetPath);
    try {
      fs.unlinkSync(stalePath);
    } catch {}
    return { writtenBytes: countChangedBytes(oldBuf, newBuf), method: 'rename-swap' };
  } catch (swapErr) {
    try {
      if (fs.existsSync(tmpNewPath)) fs.unlinkSync(tmpNewPath);
    } catch {}
    if (renamedOld && !fs.existsSync(targetPath) && fs.existsSync(stalePath)) {
      try {
        fs.renameSync(stalePath, targetPath);
      } catch {}
    }
    throw new Error(`文件正被运行中的后台服务锁定且重命名替换失败（可点击「重启客户端」或退出后重试）: ${swapErr.message}`);
  }
}

function checkLanguageServerRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist.exe', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toLowerCase();
    return (
      out.includes('"language_server.exe"') ||
      out.includes('"language_server_windows_x64.exe"') ||
      out.includes('"agy.exe"')
    );
  } catch {
    return false;
  }
}

function restartLanguageServers() {
  if (process.platform !== 'win32') {
    return { ok: false, killed: [], error: '仅支持 Windows 平台重启后台语言服务' };
  }
  const killed = [];
  for (const img of ['language_server.exe', 'language_server_windows_x64.exe', 'agy.exe']) {
    try {
      execFileSync('taskkill.exe', ['/F', '/IM', img], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      killed.push(img);
    } catch {}
  }
  return { ok: true, killed };
}

function getEnhanceBackupPath(targetPath, options = {}) {
  const dir = options.enhanceBackupDir || path.join(contextUnlock.getUnlockBackupDir(options.backupDir), 'enhance');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const key = path.basename(targetPath).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const legacyBak = `${targetPath}.bak`;
  const managedBak = path.join(dir, `${key}.orig.bak`);
  if (!fs.existsSync(managedBak) && fs.existsSync(legacyBak)) {
    return legacyBak;
  }
  return managedBak;
}

// ============================================================================
// 状态查询与统一协调应用（系统提示词 + 中文标题 + 统一上下文窗口委托）
// ============================================================================

const binaryInspectCache = new Map();

function invalidateBinaryCache(targetPath) {
  if (!targetPath) {
    binaryInspectCache.clear();
    return;
  }
  binaryInspectCache.delete(path.resolve(targetPath).toLowerCase());
}

function inspectSingleBinary(target, options = {}) {
  const exists = fs.existsSync(target.path);
  const bakPath = getEnhanceBackupPath(target.path, options);
  const bakExists = fs.existsSync(bakPath) || fs.existsSync(`${target.path}.bak`);
  const cacheKey = path.resolve(target.path).toLowerCase();

  if (!exists) {
    binaryInspectCache.delete(cacheKey);
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: false,
      bakExists,
      promptTier: 0,
      promptLabel: PROMPT_TIER_META[0].label,
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: CHINESE_TITLE_META.unsupported.label,
      contextUnlock: null,
      totalCapacityBytes: 0,
      activeSlotBytes: 0,
      savedBytes: 0,
      slotCount: 0,
      error: null
    };
  }

  let statSig = null;
  try {
    const st = fs.statSync(target.path);
    const bakMtime = fs.existsSync(bakPath) ? fs.statSync(bakPath).mtimeMs : 0;
    statSig = `${st.size}:${st.mtimeMs}:${bakExists ? 1 : 0}:${bakMtime}`;
    const cached = binaryInspectCache.get(cacheKey);
    if (cached && cached.statSig === statSig && options.forceRefresh !== true) {
      return { ...cached.result, id: target.id, label: target.label, path: target.path };
    }
  } catch {}

  if (options.cachedOnly === true) {
    return null;
  }

  try {
    const buf = fs.readFileSync(target.path);
    const templates = parsePeEmbedTemplates(buf);
    const promptTier = detectPromptTier(templates, buf);
    const titleInfo = inspectChineseTitleRules(buf);

    let totalCapacityBytes = 0;
    let activeSlotBytes = 0;
    for (const s of templates.values()) {
      totalCapacityBytes += s.dataLength;
      activeSlotBytes += s.activeBytes;
    }

    // 委托统一上下文引擎读取当前上下文状态（仅对 desktop / cli 或调用方需要的对象）
    let unlockSummary = null;
    if (target.id === 'desktop' || target.id === 'cli' || target.id === 'custom') {
      try {
        const ua = contextUnlock.analyzeBinary(target.path, { backupDir: options.backupDir });
        unlockSummary = {
          status: ua.status,
          configuredMode: ua.configuredMode,
          configuredLimitTokens: ua.configuredLimitTokens ?? null,
          configuredSummary: ua.configuredSummary || null
        };
      } catch {}
    }

    const result = {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      bakExists,
      fileSizeMb: Number((buf.length / (1024 * 1024)).toFixed(1)),
      promptTier,
      promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
      chineseTitleMode: titleInfo.mode,
      chineseTitleEnabled: titleInfo.mode === 'zh',
      chineseTitleLabel: CHINESE_TITLE_META[titleInfo.mode]?.label || CHINESE_TITLE_META.en.label,
      chineseTitleMatched: titleInfo.matchedCount,
      contextUnlock: unlockSummary,
      totalCapacityBytes,
      activeSlotBytes,
      savedBytes: Math.max(0, totalCapacityBytes - activeSlotBytes),
      slotCount: templates.size,
      error: null
    };
    if (statSig) {
      binaryInspectCache.set(cacheKey, { statSig, result });
    }
    return result;
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      bakExists,
      promptTier: 0,
      promptLabel: '解析失败',
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: '解析失败',
      contextUnlock: null,
      totalCapacityBytes: 0,
      activeSlotBytes: 0,
      savedBytes: 0,
      slotCount: 0,
      error: err.message
    };
  }
}

function getEnhanceStatus(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'win32' || arch !== 'x64')) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: '系统提示词精简与中文标题内核原位补丁目前仅支持 Windows x64 客户端',
      binaries: [],
      summary: null
    };
  }

  const targets = resolveTargetBinaries(options);
  const binaries = [];
  for (const target of targets) {
    const inspected = inspectSingleBinary(target, options);
    if (inspected === null && options.cachedOnly === true) {
      return null;
    }
    binaries.push(inspected);
  }
  const existing = binaries.filter((b) => b.exists && !b.error);
  const desktop = existing.find((b) => b.id === 'desktop') || null;
  const primary = desktop || existing.find((b) => b.id === 'cli') || existing[0] || null;

  const promptTier = primary ? primary.promptTier : 0;
  const chineseTitleMode = primary ? (primary.chineseTitleMode || 'en') : 'en';
  const chineseTitleMeta = CHINESE_TITLE_META[chineseTitleMode] || CHINESE_TITLE_META.en;
  const extCfg = contextUnlock.readExternalContextConfig(options);
  const languageServerRunning = options.skipProcessCheck ? false : checkLanguageServerRunning();

  return {
    ok: true,
    supported: true,
    platform,
    arch,
    binaries,
    promptTiersMeta: PROMPT_TIER_META,
    hallucinationNote: '说明：「防幻觉/精简」仅验证补丁模板已安全写入客户端内核；模板本身不能保证模型在每次回答时不犯错，具体效果需结合真实会话验证。',
    summary: {
      installedCount: existing.length,
      promptTier,
      promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
      promptShortLabel: PROMPT_TIER_META[promptTier]?.shortLabel || '0档原版',
      chineseTitleMode,
      chineseTitleEnabled: chineseTitleMode === 'zh',
      chineseTitleLabel: chineseTitleMeta.label,
      chineseTitleShortLabel: chineseTitleMeta.shortLabel,
      contextUnlock: primary?.contextUnlock || null,
      totalCapacityBytes: primary ? primary.totalCapacityBytes : 0,
      activeSlotBytes: primary ? primary.activeSlotBytes : 0,
      savedBytes: primary ? primary.savedBytes : 0,
      slotCount: primary ? primary.slotCount : 0,
      allBackedUp: existing.length > 0 && existing.every((b) => b.bakExists),
      configContextWindow: extCfg.configContextWindow,
      contextModeBridge: extCfg.contextModeBridge,
      languageServerRunning
    }
  };
}

/**
 * 统一应用提示词档位、中文标题与（可选）统一上下文窗口设置
 */
function applyEnhancePatch(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'win32' || arch !== 'x64')) {
    return { ok: false, error: '当前操作系统或架构不支持 Windows PE64 内核原位补丁' };
  }

  const promptTier = normalizePromptTier(payload.promptTier);
  if (promptTier === undefined) {
    return { ok: false, error: `无效的提示词档位参数: ${payload.promptTier}` };
  }

  const chineseTitle = normalizeChineseTitleMode(payload.chineseTitle);
  if (chineseTitle === undefined) {
    return { ok: false, error: `无效的中文标题补丁参数: ${payload.chineseTitle}` };
  }

  // 若携带 contextMode 或 contextLimitTokens，统一通过 contextUnlock 引擎应用，绝不再维护第二套竞争上下文门禁
  const hasContextRequest = payload.contextMode !== undefined && payload.contextMode !== null && payload.contextMode !== '';
  const restartRequested = payload.restartLanguageServer === true;
  if (promptTier === null && chineseTitle === null && !hasContextRequest && !restartRequested) {
    return { ok: false, error: '未指定要应用的提示词档位、中文标题或上下文设置' };
  }

  // 防止测试/隔离调用错传单数路径键或漏传 targets 时误落至本机真实安装目录
  const typoTargetKey = ['targetPath', 'binPath', 'binaryPath', 'filePath', 'target'].find(
    (k) => (options && options[k]) || (payload && payload[k])
  );
  if (!Array.isArray(options.targets) && typoTargetKey) {
    return {
      ok: false,
      code: 'INVALID_TARGET_OPTION',
      error: `无效的目标参数 "${typoTargetKey}"，隔离写入必须显式使用 options.targets 数组；已拒绝探测系统安装目录`
    };
  }
  const hasIsolationContext = Boolean(
    options.backupDir ||
    options.enhanceBackupDir ||
    options.homeDir ||
    options.stateDir ||
    options.skipProcessCheck ||
    process.env.NODE_TEST_CONTEXT
  );
  if (!Array.isArray(options.targets) && hasIsolationContext && !(options.homeDir && options.localAppData)) {
    return {
      ok: false,
      code: 'MISSING_TARGETS',
      error: '处于测试或隔离调用但未显式指定 options.targets（或成对提供隔离 homeDir/localAppData），已拒绝写入日常客户端'
    };
  }
  if (Array.isArray(options.targets) && options.targets.length === 0) {
    return { ok: false, code: 'MISSING_TARGETS', error: '未提供有效的目标二进制文件 (options.targets 为空)' };
  }

  const targets = resolveTargetBinaries(options).filter((t) => fs.existsSync(t.path));
  if (targets.length === 0) {
    return { ok: false, error: '未检测到本机已安装的 Antigravity 内核文件 (language_server.exe / agy.exe)' };
  }

  const logs = [];
  let needsRestart = false;

  try {
    if (promptTier !== null || chineseTitle !== null) {
      for (const target of targets) {
        const bakPath = getEnhanceBackupPath(target.path, options);
        const origDiskBuf = fs.readFileSync(target.path);
        const curTemplates = parsePeEmbedTemplates(origDiskBuf);
        const curTier = detectPromptTier(curTemplates, origDiskBuf);

        let bakBuf = null;
        if (!fs.existsSync(bakPath)) {
          const cleanStockBuf = Buffer.from(origDiskBuf);
          if (curTier === 0) {
            applyChineseTitlePatchToBuffer(cleanStockBuf, false);
          }
          fs.writeFileSync(bakPath, cleanStockBuf);
          bakBuf = cleanStockBuf;
          logs.push(`[备份] 已创建纯净提示词备份: ${path.basename(bakPath)}`);
        } else {
          const existingBak = fs.readFileSync(bakPath);
          if (isSamePeBuild(origDiskBuf, existingBak)) {
            bakBuf = existingBak;
          } else if (curTier === 0) {
            const cleanStockBuf = Buffer.from(origDiskBuf);
            applyChineseTitlePatchToBuffer(cleanStockBuf, false);
            fs.writeFileSync(bakPath, cleanStockBuf);
            bakBuf = cleanStockBuf;
            logs.push(`[备份刷新] 检测到 ${path.basename(target.path)} 已升级，已刷新备份`);
          } else if (promptTier !== null && (promptTier === 0 || promptTier === 1 || promptTier === 2)) {
            throw new Error(
              `${target.label} 的提示词备份属于旧版本客户端，且当前内核已被修改（处于 ${curTier} 档），无法直接还原原版模板，请先重新安装官方客户端`
            );
          } else {
            bakBuf = origDiskBuf;
          }
        }

        const nextBuf = Buffer.from(origDiskBuf);

        if (promptTier !== null) {
          const pRes = applyPromptTierToBuffer(nextBuf, bakBuf, promptTier);
          logs.push(
            `[提示词] ${target.label} -> ${pRes.label}${pRes.strippedBytes > 0 ? ` (剥离 ${pRes.strippedCount} 个模板, -${pRes.strippedBytes}B)` : ''}`
          );
        }

        if (chineseTitle !== null) {
          const tMatches = applyChineseTitlePatchToBuffer(nextBuf, chineseTitle);
          if (tMatches.length > 0) {
            logs.push(
              `[中文标题] ${target.label} -> ${chineseTitle ? '自动中文标题 (4~10字)' : '官方英文标题'} (处理 ${tMatches.length} 条指令)`
            );
          } else {
            logs.push(`[中文标题] ${target.label} 未包含会话标题生成指令（已跳过）`);
          }
        }

        const writeRes = writeBinarySafely(target.path, origDiskBuf, nextBuf);
        invalidateBinaryCache(target.path);
        if (writeRes.method !== 'unchanged') {
          needsRestart = true;
        }
        logs.push(
          writeRes.method === 'unchanged'
            ? `[无变更] ${path.basename(target.path)} 提示词与标题已处于目标状态`
            : `[写入成功] ${path.basename(target.path)} (${writeRes.method === 'rename-swap' ? '运行期热替换' : '原位写入'} ${writeRes.writtenBytes}B)`
        );
      }
    }

    // 上下文长度统一通过 contextUnlock 应用（支持 desktop 与 cli），不维护第二套上下文重写器
    if (hasContextRequest) {
      const unlockTargets = targets.filter((t) => t.id === 'desktop' || t.id === 'cli' || t.id === 'custom');
      const modeStr = String(payload.contextMode).trim().toLowerCase();
      let unlockOpts;
      if (modeStr === 'default' || modeStr === 'stock' || modeStr === '256k' || modeStr === 'restore') {
        unlockOpts = { mode: 'default' };
      } else if (modeStr === 'dynamic' || modeStr === 'dyn' || modeStr === '983k' || modeStr === 'auto') {
        unlockOpts = { mode: 'dynamic' };
      } else if (modeStr === '512k') {
        unlockOpts = { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 512000 };
      } else if (modeStr === '900k') {
        unlockOpts = { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 900000 };
      } else if (modeStr === 'fixed' || modeStr === 'const' || modeStr === 'custom') {
        unlockOpts = { mode: 'fixed', limitTokens: payload.contextLimitTokens };
      } else {
        throw new Error(`无效的上下文模式参数: ${payload.contextMode}`);
      }

      for (const ut of unlockTargets) {
        if (payload.contextRestoreOptional && typeof contextUnlock.analyzeBinary === 'function') {
          const curCtx = contextUnlock.analyzeBinary(ut.path, {
            backupDir: options.backupDir,
            skipProcessCheck: true
          });
          if (!curCtx || curCtx.status === 'not_patched' || (curCtx.status === 'unsupported' && !curCtx.hasBackup)) {
            logs.push(`[上下文] ${ut.label}: 当前处于默认或未发现上下文门禁特征，无需恢复`);
            continue;
          }
        }
        const res = contextUnlock.applyUnlock({
          ...unlockOpts,
          targetPath: ut.path,
          backupDir: options.backupDir,
          homeDir: options.homeDir,
          stateDir: options.stateDir,
          syncConfigFiles: options.syncConfigFiles !== false && !Array.isArray(options.targets)
        });
        invalidateBinaryCache(ut.path);
        if (!res.ok) {
          throw new Error(`${ut.label} 上下文切换失败: ${res.error}`);
        }
        if (!res.alreadyMatched) needsRestart = true;
        logs.push(`[上下文] ${ut.label}: ${res.message || res.configuredMode}`);
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      logs
    };
  }

  let restarted = false;
  let killedProcesses = [];
  if (restartRequested && !options.skipProcessCheck) {
    const r = restartLanguageServers();
    restarted = r.ok;
    killedProcesses = r.killed || [];
    logs.push(
      killedProcesses.length > 0
        ? `[服务重启] 已重启后台语言服务 (${killedProcesses.join(', ')})，新配置将在下次会话/请求时加载`
        : '[服务重启] 当前无运行中的独立语言服务进程'
    );
  }

  const status = getEnhanceStatus({ ...options, forceRefresh: true });
  return {
    ok: true,
    needsRestart,
    restarted,
    killedProcesses,
    logs,
    status
  };
}

function restoreAllEnhance(options = {}) {
  return applyEnhancePatch(
    { promptTier: 0, chineseTitle: false, contextMode: 'default', contextRestoreOptional: true },
    options
  );
}

module.exports = {
  PROMPT_TIER_META,
  CHINESE_TITLE_META,
  CHINESE_TITLE_RULES,
  TIER3_GUIDELINES,
  TIER3_FUNCTION_CALL,
  TIER3_COMMUNICATION_STYLE,
  TIER4_GUIDELINES,
  TIER4_FUNCTION_CALL,
  TIER4_COMMUNICATION_STYLE,
  normalizePromptTier,
  normalizeChineseTitleMode,
  resolveTargetBinaries,
  parsePeEmbedTemplates,
  isSamePeBuild,
  writePaddedTemplate,
  detectPromptTier,
  inspectChineseTitleRules,
  applyPromptTierToBuffer,
  applyChineseTitlePatchToBuffer,
  getEnhanceStatus,
  applyEnhancePatch,
  restoreAllEnhance,
  restartLanguageServers,
  invalidateBinaryCache
};

