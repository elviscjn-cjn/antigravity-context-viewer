'use strict';
/**
 * Antigravity 内核提示词精简与上下文窗口解锁模块 (meter-patcher.js)
 *
 * 核心能力：
 * 1. 系统提示词 5 档原位修改（0~4 档）：解析 PE64 节区与 Go embed.FS 切片表，
 *    保留 identity.tmpl 与全部原生工具定义，使用 Go 模板块注释等长原位填充，
 *    保证 PE 节区偏移与文件体积零变动，并兼容 v2.29+ applyEdits 启动校验。
 * 2. 上下文窗口上限 3 档解锁（默认 256K / 512K / 900K）：修改 GetCheckpointConfig
 *    自动压缩阈值与 populateContextWindowMetadata 前端显示上限，同步更新 config.json。
 * 3. 支持运行期免关客户端安全落盘（原位增量写入 + Windows .old_run 同目录重命名替换）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// 提示词载荷定义（严格控制在 Desktop / CLI / IDE 最小槽位字节上限内）
// 兼容旧版最小容量限制：guidelines <= 691B, function_call <= 605B, communication_style <= 2034B
// ============================================================================

const TIER3_GUIDELINES = [
  'Follow these core engineering mandates at all times:',
  '- **Grounding Override (Cutoff: March 2026)**: Probe 2025-2026 facts without pre-2025 bias. On low confidence, "do not abstain from low confidence or hedge" is REVERSED: ABSTAIN and call `read_file` first. Never trust caller call-sites, comments, or mocks as proof a signature exists.',
  '- **Adaptive Scope**: Keep narrow bugfixes surgical; for brief/vague wishes, infer full production guards (concurrency, rollback, validation) in thinking and implement end-to-end.',
  '- **Boundary Integrity**: Never bypass access controls, permissions, or sandbox limits; if blocked, report and stop.'
].join('\n');

const TIER3_FUNCTION_CALL = [
  '- **Clean Tool Turns**: Emit tool calls directly without unstructured prose preambles or trailing colons (never write "Let me read the file:" before a tool call).',
  '- **Parallel Discovery, Sequential Edits**: Batch independent read-only calls (`read_file`, `grep_search`, `find_by_name`, `list_dir`) in parallel in one turn. Include context lines in `grep_search` to avoid extra `read_file` turns.',
  '- **Reactive Wakeup (No Polling)**: Background `run_command` and `invoke_subagent` tasks wake you automatically on completion. NEVER poll `command_status` in a loop or run `sleep`.'
].join('\n');

const TIER3_COMMUNICATION_STYLE = [
  '## Intent & Autonomy',
  '- Distinguish **Inquiries** (questions, reviews, RCA) from **Directives** (requests to write, edit, or run code):',
  '  - **Inquiries**: Deliver a grounded analysis directly in chat; do NOT edit files.',
  '  - **Directives**: Execute end-to-end (read imports -> edit -> verify via `run_command`) without stopping mid-task to ask permission on reversible steps. Use `ask_question` only for genuine requirement ambiguity.',
  '',
  '## Native Tool Contracts',
  '- **Direct Chat Delivery (No Brain Artifacts)**: Deliver all explanations, plans, diffs, and reports directly in chat. Do NOT write summary files to `brain/` or pass `ArtifactMetadata` on workspace code files unless explicitly requested.',
  '- **`edit_file` Uniqueness Guard**: `edit_file` replaces every occurrence of `Target`. Always include 3-5 lines of unchanged context in `Target` so it matches one unique location, and edit the same file sequentially across turns.',
  '- **Dedicated Tools First**: Use `read_file`, `edit_file`, `write_file`, `grep_search`, `find_by_name`, and `list_dir` instead of shell `cat`, `sed`, `awk`, or `find`.',
  '- **Subagents**: Frame open-ended questions in `invoke_subagent` without presupposing conclusions, and verify cited lines.',
  '',
  '## Verification, Honesty & UI Craft',
  '- Run the narrowest test, typecheck, or build via `run_command` that proves your change works. Never fabricate tool outputs or claim tests pass when skipped.',
  '- For frontend UI, ban dark-neon (#090d16+#06b6d4/#8b5cf6) and generic warm beige (#F3F1EC); derive bespoke palettes from the domain\'s physical medium.',
  '- Lead with the conclusion in sentence 1. Link files/symbols as `[name](file:///abs/path#L10-L20)` (forward slashes on Windows) and escape literal `$` as `\\$`.'
].join('\n');

const TIER4_GUIDELINES = [
  'Follow these behavioral guidelines at all times:',
  '- Maintain documentation integrity: preserve unrelated comments and docstrings. Never bypass access controls, permissions, or sandbox limits.',
  '- **Argon Grounding Override (Cutoff: March 2026)**: Probe 2025-2026 facts without pre-2025 bias. On low confidence, "do not abstain from low confidence or hedge" is REVERSED: ABSTAIN and call `read_file` first. Never trust caller call-sites, comments, or mocks as proof a signature exists.',
  '- **Adaptive Scope**: Keep narrow bugfixes surgical; for brief/vague wishes, infer concurrency, rollback, and validation guards in thinking and implement end-to-end.'
].join('\n');

const TIER4_FUNCTION_CALL = [
  'You support batch function calling. When executing independent operations (reading multiple files, running searches, checking resources), call multiple tools in parallel in a single turn. Do NOT batch operations that depend on previous outputs.',
  '- **Argon Clean Tool Turns**: Emit tool calls directly without unstructured prose preambles or trailing colons (e.g., never write "Let me read:" before a tool call).',
  '- **Search Context & No Polling**: Include context lines in `grep_search` to save extra `read_file` turns. Background tasks wake you automatically; NEVER poll `command_status` in a loop.'
].join('\n');

const TIER4_COMMUNICATION_STYLE = [
  '- Keep your responses concise and formatted in github-style markdown.',
  '- LaTeX math (KaTeX) is rendered in direct responses: inline with \\(...\\) or $...$, display with \\[...\\] or $$...$$. Write a literal dollar as `\\$` or wrap it in backticks.',
  '- You MUST create clickable links for all files and code symbols using github-style markdown links with the file:// scheme (e.g. `[symbol](file:///abs/path#L10-L20)`).',
  '',
  '## Amp & Argon Anti-Hallucination Guardrails',
  '- **Inquiry vs. Directive**: Treat questions/reviews as Inquiries (do NOT edit files). Treat coding tasks as Directives (read imported modules -> edit -> verify via `run_command` end-to-end without stopping to ask permission on reversible steps; use `ask_question` only for genuine ambiguity).',
  '- **Direct Chat Delivery**: Deliver all explanations, plans, diffs, and summaries directly in chat. Do NOT write report files to `brain/` or pass `ArtifactMetadata` when editing workspace code files unless explicitly requested.',
  '- **`edit_file` Uniqueness Guard**: Always include 3-5 lines of unchanged context in `Target` so it matches a single unique location. Edit the same file sequentially across turns.',
  '- **Blast-Radius Verification & Honesty**: Run the narrowest test, typecheck, or build via `run_command` that proves the change works. Never fabricate tool outputs or claim tests pass when verification was skipped.',
  '- **UI Craft**: For frontend tasks, ban dark-neon (#090d16+#06b6d4/#8b5cf6) and generic warm beige (#F3F1EC); derive bespoke palettes from the domain\'s physical medium.'
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

const PROMPT_TIER_META = {
  0: { tier: 0, key: '0', label: '0档 · 官方原版', shortLabel: '0档原版', desc: '从备份完整还原全部官方系统提示词模板' },
  1: { tier: 1, key: '1', label: '1档 · 仅去推销', shortLabel: '1档去推销', desc: '仅清空 slash_commands / plugins 推销模板，其余 100% 原版' },
  2: { tier: 2, key: '2', label: '2档 · 原版精简', shortLabel: '2档精简', desc: '清空 artifacts、conversation_transcript 等冗余模板，3 个核心模板保持原版' },
  3: { tier: 3, key: '3', label: '3档 · 核心重写', shortLabel: '3档重写', desc: '清空冗余模板，并将 guidelines / function_call / communication_style 重写为精简版' },
  4: { tier: 4, key: '4', label: '4档 · 精简+防幻觉 (推荐)', shortLabel: '4档推荐', desc: '清空冗余模板，保留原版底子并增加未读禁猜、最小改动、唯一锚点与验证护栏' }
};

const CONTEXT_MODE_META = {
  stock: { mode: 'stock', label: '官方默认 (256K / 128K)', shortLabel: '默认 256K', budget: 256000, desc: '恢复默认的 256K (桌面端) / 128K (旧版 IDE) 上下文限制' },
  '512k': { mode: '512k', label: '解锁 512K 上下文', shortLabel: '512K 上限', budget: 512000, desc: '将自动压缩阈值与前端显示上限提升至 512,000 tokens' },
  '900k': { mode: '900k', label: '解锁 900K / 1M (推荐)', shortLabel: '900K 满血', budget: 983040, desc: '跳过 cmovb 硬编码封顶判断，释放 983,040 tokens 物理窗口' }
};

// 会话与章节自动中文命名等长特征表（agy-chinese-title-patch，100% 严格 ASCII 字节等长双向可逆）
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

// 上下文窗口机器码特征表（覆盖 Desktop/CLI 256K 与 IDE 128K）
const CONTEXT_SIGNATURES = [
  {
    id: 'cli_main_256k_cap',
    desc: 'Desktop/CLI GetCheckpointConfig 主路径 256K (0x3e800) cmovb 封顶',
    stockHex: '8b54244c81fa00e80300be00e803000f42f289742450',
    patch512kHex: '8b54244c81fa00d00700be00d007000f42f289742450',
    patch900kHex: '8b54244c81fa00e8030089d690909090909089742450'
  },
  {
    id: 'cli_fallback_256k_cap',
    desc: 'Desktop/CLI GetCheckpointConfig 兜底 256K (0x3e800) 赋值',
    stockHex: '837a14007f07c7400c00e80300',
    patch512kHex: '837a14007f07c7400c00d00700',
    patch900kHex: '837a14007f07c7400ca0bb0d00'
  },
  {
    id: 'cli_serializer_max_ctx',
    desc: 'Desktop/CLI populateContextWindowMetadata 前端上限返回值',
    stockHex: '4889442470488b8c24a80100008908b830000000',
    patch512kHex: '4889442470c70000d0070090909090b830000000',
    patch900kHex: '4889442470c70000000f0090909090b830000000'
  },
  {
    id: 'ide_main_128k_cap',
    desc: 'IDE GetCheckpointConfig 主路径 128K (0x1f400) cmovb 封顶',
    stockHex: '8b4c245429d181f900f40100ba00f401000f42d18954244c',
    patch512kHex: '8b4c245429d181f900d00700ba00d007000f42d18954244c',
    patch900kHex: '8b4c245429d181f900f4010089ca9090909090908954244c'
  }
];

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

function normalizeContextMode(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s === 'stock' || s === 'restore' || s === 'reset' || s === 'default' || s === '256k') return 'stock';
  if (s === '512k' || s === '512') return '512k';
  if (s === '900k' || s === '1m' || s === '900' || s === 'max') return '900k';
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

function resolveStandaloneAgyPath(localAppData) {
  const defaultPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(defaultPath)) return defaultPath;
  const cacheKey = String(localAppData || '').toLowerCase();
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
  standalonePathCache.set(cacheKey, defaultPath);
  return defaultPath;
}

function resolveTargetBinaries(options = {}) {
  if (Array.isArray(options.targets)) {
    return options.targets.map(t => ({
      id: String(t.id || 'custom'),
      label: String(t.label || path.basename(t.path || '')),
      path: path.resolve(t.path)
    }));
  }

  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return [];
  }

  const home = options.homeDir || os.homedir();
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const desktopPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
  const standalonePath = resolveStandaloneAgyPath(localAppData);
  const ideLegacyPath = path.join(
    localAppData,
    'Programs',
    'Antigravity IDE',
    'resources',
    'app',
    'extensions',
    'antigravity',
    'bin',
    'language_server_windows_x64.exe'
  );
  const ideHubPath = path.join(home, '.gemini', 'bin', 'agy.exe');

  const seenPaths = new Set();
  const list = [];
  const pushUnique = (id, label, targetPath) => {
    const resolved = path.resolve(targetPath);
    const normKey = resolved.toLowerCase();
    if (seenPaths.has(normKey)) return;
    seenPaths.add(normKey);
    list.push({ id, label, path: resolved });
  };

  pushUnique('cli', '桌面端内核 (language_server.exe)', desktopPath);
  if (fs.existsSync(standalonePath)) {
    pushUnique('standalone', '独立版 CLI (agy.exe)', standalonePath);
  }
  if (fs.existsSync(ideHubPath)) {
    pushUnique('ide_hub', 'CLI / IDE 共享后端 (~/.gemini/bin/agy.exe)', ideHubPath);
  }
  if (fs.existsSync(ideLegacyPath)) {
    pushUnique('ide', 'IDE 扩展内核 (language_server_windows_x64.exe)', ideLegacyPath);
  }

  return list;
}

// ============================================================================
// PE64 + Go embed.FS 解析与原位填充
// ============================================================================

function computeActiveBytes(rawText) {
  if (rawText.startsWith('{{- /*') && rawText.endsWith('*/ -}}')) {
    const inner = rawText.slice(6, -6);
    if (/^ *$/.test(inner)) {
      return { activeBytes: 0, isStripped: true };
    }
  }
  const idx = rawText.lastIndexOf('{{- /*');
  if (idx !== -1 && rawText.endsWith('*/ -}}')) {
    const commentInner = rawText.slice(idx + 6, -6);
    if (/^ *$/.test(commentInner)) {
      const byteLen = Buffer.byteLength(rawText.slice(0, idx), 'utf8');
      return { activeBytes: byteLen, isStripped: byteLen === 0 };
    }
  }
  return { activeBytes: Buffer.byteLength(rawText, 'utf8'), isStripped: false };
}

