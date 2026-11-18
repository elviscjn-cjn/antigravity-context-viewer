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
const { execFile, execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const contextUnlock = require('./meter-context-unlock');
const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
const {
  isMachO64Buffer,
  parseMachO64,
  getMachODataSearchRanges,
  atomicWriteMachOBinarySync,
  atomicWriteMachOBinaryAsync,
  isExactMacLanguageServerProcess,
  listMacProcessesSync,
  listMacProcessesAsync
} = require('./macos-binary-utils');

const { performance } = require('perf_hooks');
const ORIG_ENHANCE_FS_READ_SYNC = fs.readFileSync;
const ORIG_ENHANCE_FS_READ_ASYNC = fs.promises.readFile;

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

function resolveStandaloneAgyPath(localAppData, homeDir, platform = process.platform) {
  const home = homeDir || os.homedir();
  if (platform === 'darwin') {
    const macCandidates = [
      path.join(home, '.local', 'bin', 'agy'),
      path.join(home, '.gemini', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy'
    ];
    for (const c of macCandidates) {
      if (fs.existsSync(c)) return c;
    }
    return macCandidates[0];
  }

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
  const home = options.homeDir || os.homedir();

  if (platform === 'darwin') {
    const macDesktopCandidates = [
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
      '/Applications/Antigravity IDE.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'bin', 'language_server'),
      '/Applications/Google Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Google Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server')
    ];
    const desktopPath = macDesktopCandidates.find((p) => fs.existsSync(p)) || macDesktopCandidates[0];
    const cliPath = resolveStandaloneAgyPath('', home, 'darwin');
    const targets = [
      { id: 'desktop', label: 'Antigravity 桌面端内核 (language_server)', path: desktopPath }
    ];
    if (cliPath && fs.existsSync(cliPath)) {
      targets.push({ id: 'cli', label: 'Antigravity 独立 CLI 内核 (agy)', path: cliPath });
    }
    return targets;
  }

  if (platform !== 'win32') {
    return [];
  }

  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const desktopPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
  const standalonePath = resolveStandaloneAgyPath(localAppData, home, 'win32');
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
  // writePaddedTemplate 仅在尾部写入空白 Go 注释 "{{- /*   */ -}}"，官方 identity.tmpl 首尾含非空白 LINT.IfChange 注释不可误判为已剥离
  const match = rawStr.match(/\{\{- \/\*\s*\*\/ -\}\}\s*$/);
  if (match && typeof match.index === 'number') {
    const activeBytes = Buffer.byteLength(rawStr.slice(0, match.index), 'utf8');
    return { activeBytes, isStripped: match.index === 0 };
  }
  return { activeBytes: Buffer.byteLength(rawStr, 'utf8'), isStripped: false };
}

/**
 * 提取 PE64 构建指纹与只读数据区段偏移范围（避免对 .text 等代码节反复全文件扫描）
 */
function parsePeSectionSummary(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null;
  if (isMachO64Buffer(buf)) {
    const macho = parseMachO64(buf);
    if (!macho) return null;
    return {
      peBuildKey: macho.buildKey,
      format: 'Mach-O',
      arch: macho.arch,
      sections: macho.sections
    };
  }
  if (buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') {
    return null;
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\x00\x00') {
    return null;
  }
  if (buf.readUInt16LE(peOffset + 4) !== 0x8664) {
    return null;
  }
  const numSections = buf.readUInt16LE(peOffset + 6);
  const timeDateStamp = buf.readUInt32LE(peOffset + 8);
  const optSize = buf.readUInt16LE(peOffset + 20);
  const optStart = peOffset + 24;
  if (optSize < 64 || optStart + optSize > buf.length) {
    return null;
  }
  const sizeOfImage = buf.readUInt32LE(optStart + 56);
  const sectionTableStart = optStart + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = sectionTableStart + i * 40;
    if (off + 40 > buf.length) break;
    const name = buf.subarray(off, off + 8).toString('ascii').replace(/\0.*$/, '');
    const vSize = buf.readUInt32LE(off + 8);
    const vAddr = buf.readUInt32LE(off + 12);
    const rawSize = buf.readUInt32LE(off + 16);
    const rawPtr = buf.readUInt32LE(off + 20);
    const characteristics = buf.readUInt32LE(off + 36);
    sections.push({ name, vSize, vAddr, rawSize, rawPtr, characteristics });
  }
  return {
    peBuildKey: `${timeDateStamp}:${sizeOfImage}:${buf.length}`,
    timeDateStamp,
    sizeOfImage,
    sections
  };
}

function getPeDataSearchRanges(buf) {
  if (isMachO64Buffer(buf)) {
    return getMachODataSearchRanges(buf);
  }
  const pe = parsePeSectionSummary(buf);
  if (!pe || !pe.sections.length) {
    return [{ start: 0, end: buf.length }];
  }
  // 标题字符串常量位于非代码可读区段（优先 .rdata/.data/.rodata），排除可执行 .text 代码段可减少 60%+ 扫描
  const preferred = [];
  for (const s of pe.sections) {
    if (s.rawSize <= 0 || s.rawPtr <= 0 || s.rawPtr >= buf.length) continue;
    const isCode = Boolean(s.characteristics & 0x00000020) && s.name === '.text';
    if (!isCode && (s.name === '.rdata' || s.name === '.rodata' || s.name === '.data')) {
      preferred.push({ start: s.rawPtr, end: Math.min(buf.length, s.rawPtr + s.rawSize) });
    }
  }
  return preferred.length > 0 ? preferred : [{ start: 0, end: buf.length }];
}

function parsePeEmbedTemplates(buf) {
  let fileOffsetToVA;
  let vaToFileOffset;

  if (isMachO64Buffer(buf)) {
    const macho = parseMachO64(buf);
    if (!macho || !macho.arch) {
      throw new Error('不是有效的 64 位 Mach-O 可执行文件（或头部/段偏移损坏）');
    }
    if (macho.arch !== 'arm64') {
      throw new Error(`暂未开放对 Intel Mac (Mach-O ${macho.arch}) 的内核修改，当前 macOS 仅完成 Apple Silicon (arm64) 验证`);
    }
    fileOffsetToVA = macho.fileOffsetToVA;
    vaToFileOffset = macho.vaToFileOffset;
  } else {
    if (!Buffer.isBuffer(buf) || buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('不是有效的 Windows PE64 或 macOS Mach-O 可执行文件');
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

    fileOffsetToVA = (foff) => {
      for (const s of sections) {
        if (foff >= s.rawPtr && foff < s.rawPtr + s.rawSize) {
          return imageBase + BigInt(s.vAddr + (foff - s.rawPtr));
        }
      }
      return 0n;
    };

    vaToFileOffset = (va) => {
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
  }

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

function writePaddedTemplate(buf, slot, newText, dirtyRanges = null) {
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
  if (Array.isArray(dirtyRanges) && slot.dataLength > 0) {
    dirtyRanges.push({ start: slot.dataOffset, length: slot.dataLength });
  }
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

function applyPromptTierToBuffer(buf, bakBuf, tierNum, dirtyRanges = null) {
  const curTemplates = parsePeEmbedTemplates(buf);
  const bakTemplates = parsePeEmbedTemplates(bakBuf);

  // 先从备份还原全部系统提示词槽位，确保任意档位切换无残留（相等切片跳过复制）
  for (const [name, bakSlot] of bakTemplates.entries()) {
    const curSlot = curTemplates.get(name);
    if (curSlot && bakSlot.dataOffset === curSlot.dataOffset && bakSlot.dataLength === curSlot.dataLength && bakSlot.dataLength > 0) {
      const dstSlice = buf.subarray(curSlot.dataOffset, curSlot.dataOffset + curSlot.dataLength);
      const srcSlice = bakBuf.subarray(bakSlot.dataOffset, bakSlot.dataOffset + bakSlot.dataLength);
      if (!dstSlice.equals(srcSlice)) {
        srcSlice.copy(buf, curSlot.dataOffset);
        if (Array.isArray(dirtyRanges)) {
          dirtyRanges.push({ start: curSlot.dataOffset, length: bakSlot.dataLength });
        }
      }
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
          if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: tailOff, length: 10 });
        }
      }
    }
  } else if (tierNum === 1) {
    for (const name of AD_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '', dirtyRanges);
        strippedBytes += slot.dataLength;
        strippedCount++;
      }
    }
  } else if (tierNum === 2 || tierNum === 3 || tierNum === 4) {
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '', dirtyRanges);
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
      writePaddedTemplate(buf, gSlot, tierNum === 3 ? TIER3_GUIDELINES : TIER4_GUIDELINES, dirtyRanges);
      writePaddedTemplate(buf, fSlot, tierNum === 3 ? TIER3_FUNCTION_CALL : TIER4_FUNCTION_CALL, dirtyRanges);
      writePaddedTemplate(buf, cSlot, tierNum === 3 ? TIER3_COMMUNICATION_STYLE : TIER4_COMMUNICATION_STYLE, dirtyRanges);
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
        if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: tailOff, length: 10 });
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
    if (isMachO64Buffer(bufA) && isMachO64Buffer(bufB)) {
      const mA = parseMachO64(bufA);
      const mB = parseMachO64(bufB);
      if (!mA || !mB || mA.buildKey !== mB.buildKey) return false;
      const tA = parsePeEmbedTemplates(bufA);
      const tB = parsePeEmbedTemplates(bufB);
      const idA = tA.get('system_prompts/identity.tmpl');
      const idB = tB.get('system_prompts/identity.tmpl');
      return Boolean(idA && idB && idA.dataOffset === idB.dataOffset && idA.dataLength === idB.dataLength);
    }
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

