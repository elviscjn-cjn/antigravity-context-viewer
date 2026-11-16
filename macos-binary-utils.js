'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;

function isMachO64Buffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 64 && buf.readUInt32LE(0) === MH_MAGIC_64;
}

/**
 * 解析 64 位 Mach-O 容器的 CPU 架构、段/节表、UUID 与虚拟地址映射
 */
function parseMachO64(buf) {
  if (!isMachO64Buffer(buf)) return null;

  const cputype = buf.readUInt32LE(4);
  const arch = cputype === CPU_TYPE_ARM64 ? 'arm64' : (cputype === CPU_TYPE_X86_64 ? 'x86-64' : null);
  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  if (32 + sizeofcmds > buf.length) return null;

  const segments = [];
  const sections = [];
  let uuid = null;
  let hasLinkedit = false;
  let textSize = 0;

  let off = 32;
  for (let c = 0; c < ncmds; c++) {
    if (off + 8 > buf.length) break;
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > buf.length) break;

    if (cmd === LC_UUID && cmdsize >= 24) {
      uuid = buf.subarray(off + 8, off + 24).toString('hex');
    } else if (cmd === LC_SEGMENT_64 && cmdsize >= 72) {
      const segname = buf.subarray(off + 8, off + 24).toString('ascii').replace(/\0.*$/, '');
      const vmaddr = buf.readBigUInt64LE(off + 24);
      const vmsize = buf.readBigUInt64LE(off + 32);
      const fileoff = Number(buf.readBigUInt64LE(off + 40));
      const filesize = Number(buf.readBigUInt64LE(off + 48));
      const nsects = buf.readUInt32LE(off + 64);

      if (segname === '__LINKEDIT') hasLinkedit = true;
      if (segname === '__TEXT') textSize = filesize;
      segments.push({ segname, vmaddr, vmsize, fileoff, filesize });

      let sectOff = off + 72;
      for (let s = 0; s < nsects; s++) {
        if (sectOff + 80 > off + cmdsize) break;
        const sectname = buf.subarray(sectOff, sectOff + 16).toString('ascii').replace(/\0.*$/, '');
        const sectSeg = buf.subarray(sectOff + 16, sectOff + 32).toString('ascii').replace(/\0.*$/, '');
        const addr = buf.readBigUInt64LE(sectOff + 32);
        const size = Number(buf.readBigUInt64LE(sectOff + 40));
        const offset = buf.readUInt32LE(sectOff + 48);
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

function extractMachOEntitlementsXmlSync(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  try {
    const out = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', sourcePath], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const idx = out.indexOf('<?xml');
    if (idx !== -1) return out.slice(idx);
    const plistIdx = out.indexOf('<plist');
    if (plistIdx !== -1) return out.slice(plistIdx);
  } catch {}
  return null;
}

function extractMachOEntitlementsXmlAsync(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('codesign', ['-d', '--entitlements', '-', '--xml', sourcePath], {
      encoding: 'utf8',
      timeout: 5000
    }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = String(stdout || '') + String(stderr || '');
      const idx = out.indexOf('<?xml');
      if (idx !== -1) return resolve(out.slice(idx));
      const plistIdx = out.indexOf('<plist');
      if (plistIdx !== -1) return resolve(out.slice(plistIdx));
      resolve(null);
    });
  });
}

function resignMachOFileSync(filePath, entitlementsSourcePath = null) {
  const xml = extractMachOEntitlementsXmlSync(entitlementsSourcePath || filePath);
  let entPath = null;
  try {
    const args = ['--force', '--sign', '-', '--options', 'runtime'];
    if (xml) {
      entPath = path.join(os.tmpdir(), `ag-ent-${process.pid}-${Date.now()}.plist`);
      fs.writeFileSync(entPath, xml, 'utf8');
      args.push('--entitlements', entPath);
    }
    args.push(filePath);
    execFileSync('codesign', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('codesign', ['--verify', '--verbose=1', filePath], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } finally {
    if (entPath) {
      try { fs.unlinkSync(entPath); } catch {}
    }
  }
}

async function resignMachOFileAsync(filePath, entitlementsSourcePath = null) {
  const xml = await extractMachOEntitlementsXmlAsync(entitlementsSourcePath || filePath);
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
      execFile('codesign', args, { encoding: 'utf8', timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      execFile('codesign', ['--verify', '--verbose=1', filePath], { encoding: 'utf8', timeout: 15000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
  } finally {
    if (entPath) {
      try { await fs.promises.unlink(entPath); } catch {}
    }
  }
}

function shouldResignMachO(buf, options = {}) {
  if (options.skipCodesign === true || process.platform !== 'darwin') return false;
  const info = parseMachO64(buf);
  return Boolean(info && info.hasLinkedit);
}

/**
 * macOS 安全原子写盘（写入临时文件 -> 重签名并校验 -> chmod 0755 -> rename 原子切换 inode）
 */
function atomicWriteMachOBinarySync(targetPath, buf, options = {}) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.tmp_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, buf);
    try { fs.chmodSync(tmpPath, 0o755); } catch {}
    if (shouldResignMachO(buf, options)) {
      resignMachOFileSync(tmpPath, options.entitlementsSourcePath || targetPath);
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

async function atomicWriteMachOBinaryAsync(targetPath, buf, options = {}) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.tmp_${process.pid}_${Date.now()}`);
  try {
    await fs.promises.writeFile(tmpPath, buf);
    try { await fs.promises.chmod(tmpPath, 0o755); } catch {}
    if (shouldResignMachO(buf, options)) {
      await resignMachOFileAsync(tmpPath, options.entitlementsSourcePath || targetPath);
    }
    await fs.promises.rename(tmpPath, targetPath);
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
  listMacProcessesSync,
  listMacProcessesAsync
};
