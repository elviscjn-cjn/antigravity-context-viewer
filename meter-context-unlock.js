'use strict';
// Preserve Electron ASAR support in the host process.

/**
 * Antigravity 上下文加长 (Context Window Unlock) 引擎
 * 
 * 方案参考与致敬：
 * 解锁方案提供者：Linux.do @23375 (https://linux.do/u/23375/summary)
 * 本项目进行 Node.js 原生适配与客户端集成。
 *
 * 核心原理：
 * 运行时解析 Go 二进制文件中的 .gopclntab 符号表，动态定位目标函数并修补 256K (0x3e800) 压缩硬上限：
 * - Gate 3A: utils.GetCheckpointConfig (移除 256,000 封顶 clamp，恢复按模型物理窗口动态计算 983,040 上限)
 * - Gate 3B: config.applyFeatureProviderCheckpointOverrideConfig (阻止 CASCADE_USE_EXPERIMENT_CHECKPOINTER 覆盖)
 * - 针对 agy CLI 额外支持 Gate 1 (model.SelectorModel.offersContextWindow) 与 Gate 2 (store.(*Store).ContextWindow)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { getStateDir } = require('./asar-engine');
const {
  isMachO64Buffer,
  parseMachO64,
  atomicWriteMachOBinarySync,
  atomicWriteMachOBinaryAsync,
  isExactMacLanguageServerProcess,
  listMacProcessesAsync
} = require('./macos-binary-utils');

/**
 * 校验二进制格式与架构组合是否已完成端到端适配与签名验证：
 * 仅开放 Windows PE64 (x86-64) 与 macOS Mach-O Apple Silicon (arm64)，
 * 严格排除 Intel Mac (Mach-O x86-64) 与未验证架构。
 */
function isSupportedUnlockTarget(format, arch) {
  if (format === 'PE' && arch === 'x86-64') return true;
  if (format === 'Mach-O' && arch === 'arm64') return true;
  return false;
}

function getUnsupportedTargetReason(format, arch) {
  if (format === 'Mach-O' && arch === 'x86-64') {
    return '暂未开放对 Intel Mac (Mach-O x86-64) 的写入支持：当前 macOS 二进制调整仅完成 Apple Silicon (arm64) 适配与验证。';
  }
  return `暂未开放对 ${format || '未知格式'} (${arch || '未知架构'}) 的写入支持：当前仅支持 Windows PE64 (x86-64) 与 macOS Apple Silicon Mach-O (arm64)。`;
}

const ORIG_UNLOCK_FS_READ_SYNC = fs.readFileSync;
const ORIG_UNLOCK_FS_READ_ASYNC = fs.promises.readFile;

const PCLNTAB_MAGIC = 0xFFFFFFF1;

const FUNC_OFFERS = 'model.SelectorModel.offersContextWindow';
const FUNC_STORE_CW = 'store.(*Store).ContextWindow';
const FUNC_STORE_CHOICE = 'store.(*Store).ContextWindowChoice';
const FUNC_CHECKPOINT = 'utils.GetCheckpointConfig';
const FUNC_EXP_CHECKPOINT = 'config.applyFeatureProviderCheckpointOverrideConfig';
const FUNC_SELECT_EXP_KEY = 'config.selectCheckpointExperimentKey';
const FUNC_OVERRIDE = 'store.AutoCompactOverride';

const NOP_ARM64 = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
const RET_TRUE_ARM64 = Buffer.from([0x20, 0x00, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6]);
const RET_TRUE_X64 = Buffer.from([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]);

const CLAMP_256K_ARM64 = Buffer.from('04009dd26400a0f27f00046b04009dd26400a0f26330849a', 'hex');
const PATCH_256K_ARM64 = Buffer.concat([NOP_ARM64, NOP_ARM64, NOP_ARM64, NOP_ARM64, NOP_ARM64, NOP_ARM64]);
const DEF_ORIG_ARM64 = Buffer.from('03009dd26300a0f2030c00b9', 'hex'); // mov x3, #0xe800; movk x3, #0x3, lsl #16; str w3, [x0, #0xc]
const STR_W3_X0_0C_ARM64 = 0xb9000c03;
const CLAMP_256K_X64 = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
const PATCH_256K_X64 = Buffer.concat([Buffer.from('89d6', 'hex'), Buffer.alloc(12, 0x90)]);
const DEF_ORIG_X64 = Buffer.from('c7400c00e80300', 'hex'); // mov dword [rax+0xc], 256000 (7B)
const DEF_PREFIX_X64 = Buffer.from('c7400c', 'hex');
// 已知 x86-64 Gate 3A clamp 寄存器与原版上限变体表：
// - language_server.exe: cmp edx, 256000; mov esi, 256000; cmovb esi, edx
// - agy.exe CLI:         cmp ecx, 128000; mov edx, 128000; cmovb edx, ecx
const X64_CLAMP_VARIANTS = [
  {
    id: 'edx_esi_256k',
    origLimit: 256000,
    origBuf: CLAMP_256K_X64,
    dynBuf: PATCH_256K_X64,
    constOpcode: 0xbe // mov esi, imm32
  },
  {
    id: 'ecx_edx_128k',
    origLimit: 128000,
    origBuf: Buffer.from('81f900f40100ba00f401000f42d1', 'hex'),
    dynBuf: Buffer.concat([Buffer.from('89ca', 'hex'), Buffer.alloc(12, 0x90)]), // mov edx, ecx + 12 NOP
    constOpcode: 0xba // mov edx, imm32
  }
];
// populateContextWindowMetadata 前端显示上限门禁 (20B, PR #4 cli_serializer_max_ctx)
const SERIALIZER_STOCK_X64 = Buffer.from('4889442470488b8c24a80100008908b830000000', 'hex');
const SERIALIZER_HEAD_X64 = Buffer.from('4889442470c700', 'hex');
const SERIALIZER_TAIL_X64 = Buffer.from('90909090b830000000', 'hex');

// 上下文长度调整工程范围边界与常用预设
const DEFAULT_CHECKPOINT_TOKENS = 256000;
const MIN_ENGINEERING_LIMIT = 16384; // 16 KiB tokens
const MAX_ENGINEERING_LIMIT = 2097152; // 2 MiB tokens
const MIN_OUTPUT_RESERVE_HINT = 40000; // GetDefaultCheckpointConfigForModel 典型输出余量参考
const KNOWN_LIMIT_PRESETS = [256000, 512000, 524288, 900000, 983040, 1000000];

function encodeMovz64Arm64(reg, imm16) {
  return (0xd2800000 | ((imm16 & 0xffff) << 5) | (reg & 0x1f)) >>> 0;
}

function encodeMovk64Lsl16Arm64(reg, imm16) {
  return (0xf2a00000 | ((imm16 & 0xffff) << 5) | (reg & 0x1f)) >>> 0;
}

function decodeMov32Arm64(w0, w1, expectedReg) {
  const mask = 0xffe0001f;
  const expectZ = (0xd2800000 | (expectedReg & 0x1f)) >>> 0;
  const expectK = (0xf2a00000 | (expectedReg & 0x1f)) >>> 0;
  if (((w0 & mask) >>> 0) !== expectZ || ((w1 & mask) >>> 0) !== expectK) return null;
  const lo = (w0 >>> 5) & 0xffff;
  const hi = (w1 >>> 5) & 0xffff;
  return (((hi << 16) | lo) >>> 0);
}

function buildClampConstArm64(limitTokens) {
  const out = Buffer.alloc(24);
  const val = limitTokens >>> 0;
  out.writeUInt32LE(encodeMovz64Arm64(3, val & 0xffff), 0);
  out.writeUInt32LE(encodeMovk64Lsl16Arm64(3, (val >>> 16) & 0xffff), 4);
  for (let i = 8; i < 24; i += 4) NOP_ARM64.copy(out, i);
  return out;
}

function buildDefConstArm64(limitTokens) {
  const out = Buffer.alloc(12);
  const val = limitTokens >>> 0;
  out.writeUInt32LE(encodeMovz64Arm64(3, val & 0xffff), 0);
  out.writeUInt32LE(encodeMovk64Lsl16Arm64(3, (val >>> 16) & 0xffff), 4);
  out.writeUInt32LE(STR_W3_X0_0C_ARM64, 8);
  return out;
}

function decodeArm64BlTarget(instr, pcVA) {
  if (((instr & 0xfc000000) >>> 0) !== 0x94000000) return null;
  let imm26 = instr & 0x03ffffff;
  if (imm26 & 0x02000000) imm26 -= 0x04000000;
  return pcVA + BigInt(imm26 * 4);
}

/** 根据变体 ID 或 gate3a 对象查找对应的 x86-64 clamp 指令模板 */
function findClampVariant(variantOrGate3a) {
  const variantId = typeof variantOrGate3a === 'string'
    ? variantOrGate3a
    : variantOrGate3a?.clampVariant;
  return X64_CLAMP_VARIANTS.find((v) => v.id === variantId) || X64_CLAMP_VARIANTS[0];
}

function buildClampOrigX64(variantOrGate3a) {
  return findClampVariant(variantOrGate3a).origBuf;
}

function buildClampDynX64(variantOrGate3a) {
  return findClampVariant(variantOrGate3a).dynBuf;
}

function buildClampConstX64(limitTokens, variantOrGate3a) {
  const out = Buffer.alloc(14, 0x90);
  out[0] = findClampVariant(variantOrGate3a).constOpcode;
  out.writeUInt32LE(limitTokens >>> 0, 1);
  return out;
}

function buildDefConstX64(limitTokens) {
  const out = Buffer.alloc(7);
  DEF_PREFIX_X64.copy(out, 0);
  out.writeUInt32LE(limitTokens >>> 0, 3);
  return out;
}

function buildSerializerConstX64(limitTokens) {
  const out = Buffer.alloc(20);
  SERIALIZER_HEAD_X64.copy(out, 0);
  out.writeUInt32LE(limitTokens >>> 0, 7);
  SERIALIZER_TAIL_X64.copy(out, 11);
  return out;
}

/**
 * 校验自定义上下文长度输入（正整数、安全整数与工程可写边界）
 * 注意：可写边界仅代表补丁指令所能安全编码的工程范围，不代表模型必然支持。
 */
function validateContextLimit(rawInput, options = {}) {
  let num = null;
  if (typeof rawInput === 'number') {
    if (!Number.isSafeInteger(rawInput) || rawInput <= 0) {
      return { ok: false, error: '上下文长度必须为正安全整数（tokens）', min: MIN_ENGINEERING_LIMIT, max: MAX_ENGINEERING_LIMIT };
    }
    num = rawInput;
  } else if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, error: '上下文长度必须为纯正整数（tokens），不可包含小数或非数字字符', min: MIN_ENGINEERING_LIMIT, max: MAX_ENGINEERING_LIMIT };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return { ok: false, error: '上下文长度超出安全整数范围', min: MIN_ENGINEERING_LIMIT, max: MAX_ENGINEERING_LIMIT };
    }
    num = parsed;
  } else {
    return { ok: false, error: '无效的上下文长度输入类型', min: MIN_ENGINEERING_LIMIT, max: MAX_ENGINEERING_LIMIT };
  }

  if (num < MIN_ENGINEERING_LIMIT || num > MAX_ENGINEERING_LIMIT) {
    return {
      ok: false,
      error: `上下文长度超出工程可写范围 (${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens)`,
      min: MIN_ENGINEERING_LIMIT,
      max: MAX_ENGINEERING_LIMIT
    };
  }

  const warnings = [];
  if (num < 65536) {
    warnings.push(`目标值 (${num.toLocaleString('en-US')}) 较小，扣除至少 ${MIN_OUTPUT_RESERVE_HINT.toLocaleString('en-US')} tokens 输出预留与系统提示词后可用历史空间非常有限。`);
  }
  const serviceLimit = Number(options.serviceLimit || 0);
  if (serviceLimit > 0 && num > serviceLimit) {
    warnings.push(`目标值 (${num.toLocaleString('en-US')}) 高于当前观测到的服务端限制 (${serviceLimit.toLocaleString('en-US')})，实际长请求仍可能被服务端拒绝。`);
  }

  return {
    ok: true,
    limitTokens: num,
    warnings,
    min: MIN_ENGINEERING_LIMIT,
    max: MAX_ENGINEERING_LIMIT,
    scopeNote: `当前工程可写范围为 ${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens，仅代表补丁参数可写入范围，非模型保证支持范围。`
  };
}

const AUTHOR_INFO = {
  name: 'Linux.do @23375',
  credit: '解锁方案来源：原作者帖子 (Linux.do @23375)',
  url: 'https://linux.do/t/topic/3117832',
  disclaimer: '本功能为非官方本地技术修补，更新官方客户端后可能失效；账号风险未知，无法承诺“不会封号”。'
};

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 探测本机 Antigravity 桌面端 language_server 二进制路径
 */
function detectTargetBinary(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`指定的目标文件不存在: ${customPath}`);
  }

  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
      path.join(programFiles, 'antigravity', 'resources', 'bin', 'language_server.exe'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'bin', 'language_server.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
      '/Applications/Antigravity IDE.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'bin', 'language_server'),
      '/Applications/Google Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Google Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server')
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/bin/language_server',
      '/usr/lib/antigravity/resources/bin/language_server',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 探测本机独立 Antigravity CLI (agy) 原生可执行文件路径
 */
function detectCliBinary(customPath, options = {}) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`指定的目标文件不存在: ${customPath}`);
  }
  const { resolveCliExecutable } = require('./meter-cli-launcher');
  const res = resolveCliExecutable(null, options);
  if (!res || !res.ok) return null;
  let candidate = res.exePath || res.cliPath;
  if (!candidate) return null;
  const lower = String(candidate).toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const sib = path.join(path.dirname(candidate), 'agy.exe');
    if (fs.existsSync(sib)) candidate = sib;
    else return null;
  }
  return fs.existsSync(candidate) ? path.resolve(candidate) : null;
}

/**
 * 二进制容器解析：提取 .text 节区信息
 */