function parsePeEmbedTemplates(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x100) {
    throw new Error('无效的二进制文件（体积过小）');
  }
  if (buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('不是有效的 PE 可执行文件（缺少 MZ 头）');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 + 64 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('无效的 PE64 头结构');
  }
  const magic = buf.readUInt16LE(peOffset + 24);
  if (magic !== 0x20b) {
    throw new Error('仅支持 PE32+ (64-bit) 内核二进制');
  }

  const numSections = buf.readUInt16LE(peOffset + 6);
  const optHeaderSize = buf.readUInt16LE(peOffset + 20);
  const imageBase = buf.readBigUInt64LE(peOffset + 24 + 24);
  const secTableOffset = peOffset + 24 + optHeaderSize;

  if (secTableOffset + numSections * 40 > buf.length) {
    throw new Error('PE 节区表越界');
  }

  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = secTableOffset + i * 40;
    sections.push({
      vSize: buf.readUInt32LE(off + 8),
      vAddr: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20)
    });
  }

  const fileOffsetToVA = foff => {
    for (const s of sections) {
      if (foff >= s.rawPtr && foff < s.rawPtr + s.rawSize) {
        return imageBase + BigInt(s.vAddr + (foff - s.rawPtr));
      }
    }
    return 0n;
  };

  const vaToFileOffset = va => {
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
    if (guideSlot && guideSlot.dataLength > 0) {
      const txt = buf.subarray(guideSlot.dataOffset, guideSlot.dataOffset + guideSlot.dataLength).toString('utf8');
      if (txt.includes('core engineering mandates')) return 3;
      if (txt.includes('Argon Grounding Override')) return 4;
    }
    return 2;
  }
  return 0;
}

