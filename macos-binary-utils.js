'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;

function isMachO64Buffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 64 && buf.readUInt32LE(0) === MH_MAGIC_64;
}

/**
 * 解析 64 位 Mach-O 容器的 CPU 架构、段/节表、UUID 与虚拟地址映射
 * 对损坏、截断、段偏移越界或未知 Load Command 结构严格返回 null，拒绝盲目写入。
 */
function parseMachO64(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
  const magic = buf.readUInt32LE(0);
  if (magic === FAT_MAGIC || magic === FAT_CIGAM) return null;
  if (magic !== MH_MAGIC_64) return null;

  const cputype = buf.readUInt32LE(4);
  const arch = cputype === CPU_TYPE_ARM64 ? 'arm64' : (cputype === CPU_TYPE_X86_64 ? 'x86-64' : null);
  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  if (ncmds > 4096 || 32 + sizeofcmds > buf.length) return null;

  const cmdsEnd = 32 + sizeofcmds;
  const segments = [];
  const sections = [];
  let uuid = null;
  let hasLinkedit = false;
  let textSize = 0;

  let off = 32;
  for (let c = 0; c < ncmds; c++) {
    if (off + 8 > cmdsEnd) return null;
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8 || (cmdsize % 4) !== 0 || off + cmdsize > cmdsEnd) return null;

    if (cmd === LC_UUID) {
      if (cmdsize < 24) return null;
      uuid = buf.subarray(off + 8, off + 24).toString('hex');
    } else if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) return null;
      const segname = buf.subarray(off + 8, off + 24).toString('ascii').replace(/\0.*$/, '');
      const vmaddr = buf.readBigUInt64LE(off + 24);
      const vmsize = buf.readBigUInt64LE(off + 32);
      const rawFileoff = buf.readBigUInt64LE(off + 40);
      const rawFilesize = buf.readBigUInt64LE(off + 48);
      const nsects = buf.readUInt32LE(off + 64);

      if (rawFileoff > BigInt(buf.length) || rawFilesize > BigInt(buf.length) || rawFileoff + rawFilesize > BigInt(buf.length)) {
        return null;
      }
      const fileoff = Number(rawFileoff);
      const filesize = Number(rawFilesize);

      if (nsects > 4096 || 72 + nsects * 80 > cmdsize) {
        return null;
      }

      if (segname === '__LINKEDIT') hasLinkedit = true;
      if (segname === '__TEXT') textSize = filesize;
      segments.push({ segname, vmaddr, vmsize, fileoff, filesize });

      let sectOff = off + 72;
      for (let s = 0; s < nsects; s++) {
        if (sectOff + 80 > off + cmdsize) return null;
        const sectname = buf.subarray(sectOff, sectOff + 16).toString('ascii').replace(/\0.*$/, '');
        const sectSeg = buf.subarray(sectOff + 16, sectOff + 32).toString('ascii').replace(/\0.*$/, '');
        const addr = buf.readBigUInt64LE(sectOff + 32);
        const rawSize = buf.readBigUInt64LE(sectOff + 40);
        const offset = buf.readUInt32LE(sectOff + 48);
        const flags = buf.readUInt32LE(sectOff + 64);
        const sectType = flags & 0xff;
        const isZerofill = sectType === 0x1 || sectType === 0xc; // S_ZEROFILL / S_THREAD_LOCAL_ZEROFILL
        if (!isZerofill && offset > 0 && rawSize > 0n) {
          if (BigInt(offset) + rawSize > BigInt(buf.length)) {
            return null;
          }
        }
        const size = Number(rawSize);
        sections.push({ segname: sectSeg, sectname, addr, size, offset });
        sectOff += 80;
      }
    }
    off += cmdsize;
  }

  const fileOffsetToVA = (foff) => {
    for (const s of sections) {
      if (s.size > 0 && s.offset > 0 && foff >= s.offset && foff < s.offset + s.size) {
        return s.addr + BigInt(foff - s.offset);
      }
    }
    for (const seg of segments) {
      if (seg.filesize > 0 && foff >= seg.fileoff && foff < seg.fileoff + seg.filesize) {
        return seg.vmaddr + BigInt(foff - seg.fileoff);
      }
    }
    return 0n;
  };

  const vaToFileOffset = (va) => {
    for (const s of sections) {
      if (s.size > 0 && s.offset > 0 && va >= s.addr && va < s.addr + BigInt(s.size)) {
        const foff = s.offset + Number(va - s.addr);
        return foff >= 0 && foff <= buf.length ? foff : -1;
      }
    }
    for (const seg of segments) {
      if (seg.filesize > 0 && va >= seg.vmaddr && va < seg.vmaddr + BigInt(seg.filesize)) {
        const foff = seg.fileoff + Number(va - seg.vmaddr);
        return foff >= 0 && foff <= buf.length ? foff : -1;
      }
    }
    return -1;
  };

  const buildKey = uuid
    ? `macho:${uuid}:${textSize}`
    : `macho:${arch || 'unknown'}:${textSize}`;

  return {
    format: 'Mach-O',
    arch,
    cputype,
    uuid,
    buildKey,
    hasLinkedit,
    segments,
    sections,
    fileOffsetToVA,
    vaToFileOffset
  };
}