function findTextSection(buf) {
  if (buf.length < 64) throw new Error('文件体积过小，非有效可执行文件');

  // Mach-O 64-bit LE（严格复用 parseMachO64 进行头长度与段偏移边界校验）
  if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
    const cputype = buf.readUInt32LE(4);
    const macho = parseMachO64(buf);
    if (!macho) {
      throw new Error('Mach-O 头部损坏、截断或段偏移越界，已拒绝解析与写入');
    }
    if (!macho.arch) throw new Error(`不支持的 Mach-O cputype: 0x${cputype.toString(16)}`);
    const textSect = macho.sections.find((s) => s.sectname === '__text');
    if (textSect) {
      if (textSect.offset + textSect.size > buf.length) {
        throw new Error('Mach-O __text 段偏移或大小超出文件边界，已拒绝解析');
      }
      return {
        textVA: textSect.addr,
        textOff: textSect.offset,
        textSize: textSect.size,
        arch: macho.arch,
        format: 'Mach-O',
        buildId: macho.buildKey
      };
    }
    throw new Error('未在 Mach-O 中找到 __text 段');
  }

  // ELF 64-bit LE
  if (buf.subarray(0, 4).toString('ascii') === '\x7fELF') {
    if (buf[4] !== 2 || buf[5] !== 1) throw new Error('仅支持 64 位小端 ELF');
    const machine = buf.readUInt16LE(18);
    const arch = machine === 0xb7 ? 'arm64' : (machine === 0x3e ? 'x86-64' : null);
    if (!arch) throw new Error(`不支持的 ELF 架构: 0x${machine.toString(16)}`);
    const shoff = Number(buf.readBigUInt64LE(40));
    const shentsize = buf.readUInt16LE(58);
    const shnum = buf.readUInt16LE(60);
    const shstrndx = buf.readUInt16LE(62);
    const strtabOff = Number(buf.readBigUInt64LE(shoff + shstrndx * shentsize + 24));

    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      const nameoff = buf.readUInt32LE(sh);
      const end = buf.indexOf(0, strtabOff + nameoff);
      const name = buf.subarray(strtabOff + nameoff, end).toString('utf8');
      if (name === '.text') {
        const addr = buf.readBigUInt64LE(sh + 16);
        const offset = Number(buf.readBigUInt64LE(sh + 24));
        return { textVA: addr, textOff: offset, arch, format: 'ELF' };
      }
    }
    throw new Error('未在 ELF 中找到 .text 段');
  }

  // PE (Windows)
  if (buf[0] === 0x4d && buf[1] === 0x5a) { // MZ
    const peOff = buf.readUInt32LE(0x3c);
    if (buf.subarray(peOff, peOff + 4).toString('ascii') !== 'PE\0\0') {
      throw new Error('无效的 PE 签名');
    }
    const machine = buf.readUInt16LE(peOff + 4);
    const arch = machine === 0x8664 ? 'x86-64' : (machine === 0xaa64 ? 'arm64' : null);
    if (!arch) throw new Error(`不支持的 PE 机器架构: 0x${machine.toString(16)}`);
    const nsec = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const opt = peOff + 24;
    const peTimeDateStamp = buf.readUInt32LE(peOff + 8);
    const imageBase = buf.readBigUInt64LE(opt + 24);
    const peSizeOfImage = buf.readUInt32LE(opt + 56);
    let sect = opt + optSize;
    for (let i = 0; i < nsec; i++) {
      const name = buf.subarray(sect, sect + 8).toString().replace(/\0+$/, '');
      if (name === '.text') {
        const vaddr = buf.readUInt32LE(sect + 12);
        const rawptr = buf.readUInt32LE(sect + 20);
        const buildId = `${peTimeDateStamp.toString(16)}_${peSizeOfImage.toString(16)}_${rawptr.toString(16)}`;
        return { textVA: imageBase + BigInt(vaddr), textOff: rawptr, arch, format: 'PE', peTimeDateStamp, peSizeOfImage, buildId };
      }
      sect += 40;
    }
    throw new Error('未在 PE 中找到 .text 段');
  }

  throw new Error('无法识别的可执行文件格式 (必须为 PE、Mach-O 或 ELF)');
}

/**
 * 定位 Go .gopclntab 符号表基址
 */
function findPclntab(buf) {
  const magic = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]);
  let pos = 0;
  while (pos < buf.length - 64) {
    const idx = buf.indexOf(magic, pos);
    if (idx < 0) break;
    pos = idx + 1;
    const minLC = buf[idx + 6];
    const ptrSize = buf[idx + 7];
    if ((minLC === 1 || minLC === 2 || minLC === 4) && ptrSize === 8) {
      const nfunc = Number(buf.readBigUInt64LE(idx + 8));
      if (nfunc > 1000 && nfunc < 5000000) {
        const fnOff = Number(buf.readBigUInt64LE(idx + 32));
        if (idx + fnOff + 16 <= buf.length) {
          const head = buf.subarray(idx + fnOff, idx + fnOff + 16);
          let valid = true;
          for (let b of head) {
            if (!( (b >= 0x20 && b < 0x7f) || b === 0 )) {
              valid = false;
              break;
            }
          }
          if (valid) {
            return { base: idx, nfunc };
          }
        }
      }
    }
  }
  throw new Error('未在二进制中检测到 Go .gopclntab 符号表（可能已被深度 strip 或非 Go 编译）');
}

/**
 * 解析 Go 函数符号表
 */
function buildFunctions(buf, targetSymbols) {
  const { base, nfunc } = findPclntab(buf);
  const fnstart = base + Number(buf.readBigUInt64LE(base + 32));
  const pcln = base + Number(buf.readBigUInt64LE(base + 64));

  const targetSet = new Set(targetSymbols || [
    FUNC_OFFERS,
    FUNC_STORE_CW,
    FUNC_STORE_CHOICE,
    FUNC_CHECKPOINT,
    FUNC_EXP_CHECKPOINT,
    FUNC_SELECT_EXP_KEY,
    FUNC_OVERRIDE
  ]);

  const funcs = {};
  let targetsFound = 0;

  for (let i = 0; i < nfunc; i++) {
    const off = pcln + i * 8;
    if (off + 16 > buf.length) break;
    const entryoff = buf.readUInt32LE(off);
    const funcoff = buf.readUInt32LE(off + 4);
    const nextEntry = buf.readUInt32LE(off + 8);

    const rec = pcln + funcoff;
    if (rec + 8 > buf.length) continue;
    const nameoff = buf.readInt32LE(rec + 4);
    const s = fnstart + nameoff;
    const end = buf.indexOf(0, s);
    if (end < 0 || end - s > 500) continue;

    const fullName = buf.subarray(s, end).toString('ascii');
    const shortName = fullName.split('/').pop();
    if (targetSet.has(shortName)) {
      if (!funcs[shortName]) {
        funcs[shortName] = {
          entryoff,
          size: Math.max(0, nextEntry - entryoff),
          fullName
        };
        targetsFound++;
        if (targetsFound >= targetSet.size) break;
      }
    }
  }

  return { funcs, totalSymbols: nfunc };
}

function narrowCandidatesByAnchor(hits, anchorOffset, window = 8192) {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const near = hits.filter((h) => Math.abs(h.offset - anchorOffset) <= window);
  return near.length === 1 ? near[0] : null;
}

/**
 * 检测 Gate 3A 状态（融合 PR #3 的 clamp + default 双站点与 CONST/DYN/ORIG 检测）
 */