function inspectContextGates(buf) {
  const gates = [];
  for (const sig of CONTEXT_SIGNATURES) {
    const bStock = Buffer.from(sig.stockHex, 'hex');
    const b512 = Buffer.from(sig.patch512kHex, 'hex');
    const b900 = Buffer.from(sig.patch900kHex, 'hex');

    const offStock = buf.indexOf(bStock);
    if (offStock !== -1) {
      gates.push({ id: sig.id, desc: sig.desc, mode: 'stock', offset: offStock });
      continue;
    }
    const off512 = buf.indexOf(b512);
    if (off512 !== -1) {
      gates.push({ id: sig.id, desc: sig.desc, mode: '512k', offset: off512 });
      continue;
    }
    const off900 = buf.indexOf(b900);
    if (off900 !== -1) {
      gates.push({ id: sig.id, desc: sig.desc, mode: '900k', offset: off900 });
    }
  }
  return gates;
}

function resolveEffectiveContextMode(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return 'stock';
  if (gates.some(g => g.mode === '900k')) return '900k';
  if (gates.some(g => g.mode === '512k')) return '512k';
  return 'stock';
}

function inspectChineseTitleRules(buf) {
  const details = [];
  let zhCount = 0;
  let enCount = 0;
  for (const rule of CHINESE_TITLE_RULES) {
    const oldBytes = Buffer.from(rule.oldText, 'ascii');
    const newBytes = Buffer.from(rule.newText, 'ascii');
    const newOff = buf.indexOf(newBytes);
    if (newOff !== -1) {
      zhCount++;
      details.push({ id: rule.id, name: rule.name, state: 'zh', offset: newOff });
      continue;
    }
    const oldOff = buf.indexOf(oldBytes);
    if (oldOff !== -1) {
      enCount++;
      details.push({ id: rule.id, name: rule.name, state: 'en', offset: oldOff });
    }
  }
  let mode = 'unsupported';
  if (zhCount > 0 && enCount === 0) mode = 'zh';
  else if (enCount > 0) mode = 'en';
  return { mode, zhCount, enCount, matchedCount: zhCount + enCount, details };
}

