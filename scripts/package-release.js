'use strict';
require('./check-release-manifest');
/**
 * Cross-Platform Release Packager for Antigravity Context & Token Viewer (Pure Node.js Engine)
 * Builds 6 platform-specific zip bundles and generates checksums.txt matching standard GitHub Release layout.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { crc32, deflateRawSync } = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const outDirArgIdx = process.argv.indexOf('--out-dir');
const DIST_DIR = outDirArgIdx !== -1 && process.argv[outDirArgIdx + 1]
  ? path.resolve(process.argv[outDirArgIdx + 1])
  : (process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT_DIR, 'dist', 'release'));

const COMMON_FILES = [
  'cli.js',
  'install.js',
  'restore.js',
  'live-host.js',
  'host-recovery.js',
  'local-api.js',
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-storage.js',
  'meter-proxy.js',
  'meter-cli-launcher.js',
  'meter-cli-monitor.js',
  'meter-cli-adapter.js',
  'meter-cli-companion.js',
  'meter-cli-ui.js',
  'meter-context-unlock.js',
  'meter-enhance.js',
  'meter-rehydrate.js',
  'meter-accounts.js',
  'autostart.js',
  'macos-binary-utils.js',
  'attachment_scan.py',
  'asar-engine.js',
  'modules-config.js',
  'modular-installer.js',
  'i18n/zh-CN.json',
  'i18n/i18n-runtime.js',
  'rehydrate/README.md',
  'rehydrate/rehydrate_after_compact.py',
  'unlock/README.md',
  'unlock/language-server/README.md',
  'unlock/language-server/patch-language_server.py',
  'unlock/agy-cli/README.md',
  'unlock/agy-cli/README-Windows.md',
  'unlock/agy-cli/FINDINGS.md',
  'unlock/agy-cli/agy-patch.py',
  'unlock/agy-cli/apply.sh',
  'unlock/agy-cli/verify_tui.py',
  'package.json',
  'README.md',
  'README.en.md',
  'README.ja.md',
  'README.ko.md',
  'README.es.md',
  'AGENTS.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE'
];

const PLATFORMS = [
  { name: 'windows_amd64', scripts: ['install.bat', 'uninstall.bat', 'scripts/cli-window-helper.exe'] },
  { name: 'windows_arm64', scripts: ['install.bat', 'uninstall.bat', 'scripts/cli-window-helper.exe'] },
  { name: 'darwin_amd64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'darwin_arm64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'linux_amd64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'linux_arm64', scripts: ['install.sh', 'uninstall.sh'] }
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function supportsCscDeterministicFlag(cscExe) {
  if (!cscExe || !fs.existsSync(cscExe)) return false;
  try {
    const out = execFileSync(cscExe, ['/help'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    return /(?:^|\s)[/-]deterministic\b/i.test(String(out || ''));
  } catch {
    return false;
  }
}

// Legacy Framework csc writes the build clock and a random module GUID even for
// identical input. Normalize these two fields on our freshly built unsigned PE.
function normalizeLegacyHelper(file) {
  const image = fs.readFileSync(file);
  const pe = image.readUInt32LE(0x3c);
  const optional = pe + 24;
  if (image.toString('ascii', pe, pe + 4) !== 'PE\0\0' || image.readUInt16LE(optional) !== 0x10b) {
    throw new Error('Unexpected Windows helper PE format');
  }
  const directory = optional + 96;
  const sectionCount = image.readUInt16LE(pe + 6);
  const sectionTable = optional + image.readUInt16LE(pe + 20);
  const offsetOf = rva => {
    for (let i = 0; i < sectionCount; i++) {
      const section = sectionTable + i * 40;
      const start = image.readUInt32LE(section + 12);
      const size = image.readUInt32LE(section + 16);
      if (rva >= start && rva < start + size) return image.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error('Invalid Windows helper metadata address');
  };
  const cli = offsetOf(image.readUInt32LE(directory + 14 * 8));
  if (image.readUInt32LE(directory + 4 * 8 + 4) || image.readUInt32LE(cli + 36) || image.readUInt32LE(optional + 64)) {
    throw new Error('Refusing to normalize signed or checksummed Windows helper');
  }
  const metadata = offsetOf(image.readUInt32LE(cli + 8));
  if (image.toString('ascii', metadata, metadata + 4) !== 'BSJB') throw new Error('Invalid Windows helper metadata');
  const streamHeader = metadata + 16 + image.readUInt32LE(metadata + 12);
  const count = image.readUInt16LE(streamHeader + 2);
  for (let i = 0, stream = streamHeader + 4; i < count; i++) {
    const end = image.indexOf(0, stream + 8);
    if (end < stream + 8) break;
    if (image.toString('ascii', stream + 8, end) === '#GUID' && image.readUInt32LE(stream + 4) === 16) {
      const guid = metadata + image.readUInt32LE(stream);
      if (guid + 16 > image.length) break;
      image.fill(0, guid, guid + 16);
      image.writeUInt32LE(0, pe + 8);
      const digest = crypto.createHash('sha256').update(image).digest();
      digest.copy(image, guid, 0, 16);
      fs.writeFileSync(file, image);
      return;
    }
    stream = (end + 4) & ~3;
  }
  throw new Error('Expected one module GUID in Windows helper');
}

/**
 * 解析并构建 Windows 窗口辅助程序 (Issue #17 构建来源可追溯):
 * - Windows 本地打包: 强制从 scripts/cli-window-helper.cs 源码编译至系统临时目录，绝不采信源码目录残留 .exe；编译或源缺失直接报错退出。
 * - CI / 非 Windows 打包: 强制读取本轮 Windows 作业生成的 scripts/cli-window-helper.exe 并核对 .sha256，缺失或校验失败直接报错退出。
 */
