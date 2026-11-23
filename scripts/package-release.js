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
      if (supportsCscDeterministicFlag(cscExe)) {
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

function packagePlatform(plat, version, options = {}) {
  const platName = plat.name;
  const targetDistDir = options.distDir ? path.resolve(options.distDir) : DIST_DIR;
  const zipFilename = `antigravity-context-viewer_${version}_${platName}.zip`;
  const zipPath = path.join(targetDistDir, zipFilename);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const stagingDir = path.join(os.tmpdir(), `ag-pkg-${platName}-${stamp}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(targetDistDir, { recursive: true });

  try {
    const fileList = [...COMMON_FILES, ...plat.scripts];
    for (const rel of fileList) {
      const src = (rel === 'scripts/cli-window-helper.exe' && options.helperPath)
        ? path.resolve(options.helperPath)
        : path.join(ROOT_DIR, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`缺少必需的发布文件: ${rel}，拒绝打包！`);
      }
      const dest = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      if (rel.endsWith('.sh')) {
        let content = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
        fs.writeFileSync(dest, content, { encoding: 'utf8', mode: 0o755 });
      } else if (rel.endsWith('.bat')) {
        let content = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n');
        fs.writeFileSync(dest, content, { encoding: 'utf8' });
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (process.platform === 'win32') {
      // 优先使用系统自带 System32\tar.exe (bsdtar -a -cf) 生成使用正斜杠 '/' 的跨平台标准 ZIP，避免被 PATH 中的 GNU tar 抢占
      const topEntries = fs.readdirSync(stagingDir);
      const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
      const sysTar = path.win32.join(sysRoot, 'System32', 'tar.exe');
      const tarBin = fs.existsSync(sysTar) ? sysTar : 'tar.exe';
      const tarRes = spawnSync(tarBin, ['-a', '-cf', zipPath, ...topEntries], { cwd: stagingDir, stdio: 'pipe', windowsHide: true });
      if (tarRes.status !== 0 || !fs.existsSync(zipPath)) {
        // 回退 PowerShell 原生 .NET ZipFile
        const psScript = `
      [System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)
    `;
        const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'pipe', windowsHide: true });
        if (res.status !== 0 || !fs.existsSync(zipPath)) {
          throw new Error(`打包 ${zipFilename} 失败: ${res.stderr?.toString('utf8') || '未知错误'}`);
        }
      }
    } else {
      // Linux/macOS CI 下优先使用原生 zip 保留 POSIX 文件权限，缺省再回退 Python zipfile
      const zipRes = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stagingDir, stdio: 'pipe' });
      if (zipRes.status !== 0 || !fs.existsSync(zipPath)) {
        const pyCode = [
          'import os, sys, zipfile',
          'src, dst = sys.argv[1], sys.argv[2]',
          'with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:',
          '    for root, _, files in os.walk(src):',
          '        for name in files:',
          '            full = os.path.join(root, name)',
          '            zf.write(full, os.path.relpath(full, src))'
        ].join('\n');
        const pyRes = spawnSync('python3', ['-c', pyCode, stagingDir, zipPath], { stdio: 'pipe' });
        if (pyRes.status !== 0 || !fs.existsSync(zipPath)) {
          throw new Error(`打包 ${zipFilename} 失败: ${(zipRes.stderr || pyRes.stderr || Buffer.alloc(0)).toString('utf8') || '未知错误'}`);
        }
      }
    }

    const sz = fs.statSync(zipPath).size;
    const sha = sha256File(zipPath);
    console.log(`[Packaging] 成功打包 ${zipFilename} (${sz} 字节) - SHA-256: ${sha.slice(0, 16)}...`);
    return { name: zipFilename, path: zipPath, sha256: sha, size: sz };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
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
    for (const plat of PLATFORMS) {
      const r = packagePlatform(plat, version, { distDir: targetDistDir, helperPath: helperInfo.helperPath });
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