function applyChineseTitlePatchToBuffer(buf, enableZh) {
  const matched = [];
  for (const rule of CHINESE_TITLE_RULES) {
    const oldBytes = Buffer.from(rule.oldText, 'ascii');
    const newBytes = Buffer.from(rule.newText, 'ascii');
    if (enableZh) {
      let off = buf.indexOf(oldBytes);
      if (off !== -1) {
        newBytes.copy(buf, off);
        matched.push({ id: rule.id, name: rule.name, offset: off, state: 'zh', changed: true });
      } else {
        off = buf.indexOf(newBytes);
        if (off !== -1) {
          matched.push({ id: rule.id, name: rule.name, offset: off, state: 'zh', changed: false });
        }
      }
    } else {
      let off = buf.indexOf(newBytes);
      if (off !== -1) {
        oldBytes.copy(buf, off);
        matched.push({ id: rule.id, name: rule.name, offset: off, state: 'en', changed: true });
      } else {
        off = buf.indexOf(oldBytes);
        if (off !== -1) {
          matched.push({ id: rule.id, name: rule.name, offset: off, state: 'en', changed: false });
        }
      }
    }
  }
  return matched;
}

function applyPromptTierToBuffer(buf, bakBuf, tierNum) {
  const bakTemplates = parsePeEmbedTemplates(bakBuf);
  const curTemplates = parsePeEmbedTemplates(buf);

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
  if (!idText.includes('You are Antigravity, a powerful agentic AI coding assistant')) {
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
    // 校验 TimeDateStamp 与 SizeOfImage 一致
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

function locateSignatureOffset(sameBuildBakBuf, curBuf, sig) {
  const candidates = [
    Buffer.from(sig.stockHex, 'hex'),
    Buffer.from(sig.patch512kHex, 'hex'),
    Buffer.from(sig.patch900kHex, 'hex')
  ];
  // 优先在当前二进制自身定位特征码，杜绝任何跨版本偏移错位风险
  for (const pat of candidates) {
    const off = curBuf.indexOf(pat);
    if (off !== -1) return off;
  }
  if (sameBuildBakBuf) {
    for (const pat of candidates) {
      const off = sameBuildBakBuf.indexOf(pat);
      if (off !== -1) return off;
    }
  }
  return -1;
}

function applyContextPatchToBuffer(buf, bakBuf, mode) {
  const matched = [];
  for (const sig of CONTEXT_SIGNATURES) {
    const off = locateSignatureOffset(bakBuf, buf, sig);
    if (off === -1) continue;

    let replacement;
    if (mode === 'stock') {
      replacement = Buffer.from(sig.stockHex, 'hex');
    } else if (mode === '512k') {
      replacement = Buffer.from(sig.patch512kHex, 'hex');
    } else if (mode === '900k') {
      replacement = Buffer.from(sig.patch900kHex, 'hex');
    } else {
      throw new Error(`不支持的上下文窗口档位: ${mode}`);
    }

    replacement.copy(buf, off);
    matched.push({ id: sig.id, desc: sig.desc, offset: off, mode });
  }
  return matched;
}

function getConfigPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  return [
    path.join(home, '.gemini', 'config', 'config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  ];
}

function readSyncedConfigContextWindow(options = {}) {
  for (const cfgPath of getConfigPaths(options)) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed.contextWindow === 'string' && parsed.contextWindow.trim()) {
        return parsed.contextWindow.trim();
      }
    } catch {}
  }
  return null;
}