function checkGate3A(buf, textOff, sym, arch, options = {}) {
  const fnOff = textOff + sym.entryoff;
  const fnSize = sym.size || 0x600;
  const body = buf.subarray(fnOff, Math.min(buf.length, fnOff + fnSize));

  if (arch === 'arm64') {
    const clampHits = [];
    for (let i = 0; i <= body.length - 24; i += 4) {
      const slice = body.subarray(i, i + 24);
      if (slice.equals(CLAMP_256K_ARM64)) {
        clampHits.push({ state: 'ORIG', mode: 'default', limit: DEFAULT_CHECKPOINT_TOKENS, offset: fnOff + i });
      } else if (slice.equals(PATCH_256K_ARM64)) {
        clampHits.push({ state: 'DYN', mode: 'dynamic', limit: null, offset: fnOff + i });
      } else {
        const w0 = slice.readUInt32LE(0);
        const w1 = slice.readUInt32LE(4);
        const imm = decodeMov32Arm64(w0, w1, 3);
        if (
          imm !== null &&
          imm >= 4096 &&
          imm <= 16 * 1024 * 1024 &&
          slice.subarray(8, 12).equals(NOP_ARM64) &&
          slice.subarray(12, 16).equals(NOP_ARM64) &&
          slice.subarray(16, 20).equals(NOP_ARM64) &&
          slice.subarray(20, 24).equals(NOP_ARM64)
        ) {
          clampHits.push({ state: 'CONST', mode: 'fixed', limit: imm, offset: fnOff + i });
        }
      }
    }

    const candidateDefImms = new Set([DEFAULT_CHECKPOINT_TOKENS, ...KNOWN_LIMIT_PRESETS]);
    for (const h of clampHits) {
      if (h.state === 'CONST' && h.limit) candidateDefImms.add(h.limit);
    }

    const defHits = [];
    for (let i = 0; i <= body.length - 12; i += 4) {
      if (body.readUInt32LE(i + 8) === STR_W3_X0_0C_ARM64) {
        const imm = decodeMov32Arm64(body.readUInt32LE(i), body.readUInt32LE(i + 4), 3);
        if (imm !== null && candidateDefImms.has(imm)) {
          defHits.push({
            state: imm === DEFAULT_CHECKPOINT_TOKENS ? 'ORIG' : 'CONST',
            limit: imm,
            offset: fnOff + i,
            relOffset: i
          });
        }
      }
    }

    if (clampHits.length === 0) {
      return { status: 'unknown', reason: '未在 ARM64 utils.GetCheckpointConfig 中定位到 Gate 3A clamp 站点' };
    }

    let chosenClamp = clampHits.length === 1 ? clampHits[0] : null;
    let chosenDef = defHits.length === 1 ? defHits[0] : null;

    if (!chosenDef && defHits.length > 1) {
      // 优先锁定紧跟在 cmp w3, #0 (7100007f); b.gt +16 (5400008c) 之后的 default 站点
      const guardedHits = defHits.filter((d) => {
        const r = d.relOffset;
        return r >= 8 && body.readUInt32LE(r - 8) === 0x7100007f && body.readUInt32LE(r - 4) === 0x5400008c;
      });
      if (guardedHits.length === 1) {
        chosenDef = guardedHits[0];
      } else if (chosenClamp) {
        chosenDef = narrowCandidatesByAnchor(defHits, chosenClamp.offset, 8192);
      }
    }
    if (!chosenClamp && chosenDef) {
      chosenClamp = narrowCandidatesByAnchor(clampHits, chosenDef.offset, 8192);
    }
    if (!chosenClamp) {
      return {
        status: 'unknown',
        reason: `检测到 ${clampHits.length} 个 ARM64 Gate 3A clamp 候选且无法唯一收窄，拒绝写入。`,
        clampCandidateCount: clampHits.length,
        defaultCandidateCount: defHits.length
      };
    }
    if (defHits.length > 1 && !chosenDef) {
      return {
        status: 'unknown',
        reason: `检测到 ${defHits.length} 个 ARM64 Gate 3A default 候选且无法唯一收窄，拒绝写入。`,
        clampCandidateCount: clampHits.length,
        defaultCandidateCount: defHits.length
      };
    }

    const hasDefaultSite = Boolean(chosenDef);
    const baseInfo = {
      offset: chosenClamp.offset,
      length: 24,
      mode: chosenClamp.mode,
      limit: chosenClamp.limit,
      clampState: chosenClamp.state,
      defaultOffset: chosenDef ? chosenDef.offset : null,
      defaultLength: chosenDef ? 12 : 0,
      defaultLimit: chosenDef ? chosenDef.limit : null,
      defaultState: chosenDef ? chosenDef.state : null,
      hasDefaultSite,
      clampCandidateCount: clampHits.length,
      defaultCandidateCount: defHits.length
    };

    if (hasDefaultSite) {
      if (chosenClamp.state === 'ORIG' && chosenDef.state !== 'ORIG') {
        return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp 为官方默认 (256,000)，但 default 站点为 ${chosenDef.limit.toLocaleString('en-US')}` };
      }
      if (chosenClamp.state === 'DYN' && chosenDef.state !== 'ORIG') {
        return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp 为动态透传 (DYN)，但 default 站点未处于官方默认值 (实测 ${chosenDef.limit.toLocaleString('en-US')})` };
      }
      if (chosenClamp.state === 'CONST' && chosenDef.limit !== chosenClamp.limit) {
        return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp (${chosenClamp.limit.toLocaleString('en-US')}) 与 default (${chosenDef.limit.toLocaleString('en-US')}) 数值不一致` };
      }
    }

    return {
      ...baseInfo,
      status: chosenClamp.state === 'ORIG' ? 'unpatched' : 'patched'
    };
  }

  // x86-64: 在 utils.GetCheckpointConfig 函数体内搜寻所有 CLAMP 候选（兼容 256K edx/esi 与 agy 128K ecx/edx）
  const clampHits = [];
  for (let i = 0; i <= body.length - 14; i++) {
    const slice = body.subarray(i, i + 14);
    for (const variant of X64_CLAMP_VARIANTS) {
      if (slice.equals(variant.origBuf)) {
        clampHits.push({
          state: 'ORIG',
          mode: 'default',
          limit: variant.origLimit,
          origLimit: variant.origLimit,
          clampVariant: variant.id,
          offset: fnOff + i
        });
        break;
      }
      if (slice.equals(variant.dynBuf)) {
        clampHits.push({
          state: 'DYN',
          mode: 'dynamic',
          limit: null,
          origLimit: variant.origLimit,
          clampVariant: variant.id,
          offset: fnOff + i
        });
        break;
      }
      if (slice[0] === variant.constOpcode && slice.subarray(5, 14).every((b) => b === 0x90)) {
        const imm = slice.readUInt32LE(1);
        if (imm >= 4096 && imm <= 16 * 1024 * 1024) {
          clampHits.push({
            state: 'CONST',
            mode: 'fixed',
            limit: imm,
            origLimit: variant.origLimit,
            clampVariant: variant.id,
            offset: fnOff + i
          });
          break;
        }
      }
    }
  }

  // 收集已知与当前已写入的 default immediate 列表（仅依据当前二进制已存在的 CONST/ORIG 值，不提前混入待写入的 expectedLimit 以免碰撞原生常量）
  const candidateDefImms = new Set([DEFAULT_CHECKPOINT_TOKENS, ...KNOWN_LIMIT_PRESETS]);
  for (const h of clampHits) {
    if (h.state === 'CONST' && h.limit) candidateDefImms.add(h.limit);
  }

  // 在函数体内扫描所有 default 站点 (c7 40 0c <imm32>)
  const defHits = [];
  for (let i = 0; i <= body.length - 7; i++) {
    if (body[i] === 0xc7 && body[i + 1] === 0x40 && body[i + 2] === 0x0c) {
      const imm = body.readUInt32LE(i + 3);
      if (candidateDefImms.has(imm)) {
        defHits.push({
          state: imm === DEFAULT_CHECKPOINT_TOKENS ? 'ORIG' : 'CONST',
          limit: imm,
          offset: fnOff + i,
          relOffset: i
        });
      }
    }
  }

  if (clampHits.length === 0) {
    return { status: 'unknown', reason: '未在 utils.GetCheckpointConfig 中定位到 Gate 3A clamp 站点' };
  }

  // 多候选消歧：
  // 1) 当 default site 与函数内原生常量（如 rel+1271 处的原生 1,000,000）碰撞时，
  //    优先使用紧邻前置指令锚点 `cmp dword [rdx+0x14], 0; jg +7` (`83 7a 14 00 7f 07`) 唯一锁定真正 default 站点；
  // 2) 次选任意 `jcc +7` (`0x70..0x7f 0x07`) 紧邻前导；
  // 3) 兜底再以 ±8192 锚点距离窗口收窄，仍不唯一则拒写。
  let chosenClamp = clampHits.length === 1 ? clampHits[0] : null;
  let chosenDef = defHits.length === 1 ? defHits[0] : null;

  if (!chosenClamp && defHits.length === 1) {
    chosenClamp = narrowCandidatesByAnchor(clampHits, defHits[0].offset, 8192);
  }
  if (!chosenDef && defHits.length > 1) {
    const exactGuardedHits = defHits.filter((d) => {
      const r = d.relOffset;
      return (
        r >= 6 &&
        body[r - 6] === 0x83 &&
        body[r - 5] === 0x7a &&
        body[r - 4] === 0x14 &&
        body[r - 3] === 0x00 &&
        body[r - 2] === 0x7f &&
        body[r - 1] === 0x07
      );
    });
    if (exactGuardedHits.length === 1) {
      chosenDef = exactGuardedHits[0];
    } else {
      const guardedHits = defHits.filter((d) => {
        const r = d.relOffset;
        return r >= 2 && body[r - 2] >= 0x70 && body[r - 2] <= 0x7f && body[r - 1] === 0x07;
      });
      if (guardedHits.length === 1) {
        chosenDef = guardedHits[0];
      } else if (chosenClamp) {
        chosenDef = narrowCandidatesByAnchor(defHits, chosenClamp.offset, 8192);
      }
    }
  }
  // 两边都多候选时尝试双向互锁：仅当有唯一的一组距离 <= 8192 时收窄
  if (!chosenClamp && clampHits.length > 1 && defHits.length > 1) {
    if (chosenDef) {
      chosenClamp = narrowCandidatesByAnchor(clampHits, chosenDef.offset, 8192);
    } else {
      const pairs = [];
      for (const c of clampHits) {
        for (const d of defHits) {
          if (Math.abs(c.offset - d.offset) <= 8192) pairs.push([c, d]);
        }
      }
      if (pairs.length === 1) {
        chosenClamp = pairs[0][0];
        chosenDef = pairs[0][1];
      }
    }
  }

  if (!chosenClamp) {
    return {
      status: 'unknown',
      reason: `检测到 ${clampHits.length} 个 Gate 3A clamp 候选且无法通过锚点唯一收窄，拒绝写入。`,
      clampCandidateCount: clampHits.length,
      defaultCandidateCount: defHits.length
    };
  }
  if (defHits.length > 1 && !chosenDef) {
    return {
      status: 'unknown',
      reason: `检测到 ${defHits.length} 个 Gate 3A default 候选且无法唯一收窄，拒绝写入。`,
      clampCandidateCount: clampHits.length,
      defaultCandidateCount: defHits.length
    };
  }

  const hasDefaultSite = Boolean(chosenDef);
  const origLimit = chosenClamp.origLimit || DEFAULT_CHECKPOINT_TOKENS;
  const baseInfo = {
    offset: chosenClamp.offset,
    length: 14,
    mode: chosenClamp.mode,
    limit: chosenClamp.limit,
    origLimit,
    clampVariant: chosenClamp.clampVariant || 'edx_esi_256k',
    clampState: chosenClamp.state,
    defaultOffset: chosenDef ? chosenDef.offset : null,
    defaultLength: chosenDef ? 7 : 0,
    defaultLimit: chosenDef ? chosenDef.limit : null,
    defaultState: chosenDef ? chosenDef.state : null,
    hasDefaultSite,
    clampCandidateCount: clampHits.length,
    defaultCandidateCount: defHits.length
  };

  // 一致性验证：若 clamp 与 default 状态矛盾，必须报告 partial 状态，禁止盲目覆盖
  if (hasDefaultSite) {
    if (chosenClamp.state === 'ORIG' && chosenDef.state !== 'ORIG') {
      return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp 为官方默认 (${origLimit.toLocaleString('en-US')})，但 default 站点为 ${chosenDef.limit.toLocaleString('en-US')}` };
    }
    if (chosenClamp.state === 'DYN' && chosenDef.state !== 'ORIG') {
      return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp 为动态透传 (DYN)，但 default 站点未处于官方默认值 (实测 ${chosenDef.limit.toLocaleString('en-US')})` };
    }
    if (chosenClamp.state === 'CONST' && chosenDef.limit !== chosenClamp.limit) {
      return { ...baseInfo, status: 'partial', reason: `Gate 3A 部分匹配：clamp (${chosenClamp.limit.toLocaleString('en-US')}) 与 default (${chosenDef.limit.toLocaleString('en-US')}) 数值不一致` };
    }
  }

  return {
    ...baseInfo,
    status: chosenClamp.state === 'ORIG' ? 'unpatched' : 'patched'
  };
}

/**
 * 检测 Gate 3B 状态（验证唯一 call->selectCheckpointExperimentKey->test al,al->jcc 站点）
 */
function checkGate3B(buf, textVA, textOff, symExp, symSelect, arch) {
  const fnOff = textOff + symExp.entryoff;
  const fnSize = symExp.size || 0x200;
  const fnVA = textVA + BigInt(symExp.entryoff);
  const body = buf.subarray(fnOff, Math.min(buf.length, fnOff + fnSize));

  if (arch === 'x86-64') {
    if (!symSelect) return { status: 'unknown', reason: '缺符号 config.selectCheckpointExperimentKey' };
    const selVA = textVA + BigInt(symSelect.entryoff);
    const hits = [];

    for (let rel = 0; rel < body.length - 12; rel++) {
      if (body[rel] === 0xe8) {
        const disp = body.readInt32LE(rel + 1);
        if (fnVA + BigInt(rel + 5 + disp) === selVA) {
          const window = body.subarray(rel + 5, Math.min(body.length, rel + 105));
          const tIdx = window.indexOf(Buffer.from([0x84, 0xc0])); // test %al, %al
          if (tIdx >= 0) {
            const jOff = rel + 5 + tIdx + 2;
            const b1 = body[jOff];
            const b2 = body[jOff + 1];
            if (b1 === 0x75) {
              hits.push({ status: 'unpatched', offset: fnOff + jOff, length: 2, jumpType: 'rel8', origBytes: [b1, b2], origHex: Buffer.from([b1, b2]).toString('hex') });
            } else if (b1 === 0x0f && b2 === 0x85) {
              const orig = body.subarray(jOff, jOff + 6);
              hits.push({ status: 'unpatched', offset: fnOff + jOff, length: 6, jumpType: 'rel32', origBytes: Array.from(orig), origHex: Buffer.from(orig).toString('hex') });
            } else if (b1 === 0x90 && b2 === 0x90) {
              const run = (jOff + 6 <= body.length && body.subarray(jOff, jOff + 6).every((b) => b === 0x90)) ? 6 : 2;
              hits.push({ status: 'patched', offset: fnOff + jOff, length: run });
            } else {
              hits.push({ status: 'unknown', offset: fnOff + jOff, reason: 'jcc 指令形状不识别' });
            }
          }
        }
      }
    }

    if (hits.length === 0) {
      return { status: 'unknown', reason: '未在函数体内找到 call->selectCheckpointExperimentKey->jcc 特征' };
    }
    if (hits.length > 1) {
      return { status: 'unknown', reason: `检测到 ${hits.length} 个 Gate 3B 候选站点，拒绝写入`, candidateCount: hits.length };
    }
    return hits[0];
  }

  if (arch === 'arm64') {
    if (symSelect) {
      const selVA = textVA + BigInt(symSelect.entryoff);
      const hits = [];
      for (let rel = 0; rel <= body.length - 8; rel += 4) {
        const instr = body.readUInt32LE(rel);
        const targetVA = decodeArm64BlTarget(instr, fnVA + BigInt(rel));
        if (targetVA === selVA) {
          const winEnd = Math.min(body.length - 4, rel + 128);
          for (let jOff = rel + 4; jOff <= winEnd; jOff += 4) {
            const w = body.readUInt32LE(jOff);
            // 匹配 tbnz/tbz/cbz/cbnz 条件分支（如 tbnz w0, #0, +12 -> 0x37000060）或已写入的 NOP
            const isTbzTbnz = ((w & 0x7e000000) >>> 0) === 0x36000000;
            const isCbzCbnz = ((w & 0x7e000000) >>> 0) === 0x34000000;
            if (isTbzTbnz || isCbzCbnz) {
              const orig = body.subarray(jOff, jOff + 4);
              hits.push({
                status: 'unpatched',
                offset: fnOff + jOff,
                length: 4,
                jumpType: 'arm64-branch',
                origBytes: Array.from(orig),
                origHex: Buffer.from(orig).toString('hex')
              });
              break;
            }
            if (w === 0xd503201f) {
              hits.push({ status: 'patched', offset: fnOff + jOff, length: 4 });
              break;
            }
          }
        }
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        return { status: 'unknown', reason: `检测到 ${hits.length} 个 ARM64 Gate 3B 候选站点，拒绝写入`, candidateCount: hits.length };
      }
    }

    // 兼容旧版 ARM64 特征兜底
    for (let rel = 4; rel < body.length - 16; rel += 4) {
      const w0 = body.readUInt32LE(rel);
      const w1 = body.readUInt32LE(rel + 4);
      if ((w0 & 0xff00001f) === 0xb4000000 && w1 === 0xb9000c1f) {
        return { status: 'patched', offset: fnOff + rel, length: 4 };
      }
      if ((w0 & 0xff00001f) === 0xb4000001) { // cbz x1, ...
        const orig = body.subarray(rel, rel + 4);
        return { status: 'unpatched', offset: fnOff + rel, length: 4, origBytes: Array.from(orig), origHex: Buffer.from(orig).toString('hex') };
      }
    }
    return { status: 'unknown', reason: '未在 ARM64 函数体内定位到 Gate 3B 跳转站点' };
  }

  return { status: 'unknown' };
}

/**
 * 检测 Desktop/CLI populateContextWindowMetadata 前端上限返回值门禁 (PR #4 cli_serializer_max_ctx)
 * @param {Buffer} buf 目标二进制缓冲区
 * @param {string} arch 架构
 * @returns {{present: boolean, status: string, offset: number|null, limit: number|null}}
 */
function checkSerializerGate(buf, arch) {
  if (arch !== 'x86-64' || !Buffer.isBuffer(buf)) {
    return { present: false, status: 'absent', offset: null, limit: null };
  }
  const stockHits = [];
  let idx = -1;
  while ((idx = buf.indexOf(SERIALIZER_STOCK_X64, idx + 1)) !== -1) {
    stockHits.push(idx);
    if (stockHits.length > 2) break;
  }
  if (stockHits.length === 1) {
    return { present: true, status: 'unpatched', offset: stockHits[0], limit: null };
  }
  if (stockHits.length > 1) {
    return { present: false, status: 'ambiguous', offset: null, limit: null };
  }

  // 检查已改写形如 4889442470 c700 <imm32> 90909090 b830000000 (20B)
  const patchedHits = [];
  let p = -1;
  while ((p = buf.indexOf(SERIALIZER_HEAD_X64, p + 1)) !== -1) {
    if (p + 20 <= buf.length && buf.subarray(p + 11, p + 20).equals(SERIALIZER_TAIL_X64)) {
      const imm = buf.readUInt32LE(p + 7);
      if (imm >= 4096 && imm <= 16 * 1024 * 1024) {
        patchedHits.push({ offset: p, limit: imm });
        if (patchedHits.length > 2) break;
      }
    }
  }
  if (patchedHits.length === 1) {
    return { present: true, status: 'patched', offset: patchedHits[0].offset, limit: patchedHits[0].limit };
  }
  return { present: false, status: patchedHits.length > 1 ? 'ambiguous' : 'absent', offset: null, limit: null };
}

/**
 * 格式化配置同步用上下文标签（与 PR #3 / PR #4 约定一致，绝不把 dynamic 误标成 983040）
 */
function formatSyncContextLabel(mode, limitTokens) {
  if (mode === 'default' || !mode) return null;
  if (mode === 'dynamic') return 'DYNAMIC';
  const n = Number(limitTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 512000) return '512K';
  if (n === 900000) return '900K';
  if (n === 983040) return '983K';
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

/**
 * 同步 ~/.gemini/config/config.json、antigravity-cli/settings.json 与 context-mode.json
 * 仅在明确启用 options.syncConfigFiles 或指定隔离 options.homeDir 时写盘
 */
function syncExternalContextConfigs(mode, limitTokens, options = {}) {
  const shouldWrite = options.syncConfigFiles === true || Boolean(options.homeDir);
  if (!shouldWrite) return [];
  // 测试或隔离上下文中若未显式提供隔离 homeDir，严禁回落写入用户真实主目录
  const isIsolated = Boolean(
    options.backupDir ||
    options.targetPath ||
    options.stateDir ||
    options.skipProcessCheck ||
    process.env.NODE_TEST_CONTEXT
  );
  if (isIsolated && !options.homeDir) {
    return [];
  }
  const home = options.homeDir || os.homedir();
  const label = formatSyncContextLabel(mode, limitTokens);
  const synced = [];

  const shouldSyncCli = options.syncCliConfigs !== false;
  if (shouldSyncCli) {
    const jsonTargets = [
      { filePath: path.join(home, '.gemini', 'config', 'config.json'), createDir: true },
      { filePath: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), createDir: false }
    ];
    for (const item of jsonTargets) {
      try {
        const dir = path.dirname(item.filePath);
        if (!fs.existsSync(dir)) {
          if (item.createDir) fs.mkdirSync(dir, { recursive: true });
          else continue;
        }
        let obj = {};
        if (fs.existsSync(item.filePath)) {
          try {
            obj = JSON.parse(fs.readFileSync(item.filePath, 'utf8')) || {};
          } catch {
            obj = {};
          }
        }
        if (mode === 'default' || mode === 'dynamic' || !label) {
          delete obj.contextWindow;
        } else {
          obj.contextWindow = label;
        }
        const tmp = `${item.filePath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, item.filePath);
        synced.push(item.filePath);
      } catch {}
    }
  }

  // PR #3 context-mode.json 状态桥接（与 patch-language_server.py 对齐使用 getStateDir()）：
  // 清晰记录 mode（default/fixed/dynamic）与数值，绝不将 dynamic 误写为 983040
  try {
    const stateDir = options.stateDir || (options.homeDir ? path.join(options.homeDir, '.gemini', 'antigravity') : getStateDir());
    const modeFile = path.join(stateDir, 'context-mode.json');
    const modeDir = path.dirname(modeFile);
    if (!fs.existsSync(modeDir)) fs.mkdirSync(modeDir, { recursive: true });
    const modePayload = {
      mode: mode === 'dynamic' ? '983k' : (mode === 'fixed' ? '512k' : '256k'),
      effectiveMode: mode,
      limitTokens: mode === 'fixed' ? Number(limitTokens) : null,
      floor: mode === 'fixed' ? Number(limitTokens) : (mode === 'dynamic' ? null : DEFAULT_CHECKPOINT_TOKENS),
      label: mode === 'dynamic' ? 'dynamic' : (mode === 'fixed' ? label : 'default'),
      updatedAt: new Date().toISOString()
    };
    if (mode === 'fixed') {
      modePayload.limit = Number(limitTokens);
    }
    const tmpMode = `${modeFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpMode, JSON.stringify(modePayload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpMode, modeFile);
    synced.push(modeFile);
  } catch {}

  return synced;
}

function readExternalContextConfig(options = {}) {
  const home = options.homeDir || os.homedir();
  let configContextWindow = null;
  for (const cfgPath of [
    path.join(home, '.gemini', 'config', 'config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  ]) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed.contextWindow === 'string' && parsed.contextWindow.trim()) {
        configContextWindow = parsed.contextWindow.trim();
        break;
      }
    } catch {}
  }
  let contextModeBridge = null;
  try {
    const stateDir = options.stateDir || (options.homeDir ? path.join(options.homeDir, '.gemini', 'antigravity') : getStateDir());
    const modeFile = path.join(stateDir, 'context-mode.json');
    if (fs.existsSync(modeFile)) {
      contextModeBridge = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
    }
  } catch {}
  return { configContextWindow, contextModeBridge };
}

/**
 * 备份目录位置（支持通过 options 或环境变量隔离，单测安全）
 */
function getUnlockBackupDir(overrideDir) {
  if (overrideDir && typeof overrideDir === 'string') {
    if (!fs.existsSync(overrideDir)) fs.mkdirSync(overrideDir, { recursive: true });
    return overrideDir;
  }
  if (process.env.AG_UNLOCK_DIR) {
    const dir = path.resolve(process.env.AG_UNLOCK_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(getStateDir(), 'backups', 'context-unlock');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getManifestPath(backupDir) {
  return path.join(getUnlockBackupDir(backupDir), 'manifest.json');
}

function loadManifest(backupDir) {
  const mf = getManifestPath(backupDir);
  if (fs.existsSync(mf)) {
    try {
      return JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveManifest(data, backupDir) {
  const mf = getManifestPath(backupDir);
  fs.writeFileSync(mf, JSON.stringify(data, null, 2), 'utf8');
}

function getGate3BSidecarPath(backupDir) {
  return path.join(getUnlockBackupDir(backupDir), 'gate3b.json');
}

function loadGate3BSidecar(backupDir) {
  const p = getGate3BSidecarPath(backupDir);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveGate3BSidecar(data, backupDir) {
  const p = getGate3BSidecarPath(backupDir);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function isSameTargetPath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

function doesManifestMatchContainer(manifest, container, target) {
  if (!manifest || !isSameTargetPath(manifest.targetPath, target)) return false;
  if (manifest.buildId && container?.buildId && manifest.buildId !== container.buildId) return false;
  if (manifest.peTimeDateStamp !== undefined && container?.peTimeDateStamp !== undefined && manifest.peTimeDateStamp !== container.peTimeDateStamp) return false;
  if (manifest.peSizeOfImage !== undefined && container?.peSizeOfImage !== undefined && manifest.peSizeOfImage !== container.peSizeOfImage) return false;
  return true;
}

function doesSidecarMatchTarget(sidecar, target, container, gate3b) {
  if (!sidecar || !sidecar.origHex) return false;
  if (sidecar.targetPath && !isSameTargetPath(sidecar.targetPath, target)) return false;
  if (sidecar.buildId && container?.buildId && sidecar.buildId !== container.buildId) return false;
  if (sidecar.peTimeDateStamp !== undefined && container?.peTimeDateStamp !== undefined && sidecar.peTimeDateStamp !== container.peTimeDateStamp) return false;
  if (sidecar.peSizeOfImage !== undefined && container?.peSizeOfImage !== undefined && sidecar.peSizeOfImage !== container.peSizeOfImage) return false;
  if (sidecar.offset !== undefined && gate3b?.offset !== undefined && sidecar.offset !== gate3b.offset) return false;
  return true;
}

/**
 * 安全清理因运行中文件占用重命名产生的历史残留文件 (.old_*)
 * 严格只处理 targetDir 目录下且命名匹配 `<targetName>.old_<timestamp>` 的孤立旧文件
 * 绝对不触碰原版备份 (.orig)、当前目标文件及其他无关文件
 */
function cleanupOldReplacedFiles(targetDir, targetFileName, excludePath = null) {
  const cleaned = [];
  const retained = [];
  if (!targetDir || !fs.existsSync(targetDir) || !targetFileName) {
    return { cleaned, retained };
  }
  const escapedName = targetFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oldPattern = new RegExp(`^${escapedName}\\.old_\\d+$`, 'i');
  try {
    const files = fs.readdirSync(targetDir);
    for (const f of files) {
      if (oldPattern.test(f)) {
        const full = path.join(targetDir, f);
        if (excludePath && path.resolve(full) === path.resolve(excludePath)) {
          continue;
        }
        try {
          fs.unlinkSync(full);
          cleaned.push(f);
        } catch (err) {
          retained.push({ file: f, reason: err.code || err.message });
        }
      }
    }
  } catch {}
  return { cleaned, retained };
}

/**
 * 进程状态缓存（短生命周期，避免面板快速连续刷新触发重复进程枚举）
 */
let cachedProcInfo = null;
let cachedProcAt = 0;
let inFlightProcQuery = null;

/**
 * 辅助检查文件独占写锁（耗时 < 0.2ms，仅作为辅助信号，不能直接代表进程正在运行）
 */
function checkFileWriteLock(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM';
  }
}

/**
 * 纯异步获取运行中 language_server 进程的详细信息（PID、路径、启动时间毫秒）
 * 包含：并发去重 (In-flight Promise 复用)、2.5s 短期缓存、3000ms 超时控制，绝不阻塞主进程事件循环
 */
async function getRunningLanguageServerInfoAsync(targetPath, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProcInfo && (now - cachedProcAt < 2500)) {
    return cachedProcInfo;
  }

  if (inFlightProcQuery) {
    return inFlightProcQuery;
  }

  const queryPromise = (async () => {
    const result = {
      isRunning: false,
      locked: checkFileWriteLock(targetPath),
      pid: null,
      path: null,
      startTimeMs: null,
      pids: [],
      isUnknown: false,
      queryFailed: false
    };

    const targetNormalized = targetPath ? path.resolve(targetPath).toLowerCase() : null;

    if (process.platform === 'win32') {
      try {
        const psScript = `
          $procs = Get-Process -Name 'language_server*' -ErrorAction SilentlyContinue
          if (!$procs) { '[]'; exit }
          $list = @($procs) | ForEach-Object {
            $p = ''
            try { $p = $_.Path } catch {}
            $st = 0
            try { $st = [int64]($_.StartTime.ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds } catch {}
            [PSCustomObject]@{
              Id = $_.Id
              Path = $p
              StartTimeMs = $st
            }
          }
          $list | ConvertTo-Json -Compress
        `;

        const stdout = await new Promise((resolve, reject) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true
          }, (err, out) => {
            if (err) reject(err);
            else resolve(out);
          });
        });

        const parsed = JSON.parse(String(stdout || '').trim() || '[]');
        const procList = Array.isArray(parsed) ? parsed : [parsed];

        if (procList.length > 0) {
          result.pids = procList.map(p => p.Id).filter(Boolean);

          let matched = null;
          if (targetNormalized) {
            matched = procList.find(p => p.Path && path.resolve(p.Path).toLowerCase() === targetNormalized);
          }

          if (matched) {
            result.isRunning = true;
            result.pid = matched.Id;
            result.path = matched.Path || targetPath || null;
            if (matched.StartTimeMs && Number(matched.StartTimeMs) > 0) {
              result.startTimeMs = Number(matched.StartTimeMs);
            }
          } else {
            result.isRunning = result.locked;
          }
        } else {
          result.isRunning = false;
        }
      } catch (e) {
        // 异步查询超时或失败：标记为未知状态，辅助文件锁保留
        result.queryFailed = true;
        result.isUnknown = true;
        result.isRunning = result.locked;
      }
    } else {
      // Unix / macOS 异步探测
      try {
        if (process.platform === 'darwin') {
          const allProcs = await listMacProcessesAsync();
          const matchedProcs = targetNormalized
            ? allProcs.filter((p) => path.resolve(p.path).toLowerCase() === targetNormalized)
            : allProcs.filter((p) => isExactMacLanguageServerProcess(p.path));
          if (matchedProcs.length > 0) {
            result.isRunning = true;
            result.pids = matchedProcs.map((p) => p.pid);
            result.pid = matchedProcs[0].pid;
            result.path = matchedProcs[0].path;
            result.startTimeMs = matchedProcs[0].startTimeMs;
          } else {
            result.isRunning = false;
          }
        } else {
          const binName = targetPath ? path.basename(targetPath) : 'language_server';
          const res = await new Promise((resolve, reject) => {
            execFile('pgrep', ['-f', binName], { encoding: 'utf8', timeout: 2000 }, (err, out) => {
              if (err) reject(err); else resolve(out);
            });
          });
          const pids = String(res || '').trim().split(/\s+/).map(Number).filter(Boolean);
          if (pids.length > 0) {
            result.isRunning = true;
            result.pids = pids;
            result.pid = pids[0];
            result.path = targetPath || null;
            try {
              const psOut = await new Promise((resolve, reject) => {
                execFile('ps', ['-p', String(pids[0]), '-o', 'etimes='], { encoding: 'utf8', timeout: 1500 }, (err, out) => {
                  if (err) reject(err); else resolve(out);
                });
              });
              const elapsedSec = parseInt(String(psOut || '').trim(), 10);
              if (!isNaN(elapsedSec)) {
                result.startTimeMs = Date.now() - (elapsedSec * 1000);
              }
            } catch {}
          } else {
            result.isRunning = false;
          }
        }
      } catch {
        result.queryFailed = true;
        result.isUnknown = true;
      }
    }

    cachedProcInfo = result;
    cachedProcAt = Date.now();
    return result;
  })();

  inFlightProcQuery = queryPromise;
  try {
    return await queryPromise;
  } finally {
    inFlightProcQuery = null;
  }
}

/**
 * 同步快速获取进程状态（优先使用短期缓存或仅检查文件锁，绝不发起同步 powershell 阻塞主进程）
 */
function getRunningLanguageServerInfo(targetPath, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProcInfo && (now - cachedProcAt < 2500)) {
    return cachedProcInfo;
  }
  const isLocked = checkFileWriteLock(targetPath);
  return {
    isRunning: isLocked,
    locked: isLocked,
    pid: cachedProcInfo?.pid || null,
    path: targetPath || null,
    startTimeMs: cachedProcInfo?.startTimeMs || null,
    pids: cachedProcInfo?.pids || [],
    isUnknown: isLocked ? true : false,
    isSyncFallback: true
  };
}

/**
 * 保持旧签名兼容
 */
function checkProcessActivity(targetPath) {
  return getRunningLanguageServerInfo(targetPath, false);
}

function describeGate3AMode(gate3a) {
  if (!gate3a) return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未知状态' };
  if (gate3a.status === 'partial') {
    return { configuredMode: 'partial', configuredLimitTokens: gate3a.limit ?? null, configuredSummary: '部分匹配（站点不一致）' };
  }
  if (gate3a.status === 'unknown') {
    return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未知特征' };
  }
  if (gate3a.mode === 'default' || gate3a.status === 'unpatched') {
    return { configuredMode: 'default', configuredLimitTokens: null, configuredSummary: '宿主默认（恢复原有行为）' };
  }
  if (gate3a.mode === 'fixed' && gate3a.limit) {
    return {
      configuredMode: 'fixed',
      configuredLimitTokens: gate3a.limit,
      configuredSummary: `固定上限 (${gate3a.limit.toLocaleString('en-US')} tokens)`
    };
  }
  if (gate3a.mode === 'dynamic') {
    return {
      configuredMode: 'dynamic',
      configuredLimitTokens: null,
      configuredSummary: '动态跟随模型（透传，不锁定 983,040）'
    };
  }
  return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未识别配置' };
}

/**
 * 核心状态判定推导算法（综合静态特征、进程生命周期，严格区分显示预算观测与真实请求验证）
 */
function synthesizeAnalysisStatus(options = {}) {
  const {
    gate3a,
    gate3b,
    proc,
    manifest,
    container,
    stats,
    target,
    currentSha256,
    observedBudget
  } = options;

  let overallStatus = 'unsupported';
  let statusText = '不支持';
  let details = '';

  const targetNorm = path.resolve(target).toLowerCase();
  const manifestTargetNorm = (manifest && manifest.targetPath) ? path.resolve(manifest.targetPath).toLowerCase() : null;
  const isTargetMatched = manifestTargetNorm === targetNorm;
  const isBuildMatched = container ? doesManifestMatchContainer(manifest, container, target) : isTargetMatched;
  const isRecent = Boolean(manifest && manifest.patchedSha256 === currentSha256 && isBuildMatched);
  const patchedAtMs = (isRecent && manifest && manifest.patchedAt) ? new Date(manifest.patchedAt).getTime() : 0;
  const fileMtimeMs = (stats && stats.mtimeMs) ? stats.mtimeMs : 0;
  const effectivePatchTimeMs = patchedAtMs > 0 ? patchedAtMs : fileMtimeMs;

  const isProcPathMatched = Boolean(
    proc?.path &&
    targetNorm &&
    path.resolve(proc.path).toLowerCase() === targetNorm
  );

  let restartDetected = null;
  // 必须确证目标进程路径匹配，绝不能仅凭存在某个新启动的同名进程就判定加载了本次修改后的二进制
  if (isProcPathMatched && proc?.startTimeMs && effectivePatchTimeMs > 0) {
    restartDetected = (proc.startTimeMs >= effectivePatchTimeMs - 1500);
  }

  const modeDesc = describeGate3AMode(gate3a);

  if (gate3a.status === 'unpatched' && gate3b.status === 'unpatched') {
    overallStatus = 'not_patched';
    statusText = '未解锁';
    details = '检测到宿主原始后端（未修改限制），可切换为固定数值或跟随模型模式。';
  } else if (gate3a.status === 'patched' && gate3b.status === 'patched') {
    const modeNote = `当前磁盘模式：${modeDesc.configuredSummary}`;
    const unverifiedTail = observedBudget > 256000
      ? `；检测到界面显示预算 ${observedBudget.toLocaleString('en-US')} tokens（仅作参考，尚未经过真实长请求验证）。`
      : '；尚未经过真实长请求验证。';

    if (proc && !proc.isRunning && !proc.locked) {
      overallStatus = 'patched_runtime_unconfirmed';
      statusText = '磁盘已解锁，运行待确认';
      details = `${modeNote}；当前后端未运行，将在客户端启动后加载${unverifiedTail}`;
    } else if (restartDetected === true && isProcPathMatched) {
      overallStatus = 'patched_loaded';
      statusText = '已加载，待长请求实测';
      details = `${modeNote}；目标进程 (PID ${proc?.pid || '未知'}) 启动时间晚于修改时间${unverifiedTail}`;
      if (manifest && manifest.needsRestart) {
        manifest.needsRestart = false;
        try { saveManifest(manifest, options.backupDir); } catch {}
      }
    } else if (restartDetected === false && isProcPathMatched) {
      overallStatus = 'patched_pending_restart';
      statusText = '已写入补丁，待重启';
      details = `${modeNote}；当前运行中的宿主进程 (PID ${proc?.pid || '未知'}) 启动于修改之前，请重启客户端使新配置生效。`;
    } else {
      overallStatus = 'patched_runtime_unconfirmed';
      statusText = '磁盘已解锁，运行待确认';
      details = isProcPathMatched
        ? `${modeNote}；未能确定进程重启时序，请确认已重启并观察后续真实请求表现${unverifiedTail}`
        : `${modeNote}；未能确证目标进程加载路径，将在重启客户端后生效${unverifiedTail}`;
    }
  } else if (gate3a.status === 'partial') {
    overallStatus = 'partial_match';
    statusText = '状态异常（部分匹配）';
    details = '部分限制特征状态不一致，为避免损坏程序已拒绝写入。';
  } else if ((gate3a.status === 'patched' && gate3b.status === 'unpatched') || (gate3a.status === 'unpatched' && gate3b.status === 'patched')) {
    overallStatus = 'partial_match';
    statusText = '状态异常（部分匹配）';
    details = '后端限制处于半修改状态，拒绝直接覆写；请先通过「还原后端」恢复后再操作。';
  } else {
    overallStatus = 'failed';
    statusText = '检测或执行失败';
    const specificReasons = [gate3a?.reason, gate3b?.reason].filter(Boolean);
    details = specificReasons.length > 0
      ? specificReasons.join('；')
      : '未识别到可安全改写的特征（或版本已变更），已中止操作以防损坏文件。';
  }

  return {
    overallStatus,
    statusText,
    details,
    restartDetected,
    ...modeDesc
  };
}

function buildAnalysisResult({
  target,
  container,
  stats,
  currentSha256,
  totalSymbols,
  mode,
  gate3a,
  gate3b,
  serializerGate,
  proc,
  manifest,
  sidecar,
  observedBudget,
  backupDir
}) {
  const synthesis = synthesizeAnalysisStatus({
    gate3a,
    gate3b,
    proc,
    manifest,
    container,
    stats,
    target,
    currentSha256,
    observedBudget,
    backupDir
  });

  const backupExists = Boolean(manifest && manifest.backupPath && fs.existsSync(manifest.backupPath));
  const backupMatches = backupExists && doesManifestMatchContainer(manifest, container, target);
  let backupStaleReason = null;
  if (backupExists && !backupMatches) {
    backupStaleReason = '检测到目标二进制路径或 PE 构建版本已变更，历史原版备份与当前文件不匹配（已禁用跨版本还原）。';
  }

  return {
    status: synthesis.overallStatus,
    statusText: synthesis.statusText,
    details: synthesis.details,
    targetPath: target,
    format: container.format,
    arch: container.arch,
    peBuildId: container.buildId || null,
    peTimeDateStamp: container.peTimeDateStamp ?? null,
    peSizeOfImage: container.peSizeOfImage ?? null,
    mode,
    configuredMode: synthesis.configuredMode,
    configuredLimitTokens: synthesis.configuredLimitTokens,
    configuredSummary: synthesis.configuredSummary,
    scope: 'shared_backend',
    scopeNotice: '保存仅记录该模型偏好；应用会影响共享后端的所有会话，重启后生效。',
    realRequestVerified: false,
    engineeringRange: {
      min: MIN_ENGINEERING_LIMIT,
      max: MAX_ENGINEERING_LIMIT,
      presets: KNOWN_LIMIT_PRESETS,
      scopeNote: `补丁工程可写范围 ${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens（不代表模型保证支持上限）`
    },
    fileSize: stats.size,
    sha256: currentSha256,
    totalSymbols,
    gate3a,
    gate3b,
    serializerGate: serializerGate || { present: false, status: 'absent', offset: null, limit: null },
    isProcessRunning: proc.isRunning,
    isProcessLocked: proc.locked,
    runtimeEvidence: {
      isProcessRunning: proc.isRunning,
      isProcessLocked: proc.locked,
      processPid: proc.pid || null,
      processStartTime: proc.startTimeMs ? new Date(proc.startTimeMs).toISOString() : null,
      patchedAt: manifest ? manifest.patchedAt : null,
      restartDetected: synthesis.restartDetected,
      observedBudget: observedBudget || null,
      budgetObservedAbove256k: observedBudget > DEFAULT_CHECKPOINT_TOKENS,
      realRequestVerified: false,
      verificationNote: '仅依据静态特征/进程/前端显示预算，尚未经真实长请求服务端验证。'
    },
    hasBackup: backupExists,
    backupValidForCurrentBinary: backupMatches,
    backupStaleReason,
    hasMatchingGate3BSidecar: doesSidecarMatchTarget(sidecar, target, container, gate3b),
    backupInfo: manifest ? {
      origSha256: manifest.origSha256,
      backupPath: manifest.backupPath,
      patchedAt: manifest.patchedAt,
      buildId: manifest.buildId || null,
      configuredMode: manifest.configuredMode || null,
      configuredLimitTokens: manifest.configuredLimitTokens ?? null
    } : null,
    author: AUTHOR_INFO
  };
}

function resolveBinaryModeLabel(funcs, targetPath) {
  const isServerOnly = (!funcs[FUNC_OFFERS] && !funcs[FUNC_STORE_CW]);
  const isAgyCliName = Boolean(targetPath && /^agy(\.exe)?$/i.test(path.basename(String(targetPath))));
  return (isServerOnly && !isAgyCliName) ? 'standalone language_server' : 'agy CLI';
}

const unlockStaticCache = new Map();
const unlockTargetWriteQueues = new Map();

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function sha256BufferAsync(buf) {
  const hash = crypto.createHash('sha256');
  const CHUNK_SIZE = 16 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
    hash.update(buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length)));
    if (off + CHUNK_SIZE < buf.length) {
      await yieldEventLoop();
    }
  }
  return hash.digest('hex');
}

function invalidateUnlockCache(targetPath = null) {
  if (!targetPath) {
    unlockStaticCache.clear();
    return;
  }
  unlockStaticCache.delete(path.resolve(String(targetPath)).toLowerCase());
}

function enqueueUnlockTargetWrite(targetPath, taskFn) {
  const key = path.resolve(String(targetPath)).toLowerCase();
  const prev = unlockTargetWriteQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(taskFn);
  const tail = run.finally(() => {
    if (unlockTargetWriteQueues.get(key) === tail) {
      unlockTargetWriteQueues.delete(key);
    }
  });
  unlockTargetWriteQueues.set(key, tail);
  return run;
}

/**
 * 完整分析二进制支持度与补丁状态（纯异步非阻塞版本，供主进程 IPC、CLI 及前端使用）
 */
async function analyzeBinaryAsync(filePath, options = {}) {
  const target = filePath || detectTargetBinary();
  if (!target || !fs.existsSync(target)) {
    return {
      status: 'unsupported',
      targetPath: target,
      reason: target ? '目标文件不存在' : '未检测到 Antigravity 后端文件 (language_server)'
    };
  }

  // 跨平台安全策略拦截：支持 Windows (x86-64) 与 Apple Silicon macOS (arm64)，显式排除 Linux/ELF 与 Intel Mac (x64)
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      status: 'unsupported',
      targetPath: target,
      format: 'ELF',
      arch: os.arch(),
      reason: `暂未开放对 ${process.platform} 平台的写入支持：当前仅支持 Windows (x86-64) 与 macOS Apple Silicon (arm64)。`,
      isPlatformSupported: false
    };
  }
  if (!filePath && process.platform === 'darwin' && os.arch() !== 'arm64') {
    return {
      ok: false,
      status: 'unsupported',
      targetPath: target,
      format: 'Mach-O',
      arch: os.arch() === 'x64' ? 'x86-64' : os.arch(),
      reason: '暂未开放对 Intel Mac (x86-64) 的写入支持：当前 macOS 二进制调整仅完成 Apple Silicon (arm64) 验证。',
      isPlatformSupported: false
    };
  }

  let stats = options.preloadedStats || null;
  if (!stats) {
    try {
      stats = await fs.promises.stat(target);
    } catch (e) {
      return {
        status: 'failed',
        targetPath: target,
        reason: `读取目标文件失败: ${e.message}`
      };
    }
  }

  const cacheKey = path.resolve(target).toLowerCase();
  const statSig = `${stats.size}:${stats.mtimeMs}`;
  const expectedLimitKey = options.expectedLimit ?? '';
  const allowCache = options.forceRefresh !== true && !options.preloadedBuf;
  let staticInfo = null;

  if (allowCache) {
    const cached = unlockStaticCache.get(cacheKey);
    if (
      cached &&
      cached.statSig === statSig &&
      cached.expectedLimitKey === expectedLimitKey &&
      (options.skipSha256 === true || cached.currentSha256)
    ) {
      staticInfo = cached;
    }
  }

  if (!staticInfo) {
    if (canUseUnlockWorker(options) && !options.preloadedBuf) {
      const workerRes = await runUnlockWorkerTask('analyze', {
        filePath: target,
        options: sanitizeUnlockWorkerOptions(options)
      });
      if (workerRes && workerRes._workerHandled) {
        return workerRes.result;
      }
    }
    let buf = options.preloadedBuf || null;
    if (!buf) {
      try {
        buf = await fs.promises.readFile(target);
      } catch (e) {
        return {
          status: 'failed',
          targetPath: target,
          reason: `读取目标文件失败: ${e.message}`
        };
      }
    }

    const currentSha256 = options.skipSha256 === true ? '' : await sha256BufferAsync(buf);

    let container;
    try {
      container = findTextSection(buf);
    } catch (e) {
      return {
        status: 'unsupported',
        targetPath: target,
        sha256: currentSha256,
        reason: e.message
      };
    }

    const { textVA, textOff, arch, format } = container;

    if (!isSupportedUnlockTarget(format, arch)) {
      return {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        sha256: currentSha256,
        isPlatformSupported: false,
        reason: getUnsupportedTargetReason(format, arch)
      };
    }

    await yieldEventLoop();

    let funcsData;
    try {
      funcsData = buildFunctions(buf);
    } catch (e) {
      return {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        sha256: currentSha256,
        reason: e.message
      };
    }

    const { funcs, totalSymbols } = funcsData;
    const mode = resolveBinaryModeLabel(funcs, target);

    const symCheckpoint = funcs[FUNC_CHECKPOINT];
    const symExp = funcs[FUNC_EXP_CHECKPOINT];
    const symSelect = funcs[FUNC_SELECT_EXP_KEY];

    if (!symCheckpoint || !symExp) {
      return {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        mode,
        sha256: currentSha256,
        reason: '缺少核心检查点上限符号 (utils.GetCheckpointConfig 或 config.applyFeatureProviderCheckpointOverrideConfig)'
      };
    }

    await yieldEventLoop();

    const gate3a = checkGate3A(buf, textOff, symCheckpoint, arch, options);
    const gate3b = checkGate3B(buf, textVA, textOff, symExp, symSelect, arch);
    const serializerGate = checkSerializerGate(buf, arch);

    staticInfo = {
      statSig,
      expectedLimitKey,
      container,
      currentSha256,
      totalSymbols,
      mode,
      gate3a,
      gate3b,
      serializerGate
    };
    if (!options.expectedLimit) {
      unlockStaticCache.set(cacheKey, staticInfo);
    }
  }

  // 异步非阻塞枚举进程信息（可选跳过以降低高频批量探测开销）
  const proc = options.skipProcessCheck
    ? { isRunning: false, locked: false, pid: null, startTimeMs: null }
    : await getRunningLanguageServerInfoAsync(target, options.forceRefresh === true);
  const manifest = loadManifest(options.backupDir);
  const sidecar = loadGate3BSidecar(options.backupDir);
  const observedBudget = Number(options?.currentBudget || options?.observedBudget || 0);

  return buildAnalysisResult({
    target,
    container: staticInfo.container,
    stats,
    currentSha256: staticInfo.currentSha256,
    totalSymbols: staticInfo.totalSymbols,
    mode: staticInfo.mode,
    gate3a: staticInfo.gate3a,
    gate3b: staticInfo.gate3b,
    serializerGate: staticInfo.serializerGate,
    proc,
    manifest,
    sidecar,
    observedBudget,
    backupDir: options.backupDir
  });
}

/**
 * 同步分析（保持与单测兼容，使用非阻塞快速探测）
 */
function analyzeBinary(filePath, options = {}) {
  const target = filePath || detectTargetBinary();
  if (!target || !fs.existsSync(target)) {
    return {
      status: 'unsupported',
      targetPath: target,
      reason: target ? '目标文件不存在' : '未检测到 Antigravity 后端文件 (language_server)'
    };
  }

  let buf;
  let stats;
  try {
    stats = fs.statSync(target);
    buf = fs.readFileSync(target);
  } catch (e) {
    return {
      status: 'failed',
      targetPath: target,
      reason: `读取目标文件失败: ${e.message}`
    };
  }

  const currentSha256 = sha256Buffer(buf);

  let container;
  try {
    container = findTextSection(buf);
  } catch (e) {
    return {
      status: 'unsupported',
      targetPath: target,
      sha256: currentSha256,
      reason: e.message
    };
  }

  const { textVA, textOff, arch, format } = container;

  if (!isSupportedUnlockTarget(format, arch)) {
    return {
      status: 'unsupported',
      targetPath: target,
      arch,
      format,
      sha256: currentSha256,
      isPlatformSupported: false,
      reason: getUnsupportedTargetReason(format, arch)
    };
  }

  let funcsData;
  try {
    funcsData = buildFunctions(buf);
  } catch (e) {
    return {
      status: 'unsupported',
      targetPath: target,
      arch,
      format,
      sha256: currentSha256,
      reason: e.message
    };
  }

  const { funcs, totalSymbols } = funcsData;
  const mode = resolveBinaryModeLabel(funcs, target);

  const symCheckpoint = funcs[FUNC_CHECKPOINT];
  const symExp = funcs[FUNC_EXP_CHECKPOINT];
  const symSelect = funcs[FUNC_SELECT_EXP_KEY];

  if (!symCheckpoint || !symExp) {
    return {
      status: 'unsupported',
      targetPath: target,
      arch,
      format,
      mode,
      sha256: currentSha256,
      reason: '缺少核心检查点上限符号 (utils.GetCheckpointConfig 或 config.applyFeatureProviderCheckpointOverrideConfig)'
    };
  }

  const gate3a = checkGate3A(buf, textOff, symCheckpoint, arch, options);
  const gate3b = checkGate3B(buf, textVA, textOff, symExp, symSelect, arch);
  const serializerGate = checkSerializerGate(buf, arch);

  const proc = checkProcessActivity(target);
  const manifest = loadManifest(options.backupDir);
  const sidecar = loadGate3BSidecar(options.backupDir);
  const observedBudget = Number(options?.currentBudget || options?.observedBudget || 0);

  return buildAnalysisResult({
    target,
    container,
    stats,
    currentSha256,
    totalSymbols,
    mode,
    gate3a,
    gate3b,
    serializerGate,
    proc,
    manifest,
    sidecar,
    observedBudget,
    backupDir: options.backupDir
  });
}

/**
 * 执行上下文加长解锁 (Apply)
 */
/**
 * Windows 占用下安全原子写盘与回滚共用助手
 */
function atomicWriteBinary(targetPath, buf, tempTag = 'new', writeOpts = {}) {
  if ((process.platform === 'darwin' || writeOpts.forceCodesign === true) && isMachO64Buffer(buf)) {
    try {
      const signRes = atomicWriteMachOBinarySync(targetPath, buf, {
        entitlementsSourcePath: writeOpts.entitlementsSourcePath || targetPath,
        skipCodesign: writeOpts.skipCodesign === true,
        forceCodesign: writeOpts.forceCodesign === true,
        codesignBin: writeOpts.codesignBin,
        _execFileSync: writeOpts._execFileSync
      });
      invalidateUnlockCache(targetPath);
      return {
        ok: true,
        usedRenameTrick: true,
        signatureMode: signRes?.signatureMode || (writeOpts.skipCodesign ? 'unchanged' : 'ad-hoc'),
        entitlementsPreserved: Boolean(signRes?.entitlementsPreserved)
      };
    } catch (e) {
      return {
        ok: false,
        code: 'MACOS_CODESIGN_OR_WRITE_FAILED',
        error: `macOS 原子写入或本地 ad-hoc 重签名失败，已完整保留原文件 (${e.code || e.message})`
      };
    }
  }

  const tmpNew = `${targetPath}.${tempTag}_${Date.now()}`;
  let usedRenameTrick = false;
  let tmpOldCreated = null;

  try {
    fs.writeFileSync(tmpNew, buf);
    try {
      fs.copyFileSync(tmpNew, targetPath);
    } catch (e) {
      if (process.platform === 'win32' && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        const tmpOld = `${targetPath}.old_${Date.now()}`;
        fs.renameSync(targetPath, tmpOld);
        tmpOldCreated = tmpOld;
        try {
          fs.renameSync(tmpNew, targetPath);
          usedRenameTrick = true;
        } catch (renameNewErr) {
          try {
            fs.renameSync(tmpOld, targetPath);
          } catch (rollbackErr) {
            return {
              ok: false,
              error: `替换新文件失败且回滚原文件失败: ${rollbackErr.message} (原始错误: ${renameNewErr.message})`
            };
          }
          return {
            ok: false,
            error: `写入新补丁文件失败，已安全回滚原文件: ${renameNewErr.message}`
          };
        }
      } else {
        throw e;
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `写入目标文件失败 (${e.code || e.message})。若客户端正在运行，请退出 Antigravity 客户端后重试。`
    };
  } finally {
    if (fs.existsSync(tmpNew)) {
      try { fs.unlinkSync(tmpNew); } catch {}
    }
  }

  try {
    cleanupOldReplacedFiles(path.dirname(targetPath), path.basename(targetPath), tmpOldCreated);
  } catch {}

  invalidateUnlockCache(targetPath);
  return { ok: true, usedRenameTrick };
}

/**
 * 异步安全原子写盘与回滚助手（避免大二进制 writeFileSync/copyFileSync 阻塞主线程）
 */
async function atomicWriteBinaryAsync(targetPath, buf, tempTag = 'new', writeOpts = {}) {
  if ((process.platform === 'darwin' || writeOpts.forceCodesign === true) && isMachO64Buffer(buf)) {
    try {
      const signRes = await atomicWriteMachOBinaryAsync(targetPath, buf, {
        entitlementsSourcePath: writeOpts.entitlementsSourcePath || targetPath,
        skipCodesign: writeOpts.skipCodesign === true,
        forceCodesign: writeOpts.forceCodesign === true,
        codesignBin: writeOpts.codesignBin,
        _execFile: writeOpts._execFile
      });
      invalidateUnlockCache(targetPath);
      return {
        ok: true,
        usedRenameTrick: true,
        signatureMode: signRes?.signatureMode || (writeOpts.skipCodesign ? 'unchanged' : 'ad-hoc'),
        entitlementsPreserved: Boolean(signRes?.entitlementsPreserved)
      };
    } catch (e) {
      return {
        ok: false,
        code: 'MACOS_CODESIGN_OR_WRITE_FAILED',
        error: `macOS 原子写入或本地 ad-hoc 重签名失败，已完整保留原文件 (${e.code || e.message})`
      };
    }
  }

  const tmpNew = `${targetPath}.${tempTag}_${Date.now()}`;
  let usedRenameTrick = false;
  let tmpOldCreated = null;

  try {
    await fs.promises.writeFile(tmpNew, buf);
    try {
      await fs.promises.copyFile(tmpNew, targetPath);
    } catch (e) {
      if (process.platform === 'win32' && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        const tmpOld = `${targetPath}.old_${Date.now()}`;
        await fs.promises.rename(targetPath, tmpOld);
        tmpOldCreated = tmpOld;
        try {
          await fs.promises.rename(tmpNew, targetPath);
          usedRenameTrick = true;
        } catch (renameNewErr) {
          try {
            await fs.promises.rename(tmpOld, targetPath);
          } catch (rollbackErr) {
            return {
              ok: false,
              error: `替换新文件失败且回滚原文件失败: ${rollbackErr.message} (原始错误: ${renameNewErr.message})`
            };
          }
          return {
            ok: false,
            error: `写入新补丁文件失败，已安全回滚原文件: ${renameNewErr.message}`
          };
        }
      } else {
        throw e;
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `写入目标文件失败 (${e.code || e.message})。若客户端正在运行，请退出 Antigravity 客户端后重试。`
    };
  } finally {
    try {
      await fs.promises.unlink(tmpNew);
    } catch {}
  }

  try {
    cleanupOldReplacedFiles(path.dirname(targetPath), path.basename(targetPath), tmpOldCreated);
  } catch {}

  invalidateUnlockCache(targetPath);
  return { ok: true, usedRenameTrick };
}

/**
 * 解析并规范化目标上下文调整参数
 */
function normalizeUnlockTargetOptions(options = {}) {
  const hasLimitParam = options?.limitTokens !== undefined && options?.limitTokens !== null && options?.limitTokens !== '';
  const rawMode = options?.mode ? String(options.mode).trim().toLowerCase() : (hasLimitParam ? 'fixed' : 'dynamic');

  if (rawMode === 'default' || rawMode === 'orig' || rawMode === 'official') {
    return { ok: true, mode: 'default', limitTokens: DEFAULT_CHECKPOINT_TOKENS, warnings: [] };
  }
  if (rawMode === 'dynamic' || rawMode === 'dyn' || rawMode === 'passthrough') {
    return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
  }
  if (rawMode === 'fixed' || rawMode === 'const' || rawMode === 'custom') {
    const validation = validateContextLimit(options?.limitTokens, { serviceLimit: options?.serviceLimit });
    if (!validation.ok) return validation;
    return {
      ok: true,
      mode: 'fixed',
      limitTokens: validation.limitTokens,
      warnings: validation.warnings,
      scopeNote: validation.scopeNote
    };
  }

  return { ok: false, error: `未知上下文模式: ${options.mode}`, code: 'INVALID_MODE' };
}

/**
 * 安全解析写入/恢复目标二进制路径：测试/隔离上下文或拼错路径字段名时严禁回退系统安装目录
 */
function resolveUnlockTargetPath(options = {}) {
  const typoKey = ['binPath', 'binaryPath', 'filePath', 'path', 'target'].find(
    (k) => options[k] !== undefined && options[k] !== null && String(options[k]).trim() !== ''
  );
  if (typoKey && !options.targetPath) {
    return {
      ok: false,
      code: 'INVALID_TARGET_OPTION',
      error: `无效的目标路径字段 "${typoKey}"，请显式使用 targetPath；已拒绝回退至系统安装目录。`
    };
  }
  if (options.targetPath && String(options.targetPath).trim() !== '') {
    return { ok: true, target: path.resolve(String(options.targetPath)) };
  }
  const hasIsolationContext = Boolean(
    options.backupDir ||
    options.homeDir ||
    options.stateDir ||
    options.skipProcessCheck ||
    process.env.NODE_TEST_CONTEXT
  );
  if (hasIsolationContext) {
    return {
      ok: false,
      code: 'MISSING_TARGET_PATH',
      error: '处于测试或隔离上下文但未显式指定 targetPath，已拒绝探测或写入系统安装目录。'
    };
  }
  try {
    const detected = detectTargetBinary();
    if (!detected) {
      return { ok: false, code: 'MISSING_TARGET_PATH', error: '未指定目标二进制文件路径，且未检测到默认安装目录。' };
    }
    return { ok: true, target: detected };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 执行上下文长度模式应用与已知态安全互切 (default / fixed / dynamic)
 */
function applyUnlock(options = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前平台 (${process.platform}) 暂未通过安全写入与签名验证验收，已自动拦截写入操作，确保客户端稳定。`
    };
  }

  const targetSpec = normalizeUnlockTargetOptions(options);
  if (!targetSpec.ok) {
    return { ok: false, code: targetSpec.code || 'INVALID_INPUT', error: targetSpec.error };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) {
    return resolvedTarget;
  }
  const target = resolvedTarget.target;

  const analysis = analyzeBinary(target, {
    backupDir: options.backupDir,
    expectedLimit: targetSpec.limitTokens
  });

  const allowedStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
  if (!allowedStatuses.has(analysis.status) || !isSupportedUnlockTarget(analysis.format, analysis.arch)) {
    return {
      ok: false,
      code: analysis.status === 'partial_match' ? 'PARTIAL_MATCH' : 'UNSUPPORTED_OR_UNKNOWN',
      error: `无法应用设置：${analysis.details || analysis.reason || '目标状态不受支持或存在部分匹配异常'}`,
      analysis
    };
  }

  // 幂等检查
  if (targetSpec.mode === 'default' && analysis.status === 'not_patched') {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyRestored: true,
      alreadyMatched: true,
      configuredMode: 'default',
      configuredLimitTokens: analysis.gate3a?.origLimit || DEFAULT_CHECKPOINT_TOKENS,
      needsRestart: false,
      message: '当前已经处于宿主默认状态，无需重复切换。',
      analysis
    };
  }
  if (
    targetSpec.mode === 'dynamic' &&
    analysis.status !== 'not_patched' &&
    analysis.configuredMode === 'dynamic'
  ) {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'dynamic',
      configuredLimitTokens: null,
      needsRestart: analysis.status === 'patched_pending_restart',
      message: '当前已经处于「动态跟随模型（透传）」模式，无需重复写入。',
      analysis
    };
  }
  if (
    targetSpec.mode === 'fixed' &&
    analysis.status !== 'not_patched' &&
    analysis.configuredMode === 'fixed' &&
    analysis.configuredLimitTokens === targetSpec.limitTokens
  ) {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'fixed',
      configuredLimitTokens: targetSpec.limitTokens,
      needsRestart: analysis.status === 'patched_pending_restart',
      message: `当前已经应用固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens，无需重复写入。`,
      analysis
    };
  }

  const { gate3a, gate3b, serializerGate, arch, targetPath, sha256: beforeSha256, fileSize } = analysis;
  const backupDir = getUnlockBackupDir(options.backupDir);
  const existingManifest = loadManifest(options.backupDir);
  const existingSidecar = loadGate3BSidecar(options.backupDir);
  const buf = fs.readFileSync(targetPath);
  const container = findTextSection(buf);

  // 处理切回官方默认模式时对 Gate 3B 原始字节的安全核验
  let gate3bOrigBytesForDefault = null;
  if (targetSpec.mode === 'default') {
    if (gate3b.status === 'patched') {
      if (doesSidecarMatchTarget(existingSidecar, targetPath, container, gate3b)) {
        gate3bOrigBytesForDefault = Buffer.from(existingSidecar.origHex, 'hex');
      } else if (
        existingManifest &&
        existingManifest.backupPath &&
        fs.existsSync(existingManifest.backupPath) &&
        doesManifestMatchContainer(existingManifest, container, targetPath) &&
        sha256File(existingManifest.backupPath) === existingManifest.origSha256
      ) {
        const backupBuf = fs.readFileSync(existingManifest.backupPath);
        gate3bOrigBytesForDefault = backupBuf.subarray(gate3b.offset, gate3b.offset + (gate3b.length || 2));
      } else {
        return {
          ok: false,
          code: 'MISSING_OR_STALE_GATE3B_SIDECAR',
          error: '缺少与当前版本匹配的原始字节记录或备份，无法安全切换回默认状态（已阻止盲写）。',
          analysis
        };
      }
    }
  }

  // 若当前为官方原版，首次修改前必须保存完整原版备份与 Gate 3B sidecar
  let manifestToSave = existingManifest && doesManifestMatchContainer(existingManifest, container, targetPath)
    ? { ...existingManifest }
    : null;

  if (analysis.status === 'not_patched') {
    const backupFile = path.join(backupDir, `${path.basename(targetPath)}_${beforeSha256.slice(0, 12)}.orig`);
    try {
      fs.copyFileSync(targetPath, backupFile);
      const backupSha = sha256File(backupFile);
      if (backupSha !== beforeSha256) {
        if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        return { ok: false, error: '原版备份哈希校验不匹配，操作已中止。' };
      }
    } catch (e) {
      return { ok: false, error: `创建原版备份失败: ${e.message}` };
    }

    if (gate3b.origHex) {
      saveGate3BSidecar({
        targetPath,
        buildId: container.buildId || null,
        peTimeDateStamp: container.peTimeDateStamp ?? null,
        peSizeOfImage: container.peSizeOfImage ?? null,
        offset: gate3b.offset,
        length: gate3b.length,
        origHex: gate3b.origHex,
        origSha8: beforeSha256.slice(0, 8),
        updatedAt: new Date().toISOString()
      }, options.backupDir);
    }

    manifestToSave = {
      targetPath,
      arch,
      buildId: container.buildId || null,
      peTimeDateStamp: container.peTimeDateStamp ?? null,
      peSizeOfImage: container.peSizeOfImage ?? null,
      origSha256: beforeSha256,
      origSize: fileSize,
      backupPath: backupFile,
      backupSha256: beforeSha256,
      gate3aVariant: gate3a.clampVariant || 'edx_esi_256k',
      gate3aOrigLimit: gate3a.origLimit || DEFAULT_CHECKPOINT_TOKENS,
      gate3bOrigHex: gate3b.origHex || null,
      gate3bLength: gate3b.length || null,
      gate3bOffset: gate3b.offset ?? null,
      author: AUTHOR_INFO
    };
  }

  // 写入 Gate 3A (clamp + 若存在则同步写 default 站点) 与可选 Serializer 前端门禁
  const serializerPatched = patchUnlockBuffer(buf, targetSpec, gate3a, gate3b, serializerGate, gate3bOrigBytesForDefault, arch);

  const writeRes = atomicWriteBinary(targetPath, buf, 'new', {
    entitlementsSourcePath: manifestToSave?.backupPath || targetPath,
    skipCodesign: options.skipCodesign === true,
    forceCodesign: options.forceCodesign === true,
    codesignBin: options.codesignBin,
    _execFileSync: options._execFileSync
  });
  if (!writeRes.ok) {
    return { ok: false, code: writeRes.code || 'WRITE_FAILED', error: writeRes.error };
  }
  const afterSha256 = isMachO64Buffer(buf) ? sha256File(targetPath) : sha256Buffer(buf);

  const syncedConfigs = syncExternalContextConfigs(targetSpec.mode, targetSpec.limitTokens, options);

  const effectiveLimitTokens = targetSpec.mode === 'default'
    ? (gate3a.origLimit || DEFAULT_CHECKPOINT_TOKENS)
    : targetSpec.limitTokens;

  if (manifestToSave) {
    manifestToSave.patchedSha256 = afterSha256;
    manifestToSave.patchedAt = new Date().toISOString();
    manifestToSave.configuredMode = targetSpec.mode;
    manifestToSave.configuredLimitTokens = effectiveLimitTokens;
    manifestToSave.needsRestart = true;
    saveManifest(manifestToSave, options.backupDir);
  }

  const modeSummary = targetSpec.mode === 'default'
    ? '宿主默认模式（恢复原有行为）'
    : targetSpec.mode === 'fixed'
      ? `固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens`
      : '跟随模型（动态透传）';

  const restartHint = writeRes.usedRenameTrick
    ? '由于客户端正在运行，请【完全退出并重启 Antigravity 客户端】使新后端配置生效。'
    : '请重启 Antigravity 客户端使新后端配置生效。';

  const signHint = writeRes.signatureMode === 'ad-hoc'
    ? (writeRes.entitlementsPreserved
      ? '已保留原有 entitlements 并完成本地 ad-hoc 重签名'
      : '已完成本地 ad-hoc 重签名')
    : '';

  return {
    ok: true,
    needsRestart: true,
    targetPath,
    configuredMode: targetSpec.mode,
    configuredLimitTokens: targetSpec.limitTokens,
    defaultSitePatched: Boolean(gate3a.hasDefaultSite),
    serializerPatched,
    syncedConfigs,
    signatureMode: writeRes.signatureMode || null,
    entitlementsPreserved: Boolean(writeRes.entitlementsPreserved),
    warnings: targetSpec.warnings || [],
    scopeNote: analysis.scopeNotice,
    beforeSha256,
    afterSha256,
    backupPath: manifestToSave ? manifestToSave.backupPath : null,
    message: `已将共享后端切换为「${modeSummary}」，影响共享该后端的所有会话；${signHint ? `${signHint}；` : ''}${restartHint}（尚未经过真实长请求验证）`
  };
}