function ensureWindowsHelper(opts = {}) {
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : ROOT_DIR;
  const platform = opts.platform || process.platform;
  const csSrc = opts.csSrc ? path.resolve(opts.csSrc) : path.join(rootDir, 'scripts', 'cli-window-helper.cs');
  const useCiArtifact = opts.useCiArtifact === true || platform !== 'win32';

  if (!useCiArtifact) {
    if (!fs.existsSync(csSrc)) {
      throw new Error(`缺少 Windows 辅助程序源码 ${csSrc}，拒绝使用任何未验证预编译二进制！`);
    }
    const cscCandidates = Array.isArray(opts.cscCandidates) ? opts.cscCandidates : [
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
    ];
    const cscExe = cscCandidates.find(p => p && fs.existsSync(p));
    if (!cscExe) {
      throw new Error('未找到 .NET Framework csc.exe，无法从源码编译 scripts/cli-window-helper.cs，已终止本地打包！');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-win-helper-'));
    const tempHelperPath = path.join(tempDir, 'cli-window-helper.exe');
    try {
      const cscArgs = ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+'];
      const deterministic = supportsCscDeterministicFlag(cscExe);
      if (deterministic) {
        cscArgs.push('/deterministic');
      }
      cscArgs.push(`/out:${tempHelperPath}`, csSrc);
      const res = spawnSync(cscExe, cscArgs, { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
      if (res.error) {
        throw res.error;
      }
      if (res.status !== 0) {
        const detail = String(res.stderr || res.stdout || '').trim();
        throw new Error(`csc.exe 退出码 ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!fs.existsSync(tempHelperPath) || fs.statSync(tempHelperPath).size === 0) {
        throw new Error('编译完成但未生成有效的 cli-window-helper.exe');
      }
      if (!deterministic) normalizeLegacyHelper(tempHelperPath);
      const helperSha256 = sha256File(tempHelperPath);
      const size = fs.statSync(tempHelperPath).size;
      console.log(`[Packaging] cli-window-helper.exe 已在临时目录源码编译 (${size} 字节, SHA-256: ${helperSha256})`);
      return {
        helperPath: tempHelperPath,
        helperSha256,
        size,
        tempDir,
        compiled: true,
        source: 'local_source_build'
      };
    } catch (e) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
      throw new Error(`本地源码编译 scripts/cli-window-helper.cs 失败，已终止打包 (禁止回退残留 .exe): ${e.message}`);
    }
  }

  const ciHelperPath = opts.ciHelperPath
    ? path.resolve(opts.ciHelperPath)
    : path.join(rootDir, 'scripts', 'cli-window-helper.exe');
  const ciSha256File = opts.ciSha256File
    ? path.resolve(opts.ciSha256File)
    : path.join(rootDir, 'scripts', 'cli-window-helper.exe.sha256');

  if (!fs.existsSync(ciHelperPath) || fs.statSync(ciHelperPath).size === 0) {
    throw new Error(`缺少 CI 构建产物 ${ciHelperPath}，拒绝打包！`);
  }

  let expectedSha = typeof opts.expectedSha256 === 'string' ? opts.expectedSha256.trim().toLowerCase() : '';
  if (!expectedSha) {
    if (!fs.existsSync(ciSha256File)) {
      throw new Error(`缺少 CI 辅助程序哈希校验文件 ${ciSha256File}，无法验证构建来源！`);
    }
    const shaContent = fs.readFileSync(ciSha256File, 'utf8');
    const shaMatch = shaContent.match(/([a-f0-9]{64})/i);
    if (!shaMatch) {
      throw new Error(`哈希校验文件 ${ciSha256File} 格式无效，未包含 64 位 SHA-256！`);
    }
    expectedSha = shaMatch[1].toLowerCase();
  }

  const actualSha = sha256File(ciHelperPath).toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(`CI 构建的 cli-window-helper.exe 哈希校验失败 (期望: ${expectedSha}, 实际: ${actualSha})！`);
  }

  console.log(`[Packaging] 已验证 CI 源码构建产物 scripts/cli-window-helper.exe (SHA-256: ${actualSha})`);
  return {
    helperPath: ciHelperPath,
    helperSha256: actualSha,
    size: fs.statSync(ciHelperPath).size,
    tempDir: null,
    compiled: false,
    source: 'ci_verified_artifact'
  };
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  return pkg.version || '0.8.5';
}

// Write ZIP metadata directly so timestamps, permissions and entry order do not
// depend on the checkout filesystem or the OS archive tool.
function createReleaseZip(fileList, helperPath) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

  for (const relative of fileList) {
    const file = relative === 'scripts/cli-window-helper.exe' && helperPath
      ? path.resolve(helperPath) : path.join(ROOT_DIR, relative);
    if (!fs.existsSync(file)) throw new Error(`缺少必需的发布文件: ${relative}`);
    let raw = fs.readFileSync(file);
    if (!relative.endsWith('.exe')) {
      const lf = raw.toString('utf8').replace(/\r\n/g, '\n');
      raw = Buffer.from(relative.endsWith('.bat') ? lf.replace(/\n/g, '\r\n') : lf);
    }
    const name = Buffer.from(relative, 'utf8');
    const packed = deflateRawSync(raw, { level: 6 });
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0); // Minimum reader version
    fields.writeUInt16LE(0x0800, 2); // UTF-8 file names
    fields.writeUInt16LE(8, 4); // Deflate
    fields.writeUInt16LE(dosDate, 8);
    fields.writeUInt32LE(crc32(raw), 10);
    fields.writeUInt32LE(packed.length, 14);
    fields.writeUInt32LE(raw.length, 18);
    fields.writeUInt16LE(name.length, 22);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    fields.copy(local, 4);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4); // Unix attributes
    fields.copy(central, 6);
    const mode = relative.endsWith('.sh') ? 0o100755 : 0o100644;
    central.writeUInt32LE(mode * 65536, 38);
    central.writeUInt32LE(localOffset, 42);
    localChunks.push(local, name, packed);
    centralChunks.push(central, name);
    localOffset += local.length + name.length + packed.length;
  }

  const centralSize = centralChunks.reduce((size, chunk) => size + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(fileList.length, 8);
  end.writeUInt16LE(fileList.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

function packagePlatform(plat, version, options = {}) {
  const platName = plat.name;
  const targetDistDir = options.distDir ? path.resolve(options.distDir) : DIST_DIR;
  const zipFilename = `antigravity-context-viewer_${version}_${platName}.zip`;
  const zipPath = path.join(targetDistDir, zipFilename);

  fs.mkdirSync(targetDistDir, { recursive: true });
  const archive = createReleaseZip([...COMMON_FILES, ...plat.scripts].sort(), options.helperPath);
  fs.writeFileSync(zipPath, archive);
  const sz = archive.length;
  const sha = crypto.createHash('sha256').update(archive).digest('hex');
  console.log(`[Packaging] Packaged ${zipFilename} (${sz} bytes) - SHA-256: ${sha.slice(0, 16)}...`);
  return { name: zipFilename, path: zipPath, sha256: sha, size: sz };
}

function main(options = {}) {
  const helperInfo = ensureWindowsHelper(options);
  const targetDistDir = options.distDir ? path.resolve(options.distDir) : DIST_DIR;

  try {
    if (!options.skipBuild) {
      console.log('[Packaging] Building latest meter-renderer.js from src/renderer/...');
      execFileSync('node', [path.join(ROOT_DIR, 'scripts', 'build-renderer.js')], { stdio: 'inherit' });
    }

    const version = getVersion();
    fs.mkdirSync(targetDistDir, { recursive: true });

    const results = [];
    // 相同载荷必须产出逐字节一致的资产：按载荷签名复用已生成的包，
    // 彻底消除归档器在条目元数据与读取顺序上的非确定性
    const builtBySignature = new Map();
    for (const plat of PLATFORMS) {
      const signature = JSON.stringify({
        version,
        files: [...COMMON_FILES, ...plat.scripts].slice().sort(),
        helper: helperInfo.helperSha256 || null
      });
      const cached = builtBySignature.get(signature);
      if (cached) {
        const zipFilename = `antigravity-context-viewer_${version}_${plat.name}.zip`;
        const zipPath = path.join(targetDistDir, zipFilename);
        fs.copyFileSync(cached.path, zipPath);
        const reused = {
          name: zipFilename,
          path: zipPath,
          sha256: cached.sha256,
          size: cached.size,
          reusedFrom: cached.name
        };
        console.log(`[Packaging] 复用同载荷资产 ${zipFilename} (${reused.size} 字节) - SHA-256: ${reused.sha256.slice(0, 16)}...`);
        results.push(reused);
        continue;
      }
      const r = packagePlatform(plat, version, { distDir: targetDistDir, helperPath: helperInfo.helperPath });
      builtBySignature.set(signature, r);
      results.push(r);
    }

    const checksumLines = results.map(r => `${r.sha256}  ${r.name}`).join('\n') + '\n';
    const checksumFile = path.join(targetDistDir, 'checksums.txt');
    fs.writeFileSync(checksumFile, checksumLines, 'utf8');
    console.log(`[Packaging] 已生成 checksums.txt (共 ${results.length} 个资产包)`);

    results.helperSha256 = helperInfo.helperSha256 || null;
    results.helperSource = helperInfo.source || null;
    return results;
  } finally {
    if (helperInfo?.tempDir) {
      try { fs.rmSync(helperInfo.tempDir, { recursive: true, force: true }); } catch { }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, packagePlatform, ensureWindowsHelper, supportsCscDeterministicFlag };