function syncSettingsJsonContextWindow(mode, options = {}) {
  const synced = [];
  const paths = getConfigPaths(options);
  for (let idx = 0; idx < paths.length; idx++) {
    const sp = paths[idx];
    try {
      const dir = path.dirname(sp);
      // 主配置文件 ~/.gemini/config/config.json 目录不存在时可自动创建，次要 CLI 目录仅在存在时同步
      if (!fs.existsSync(dir)) {
        if (idx === 0) fs.mkdirSync(dir, { recursive: true });
        else continue;
      }
      let obj = {};
      if (fs.existsSync(sp)) {
        try {
          obj = JSON.parse(fs.readFileSync(sp, 'utf8')) || {};
        } catch {
          obj = {};
        }
      }
      if (mode === 'stock') {
        delete obj.contextWindow;
      } else if (mode === '512k') {
        obj.contextWindow = '512K';
      } else if (mode === '900k') {
        obj.contextWindow = '900K';
      }
      const tmp = `${sp}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, sp);
      synced.push(sp);
    } catch {}
  }
  return synced;
}

// ============================================================================
// 增量原位写入与 Windows 运行期免杀进程替换
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

  // 1. 优先尝试文件句柄原位增量写入（进程未锁写时耗时 <5ms）
  try {
    const writtenBytes = writeChangedRangesInPlace(targetPath, oldBuf, newBuf);
    return { writtenBytes, method: 'in-place' };
  } catch (inPlaceErr) {
    if (process.platform !== 'win32') {
      throw inPlaceErr;
    }
  }

  // 2. Windows 特性：运行中的 .exe 允许同目录重命名，不中断现有连接即可落盘新文件
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
    throw new Error(`文件正被运行中的后台服务锁定且重命名替换失败（可点击「重启语言服务」或关闭客户端后重试）: ${swapErr.message}`);
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

// ============================================================================
// 状态查询与补丁执行入口
// ============================================================================

// 基于文件元数据 (size + mtimeMs + bakExists) 的二进制状态内存缓存，避免重复读取百兆级 PE 文件阻塞主进程
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
  const bakPath = `${target.path}.bak`;
  const bakExists = fs.existsSync(bakPath);
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
      contextMode: 'stock',
      contextLabel: CONTEXT_MODE_META.stock.label,
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: CHINESE_TITLE_META.unsupported.label,
      totalCapacityBytes: 0,
      activeSlotBytes: 0,
      savedBytes: 0,
      slotCount: 0,
      gatesCount: 0,
      error: null
    };
  }

  let statSig = null;
  try {
    const st = fs.statSync(target.path);
    const bakMtime = bakExists ? fs.statSync(bakPath).mtimeMs : 0;
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
    const gates = inspectContextGates(buf);
    const contextMode = resolveEffectiveContextMode(gates);
    const titleInfo = inspectChineseTitleRules(buf);

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
      promptTier,
      promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
      contextMode,
      contextLabel: CONTEXT_MODE_META[contextMode]?.label || CONTEXT_MODE_META.stock.label,
      chineseTitleMode: titleInfo.mode,
      chineseTitleEnabled: titleInfo.mode === 'zh',
      chineseTitleLabel: CHINESE_TITLE_META[titleInfo.mode]?.label || CHINESE_TITLE_META.en.label,
      chineseTitleMatched: titleInfo.matchedCount,
      totalCapacityBytes,
      activeSlotBytes,
      savedBytes: Math.max(0, totalCapacityBytes - activeSlotBytes),
      slotCount: templates.size,
      gatesCount: gates.length,
      gates,
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
      contextMode: 'stock',
      contextLabel: '解析失败',
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: '解析失败',
      totalCapacityBytes: 0,
      activeSlotBytes: 0,
      savedBytes: 0,
      slotCount: 0,
      gatesCount: 0,
      error: err.message
    };
  }
}

function getKernelStatus(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'win32' || arch !== 'x64')) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: '内核 PE64 原位补丁目前仅支持 Windows x64 客户端',
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
  const existing = binaries.filter(b => b.exists && !b.error);
  const primary = existing.find(b => b.id === 'cli') || existing[0] || null;

  const promptTier = primary ? primary.promptTier : 0;
  const contextMode = primary ? primary.contextMode : 'stock';
  const chineseTitleMode = primary ? (primary.chineseTitleMode || 'en') : 'en';
  const chineseTitleMeta = CHINESE_TITLE_META[chineseTitleMode] || CHINESE_TITLE_META.en;
  const configContextWindow = readSyncedConfigContextWindow(options);
  const languageServerRunning = options.skipProcessCheck ? false : checkLanguageServerRunning();

  return {
    ok: true,
    supported: true,
    platform,
    arch,
    binaries,
    summary: {
      installedCount: existing.length,
      promptTier,
      promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
      promptShortLabel: PROMPT_TIER_META[promptTier]?.shortLabel || '0档原版',
      contextMode,
      contextLabel: CONTEXT_MODE_META[contextMode]?.label || CONTEXT_MODE_META.stock.label,
      contextShortLabel: CONTEXT_MODE_META[contextMode]?.shortLabel || '默认 256K',
      effectiveBudget: CONTEXT_MODE_META[contextMode]?.budget || 256000,
      chineseTitleMode,
      chineseTitleEnabled: chineseTitleMode === 'zh',
      chineseTitleLabel: chineseTitleMeta.label,
      chineseTitleShortLabel: chineseTitleMeta.shortLabel,
      totalCapacityBytes: primary ? primary.totalCapacityBytes : 0,
      activeSlotBytes: primary ? primary.activeSlotBytes : 0,
      savedBytes: primary ? primary.savedBytes : 0,
      slotCount: primary ? primary.slotCount : 0,
      allBackedUp: existing.length > 0 && existing.every(b => b.bakExists),
      configContextWindow,
      languageServerRunning
    }
  };
}

function applyKernelPatch(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'win32' || arch !== 'x64')) {
    return { ok: false, error: '当前操作系统或架构不支持 Windows PE64 内核原位补丁' };
  }

  const promptTier = normalizePromptTier(payload.promptTier);
  if (promptTier === undefined) {
    return { ok: false, error: `无效的提示词档位参数: ${payload.promptTier}` };
  }

  const contextMode = normalizeContextMode(payload.contextMode);
  if (contextMode === undefined) {
    return { ok: false, error: `无效的上下文上限参数: ${payload.contextMode}` };
  }

  const chineseTitle = normalizeChineseTitleMode(payload.chineseTitle);
  if (chineseTitle === undefined) {
    return { ok: false, error: `无效的中文标题补丁参数: ${payload.chineseTitle}` };
  }

  const restartRequested = payload.restartLanguageServer === true;
  if (promptTier === null && contextMode === null && chineseTitle === null && !restartRequested) {
    return { ok: false, error: '未指定要应用的提示词档位、上下文解锁模式或中文标题配置' };
  }

  const targets = resolveTargetBinaries(options).filter(t => fs.existsSync(t.path));
  if (targets.length === 0) {
    return { ok: false, error: '未检测到本机已安装的 Antigravity 内核文件 (language_server.exe / agy.exe)' };
  }

  const logs = [];

  try {
    if (promptTier !== null || contextMode !== null || chineseTitle !== null) {
      for (const target of targets) {
        const bakPath = `${target.path}.bak`;
        const origDiskBuf = fs.readFileSync(target.path);
        const curTemplates = parsePeEmbedTemplates(origDiskBuf);
        const curTier = detectPromptTier(curTemplates, origDiskBuf);

        let bakBuf = null;
        if (!fs.existsSync(bakPath)) {
          const cleanStockBuf = Buffer.from(origDiskBuf);
          if (curTier === 0) {
            applyContextPatchToBuffer(cleanStockBuf, null, 'stock');
            applyChineseTitlePatchToBuffer(cleanStockBuf, false);
          }
          fs.writeFileSync(bakPath, cleanStockBuf);
          bakBuf = cleanStockBuf;
          logs.push(`[备份] 已创建原始内核备份: ${path.basename(bakPath)}`);
        } else {
          const existingBak = fs.readFileSync(bakPath);
          if (isSamePeBuild(origDiskBuf, existingBak)) {
            bakBuf = existingBak;
          } else if (curTier === 0) {
            // 宿主客户端已升级为新版本且当前提示词处于原版状态：自动刷新过期备份，杜绝跨版本偏移污染
            const cleanStockBuf = Buffer.from(origDiskBuf);
            applyContextPatchToBuffer(cleanStockBuf, null, 'stock');
            applyChineseTitlePatchToBuffer(cleanStockBuf, false);
            fs.writeFileSync(bakPath, cleanStockBuf);
            bakBuf = cleanStockBuf;
            logs.push(`[备份刷新] 检测到 ${path.basename(target.path)} 已升级版本，已同步刷新纯净 .bak 备份`);
          } else if (promptTier !== null && (promptTier === 0 || promptTier === 1 || promptTier === 2)) {
            throw new Error(
              `${target.label} 的 .bak 备份属于旧版本客户端，且当前内核已被修改（处于 ${curTier} 档），无法直接还原原版模板，请重新安装客户端以获取最新纯净原版`
            );
          } else {
            // 仅切换上下文门禁、中文标题或覆盖写入 3/4 档时，直接使用同版本自身结构
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

        if (contextMode !== null) {
          const cMatches = applyContextPatchToBuffer(nextBuf, isSamePeBuild(origDiskBuf, bakBuf) ? bakBuf : null, contextMode);
          if (cMatches.length === 0) {
            throw new Error(`${target.label} 未匹配到已知上下文门禁特征码，已中止写入以保护内核`);
          }
          logs.push(`[上下文] ${target.label} -> ${CONTEXT_MODE_META[contextMode].label} (命中 ${cMatches.length} 处门禁)`);
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
        logs.push(
          writeRes.method === 'unchanged'
            ? `[无变更] ${path.basename(target.path)} 已处于目标状态`
            : `[写入成功] ${path.basename(target.path)} (${writeRes.method === 'rename-swap' ? '运行期热替换' : '原位写入'} ${writeRes.writtenBytes}B)`
        );
      }

      if (contextMode !== null) {
        const syncedFiles = syncSettingsJsonContextWindow(contextMode, options);
        if (syncedFiles.length > 0) {
          logs.push(
            `[配置同步] 已更新 ${syncedFiles.map(f => path.basename(f)).join(', ')} -> ${contextMode === 'stock' ? '默认' : contextMode.toUpperCase()}`
          );
        }
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
        ? `[服务重启] 已重启后台语言服务 (${killedProcesses.join(', ')})，新配置立即生效`
        : '[服务重启] 当前无运行中的独立语言服务进程，下次请求或启动时自动加载新内核'
    );
  }

  const status = getKernelStatus(options);
  return {
    ok: true,
    restarted,
    killedProcesses,
    logs,
    status
  };
}

module.exports = {
  PROMPT_TIER_META,
  CONTEXT_MODE_META,
  CHINESE_TITLE_META,
  CHINESE_TITLE_RULES,
  CONTEXT_SIGNATURES,
  TIER3_GUIDELINES,
  TIER3_FUNCTION_CALL,
  TIER3_COMMUNICATION_STYLE,
  TIER4_GUIDELINES,
  TIER4_FUNCTION_CALL,
  TIER4_COMMUNICATION_STYLE,
  normalizePromptTier,
  normalizeContextMode,
  normalizeChineseTitleMode,
  resolveTargetBinaries,
  parsePeEmbedTemplates,
  isSamePeBuild,
  writePaddedTemplate,
  detectPromptTier,
  inspectContextGates,
  inspectChineseTitleRules,
  applyPromptTierToBuffer,
  applyContextPatchToBuffer,
  applyChineseTitlePatchToBuffer,
  syncSettingsJsonContextWindow,
  getKernelStatus,
  applyKernelPatch,
  restartLanguageServers
};