/**
 * 恢复原版二进制 (Restore) — 严格校验路径、PE 构建版本与完整哈希匹配
 */
function restoreUnlock(options = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前平台 (${process.platform}) 暂未通过安全写入验证，已自动拦截操作。`
    };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) {
    return resolvedTarget;
  }
  const target = resolvedTarget.target;

  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '目标文件不存在，无法恢复' };
  }

  const manifest = loadManifest(options.backupDir);
  const sidecar = loadGate3BSidecar(options.backupDir);
  const currentBuf = fs.readFileSync(target);
  const currentSha256 = sha256Buffer(currentBuf);

  let container;
  try {
    container = findTextSection(currentBuf);
  } catch (e) {
    return { ok: false, error: `解析当前二进制容器失败，拒绝恢复: ${e.message}` };
  }

  // 1. 优先使用经完整路径 + 完整 SHA-256 + PE 构建指纹校验通过的官方原版备份
  if (manifest && manifest.backupPath && fs.existsSync(manifest.backupPath)) {
    if (!isSameTargetPath(manifest.targetPath, target)) {
      return { ok: false, error: '安装记录目标与当前恢复目标不一致，拒绝跨路径还原。' };
    }

    if (!doesManifestMatchContainer(manifest, container, target)) {
      return {
        ok: false,
        code: 'BACKUP_VERSION_MISMATCH',
        error: '检测到当前目标文件版本/构建已更新，与历史备份的 PE 构建指纹不一致，已拒绝跨版本还原以免破坏新版本二进制。'
      };
    }

    const backupSha = sha256File(manifest.backupPath);
    if (backupSha !== manifest.origSha256) {
      return { ok: false, error: '原版备份文件已损坏或被篡改，无法执行还原。' };
    }

    if (currentSha256 === manifest.origSha256) {
      manifest.needsRestart = false;
      saveManifest(manifest, options.backupDir);
      return { ok: true, alreadyRestored: true, message: '当前已经是官方原版，无需重复恢复。' };
    }

    const backupBuf = fs.readFileSync(manifest.backupPath);
    const writeRes = atomicWriteBinary(target, backupBuf, 'res', { skipCodesign: true });
    if (!writeRes.ok) {
      return { ok: false, error: `恢复原版写入失败: ${writeRes.error}` };
    }

    manifest.needsRestart = true;
    manifest.configuredMode = 'default';
    manifest.configuredLimitTokens = manifest.gate3aOrigLimit || DEFAULT_CHECKPOINT_TOKENS;
    saveManifest(manifest, options.backupDir);
    const syncedConfigs = syncExternalContextConfigs('default', null, options);

    return {
      ok: true,
      needsRestart: true,
      restoredOriginalSignature: true,
      afterSha256: manifest.origSha256,
      syncedConfigs,
      message: writeRes.usedRenameTrick
        ? '已成功恢复官方原版二进制！请【完全退出并重启 Antigravity 客户端】生效。'
        : '已成功恢复官方原版二进制！请重启客户端生效。'
    };
  }

  // 2. 无匹配整包备份时：仅当匹配当前 PE 构建且同构建 Gate 3B sidecar 完整可用时，按确定性特征逆向还原
  const analysis = analyzeBinary(target, { backupDir: options.backupDir });
  if (analysis.status === 'not_patched') {
    const syncedConfigs = syncExternalContextConfigs('default', null, options);
    return { ok: true, alreadyRestored: true, syncedConfigs, message: '当前已经是官方原版，无需恢复。' };
  }

  if (
    (analysis.gate3a?.status === 'patched' || analysis.gate3a?.status === 'unpatched') &&
    analysis.gate3b?.status === 'patched' &&
    doesSidecarMatchTarget(sidecar, target, container, analysis.gate3b)
  ) {
    restoreBufferBySidecar(currentBuf, analysis, sidecar, container.arch);

    const writeRes = atomicWriteBinary(target, currentBuf, 'rev', {
      skipCodesign: options.skipCodesign === true,
      forceCodesign: options.forceCodesign === true,
      codesignBin: options.codesignBin,
      _execFileSync: options._execFileSync
    });
    if (!writeRes.ok) {
      return { ok: false, error: `逆向还原写入失败: ${writeRes.error}` };
    }
    const syncedConfigs = syncExternalContextConfigs('default', null, options);

    return {
      ok: true,
      needsRestart: true,
      syncedConfigs,
      message: '已通过同构建校验记录恢复官方原版！请重启 Antigravity 客户端生效。'
    };
  }

  return {
    ok: false,
    code: 'RESTORE_REJECTED',
    error: '未找到与当前版本匹配的原版备份或原始字节记录，为确保安全拒绝覆盖。'
  };
}

/**
 * 复用：幂等性判定，避免重复改写同一二进制
 */
function checkUnlockIdempotency(targetSpec, analysis) {
  if (targetSpec.mode === 'default' && analysis.status === 'not_patched') {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyRestored: true,
      alreadyMatched: true,
      configuredMode: 'default',
      configuredLimitTokens: DEFAULT_CHECKPOINT_TOKENS,
      needsRestart: false,
      message: '当前已经处于宿主默认状态，无需重复切换。',
      analysis
    };
  }
  if (
    targetSpec.mode === 'dynamic' &&
    analysis.status !== 'not_patched' &&
    analysis.configuredMode === 'dynamic'
  ) {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'dynamic',
      configuredLimitTokens: null,
      needsRestart: analysis.status === 'patched_pending_restart',
      message: '当前已经处于「动态跟随模型（透传）」模式，无需重复写入。',
      analysis
    };
  }
  if (
    targetSpec.mode === 'fixed' &&
    analysis.status !== 'not_patched' &&
    analysis.configuredMode === 'fixed' &&
    analysis.configuredLimitTokens === targetSpec.limitTokens
  ) {
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'fixed',
      configuredLimitTokens: targetSpec.limitTokens,
      needsRestart: analysis.status === 'patched_pending_restart',
      message: `当前已经应用固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens，无需重复写入。`,
      analysis
    };
  }
  return null;
}

/**
 * 复用：按目标规格就地修改二进制 Buffer 中的 Gate 3A/3B 与 Serializer 门禁
 */
function patchUnlockBuffer(buf, targetSpec, gate3a, gate3b, serializerGate, gate3bOrigBytesForDefault, arch = 'x86-64') {
  let serializerPatched = false;
  const isArm64 = arch === 'arm64';

  const writeGate3BNop = () => {
    if (isArm64) {
      for (let off = gate3b.offset; off < gate3b.offset + (gate3b.length || 4); off += 4) {
        NOP_ARM64.copy(buf, off);
      }
    } else {
      buf.fill(0x90, gate3b.offset, gate3b.offset + (gate3b.length || 2));
    }
  };

  if (targetSpec.mode === 'default') {
    buf.set(isArm64 ? CLAMP_256K_ARM64 : buildClampOrigX64(gate3a), gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(isArm64 ? DEF_ORIG_ARM64 : DEF_ORIG_X64, gate3a.defaultOffset);
    }
    if (gate3b.status === 'patched' && gate3bOrigBytesForDefault) {
      buf.set(gate3bOrigBytesForDefault, gate3b.offset);
    }
    if (!isArm64 && serializerGate && serializerGate.present && serializerGate.offset !== null) {
      buf.set(SERIALIZER_STOCK_X64, serializerGate.offset);
      serializerPatched = true;
    }
  } else if (targetSpec.mode === 'fixed') {
    buf.set(isArm64 ? buildClampConstArm64(targetSpec.limitTokens) : buildClampConstX64(targetSpec.limitTokens, gate3a), gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(isArm64 ? buildDefConstArm64(targetSpec.limitTokens) : buildDefConstX64(targetSpec.limitTokens), gate3a.defaultOffset);
    }
    if (gate3b.status === 'unpatched') {
      writeGate3BNop();
    }
    if (!isArm64 && serializerGate && serializerGate.present && serializerGate.offset !== null) {
      buf.set(buildSerializerConstX64(targetSpec.limitTokens), serializerGate.offset);
      serializerPatched = true;
    }
  } else if (targetSpec.mode === 'dynamic') {
    buf.set(isArm64 ? PATCH_256K_ARM64 : buildClampDynX64(gate3a), gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(isArm64 ? DEF_ORIG_ARM64 : DEF_ORIG_X64, gate3a.defaultOffset);
    }
    if (gate3b.status === 'unpatched') {
      writeGate3BNop();
    }
    if (!isArm64 && serializerGate && serializerGate.present && serializerGate.offset !== null) {
      buf.set(SERIALIZER_STOCK_X64, serializerGate.offset);
      serializerPatched = true;
    }
  }
  return serializerPatched;
}

/**
 * 复用：通过同构建 sidecar 记录就地还原 Gate 3A/3B 与 Serializer 至宿主原版字节
 */
function restoreBufferBySidecar(buf, analysis, sidecar, arch = 'x86-64') {
  return patchUnlockBuffer(
    buf,
    { mode: 'default', limitTokens: analysis.gate3a?.origLimit || DEFAULT_CHECKPOINT_TOKENS },
    analysis.gate3a,
    analysis.gate3b,
    analysis.serializerGate,
    Buffer.from(sidecar.origHex, 'hex'),
    arch
  );
}

/**
 * 异步非阻塞上下文长度应用（同一目标串行加锁，保持备份、校验与回滚语义）
 */
async function applyUnlockAsync(options = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前平台 (${process.platform}) 暂未通过安全写入与签名验证验收，已自动拦截写入操作，确保客户端稳定。`
    };
  }

  const targetSpec = normalizeUnlockTargetOptions(options);
  if (!targetSpec.ok) {
    return { ok: false, code: targetSpec.code || 'INVALID_INPUT', error: targetSpec.error };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) {
    return resolvedTarget;
  }
  const target = resolvedTarget.target;

  return enqueueUnlockTargetWrite(target, async () => {
    if (canUseUnlockWorker(options) && !options.preloadedBuf) {
      const workerRes = await runUnlockWorkerTask('apply', {
        options: { ...sanitizeUnlockWorkerOptions(options), targetPath: target }
      });
      if (workerRes && workerRes._workerHandled) {
        invalidateUnlockCache(target);
        return workerRes.result;
      }
    }
    let preloadedBuf = options.preloadedBuf || null;
    let preloadedStats = options.preloadedStats || null;
    if (!preloadedBuf && fs.existsSync(target)) {
      try {
        preloadedStats = await fs.promises.stat(target);
        preloadedBuf = await fs.promises.readFile(target);
      } catch {}
    }

    const analysis = await analyzeBinaryAsync(target, {
      backupDir: options.backupDir,
      expectedLimit: targetSpec.limitTokens,
      preloadedBuf,
      preloadedStats,
      forceRefresh: true,
      skipProcessCheck: options.skipProcessCheck === true
    });

    const allowedStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
    if (!allowedStatuses.has(analysis.status) || !isSupportedUnlockTarget(analysis.format, analysis.arch)) {
      return {
        ok: false,
        code: analysis.status === 'partial_match' ? 'PARTIAL_MATCH' : 'UNSUPPORTED_OR_UNKNOWN',
        error: `无法应用设置：${analysis.details || analysis.reason || '目标状态不受支持或存在部分匹配异常'}`,
        analysis
      };
    }

    const idemRes = checkUnlockIdempotency(targetSpec, analysis);
    if (idemRes) return idemRes;

    const { gate3a, gate3b, serializerGate, arch, targetPath, sha256: beforeSha256, fileSize } = analysis;
    const backupDir = getUnlockBackupDir(options.backupDir);
    const existingManifest = loadManifest(options.backupDir);
    const existingSidecar = loadGate3BSidecar(options.backupDir);
    const buf = preloadedBuf ? Buffer.from(preloadedBuf) : await fs.promises.readFile(targetPath);
    const container = findTextSection(buf);

    let gate3bOrigBytesForDefault = null;
    if (targetSpec.mode === 'default' && gate3b.status === 'patched') {
      if (doesSidecarMatchTarget(existingSidecar, targetPath, container, gate3b)) {
        gate3bOrigBytesForDefault = Buffer.from(existingSidecar.origHex, 'hex');
      } else if (
        existingManifest &&
        existingManifest.backupPath &&
        fs.existsSync(existingManifest.backupPath) &&
        doesManifestMatchContainer(existingManifest, container, targetPath)
      ) {
        const backupBuf = await fs.promises.readFile(existingManifest.backupPath);
        const backupSha = await sha256BufferAsync(backupBuf);
        if (backupSha !== existingManifest.origSha256) {
          return {
            ok: false,
            code: 'MISSING_OR_STALE_GATE3B_SIDECAR',
            error: '缺少与当前版本匹配的原始字节记录或备份，无法安全切换回默认状态（已阻止盲写）。',
            analysis
          };
        }
        gate3bOrigBytesForDefault = backupBuf.subarray(gate3b.offset, gate3b.offset + (gate3b.length || 2));
      } else {
        return {
          ok: false,
          code: 'MISSING_OR_STALE_GATE3B_SIDECAR',
          error: '缺少与当前版本匹配的原始字节记录或备份，无法安全切换回默认状态（已阻止盲写）。',
          analysis
        };
      }
    }

    let manifestToSave = existingManifest && doesManifestMatchContainer(existingManifest, container, targetPath)
      ? { ...existingManifest }
      : null;

    if (analysis.status === 'not_patched') {
      const backupFile = path.join(backupDir, `${path.basename(targetPath)}_${beforeSha256.slice(0, 12)}.orig`);
      try {
        await fs.promises.writeFile(backupFile, buf);
        const backupRead = await fs.promises.readFile(backupFile);
        const backupSha = await sha256BufferAsync(backupRead);
        if (backupSha !== beforeSha256) {
          try { await fs.promises.unlink(backupFile); } catch {}
          return { ok: false, error: '原版备份哈希校验不匹配，操作已中止。' };
        }
      } catch (e) {
        return { ok: false, error: `创建原版备份失败: ${e.message}` };
      }

      if (gate3b.origHex) {
        saveGate3BSidecar({
          targetPath,
          buildId: container.buildId || null,
          peTimeDateStamp: container.peTimeDateStamp ?? null,
          peSizeOfImage: container.peSizeOfImage ?? null,
          offset: gate3b.offset,
          length: gate3b.length,
          origHex: gate3b.origHex,
          origSha8: beforeSha256.slice(0, 8),
          updatedAt: new Date().toISOString()
        }, options.backupDir);
      }

      manifestToSave = {
        targetPath,
        arch,
        buildId: container.buildId || null,
        peTimeDateStamp: container.peTimeDateStamp ?? null,
        peSizeOfImage: container.peSizeOfImage ?? null,
        origSha256: beforeSha256,
        origSize: fileSize,
        backupPath: backupFile,
        backupSha256: beforeSha256,
        gate3aVariant: gate3a.clampVariant || 'edx_esi_256k',
        gate3aOrigLimit: gate3a.origLimit || DEFAULT_CHECKPOINT_TOKENS,
        gate3bOrigHex: gate3b.origHex || null,
        gate3bLength: gate3b.length || null,
        gate3bOffset: gate3b.offset ?? null,
        author: AUTHOR_INFO
      };
    }

    const serializerPatched = patchUnlockBuffer(buf, targetSpec, gate3a, gate3b, serializerGate, gate3bOrigBytesForDefault, arch);
    const writeRes = await atomicWriteBinaryAsync(targetPath, buf, 'new', {
      entitlementsSourcePath: manifestToSave?.backupPath || targetPath,
      skipCodesign: options.skipCodesign === true,
      forceCodesign: options.forceCodesign === true,
      codesignBin: options.codesignBin,
      _execFile: options._execFile
    });
    if (!writeRes.ok) {
      return { ok: false, code: writeRes.code || 'WRITE_FAILED', error: writeRes.error };
    }
    const afterSha256 = isMachO64Buffer(buf)
      ? await sha256BufferAsync(await fs.promises.readFile(targetPath))
      : await sha256BufferAsync(buf);

    const syncedConfigs = syncExternalContextConfigs(targetSpec.mode, targetSpec.limitTokens, options);

    const effectiveLimitTokens = targetSpec.mode === 'default'
      ? (gate3a.origLimit || DEFAULT_CHECKPOINT_TOKENS)
      : targetSpec.limitTokens;

    if (manifestToSave) {
      manifestToSave.patchedSha256 = afterSha256;
      manifestToSave.patchedAt = new Date().toISOString();
      manifestToSave.configuredMode = targetSpec.mode;
      manifestToSave.configuredLimitTokens = effectiveLimitTokens;
      manifestToSave.needsRestart = true;
      saveManifest(manifestToSave, options.backupDir);
    }

    const modeSummary = targetSpec.mode === 'default'
      ? '宿主默认模式（恢复原有行为）'
      : targetSpec.mode === 'fixed'
        ? `固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens`
        : '跟随模型（动态透传）';
    const restartHint = writeRes.usedRenameTrick
      ? '由于客户端正在运行，请【完全退出并重启 Antigravity 客户端】使新后端配置生效。'
      : '请重启 Antigravity 客户端使新后端配置生效。';

    const signHint = writeRes.signatureMode === 'ad-hoc'
      ? (writeRes.entitlementsPreserved
        ? '已保留原有 entitlements 并完成本地 ad-hoc 重签名'
        : '已完成本地 ad-hoc 重签名')
      : '';

    return {
      ok: true,
      needsRestart: true,
      targetPath,
      configuredMode: targetSpec.mode,
      configuredLimitTokens: targetSpec.limitTokens,
      defaultSitePatched: Boolean(gate3a.hasDefaultSite),
      serializerPatched,
      syncedConfigs,
      signatureMode: writeRes.signatureMode || null,
      entitlementsPreserved: Boolean(writeRes.entitlementsPreserved),
      warnings: targetSpec.warnings || [],
      scopeNote: analysis.scopeNotice,
      beforeSha256,
      afterSha256,
      backupPath: manifestToSave ? manifestToSave.backupPath : null,
      message: `已将共享后端切换为「${modeSummary}」，影响共享该后端的所有会话；${signHint ? `${signHint}；` : ''}${restartHint}（尚未经过真实长请求验证）`
    };
  });
}