function findInRanges(buf, needleBuf, ranges) {
  for (const r of ranges) {
    const idx = buf.indexOf(needleBuf, r.start);
    if (idx !== -1 && idx + needleBuf.length <= r.end) {
      return idx;
    }
  }
  return -1;
}

function inspectChineseTitleRules(buf) {
  const ranges = getPeDataSearchRanges(buf);
  const fullFallback = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === buf.length;
  const details = [];
  let enCount = 0;
  let zhCount = 0;

  const scan = (scanRanges) => {
    details.length = 0;
    enCount = 0;
    zhCount = 0;
    for (const rule of CHINESE_TITLE_RULES) {
      const oldBuf = Buffer.from(rule.oldText, 'ascii');
      const newBuf = Buffer.from(rule.newText, 'ascii');
      const newOff = findInRanges(buf, newBuf, scanRanges);
      const oldOff = newOff === -1 ? findInRanges(buf, oldBuf, scanRanges) : -1;

      if (newOff !== -1) {
        zhCount++;
        details.push({ id: rule.id, name: rule.name, state: 'zh', offset: newOff });
      } else if (oldOff !== -1) {
        enCount++;
        details.push({ id: rule.id, name: rule.name, state: 'en', offset: oldOff });
      }
    }
  };

  scan(ranges);
  if (!fullFallback && zhCount + enCount === 0) {
    scan([{ start: 0, end: buf.length }]);
  }

  let mode = 'unsupported';
  if (zhCount > 0 && enCount === 0) mode = 'zh';
  else if (zhCount > 0 && enCount > 0) mode = 'mixed';
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

function applyChineseTitlePatchToBuffer(buf, enableZh, dirtyRanges = null) {
  const ranges = getPeDataSearchRanges(buf);
  const fullFallback = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === buf.length;

  const applyOnRanges = (scanRanges) => {
    const matched = [];
    for (const rule of CHINESE_TITLE_RULES) {
      const oldBuf = Buffer.from(rule.oldText, 'ascii');
      const newBuf = Buffer.from(rule.newText, 'ascii');
      const src = enableZh ? oldBuf : newBuf;
      const dst = enableZh ? newBuf : oldBuf;

      for (const r of scanRanges) {
        let pos = r.start;
        while (pos < r.end) {
          const idx = buf.indexOf(src, pos);
          if (idx === -1 || idx + src.length > r.end) break;
          dst.copy(buf, idx);
          if (Array.isArray(dirtyRanges)) {
            dirtyRanges.push({ start: idx, length: dst.length });
          }
          matched.push({ id: rule.id, offset: idx, enabled: Boolean(enableZh) });
          pos = idx + dst.length;
        }
      }

      if (!matched.some((m) => m.id === rule.id)) {
        const dstIdx = findInRanges(buf, dst, scanRanges);
        if (dstIdx !== -1) {
          matched.push({ id: rule.id, offset: dstIdx, enabled: Boolean(enableZh) });
        }
      }
    }
    return matched;
  };

  let matched = applyOnRanges(ranges);
  if (!fullFallback && matched.length === 0) {
    matched = applyOnRanges([{ start: 0, end: buf.length }]);
  }
  return matched;
}

// ============================================================================
// 增量原位写入与 Windows 运行期安全替换（备份外置在 stateDir 中）
// ============================================================================

function mergeDirtyRanges(dirtyRanges, totalLen) {
  if (!Array.isArray(dirtyRanges) || dirtyRanges.length === 0) return [];
  const norm = dirtyRanges
    .map((r) => {
      const s = Math.max(0, Number(r.start) || 0);
      const e = Math.min(totalLen, s + Math.max(0, Number(r.length) || 0));
      return s < e ? { start: s, end: e } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  if (norm.length === 0) return [];
  const merged = [norm[0]];
  for (let i = 1; i < norm.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = norm[i];
    if (cur.start <= prev.end + 64) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function getEffectiveDiffRanges(oldBuf, newBuf, dirtyRanges = null) {
  if (Array.isArray(dirtyRanges)) {
    const merged = mergeDirtyRanges(dirtyRanges, newBuf.length);
    const diffs = [];
    for (const r of merged) {
      if (!oldBuf.subarray(r.start, r.end).equals(newBuf.subarray(r.start, r.end))) {
        let s = r.start;
        let e = r.end;
        while (s < e && oldBuf[s] === newBuf[s]) s++;
        while (e > s && oldBuf[e - 1] === newBuf[e - 1]) e--;
        if (s < e) diffs.push({ start: s, end: e });
      }
    }
    return diffs;
  }
  return null;
}

function writeChangedRangesInPlace(targetPath, oldBuf, newBuf, precomputedDiffs = null) {
  if (oldBuf.length !== newBuf.length) {
    throw new Error('原位补丁要求前后二进制字节长度严格一致');
  }
  const fd = fs.openSync(targetPath, 'r+');
  let totalWritten = 0;
  try {
    if (Array.isArray(precomputedDiffs)) {
      for (const r of precomputedDiffs) {
        const slice = newBuf.subarray(r.start, r.end);
        fs.writeSync(fd, slice, 0, slice.length, r.start);
        totalWritten += slice.length;
      }
    } else {
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
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return totalWritten;
}

function countChangedBytes(oldBuf, newBuf, precomputedDiffs = null) {
  if (Array.isArray(precomputedDiffs)) {
    let diff = 0;
    for (const r of precomputedDiffs) {
      for (let i = r.start; i < r.end; i++) {
        if (oldBuf[i] !== newBuf[i]) diff++;
      }
    }
    return diff;
  }
  const len = Math.min(oldBuf.length, newBuf.length);
  let diff = Math.abs(oldBuf.length - newBuf.length);
  for (let i = 0; i < len; i++) {
    if (oldBuf[i] !== newBuf[i]) diff++;
  }
  return diff;
}

function writeBinarySafely(targetPath, oldBuf, newBuf, dirtyRanges = null, writeOpts = {}) {
  let diffs = null;
  if (Array.isArray(dirtyRanges) && oldBuf.length === newBuf.length) {
    diffs = getEffectiveDiffRanges(oldBuf, newBuf, dirtyRanges);
    if (diffs.length === 0) return { writtenBytes: 0, method: 'unchanged' };
  } else if (Buffer.compare(oldBuf, newBuf) === 0) {
    return { writtenBytes: 0, method: 'unchanged' };
  }

  if (isMachO64Buffer(newBuf)) {
    atomicWriteMachOBinarySync(targetPath, newBuf, {
      entitlementsSourcePath: writeOpts.entitlementsSourcePath || targetPath,
      skipCodesign: writeOpts.skipCodesign === true,
      forceCodesign: writeOpts.forceCodesign === true,
      codesignBin: writeOpts.codesignBin,
      _execFileSync: writeOpts._execFileSync
    });
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
  }

  try {
    const writtenBytes = writeChangedRangesInPlace(targetPath, oldBuf, newBuf, diffs);
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
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
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

async function writeChangedRangesInPlaceAsync(targetPath, oldBuf, newBuf, precomputedDiffs = null) {
  if (oldBuf.length !== newBuf.length) {
    throw new Error('原位补丁要求前后二进制字节长度严格一致');
  }
  const fh = await fs.promises.open(targetPath, 'r+');
  let totalWritten = 0;
  try {
    if (Array.isArray(precomputedDiffs)) {
      for (const r of precomputedDiffs) {
        const slice = newBuf.subarray(r.start, r.end);
        await fh.write(slice, 0, slice.length, r.start);
        totalWritten += slice.length;
      }
    } else {
      let i = 0;
      const len = newBuf.length;
      while (i < len) {
        if (oldBuf[i] !== newBuf[i]) {
          const start = i;
          i++;
          while (i < len && oldBuf[i] !== newBuf[i]) i++;
          const slice = newBuf.subarray(start, i);
          await fh.write(slice, 0, slice.length, start);
          totalWritten += slice.length;
        } else {
          i++;
        }
      }
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  return totalWritten;
}

async function writeBinarySafelyAsync(targetPath, oldBuf, newBuf, dirtyRanges = null, writeOpts = {}) {
  let diffs = null;
  if (Array.isArray(dirtyRanges) && oldBuf.length === newBuf.length) {
    diffs = getEffectiveDiffRanges(oldBuf, newBuf, dirtyRanges);
    if (diffs.length === 0) return { writtenBytes: 0, method: 'unchanged' };
  } else if (Buffer.compare(oldBuf, newBuf) === 0) {
    return { writtenBytes: 0, method: 'unchanged' };
  }

  if (isMachO64Buffer(newBuf)) {
    await atomicWriteMachOBinaryAsync(targetPath, newBuf, {
      entitlementsSourcePath: writeOpts.entitlementsSourcePath || targetPath,
      skipCodesign: writeOpts.skipCodesign === true,
      forceCodesign: writeOpts.forceCodesign === true,
      codesignBin: writeOpts.codesignBin,
      _execFile: writeOpts._execFile
    });
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
  }

  try {
    const writtenBytes = await writeChangedRangesInPlaceAsync(targetPath, oldBuf, newBuf, diffs);
    return { writtenBytes, method: 'in-place' };
  } catch (inPlaceErr) {
    if (process.platform !== 'win32') {
      throw inPlaceErr;
    }
  }

  const stalePath = `${targetPath}.old_run`;
  const tmpNewPath = `${targetPath}.new_${process.pid}`;
  try {
    if (fs.existsSync(stalePath)) await fs.promises.unlink(stalePath);
  } catch {}

  let renamedOld = false;
  try {
    await fs.promises.writeFile(tmpNewPath, newBuf);
    await fs.promises.rename(targetPath, stalePath);
    renamedOld = true;
    await fs.promises.rename(tmpNewPath, targetPath);
    try {
      await fs.promises.unlink(stalePath);
    } catch {}
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
  } catch (swapErr) {
    try {
      if (fs.existsSync(tmpNewPath)) await fs.promises.unlink(tmpNewPath);
    } catch {}
    if (renamedOld && !fs.existsSync(targetPath) && fs.existsSync(stalePath)) {
      try {
        await fs.promises.rename(stalePath, targetPath);
      } catch {}
    }
    throw new Error(`文件正被运行中的后台服务锁定且重命名替换失败（可点击「重启客户端」或退出后重试）: ${swapErr.message}`);
  }
}

let lsProcCache = { ts: 0, running: false, startTimeMs: null };

function checkLanguageServerRunning() {
  if (process.platform === 'darwin') {
    const procs = listMacProcessesSync();
    return procs.some((p) => isExactMacLanguageServerProcess(p.path));
  }
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

async function checkLanguageServerRunningAsync(options = {}) {
  if ((process.platform !== 'win32' && process.platform !== 'darwin') || options.skipProcessCheck) {
    return { running: false, startTimeMs: null };
  }
  const now = Date.now();
  if (options.forceRefresh !== true && now - lsProcCache.ts < 1500) {
    return { running: lsProcCache.running, startTimeMs: lsProcCache.startTimeMs };
  }
  const targets = resolveTargetBinaries(options).filter((t) => fs.existsSync(t.path));
  let running = false;
  let earliestStartMs = null;
  if (process.platform === 'darwin') {
    const procs = await listMacProcessesAsync();
    const targetPaths = new Set(targets.map((t) => path.resolve(t.path)));
    for (const p of procs) {
      if (targetPaths.has(path.resolve(p.path))) {
        running = true;
        if (p.startTimeMs && (!earliestStartMs || p.startTimeMs < earliestStartMs)) {
          earliestStartMs = p.startTimeMs;
        }
      }
    }
  } else {
    for (const t of targets) {
      try {
        const info = await contextUnlock.getRunningLanguageServerInfoAsync(t.path, options.forceRefresh === true);
        if (info && info.isRunning) {
          running = true;
          if (info.startTimeMs && (!earliestStartMs || info.startTimeMs < earliestStartMs)) {
            earliestStartMs = info.startTimeMs;
          }
        }
      } catch {}
    }
  }
  lsProcCache = { ts: Date.now(), running, startTimeMs: earliestStartMs };
  return { running, startTimeMs: earliestStartMs };
}

function restartLanguageServers(options = {}) {
  const includeCli = options?.includeCli !== false;
  if (process.platform === 'darwin') {
    const procs = listMacProcessesSync();
    const killed = [];
    for (const p of procs) {
      if (isExactMacLanguageServerProcess(p.path)) {
        try {
          process.kill(p.pid, 'SIGTERM');
          killed.push(`${path.basename(p.path)}#${p.pid}`);
        } catch {}
      }
    }
    lsProcCache = { ts: 0, running: false, startTimeMs: null };
    return { ok: true, killed };
  }
  if (process.platform !== 'win32') {
    return { ok: false, killed: [], error: '仅支持 Windows / macOS 平台重启后台语言服务' };
  }
  const images = includeCli
    ? ['language_server.exe', 'language_server_windows_x64.exe', 'agy.exe']
    : ['language_server.exe', 'language_server_windows_x64.exe'];
  const killed = [];
  for (const img of images) {
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
  lsProcCache = { ts: 0, running: false, startTimeMs: null };
  return { ok: true, killed };
}

async function restartLanguageServersAsync(options = {}) {
  const includeCli = options?.includeCli !== false;
  if (process.platform === 'darwin') {
    const procs = await listMacProcessesAsync();
    const killed = [];
    for (const p of procs) {
      if (isExactMacLanguageServerProcess(p.path)) {
        try {
          process.kill(p.pid, 'SIGTERM');
          killed.push(`${path.basename(p.path)}#${p.pid}`);
        } catch {}
      }
    }
    lsProcCache = { ts: 0, running: false, startTimeMs: null };
    return { ok: true, killed };
  }
  if (process.platform !== 'win32') {
    return { ok: false, killed: [], error: '仅支持 Windows / macOS 平台重启后台语言服务' };
  }
  const images = includeCli
    ? ['language_server.exe', 'language_server_windows_x64.exe', 'agy.exe']
    : ['language_server.exe', 'language_server_windows_x64.exe'];
  const killed = [];
  await Promise.all(images.map((img) => new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', '/IM', img], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    }, (err) => {
      if (!err) killed.push(img);
      resolve();
    });
  })));
  lsProcCache = { ts: 0, running: false, startTimeMs: null };
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

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function canPersistEnhancePreference(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) return true;
  if (options && options.homeDir && options.localAppData) return true;
  const hasIsolationContext = Boolean(
    options.backupDir ||
    options.enhanceBackupDir ||
    options.homeDir ||
    options.skipProcessCheck ||
    Array.isArray(options.targets) ||
    process.env.NODE_TEST_CONTEXT
  );
  return !hasIsolationContext;
}

function readSavedEnhancePreference(options = {}) {
  if (!canPersistEnhancePreference(options)) {
    return null;
  }
  try {
    const cfg = loadModulesConfig(options);
    const enh = cfg?.modules?.enhance;
    if (!enh || typeof enh !== 'object') return null;
    const promptTier = [0, 1, 2, 3, 4].includes(enh.promptTier) ? enh.promptTier : null;
    const chineseTitle = typeof enh.chineseTitle === 'boolean' ? enh.chineseTitle : null;
    if (promptTier === null && chineseTitle === null && !enh.lastAppliedAt) {
      return null;
    }
    return {
      promptTier,
      chineseTitle,
      lastAppliedAt: enh.lastAppliedAt || null,
      targetBuilds: Object.assign({}, enh.targetBuilds || {})
    };
  } catch {
    return null;
  }
}

function saveSavedEnhancePreference(pref, options = {}) {
  if (!canPersistEnhancePreference(options)) {
    return false;
  }
  try {
    const cfg = loadModulesConfig(options);
    const prev = cfg.modules.enhance || {};
    const mergedBuilds = Object.assign({}, prev.targetBuilds || {}, pref.targetBuilds || {});
    cfg.modules.enhance = {
      promptTier: [0, 1, 2, 3, 4].includes(pref.promptTier) ? pref.promptTier : (prev.promptTier ?? null),
      chineseTitle: typeof pref.chineseTitle === 'boolean' ? pref.chineseTitle : (typeof prev.chineseTitle === 'boolean' ? prev.chineseTitle : null),
      lastAppliedAt: pref.lastAppliedAt || new Date().toISOString(),
      targetBuilds: mergedBuilds
    };
    saveModulesConfig(cfg, options);
    return true;
  } catch {
    return false;
  }
}

function buildInspectedResultFromBuffer(target, buf, st, bakExists, statSig, unlockSummary) {
  const templates = parsePeEmbedTemplates(buf);
  const promptTier = detectPromptTier(templates, buf);
  const titleInfo = inspectChineseTitleRules(buf);
  const peSummary = parsePeSectionSummary(buf);

  let totalCapacityBytes = 0;
  let activeSlotBytes = 0;
  for (const s of templates.values()) {
    totalCapacityBytes += s.dataLength;
    activeSlotBytes += s.activeBytes;
  }

  const result = {
    id: target.id,
    label: target.label,
    path: target.path,
    exists: true,
    bakExists,
    fileSizeMb: Number((buf.length / (1024 * 1024)).toFixed(1)),
    fileMtimeMs: st ? st.mtimeMs : 0,
    peBuildKey: peSummary ? peSummary.peBuildKey : null,
    promptTier,
    promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
    chineseTitleMode: titleInfo.mode,
    chineseTitleEnabled: titleInfo.mode === 'zh',
    chineseTitleLabel: CHINESE_TITLE_META[titleInfo.mode]?.label || CHINESE_TITLE_META.en.label,
    chineseTitleMatched: titleInfo.matchedCount,
    contextUnlock: unlockSummary || null,
    totalCapacityBytes,
    activeSlotBytes,
    savedBytes: Math.max(0, totalCapacityBytes - activeSlotBytes),
    slotCount: templates.size,
    error: null
  };
  if (statSig) {
    binaryInspectCache.set(path.resolve(target.path).toLowerCase(), { statSig, result });
  }
  return result;
}

function makeMissingBinaryResult(target, bakExists) {
  return {
    id: target.id,
    label: target.label,
    path: target.path,
    exists: false,
    bakExists,
    fileMtimeMs: 0,
    peBuildKey: null,
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

function makeErrorBinaryResult(target, bakExists, err) {
  return {
    id: target.id,
    label: target.label,
    path: target.path,
    exists: true,
    bakExists,
    fileMtimeMs: 0,
    peBuildKey: null,
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

function inspectSingleBinary(target, options = {}) {
  const exists = fs.existsSync(target.path);
  const bakPath = getEnhanceBackupPath(target.path, options);
  const bakExists = fs.existsSync(bakPath) || fs.existsSync(`${target.path}.bak`);
  const cacheKey = path.resolve(target.path).toLowerCase();

  if (!exists) {
    binaryInspectCache.delete(cacheKey);
    return makeMissingBinaryResult(target, bakExists);
  }

  let st = null;
  let statSig = null;
  try {
    st = fs.statSync(target.path);
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
    return buildInspectedResultFromBuffer(target, buf, st, bakExists, statSig, unlockSummary);
  } catch (err) {
    return makeErrorBinaryResult(target, bakExists, err);
  }
}

async function inspectSingleBinaryAsync(target, options = {}) {
  const exists = fs.existsSync(target.path);
  const bakPath = getEnhanceBackupPath(target.path, options);
  const bakExists = fs.existsSync(bakPath) || fs.existsSync(`${target.path}.bak`);
  const cacheKey = path.resolve(target.path).toLowerCase();

  if (!exists) {
    binaryInspectCache.delete(cacheKey);
    return makeMissingBinaryResult(target, bakExists);
  }

  let st = null;
  let statSig = null;
  try {
    st = await fs.promises.stat(target.path);
    const bakMtime = fs.existsSync(bakPath) ? (await fs.promises.stat(bakPath)).mtimeMs : 0;
    statSig = `${st.size}:${st.mtimeMs}:${bakExists ? 1 : 0}:${bakMtime}`;
    const cached = binaryInspectCache.get(cacheKey);
    if (cached && cached.statSig === statSig && options.forceRefresh !== true) {
      return { ...cached.result, id: target.id, label: target.label, path: target.path };
    }
  } catch {}

  if (options.cachedOnly === true) {
    return null;
  }

  if (canUseEnhanceWorker(options)) {
    const wRes = await runEnhanceWorkerTask('inspect', {
      target,
      options: sanitizeEnhanceWorkerOptions(options)
    });
    if (wRes && wRes._workerHandled && wRes.result) {
      if (wRes.result.statSig && wRes.result.inspected && !wRes.result.inspected.error) {
        binaryInspectCache.set(cacheKey, { statSig: wRes.result.statSig, result: wRes.result.inspected });
      }
      return wRes.result.inspected;
    }
  }

  try {
    const buf = await fs.promises.readFile(target.path);
    let unlockSummary = null;
    if (target.id === 'desktop' || target.id === 'cli' || target.id === 'custom') {
      try {
        const ua = await contextUnlock.analyzeBinaryAsync(target.path, {
          backupDir: options.backupDir,
          preloadedBuf: buf,
          preloadedStats: st,
          skipSha256: true,
          skipProcessCheck: true,
          forceRefresh: options.forceRefresh === true
        });
        unlockSummary = {
          status: ua.status,
          configuredMode: ua.configuredMode,
          configuredLimitTokens: ua.configuredLimitTokens ?? null,
          configuredSummary: ua.configuredSummary || null
        };
      } catch {}
    }
    await yieldEventLoop();
    return buildInspectedResultFromBuffer(target, buf, st, bakExists, statSig, unlockSummary);
  } catch (err) {
    return makeErrorBinaryResult(target, bakExists, err);
  }
}

function finalizeEnhanceStatus(platform, arch, binaries, procInfo, options = {}) {
  const existing = binaries.filter((b) => b.exists && !b.error);
  const failedTargets = binaries.filter((b) => b.exists && b.error);
  const desktop = existing.find((b) => b.id === 'desktop') || null;
  const primary = desktop || existing.find((b) => b.id === 'cli') || existing[0] || null;

  const promptTier = primary ? primary.promptTier : 0;
  const chineseTitleMode = primary ? (primary.chineseTitleMode || 'en') : 'en';
  const chineseTitleMeta = CHINESE_TITLE_META[chineseTitleMode] || CHINESE_TITLE_META.en;
  const extCfg = contextUnlock.readExternalContextConfig(options);
  const savedConfig = readSavedEnhancePreference(options);

  const targetsConsistent = existing.length <= 1 || existing.every(
    (b) => b.promptTier === promptTier && b.chineseTitleMode === chineseTitleMode
  );

  // 分析磁盘状态、保存配置、PE 构建升级与进程启动时间的关系
  const languageServerRunning = Boolean(procInfo?.running);
  const processStartTimeMs = procInfo?.startTimeMs || null;
  const maxFileMtimeMs = existing.reduce((m, b) => Math.max(m, Number(b.fileMtimeMs || 0)), 0);
  const appliedAtMs = savedConfig?.lastAppliedAt ? Date.parse(savedConfig.lastAppliedAt) : 0;

  let clientUpdatedSinceSave = false;
  if (savedConfig && savedConfig.targetBuilds && existing.length > 0) {
    for (const b of existing) {
      const prevBuild = savedConfig.targetBuilds[b.id];
      if (prevBuild && b.peBuildKey && prevBuild !== b.peBuildKey) {
        clientUpdatedSinceSave = true;
        break;
      }
    }
  }

  let matchesSaved = false;
  if (savedConfig) {
    const tierOk = savedConfig.promptTier === null || savedConfig.promptTier === promptTier;
    const titleOk = savedConfig.chineseTitle === null || savedConfig.chineseTitle === (chineseTitleMode === 'zh');
    matchesSaved = tierOk && titleOk && targetsConsistent && failedTargets.length === 0;
  }

  const writeRefMs = Math.max(maxFileMtimeMs, Number.isFinite(appliedAtMs) ? appliedAtMs : 0);
  const pendingLsRestart = Boolean(
    languageServerRunning &&
    processStartTimeMs &&
    writeRefMs > 0 &&
    (promptTier > 0 || chineseTitleMode === 'zh' || savedConfig) &&
    processStartTimeMs < writeRefMs - 500
  );

  let syncState = 'stock';
  if (failedTargets.length > 0 || !targetsConsistent || chineseTitleMode === 'mixed') {
    syncState = 'partial_mismatch';
  } else if (savedConfig && !matchesSaved) {
    syncState = clientUpdatedSinceSave ? 'client_updated_mismatch' : 'saved_disk_mismatch';
  } else if (pendingLsRestart) {
    syncState = 'pending_ls_restart';
  } else if (savedConfig && matchesSaved) {
    syncState = (languageServerRunning && processStartTimeMs && processStartTimeMs >= writeRefMs - 500)
      ? 'runtime_confirmed'
      : 'applied_saved';
  } else if (promptTier > 0 || chineseTitleMode === 'zh') {
    syncState = (languageServerRunning && processStartTimeMs && maxFileMtimeMs > 0 && processStartTimeMs >= maxFileMtimeMs - 500)
      ? 'runtime_confirmed'
      : 'disk_only_patched';
  }

  return {
    ok: true,
    supported: true,
    platform,
    arch,
    binaries,
    promptTiersMeta: PROMPT_TIER_META,
    hallucinationNote: '说明：「防幻觉/精简」仅验证补丁模板已安全写入客户端内核；模板本身不能保证模型在每次回答时不犯错，具体效果需结合真实会话验证。',
    savedConfig,
    summary: {
      installedCount: existing.length,
      failedCount: failedTargets.length,
      targetsConsistent,
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
      languageServerRunning,
      processStartTimeMs,
      pendingLsRestart,
      clientUpdatedSinceSave,
      syncState,
      savedPromptTier: savedConfig ? savedConfig.promptTier : null,
      savedChineseTitle: savedConfig ? savedConfig.chineseTitle : null,
      lastAppliedAt: savedConfig ? savedConfig.lastAppliedAt : null
    }
  };
}

function isSupportedEnhancePlatform(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return true;
  if (platform === 'darwin' && arch === 'arm64') return true;
  return false;
}

function getUnsupportedEnhanceReason(platform, arch) {
  if (platform === 'darwin' && arch !== 'arm64') {
    return `系统提示词精简与中文标题内核原位补丁目前仅完成 Windows x64 与 Apple Silicon (macOS arm64) 验证，暂不支持 Intel Mac (${arch})`;
  }
  return '系统提示词精简与中文标题内核原位补丁目前仅支持 Windows x64 与 Apple Silicon (macOS arm64) 客户端';
}

function getEnhanceStatus(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && !isSupportedEnhancePlatform(platform, arch)) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: getUnsupportedEnhanceReason(platform, arch),
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
  const lsRunning = options.skipProcessCheck ? false : checkLanguageServerRunning();
  return finalizeEnhanceStatus(platform, arch, binaries, { running: lsRunning, startTimeMs: null }, options);
}

async function getEnhanceStatusAsync(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && !isSupportedEnhancePlatform(platform, arch)) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: getUnsupportedEnhanceReason(platform, arch),
      binaries: [],
      summary: null
    };
  }

  const targets = resolveTargetBinaries(options);
  const binaries = [];
  for (const target of targets) {
    const inspected = await inspectSingleBinaryAsync(target, options);
    if (inspected === null && options.cachedOnly === true) {
      return null;
    }
    binaries.push(inspected);
  }
  const procInfo = await checkLanguageServerRunningAsync(options);
  return finalizeEnhanceStatus(platform, arch, binaries, procInfo, options);
}

function validateEnhanceApplyInputs(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

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

  if (!Array.isArray(options.targets) && !isSupportedEnhancePlatform(platform, arch)) {
    return { ok: false, error: getUnsupportedEnhanceReason(platform, arch) };
  }

  const targets = resolveTargetBinaries(options).filter((t) => fs.existsSync(t.path));
  if (targets.length === 0) {
    return { ok: false, error: '未检测到本机已安装的 Antigravity 内核文件 (language_server / agy)' };
  }

  return {
    ok: true,
    platform,
    arch,
    promptTier,
    chineseTitle,
    hasContextRequest,
    restartRequested,
    targets
  };
}

function resolveEnhanceContextOpts(payload = {}) {
  const modeStr = String(payload.contextMode).trim().toLowerCase();
  if (modeStr === 'default' || modeStr === 'stock' || modeStr === '256k' || modeStr === 'restore') {
    return { mode: 'default' };
  }
  if (modeStr === 'dynamic' || modeStr === 'dyn' || modeStr === '983k' || modeStr === 'auto') {
    return { mode: 'dynamic' };
  }
  if (modeStr === '512k') {
    return { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 512000 };
  }
  if (modeStr === '900k') {
    return { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 900000 };
  }
  if (modeStr === 'fixed' || modeStr === 'const' || modeStr === 'custom') {
    return { mode: 'fixed', limitTokens: payload.contextLimitTokens };
  }
  throw new Error(`无效的上下文模式参数: ${payload.contextMode}`);
}

function patchSingleEnhanceBuffer(target, origDiskBuf, bakBuf, promptTier, chineseTitle, logs) {
  const nextBuf = Buffer.from(origDiskBuf);
  const dirtyRanges = [];
  if (promptTier !== null) {
    const pRes = applyPromptTierToBuffer(nextBuf, bakBuf, promptTier, dirtyRanges);
    logs.push(
      `[提示词] ${target.label} -> ${pRes.label}${pRes.strippedBytes > 0 ? ` (剥离 ${pRes.strippedCount} 个模板, -${pRes.strippedBytes}B)` : ''}`
    );
  }

  let titleMatchedCount = null;
  if (chineseTitle !== null) {
    const tMatches = applyChineseTitlePatchToBuffer(nextBuf, chineseTitle, dirtyRanges);
    titleMatchedCount = tMatches.length;
    if (tMatches.length > 0) {
      logs.push(
        `[中文标题] ${target.label} -> ${chineseTitle ? '自动中文标题 (4~10字)' : '官方英文标题'} (处理 ${tMatches.length} 条指令)`
      );
    } else {
      logs.push(`[中文标题] ${target.label} 未包含会话标题生成指令（已跳过）`);
    }
  }

  return { nextBuf, titleMatchedCount, dirtyRanges };
}

function recordEnhancePreferenceFromStatus(promptTier, chineseTitle, targetBuilds, status, options) {
  if (promptTier === null && chineseTitle === null) return false;
  const effTier = promptTier !== null ? promptTier : status?.summary?.promptTier;
  const effTitle = chineseTitle !== null ? chineseTitle : status?.summary?.chineseTitleEnabled;
  return saveSavedEnhancePreference({
    promptTier: effTier,
    chineseTitle: effTitle,
    lastAppliedAt: new Date().toISOString(),
    targetBuilds
  }, options);
}

/**
 * 统一应用提示词档位、中文标题与（可选）统一上下文窗口设置（同步版，供 CLI 与现有同步单测兼容）
 */
function applyEnhancePatch(payload = {}, options = {}) {
  const checked = validateEnhanceApplyInputs(payload, options);
  if (!checked.ok) return checked;

  const { promptTier, chineseTitle, hasContextRequest, restartRequested, targets } = checked;
  const logs = [];
  const targetResults = [];
  const targetBuilds = {};
  let needsRestart = false;
  let changedTargets = 0;

  try {
    if (promptTier !== null || chineseTitle !== null) {
      for (const target of targets) {
        try {
          const bakPath = getEnhanceBackupPath(target.path, options);
          const origDiskBuf = fs.readFileSync(target.path);
          const curTemplates = parsePeEmbedTemplates(origDiskBuf);
          const curTier = detectPromptTier(curTemplates, origDiskBuf);
          const peSum = parsePeSectionSummary(origDiskBuf);
          if (peSum?.peBuildKey) targetBuilds[target.id] = peSum.peBuildKey;

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

          const { nextBuf, titleMatchedCount, dirtyRanges } = patchSingleEnhanceBuffer(target, origDiskBuf, bakBuf, promptTier, chineseTitle, logs);
          const writeRes = writeBinarySafely(target.path, origDiskBuf, nextBuf, dirtyRanges, {
            entitlementsSourcePath: bakPath,
            skipCodesign: options.skipCodesign === true,
            forceCodesign: options.forceCodesign === true,
            codesignBin: options.codesignBin,
            _execFileSync: options._execFileSync
          });
          invalidateBinaryCache(target.path);
          if (writeRes.method !== 'unchanged') {
            needsRestart = true;
            changedTargets++;
          }
          logs.push(
            writeRes.method === 'unchanged'
              ? `[无变更] ${path.basename(target.path)} 提示词与标题已处于目标状态`
              : `[写入成功] ${path.basename(target.path)} (${writeRes.method === 'rename-swap' ? '运行期热替换' : '原位写入'} ${writeRes.writtenBytes}B)`
          );
          targetResults.push({
            id: target.id,
            label: target.label,
            path: target.path,
            ok: true,
            method: writeRes.method,
            changed: writeRes.method !== 'unchanged',
            titleMatchedCount
          });
        } catch (tErr) {
          targetResults.push({
            id: target.id,
            label: target.label,
            path: target.path,
            ok: false,
            method: 'error',
            changed: false,
            error: tErr.message || String(tErr)
          });
        }
      }

      const failedList = targetResults.filter((r) => !r.ok);
      if (failedList.length > 0) {
        const succeededCount = targetResults.filter((r) => r.ok).length;
        const detail = failedList.map((f) => `${f.label}: ${f.error}`).join('；');
        return {
          ok: false,
          partialOk: succeededCount > 0,
          targetResults,
          error: detail,
          logs
        };
      }
    }

    // 上下文长度统一通过 contextUnlock 应用（支持 desktop 与 cli），不维护第二套上下文重写器
    if (hasContextRequest) {
      const unlockTargets = targets.filter((t) => t.id === 'desktop' || t.id === 'cli' || t.id === 'custom');
      const unlockOpts = resolveEnhanceContextOpts(payload);

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
        if (!res.alreadyMatched) {
          needsRestart = true;
          changedTargets++;
        }
        logs.push(`[上下文] ${ut.label}: ${res.message || res.configuredMode}`);
      }
    }
  } catch (err) {
    return {
      ok: false,
      targetResults,
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
  recordEnhancePreferenceFromStatus(promptTier, chineseTitle, targetBuilds, status, options);
  const finalStatus = getEnhanceStatus({ ...options, forceRefresh: false });

  return {
    ok: true,
    needsRestart: needsRestart || Boolean(finalStatus?.summary?.pendingLsRestart),
    changed: changedTargets > 0,
    changedTargets,
    targetResults,
    appliedPromptTier: finalStatus?.summary?.promptTier ?? 0,
    appliedChineseTitleMode: finalStatus?.summary?.chineseTitleMode ?? 'en',
    appliedChineseTitleEnabled: Boolean(finalStatus?.summary?.chineseTitleEnabled),
    restarted,
    killedProcesses,
    logs,
    status: finalStatus
  };
}

async function applySingleEnhanceTargetCoreAsync(target, promptTier, chineseTitle, options = {}) {
  const localLogs = [];
  let readMs = 0;
  let parseMs = 0;
  let backupMs = 0;
  let patchMs = 0;
  let writeMs = 0;

  const bakPath = getEnhanceBackupPath(target.path, options);
  const r0 = performance.now();
  const origDiskBuf = await fs.promises.readFile(target.path);
  readMs = performance.now() - r0;

  const p0 = performance.now();
  const curTemplates = parsePeEmbedTemplates(origDiskBuf);
  const curTier = detectPromptTier(curTemplates, origDiskBuf);
  const curTitleInfo = chineseTitle !== null ? inspectChineseTitleRules(origDiskBuf) : null;
  const peSum = parsePeSectionSummary(origDiskBuf);
  const peBuildKey = peSum?.peBuildKey || null;
  parseMs = performance.now() - p0;

  await yieldEventLoop();

  const b0 = performance.now();
  let bakBuf = null;
  let bakPreparedFresh = false;
  if (!fs.existsSync(bakPath)) {
    const bakDir = path.dirname(bakPath);
    if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });
    if (curTier === 0) {
      await fs.promises.copyFile(target.path, bakPath);
      if (inspectChineseTitleRules(origDiskBuf).mode === 'zh') {
        bakBuf = Buffer.from(origDiskBuf);
        const bakDirty = [];
        applyChineseTitlePatchToBuffer(bakBuf, false, bakDirty);
        await writeBinarySafelyAsync(bakPath, origDiskBuf, bakBuf, bakDirty, { skipCodesign: true });
      } else {
        bakBuf = origDiskBuf;
      }
    } else {
      await fs.promises.copyFile(target.path, bakPath);
      bakBuf = origDiskBuf;
    }
    bakPreparedFresh = true;
    localLogs.push(`[备份] 已创建纯净提示词备份: ${path.basename(bakPath)}`);
  }
  backupMs = performance.now() - b0;

  // 幂等快路径：若当前目标与期望档位、标题完全一致且备份无需额外迁移刷新，直接跳过 220MB 复制、补丁和全盘写比对
  const tierMatched = promptTier === null || curTier === promptTier;
  const titleMatched = chineseTitle === null ||
    curTitleInfo.mode === 'unsupported' ||
    (chineseTitle === true && curTitleInfo.mode === 'zh') ||
    (chineseTitle === false && curTitleInfo.mode === 'en');

  let needWriteAndPatch = !(tierMatched && titleMatched);
  if (!needWriteAndPatch && !bakPreparedFresh && fs.existsSync(bakPath)) {
    const existingBakStat = await fs.promises.stat(bakPath);
    if (isMachO64Buffer(origDiskBuf)) {
      const bakHead = Buffer.alloc(Math.min(4096, existingBakStat.size));
      const fh = await fs.promises.open(bakPath, 'r');
      try { await fh.read(bakHead, 0, bakHead.length, 0); } finally { await fh.close(); }
      const mOrig = parseMachO64(origDiskBuf);
      const mBak = parseMachO64(bakHead);
      if (!mOrig || !mBak || mOrig.buildKey !== mBak.buildKey) {
        needWriteAndPatch = true;
      }
    } else if (existingBakStat.size === origDiskBuf.length) {
      const bakHead = Buffer.alloc(Math.min(4096, existingBakStat.size));
      const fh = await fs.promises.open(bakPath, 'r');
      try { await fh.read(bakHead, 0, bakHead.length, 0); } finally { await fh.close(); }
      const peA = origDiskBuf.readUInt32LE(0x3c);
      const peB = bakHead.readUInt32LE(0x3c);
      if (peA !== peB || peA + 24 + 60 > bakHead.length ||
          origDiskBuf.readUInt32LE(peA + 8) !== bakHead.readUInt32LE(peB + 8) ||
          origDiskBuf.readUInt32LE(peA + 24 + 56) !== bakHead.readUInt32LE(peB + 24 + 56)) {
        needWriteAndPatch = true;
      }
    } else {
      needWriteAndPatch = true;
    }
  }

  let writeRes = { writtenBytes: 0, method: 'unchanged' };
  let titleMatchedCount = curTitleInfo ? curTitleInfo.matchedCount : null;
  let resultBuf = origDiskBuf;

  if (needWriteAndPatch) {
    const b1 = performance.now();
    if (!bakBuf) {
      const existingBak = await fs.promises.readFile(bakPath);
      if (isSamePeBuild(origDiskBuf, existingBak)) {
        bakBuf = existingBak;
      } else if (curTier === 0) {
        await fs.promises.copyFile(target.path, bakPath);
        if (inspectChineseTitleRules(origDiskBuf).mode === 'zh') {
          const cleanStockBuf = Buffer.from(origDiskBuf);
          const bakDirty = [];
          applyChineseTitlePatchToBuffer(cleanStockBuf, false, bakDirty);
          await writeBinarySafelyAsync(bakPath, origDiskBuf, cleanStockBuf, bakDirty, { skipCodesign: true });
          bakBuf = cleanStockBuf;
        } else {
          bakBuf = origDiskBuf;
        }
        localLogs.push(`[备份刷新] 检测到 ${path.basename(target.path)} 已升级，已刷新备份`);
      } else if (promptTier !== null && (promptTier === 0 || promptTier === 1 || promptTier === 2)) {
        throw new Error(
          `${target.label} 的提示词备份属于旧版本客户端，且当前内核已被修改（处于 ${curTier} 档），无法直接还原原版模板，请先重新安装官方客户端`
        );
      } else {
        bakBuf = origDiskBuf;
      }
    }
    backupMs += performance.now() - b1;

    await yieldEventLoop();

    const pa0 = performance.now();
    const patched = patchSingleEnhanceBuffer(target, origDiskBuf, bakBuf, promptTier, chineseTitle, localLogs);
    resultBuf = patched.nextBuf;
    titleMatchedCount = patched.titleMatchedCount;
    patchMs = performance.now() - pa0;

    await yieldEventLoop();

    const w0 = performance.now();
    writeRes = await writeBinarySafelyAsync(target.path, origDiskBuf, resultBuf, patched.dirtyRanges, {
      entitlementsSourcePath: bakPath,
      skipCodesign: options.skipCodesign === true,
      forceCodesign: options.forceCodesign === true,
      codesignBin: options.codesignBin,
      _execFile: options._execFile
    });
    writeMs = performance.now() - w0;
  } else {
    if (promptTier !== null) {
      localLogs.push(`[提示词] ${target.label} -> ${PROMPT_TIER_META[promptTier]?.label || promptTier}`);
    }
    if (chineseTitle !== null) {
      localLogs.push(
        titleMatchedCount > 0
          ? `[中文标题] ${target.label} -> ${chineseTitle ? '自动中文标题 (4~10字)' : '官方英文标题'} (处理 ${titleMatchedCount} 条指令)`
          : `[中文标题] ${target.label} 未包含会话标题生成指令（已跳过）`
      );
    }
  }

  localLogs.push(
    writeRes.method === 'unchanged'
      ? `[无变更] ${path.basename(target.path)} 提示词与标题已处于目标状态`
      : `[写入成功] ${path.basename(target.path)} (${writeRes.method === 'rename-swap' ? '运行期热替换' : '原位写入'} ${writeRes.writtenBytes}B)`
  );

  let unlockSummary = null;
  let stAfter = null;
  const bakExistsAfter = fs.existsSync(bakPath) || fs.existsSync(`${target.path}.bak`);
  let bakMtimeAfter = 0;
  try {
    stAfter = await fs.promises.stat(target.path);
    if (fs.existsSync(bakPath)) bakMtimeAfter = (await fs.promises.stat(bakPath)).mtimeMs;
  } catch {}
  const statSigAfter = stAfter ? `${stAfter.size}:${stAfter.mtimeMs}:${bakExistsAfter ? 1 : 0}:${bakMtimeAfter}` : null;
  if (target.id === 'desktop' || target.id === 'cli' || target.id === 'custom') {
    try {
      const ua = await contextUnlock.analyzeBinaryAsync(target.path, {
        backupDir: options.backupDir,
        preloadedBuf: resultBuf,
        preloadedStats: stAfter,
        skipSha256: true,
        skipProcessCheck: true,
        forceRefresh: writeRes.method !== 'unchanged',
        _inWorker: options._inWorker === true
      });
      unlockSummary = {
        status: ua.status,
        configuredMode: ua.configuredMode,
        configuredLimitTokens: ua.configuredLimitTokens ?? null,
        configuredSummary: ua.configuredSummary || null
      };
    } catch {}
  }

  const inspectedAfter = buildInspectedResultFromBuffer(target, resultBuf, stAfter, bakExistsAfter, statSigAfter, unlockSummary);
  return {
    ok: true,
    peBuildKey,
    statSigAfter,
    inspectedAfter,
    localLogs,
    targetResult: {
      id: target.id,
      label: target.label,
      path: target.path,
      ok: true,
      method: writeRes.method,
      changed: writeRes.method !== 'unchanged',
      promptTier: inspectedAfter.promptTier,
      chineseTitleMode: inspectedAfter.chineseTitleMode,
      titleMatchedCount
    },
    timings: { readMs, parseMs, backupMs, patchMs, writeMs }
  };
}

/**
 * 异步非阻塞统一应用（IPC 首选路径：Worker 后台线程处理 200MB IO/CPU + 同一目标串行加锁 + 缓存直更新）
 */
async function applyEnhancePatchAsync(payload = {}, options = {}) {
  const totalT0 = performance.now();
  const checked = validateEnhanceApplyInputs(payload, options);
  if (!checked.ok) return checked;

  const { platform, arch, promptTier, chineseTitle, hasContextRequest, restartRequested, targets } = checked;
  const logs = [];
  const targetResults = [];
  const targetBuilds = {};
  const inspectedByPath = new Map();
  let needsRestart = false;
  let changedTargets = 0;

  let readMs = 0;
  let parseMs = 0;
  let backupMs = 0;
  let patchMs = 0;
  let writeMs = 0;

  try {
    if (promptTier !== null || chineseTitle !== null) {
      for (const target of targets) {
        await contextUnlock.enqueueUnlockTargetWrite(target.path, async () => {
          try {
            let outcome = null;
            if (canUseEnhanceWorker(options)) {
              const wRes = await runEnhanceWorkerTask('applyTarget', {
                target,
                promptTier,
                chineseTitle,
                options: sanitizeEnhanceWorkerOptions(options)
              });
              if (wRes && wRes._workerHandled) {
                outcome = wRes.result;
              }
            }
            if (!outcome) {
              outcome = await applySingleEnhanceTargetCoreAsync(target, promptTier, chineseTitle, options);
            }
            if (!outcome || !outcome.ok) {
              throw new Error(outcome?.error || '目标应用失败');
            }

            invalidateBinaryCache(target.path);
            if (outcome.statSigAfter && outcome.inspectedAfter) {
              binaryInspectCache.set(path.resolve(target.path).toLowerCase(), {
                statSig: outcome.statSigAfter,
                result: outcome.inspectedAfter
              });
            }
            if (outcome.peBuildKey) targetBuilds[target.id] = outcome.peBuildKey;
            if (Array.isArray(outcome.localLogs)) logs.push(...outcome.localLogs);
            if (outcome.timings) {
              readMs += Number(outcome.timings.readMs || 0);
              parseMs += Number(outcome.timings.parseMs || 0);
              backupMs += Number(outcome.timings.backupMs || 0);
              patchMs += Number(outcome.timings.patchMs || 0);
              writeMs += Number(outcome.timings.writeMs || 0);
            }
            if (outcome.targetResult.changed) {
              needsRestart = true;
              changedTargets++;
            }
            inspectedByPath.set(path.resolve(target.path).toLowerCase(), outcome.inspectedAfter);
            targetResults.push(outcome.targetResult);
          } catch (tErr) {
            targetResults.push({
              id: target.id,
              label: target.label,
              path: target.path,
              ok: false,
              method: 'error',
              changed: false,
              error: tErr.message || String(tErr)
            });
          }
        });
      }

      const failedList = targetResults.filter((r) => !r.ok);
      if (failedList.length > 0) {
        const succeededCount = targetResults.filter((r) => r.ok).length;
        const detail = failedList.map((f) => `${f.label}: ${f.error}`).join('；');
        return {
          ok: false,
          partialOk: succeededCount > 0,
          targetResults,
          error: detail,
          logs
        };
      }
    }

    if (hasContextRequest) {
      const unlockTargets = targets.filter((t) => t.id === 'desktop' || t.id === 'cli' || t.id === 'custom');
      const unlockOpts = resolveEnhanceContextOpts(payload);

      for (const ut of unlockTargets) {
        if (payload.contextRestoreOptional) {
          const curCtx = await contextUnlock.analyzeBinaryAsync(ut.path, {
            backupDir: options.backupDir,
            skipProcessCheck: true
          });
          if (!curCtx || curCtx.status === 'not_patched' || (curCtx.status === 'unsupported' && !curCtx.hasBackup)) {
            logs.push(`[上下文] ${ut.label}: 当前处于默认或未发现上下文门禁特征，无需恢复`);
            continue;
          }
        }
        const res = await contextUnlock.applyUnlockAsync({
          ...unlockOpts,
          targetPath: ut.path,
          backupDir: options.backupDir,
          homeDir: options.homeDir,
          stateDir: options.stateDir,
          skipProcessCheck: options.skipProcessCheck,
          syncConfigFiles: options.syncConfigFiles !== false && !Array.isArray(options.targets)
        });
        invalidateBinaryCache(ut.path);
        inspectedByPath.delete(path.resolve(ut.path).toLowerCase());
        if (!res.ok) {
          throw new Error(`${ut.label} 上下文切换失败: ${res.error}`);
        }
        if (!res.alreadyMatched) {
          needsRestart = true;
          changedTargets++;
        }
        logs.push(`[上下文] ${ut.label}: ${res.message || res.configuredMode}`);
      }
    }
  } catch (err) {
    return {
      ok: false,
      targetResults,
      error: err.message || String(err),
      logs
    };
  }

  let restarted = false;
  let killedProcesses = [];
  if (restartRequested && !options.skipProcessCheck) {
    const r = await restartLanguageServersAsync();
    restarted = r.ok;
    killedProcesses = r.killed || [];
    logs.push(
      killedProcesses.length > 0
        ? `[服务重启] 已重启后台语言服务 (${killedProcesses.join(', ')})，新配置将在下次会话/请求时加载`
        : '[服务重启] 当前无运行中的独立语言服务进程'
    );
  }

  const s0 = performance.now();
  const allTargets = resolveTargetBinaries(options);
  const finalBinaries = [];
  for (const t of allTargets) {
    const key = path.resolve(t.path).toLowerCase();
    if (inspectedByPath.has(key)) {
      finalBinaries.push({ ...inspectedByPath.get(key), id: t.id, label: t.label, path: t.path });
    } else {
      finalBinaries.push(await inspectSingleBinaryAsync(t, options));
    }
  }
  const procInfo = await checkLanguageServerRunningAsync({ ...options, forceRefresh: restartRequested });
  const preStatus = finalizeEnhanceStatus(platform, arch, finalBinaries, procInfo, options);
  recordEnhancePreferenceFromStatus(promptTier, chineseTitle, targetBuilds, preStatus, options);
  const status = finalizeEnhanceStatus(platform, arch, finalBinaries, procInfo, options);
  const echoMs = performance.now() - s0;

  return {
    ok: true,
    needsRestart: needsRestart || Boolean(status?.summary?.pendingLsRestart),
    changed: changedTargets > 0,
    changedTargets,
    targetResults,
    appliedPromptTier: status?.summary?.promptTier ?? 0,
    appliedChineseTitleMode: status?.summary?.chineseTitleMode ?? 'en',
    appliedChineseTitleEnabled: Boolean(status?.summary?.chineseTitleEnabled),
    restarted,
    killedProcesses,
    logs,
    status,
    _timings: {
      readMs: Number(readMs.toFixed(1)),
      parseMs: Number(parseMs.toFixed(1)),
      backupMs: Number(backupMs.toFixed(1)),
      patchMs: Number(patchMs.toFixed(1)),
      writeMs: Number(writeMs.toFixed(1)),
      statusMs: Number(echoMs.toFixed(1)),
      totalMs: Number((performance.now() - totalT0).toFixed(1))
    }
  };
}

function restoreAllEnhance(options = {}) {
  return applyEnhancePatch(
    { promptTier: 0, chineseTitle: false, contextMode: 'default', contextRestoreOptional: true },
    options
  );
}

function restoreAllEnhanceAsync(options = {}) {
  return applyEnhancePatchAsync(
    { promptTier: 0, chineseTitle: false, contextMode: 'default', contextRestoreOptional: true },
    options
  );
}

// ============================================================================
// 内嵌 worker_threads 后台卸载引擎（将 200MB+ 大文件解析、备份与写入移出主线程）
// ============================================================================

let enhanceWorkerInstance = null;
let enhanceWorkerDisabled = false;
let enhanceWorkerReqId = 1;
const enhanceWorkerPending = new Map();
let enhanceWorkerIdleTimer = null;

function canUseEnhanceWorker(options = {}) {
  if (!isMainThread || enhanceWorkerDisabled || options._inWorker === true || options.useMainThread === true) {
    return false;
  }
  if (
    typeof options._execFile === 'function' ||
    typeof options._execFileSync === 'function' ||
    options.forceCodesign === true ||
    options.codesignBin !== undefined
  ) {
    return false;
  }
  if (fs.readFileSync !== ORIG_ENHANCE_FS_READ_SYNC || fs.promises.readFile !== ORIG_ENHANCE_FS_READ_ASYNC) {
    return false;
  }
  return typeof Worker === 'function';
}

function sanitizeEnhanceWorkerOptions(options = {}) {
  const safe = {};
  const keys = ['backupDir', 'enhanceBackupDir', 'stateDir', 'homeDir', 'localAppData', 'platform', 'arch', 'forceRefresh'];
  for (const k of keys) {
    if (options[k] !== undefined) safe[k] = options[k];
  }
  return safe;
}

function captureEnhanceEnvSnapshot() {
  return {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    AG_METER_TEST_MODE: process.env.AG_METER_TEST_MODE
  };
}

function scheduleEnhanceWorkerIdleCleanup() {
  if (enhanceWorkerIdleTimer) {
    clearTimeout(enhanceWorkerIdleTimer);
    enhanceWorkerIdleTimer = null;
  }
  if (enhanceWorkerPending.size > 0 || !enhanceWorkerInstance) return;
  const idleMs = process.env.NODE_TEST_CONTEXT ? 120 : 2500;
  enhanceWorkerIdleTimer = setTimeout(() => {
    enhanceWorkerIdleTimer = null;
    if (enhanceWorkerPending.size === 0 && enhanceWorkerInstance) {
      const w = enhanceWorkerInstance;
      enhanceWorkerInstance = null;
      try { w.terminate(); } catch {}
    }
  }, idleMs);
  if (typeof enhanceWorkerIdleTimer.unref === 'function') enhanceWorkerIdleTimer.unref();
}

function getOrStartEnhanceWorker() {
  if (enhanceWorkerInstance) return enhanceWorkerInstance;
  const w = new Worker(__filename, {
    workerData: { agEnhanceWorker: true }
  });
  w.unref();
  w.on('message', (msg) => {
    if (!msg || !msg.id) return;
    const entry = enhanceWorkerPending.get(msg.id);
    if (!entry) return;
    enhanceWorkerPending.delete(msg.id);
    scheduleEnhanceWorkerIdleCleanup();
    if (msg.ok) entry.resolve({ _workerHandled: true, result: msg.result });
    else entry.resolve({ _workerHandled: true, result: { ok: false, error: msg.error || 'Worker 执行失败' } });
  });
  w.on('error', () => {
    enhanceWorkerDisabled = true;
    if (enhanceWorkerInstance === w) enhanceWorkerInstance = null;
    for (const [id, entry] of enhanceWorkerPending.entries()) {
      enhanceWorkerPending.delete(id);
      entry.resolve(null);
    }
    try { w.terminate(); } catch {}
  });
  w.on('exit', () => {
    if (enhanceWorkerInstance === w) enhanceWorkerInstance = null;
    for (const [id, entry] of enhanceWorkerPending.entries()) {
      enhanceWorkerPending.delete(id);
      entry.resolve(null);
    }
  });
  enhanceWorkerInstance = w;
  return w;
}

async function runEnhanceWorkerTask(cmd, payload) {
  try {
    if (enhanceWorkerIdleTimer) {
      clearTimeout(enhanceWorkerIdleTimer);
      enhanceWorkerIdleTimer = null;
    }
    const w = getOrStartEnhanceWorker();
    const id = enhanceWorkerReqId++;
    return await new Promise((resolve) => {
      enhanceWorkerPending.set(id, { resolve });
      try {
        w.postMessage({ id, cmd, payload, env: captureEnhanceEnvSnapshot() });
      } catch {
        enhanceWorkerPending.delete(id);
        resolve(null);
      }
    });
  } catch {
    enhanceWorkerDisabled = true;
    return null;
  }
}

if (!isMainThread && workerData && workerData.agEnhanceWorker && parentPort) {
  parentPort.on('message', async (msg) => {
    const { id, cmd, payload, env } = msg || {};
    const prevEnv = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        prevEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      let result = null;
      if (cmd === 'inspect') {
        const target = payload.target;
        const opts = { ...(payload.options || {}), _inWorker: true };
        const bakPath = getEnhanceBackupPath(target.path, opts);
        const bakExists = fs.existsSync(bakPath) || fs.existsSync(`${target.path}.bak`);
        let st = null;
        let statSig = null;
        try {
          st = await fs.promises.stat(target.path);
          const bakMtime = fs.existsSync(bakPath) ? (await fs.promises.stat(bakPath)).mtimeMs : 0;
          statSig = `${st.size}:${st.mtimeMs}:${bakExists ? 1 : 0}:${bakMtime}`;
        } catch {}
        const inspected = await inspectSingleBinaryAsync(target, opts);
        result = { statSig, inspected };
      } else if (cmd === 'applyTarget') {
        const opts = { ...(payload.options || {}), _inWorker: true };
        result = await applySingleEnhanceTargetCoreAsync(payload.target, payload.promptTier, payload.chineseTitle, opts);
      } else {
        throw new Error(`Unknown enhance worker command: ${cmd}`);
      }
      parentPort.postMessage({ id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
    } finally {
      if (env && typeof env === 'object') {
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }
  });
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
  getEnhanceStatusAsync,
  applyEnhancePatch,
  applyEnhancePatchAsync,
  restoreAllEnhance,
  restoreAllEnhanceAsync,
  restartLanguageServers,
  restartLanguageServersAsync,
  invalidateBinaryCache
};