/**
 * 提取 Mach-O 只读数据区段范围，避免全文件扫描 __text 与 __LINKEDIT
 */
function getMachODataSearchRanges(buf) {
  const info = parseMachO64(buf);
  if (!info || !info.sections.length) return [{ start: 0, end: buf.length }];

  const targetSects = new Set(['__rodata', '__cstring', '__const', '__ustring']);
  const ranges = [];
  for (const s of info.sections) {
    if (s.size <= 0 || s.offset <= 0 || s.offset >= buf.length) continue;
    if (targetSects.has(s.sectname)) {
      ranges.push({ start: s.offset, end: Math.min(buf.length, s.offset + s.size) });
    }
  }
  return ranges.length > 0 ? ranges : [{ start: 0, end: buf.length }];
}

function extractPlistXml(rawOut) {
  const out = String(rawOut || '');
  const idx = out.indexOf('<?xml');
  if (idx !== -1) return out.slice(idx);
  const plistIdx = out.indexOf('<plist');
  if (plistIdx !== -1) return out.slice(plistIdx);
  return null;
}

function extractMachOEntitlementsXmlSync(sourcePath, options = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const runSync = typeof options._execFileSync === 'function' ? options._execFileSync : execFileSync;
  const codesignBin = options.codesignBin || 'codesign';
  try {
    const out = runSync(codesignBin, ['-d', '--entitlements', '-', '--xml', sourcePath], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return extractPlistXml(out);
  } catch (e) {
    const fallbackOut = (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
    return extractPlistXml(fallbackOut);
  }
}

function extractMachOEntitlementsXmlAsync(sourcePath, options = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return Promise.resolve(null);
  const runAsync = typeof options._execFile === 'function' ? options._execFile : execFile;
  const codesignBin = options.codesignBin || 'codesign';
  return new Promise((resolve) => {
    runAsync(codesignBin, ['-d', '--entitlements', '-', '--xml', sourcePath], {
      encoding: 'utf8',
      timeout: 5000
    }, (err, stdout, stderr) => {
      const combined = String(stdout || '') + String(stderr || '');
      const xml = extractPlistXml(combined);
      if (xml) return resolve(xml);
      if (err) return resolve(null);
      resolve(null);
    });
  });
}

function resignMachOFileSync(filePath, entitlementsSourcePath = null, options = {}) {
  const runSync = typeof options._execFileSync === 'function' ? options._execFileSync : execFileSync;
  const codesignBin = options.codesignBin || 'codesign';
  const xml = extractMachOEntitlementsXmlSync(entitlementsSourcePath || filePath, options);
  let entPath = null;
  try {
    const args = ['--force', '--sign', '-', '--options', 'runtime'];
    if (xml) {
      entPath = path.join(os.tmpdir(), `ag-ent-${process.pid}-${Date.now()}.plist`);
      fs.writeFileSync(entPath, xml, 'utf8');
      args.push('--entitlements', entPath);
    }
    args.push(filePath);
    runSync(codesignBin, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    runSync(codesignBin, ['--verify', '--deep', '--strict', '--verbose=1', filePath], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, entitlementsPreserved: Boolean(xml), signatureMode: 'ad-hoc' };
  } finally {
    if (entPath) {
      try { fs.unlinkSync(entPath); } catch {}
    }
  }
}

async function resignMachOFileAsync(filePath, entitlementsSourcePath = null, options = {}) {
  const runAsync = typeof options._execFile === 'function' ? options._execFile : execFile;
  const codesignBin = options.codesignBin || 'codesign';
  const xml = await extractMachOEntitlementsXmlAsync(entitlementsSourcePath || filePath, options);
  let entPath = null;
  try {
    const args = ['--force', '--sign', '-', '--options', 'runtime'];
    if (xml) {
      entPath = path.join(os.tmpdir(), `ag-ent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.plist`);
      await fs.promises.writeFile(entPath, xml, 'utf8');
      args.push('--entitlements', entPath);
    }
    args.push(filePath);
    await new Promise((resolve, reject) => {
      runAsync(codesignBin, args, { encoding: 'utf8', timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      runAsync(codesignBin, ['--verify', '--deep', '--strict', '--verbose=1', filePath], { encoding: 'utf8', timeout: 15000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    return { ok: true, entitlementsPreserved: Boolean(xml), signatureMode: 'ad-hoc' };
  } finally {
    if (entPath) {
      try { await fs.promises.unlink(entPath); } catch {}
    }
  }
}

function shouldResignMachO(buf, options = {}) {
  if (options.skipCodesign === true) return false;
  const info = parseMachO64(buf);
  if (!info) return false;
  if (options.forceCodesign === true) return true;
  if (process.platform !== 'darwin') return false;
  return Boolean(info.hasLinkedit);
}

/**
 * macOS 安全原子写盘（写入临时文件 -> 重签名并校验 -> chmod 0755 -> rename 原子切换 inode；失败则删临时文件保留原文件）
 */
function atomicWriteMachOBinarySync(targetPath, buf, options = {}) {
  const info = parseMachO64(buf);
  if (!info) {
    throw new Error('目标 Mach-O 二进制格式损坏或结构异常，拒绝写入');
  }
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.tmp_${process.pid}_${Date.now()}`);
  let signResult = { entitlementsPreserved: false, signatureMode: 'unchanged' };
  try {
    fs.writeFileSync(tmpPath, buf);
    try { fs.chmodSync(tmpPath, 0o755); } catch {}
    if (shouldResignMachO(buf, options)) {
      signResult = resignMachOFileSync(tmpPath, options.entitlementsSourcePath || targetPath, options);
    }
    fs.renameSync(tmpPath, targetPath);
    return signResult;
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

async function atomicWriteMachOBinaryAsync(targetPath, buf, options = {}) {
  const info = parseMachO64(buf);
  if (!info) {
    throw new Error('目标 Mach-O 二进制格式损坏或结构异常，拒绝写入');
  }
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.tmp_${process.pid}_${Date.now()}`);
  let signResult = { entitlementsPreserved: false, signatureMode: 'unchanged' };
  try {
    await fs.promises.writeFile(tmpPath, buf);
    try { await fs.promises.chmod(tmpPath, 0o755); } catch {}
    if (shouldResignMachO(buf, options)) {
      signResult = await resignMachOFileAsync(tmpPath, options.entitlementsSourcePath || targetPath, options);
    }
    await fs.promises.rename(tmpPath, targetPath);
    return signResult;
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

function parsePsOutput(stdout) {
  const procs = [];
  const lineRe = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const pid = Number(m[1]);
    const parsedTime = Date.parse(m[2]);
    const comm = m[3].trim();
    if (Number.isFinite(pid) && pid > 0 && comm) {
      procs.push({
        pid,
        startTimeMs: Number.isFinite(parsedTime) ? parsedTime : null,
        path: comm
      });
    }
  }
  return procs;
}

/**
 * 精确判定进程可执行路径是否为目标 Antigravity language_server（绝不按宽泛名称误杀其他应用）
 */
function isExactMacLanguageServerProcess(procPath, knownTargetPaths = []) {
  if (!procPath || typeof procPath !== 'string') return false;
  const resolved = path.resolve(procPath.trim());
  if (Array.isArray(knownTargetPaths) && knownTargetPaths.length > 0) {
    for (const kt of knownTargetPaths) {
      if (kt && path.resolve(String(kt)) === resolved) return true;
    }
  }
  const norm = resolved.replace(/\\/g, '/');
  return (
    norm.endsWith('/Antigravity.app/Contents/Resources/bin/language_server') ||
    norm.endsWith('/Antigravity IDE.app/Contents/Resources/bin/language_server') ||
    norm.endsWith('/Google Antigravity.app/Contents/Resources/bin/language_server') ||
    norm.endsWith('/Contents/Resources/app/extensions/antigravity/bin/language_server_darwin_arm64') ||
    norm.endsWith('/Contents/Resources/app/extensions/antigravity/bin/language_server_darwin_x64')
  );
}

function listMacProcessesSync() {
  if (process.platform !== 'darwin') return [];
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parsePsOutput(out);
  } catch {
    return [];
  }
}

function listMacProcessesAsync() {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('ps', ['-ax', '-o', 'pid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 3000
    }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parsePsOutput(stdout));
    });
  });
}

module.exports = {
  MH_MAGIC_64,
  FAT_MAGIC,
  FAT_CIGAM,
  LC_SEGMENT_64,
  LC_UUID,
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  isMachO64Buffer,
  parseMachO64,
  getMachODataSearchRanges,
  extractMachOEntitlementsXmlSync,
  extractMachOEntitlementsXmlAsync,
  resignMachOFileSync,
  resignMachOFileAsync,
  atomicWriteMachOBinarySync,
  atomicWriteMachOBinaryAsync,
  parsePsOutput,
  isExactMacLanguageServerProcess,
  listMacProcessesSync,
  listMacProcessesAsync
};