/**
 * 异步非阻塞恢复原版二进制 (Restore)
 */
async function restoreUnlockAsync(options = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前平台 (${process.platform}) 暂未通过安全写入验证，已自动拦截操作。`
    };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) {
    return resolvedTarget;
  }
  const target = resolvedTarget.target;

  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '目标文件不存在，无法恢复' };
  }

  return enqueueUnlockTargetWrite(target, async () => {
    if (canUseUnlockWorker(options)) {
      const workerRes = await runUnlockWorkerTask('restore', {
        options: { ...sanitizeUnlockWorkerOptions(options), targetPath: target }
      });
      if (workerRes && workerRes._workerHandled) {
        invalidateUnlockCache(target);
        return workerRes.result;
      }
    }
    const manifest = loadManifest(options.backupDir);
    const sidecar = loadGate3BSidecar(options.backupDir);
    const currentBuf = await fs.promises.readFile(target);
    const currentSha256 = await sha256BufferAsync(currentBuf);

    let container;
    try {
      container = findTextSection(currentBuf);
    } catch (e) {
      return { ok: false, error: `解析当前二进制容器失败，拒绝恢复: ${e.message}` };
    }

    if (manifest && manifest.backupPath && fs.existsSync(manifest.backupPath)) {
      if (!isSameTargetPath(manifest.targetPath, target)) {
        return { ok: false, error: '安装记录目标与当前恢复目标不一致，拒绝跨路径还原。' };
      }
      if (!doesManifestMatchContainer(manifest, container, target)) {
        return {
          ok: false,
          code: 'BACKUP_VERSION_MISMATCH',
          error: '检测到当前目标文件版本/构建已更新，与历史备份的 PE 构建指纹不一致，已拒绝跨版本还原以免破坏新版本二进制。'
        };
      }
      const backupBuf = await fs.promises.readFile(manifest.backupPath);
      const backupSha = await sha256BufferAsync(backupBuf);
      if (backupSha !== manifest.origSha256) {
        return { ok: false, error: '原版备份文件已损坏或被篡改，无法执行还原。' };
      }
      if (currentSha256 === manifest.origSha256) {
        manifest.needsRestart = false;
        saveManifest(manifest, options.backupDir);
        return { ok: true, alreadyRestored: true, message: '当前已经是官方原版，无需重复恢复。' };
      }

      const writeRes = await atomicWriteBinaryAsync(target, backupBuf, 'res', { skipCodesign: true });
      if (!writeRes.ok) {
        return { ok: false, error: `恢复原版写入失败: ${writeRes.error}` };
      }

      manifest.needsRestart = true;
      manifest.configuredMode = 'default';
      manifest.configuredLimitTokens = manifest.gate3aOrigLimit || DEFAULT_CHECKPOINT_TOKENS;
      saveManifest(manifest, options.backupDir);
      const syncedConfigs = syncExternalContextConfigs('default', null, options);

      return {
        ok: true,
        needsRestart: true,
        restoredOriginalSignature: true,
        afterSha256: manifest.origSha256,
        syncedConfigs,
        message: writeRes.usedRenameTrick
          ? '已成功恢复官方原版二进制！请【完全退出并重启 Antigravity 客户端】生效。'
          : '已成功恢复官方原版二进制！请重启客户端生效。'
      };
    }

    const analysis = await analyzeBinaryAsync(target, {
      backupDir: options.backupDir,
      preloadedBuf: currentBuf,
      forceRefresh: true,
      skipProcessCheck: true
    });
    if (analysis.status === 'not_patched') {
      const syncedConfigs = syncExternalContextConfigs('default', null, options);
      return { ok: true, alreadyRestored: true, syncedConfigs, message: '当前已经是官方原版，无需恢复。' };
    }

    if (
      (analysis.gate3a?.status === 'patched' || analysis.gate3a?.status === 'unpatched') &&
      analysis.gate3b?.status === 'patched' &&
      doesSidecarMatchTarget(sidecar, target, container, analysis.gate3b)
    ) {
      restoreBufferBySidecar(currentBuf, analysis, sidecar, container.arch);

      const writeRes = await atomicWriteBinaryAsync(target, currentBuf, 'rev', {
        skipCodesign: options.skipCodesign === true,
        forceCodesign: options.forceCodesign === true,
        codesignBin: options.codesignBin,
        _execFile: options._execFile
      });
      if (!writeRes.ok) {
        return { ok: false, error: `逆向还原写入失败: ${writeRes.error}` };
      }
      const syncedConfigs = syncExternalContextConfigs('default', null, options);

      return {
        ok: true,
        needsRestart: true,
        syncedConfigs,
        message: '已通过同构建校验记录恢复官方原版！请重启 Antigravity 客户端生效。'
      };
    }

    return {
      ok: false,
      code: 'RESTORE_REJECTED',
      error: '未找到与当前版本匹配的原版备份或原始字节记录，为确保安全拒绝覆盖。'
    };
  });
}

// ============================================================================
// 内嵌 worker_threads 后台卸载引擎（消除 200MB 二进制扫描、哈希与写盘的主线程阻塞）
// ============================================================================

let unlockWorkerInstance = null;
let unlockWorkerDisabled = false;
let unlockWorkerReqId = 1;
const unlockWorkerPending = new Map();
let unlockWorkerIdleTimer = null;
let unlockWorkerScriptPath = __filename;
let unlockWorkerConsecutiveFailures = 0;
const UNLOCK_WORKER_TIMEOUT_MS = 45000;
const UNLOCK_WORKER_MAX_FAILURES = 3;

function clearAllUnlockWorkerPending(targetWorker = null, reasonResult = null) {
  for (const [id, entry] of unlockWorkerPending.entries()) {
    if (targetWorker && entry.worker !== targetWorker) continue;
    unlockWorkerPending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(reasonResult);
  }
}

function canUseUnlockWorker(options = {}) {
  if (!isMainThread || unlockWorkerDisabled || options._inWorker === true || options.useMainThread === true) {
    return false;
  }
  if (
    typeof options._execFile === 'function' ||
    typeof options._execFileSync === 'function' ||
    options.forceCodesign === true ||
    options.codesignBin !== undefined ||
    options.skipCodesign === true
  ) {
    return false;
  }
  if (fs.readFileSync !== ORIG_UNLOCK_FS_READ_SYNC || fs.promises.readFile !== ORIG_UNLOCK_FS_READ_ASYNC) {
    return false;
  }
  return typeof Worker === 'function';
}

function sanitizeUnlockWorkerOptions(options = {}) {
  const safe = {};
  const keys = [
    'targetPath', 'backupDir', 'enhanceBackupDir', 'homeDir', 'localAppData',
    'stateDir', 'expectedLimit', 'limitTokens', 'mode', 'modeName',
    'skipSha256', 'skipProcessCheck', 'syncConfigFiles', 'forceRefresh',
    'contextMode', 'contextLimitTokens'
  ];
  for (const k of keys) {
    if (options[k] !== undefined) safe[k] = options[k];
  }
  return safe;
}

function captureEnvSnapshot() {
  return {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    AG_METER_TEST_MODE: process.env.AG_METER_TEST_MODE
  };
}

function scheduleUnlockWorkerIdleCleanup() {
  if (unlockWorkerIdleTimer) {
    clearTimeout(unlockWorkerIdleTimer);
    unlockWorkerIdleTimer = null;
  }
  if (unlockWorkerPending.size > 0 || !unlockWorkerInstance) return;
  const idleMs = process.env.NODE_TEST_CONTEXT ? 120 : 2500;
  unlockWorkerIdleTimer = setTimeout(() => {
    unlockWorkerIdleTimer = null;
    if (unlockWorkerPending.size === 0 && unlockWorkerInstance) {
      const w = unlockWorkerInstance;
      unlockWorkerInstance = null;
      try { w.terminate(); } catch {}
    }
  }, idleMs);
  if (typeof unlockWorkerIdleTimer.unref === 'function') unlockWorkerIdleTimer.unref();
}

function getOrStartUnlockWorker(workerScript = __filename) {
  const targetScript = workerScript || __filename;
  if (unlockWorkerInstance && unlockWorkerScriptPath === targetScript) {
    return unlockWorkerInstance;
  }
  if (unlockWorkerInstance && unlockWorkerScriptPath !== targetScript) {
    const oldW = unlockWorkerInstance;
    unlockWorkerInstance = null;
    clearAllUnlockWorkerPending(oldW, null);
    try { oldW.terminate(); } catch {}
  }
  unlockWorkerScriptPath = targetScript;
  const w = new Worker(targetScript, {
    workerData: { agUnlockWorker: true }
  });
  w.unref();
  w.on('message', (msg) => {
    if (!msg || !msg.id) return;
    const entry = unlockWorkerPending.get(msg.id);
    if (!entry) return;
    unlockWorkerPending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.ok) unlockWorkerConsecutiveFailures = 0;
    scheduleUnlockWorkerIdleCleanup();
    if (msg.ok) entry.resolve({ _workerHandled: true, result: msg.result });
    else entry.resolve(null);
  });
  w.on('error', () => {
    if (unlockWorkerInstance === w) unlockWorkerInstance = null;
    unlockWorkerConsecutiveFailures += 1;
    if (unlockWorkerConsecutiveFailures >= UNLOCK_WORKER_MAX_FAILURES) {
      unlockWorkerDisabled = true;
    }
    clearAllUnlockWorkerPending(w, null);
    try { w.terminate(); } catch {}
  });
  w.on('exit', (code) => {
    if (unlockWorkerInstance === w) unlockWorkerInstance = null;
    if (code !== 0) {
      let hadPending = false;
      for (const entry of unlockWorkerPending.values()) {
        if (entry.worker === w) { hadPending = true; break; }
      }
      if (hadPending) {
        unlockWorkerConsecutiveFailures += 1;
        if (unlockWorkerConsecutiveFailures >= UNLOCK_WORKER_MAX_FAILURES) {
          unlockWorkerDisabled = true;
        }
      }
    }
    clearAllUnlockWorkerPending(w, null);
  });
  unlockWorkerInstance = w;
  return w;
}

async function runUnlockWorkerTask(cmd, payload, workerOpts = {}) {
  try {
    if (unlockWorkerIdleTimer) {
      clearTimeout(unlockWorkerIdleTimer);
      unlockWorkerIdleTimer = null;
    }
    const targetScript = (typeof workerOpts._unlockWorkerScript === 'string' && workerOpts._unlockWorkerScript.trim())
      ? workerOpts._unlockWorkerScript.trim()
      : __filename;
    const timeoutMs = (Number.isFinite(workerOpts.workerTimeoutMs) && workerOpts.workerTimeoutMs > 0)
      ? workerOpts.workerTimeoutMs
      : UNLOCK_WORKER_TIMEOUT_MS;
    const w = getOrStartUnlockWorker(targetScript);
    const id = unlockWorkerReqId++;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = unlockWorkerPending.get(id);
        if (!entry) return;
        unlockWorkerPending.delete(id);
        // 超时销毁卡死 Worker 并仅清属于该 Worker 的等待项，由后续队列按需重建而非永久禁用
        if (unlockWorkerInstance === w) unlockWorkerInstance = null;
        clearAllUnlockWorkerPending(w, null);
        try { w.terminate(); } catch {}
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      unlockWorkerPending.set(id, { resolve, timer, worker: w });
      try {
        w.postMessage({ id, cmd, payload, env: captureEnvSnapshot() });
      } catch {
        clearTimeout(timer);
        unlockWorkerPending.delete(id);
        resolve(null);
      }
    });
  } catch {
    unlockWorkerConsecutiveFailures += 1;
    if (unlockWorkerConsecutiveFailures >= UNLOCK_WORKER_MAX_FAILURES) {
      unlockWorkerDisabled = true;
    }
    return null;
  }
}

if (!isMainThread && workerData && workerData.agUnlockWorker && parentPort) {
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
      if (cmd === 'analyze') {
        result = await analyzeBinaryAsync(payload.filePath, { ...(payload.options || {}), _inWorker: true });
      } else if (cmd === 'apply') {
        result = await applyUnlockAsync({ ...(payload.options || {}), _inWorker: true });
      } else if (cmd === 'restore') {
        result = await restoreUnlockAsync({ ...(payload.options || {}), _inWorker: true });
      } else {
        throw new Error(`Unknown unlock worker command: ${cmd}`);
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
  AUTHOR_INFO,
  DEFAULT_CHECKPOINT_TOKENS,
  MIN_ENGINEERING_LIMIT,
  MAX_ENGINEERING_LIMIT,
  KNOWN_LIMIT_PRESETS,
  validateContextLimit,
  detectTargetBinary,
  detectCliBinary,
  findTextSection,
  findPclntab,
  buildFunctions,
  checkSerializerGate,
  syncExternalContextConfigs,
  readExternalContextConfig,
  analyzeBinary,
  analyzeBinaryAsync,
  getRunningLanguageServerInfoAsync,
  cleanupOldReplacedFiles,
  synthesizeAnalysisStatus,
  applyUnlock,
  applyUnlockAsync,
  restoreUnlock,
  restoreUnlockAsync,
  invalidateUnlockCache,
  enqueueUnlockTargetWrite,
  getUnlockBackupDir,
  loadGate3BSidecar,
  saveGate3BSidecar,
  runUnlockWorkerTask
};
