'use strict';
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
const DIST_DIR = path.join(ROOT_DIR, 'dist', 'release');

const COMMON_FILES = [
  'cli.js',
  'install.js',
  'restore.js',
  'live-host.js',
  'local-api.js',
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-storage.js',
  'meter-proxy.js',
  'meter-cli-launcher.js',
  'meter-context-unlock.js',
  'attachment_scan.py',
  'asar-engine.js',
  'modules-config.js',
  'modular-installer.js',
  'i18n/zh-CN.json',
  'i18n/i18n-runtime.js',
  'package.json',
  'README.md',
  'README.en.md',
  'README.ja.md',
  'README.ko.md',
  'README.es.md',
  'AGENTS.md',
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

function ensureWindowsHelper() {
  const helperPath = path.join(ROOT_DIR, 'scripts', 'cli-window-helper.exe');
  const csSrc = path.join(ROOT_DIR, 'scripts', 'cli-window-helper.cs');

  const cscCandidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
  ];
  let cscExe = cscCandidates.find(p => fs.existsSync(p));

  if (cscExe && fs.existsSync(csSrc)) {
    try {
      execFileSync(cscExe, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${helperPath}`, csSrc], { stdio: 'pipe' });
      if (fs.existsSync(helperPath) && fs.statSync(helperPath).size > 0) {
        console.log(`[Packaging] scripts/cli-window-helper.exe 源码编译成功 (${fs.statSync(helperPath).size} 字节)`);
        return true;
      }
    } catch (e) {
      console.warn(`[Packaging Warning] 调用 csc 重新编译失败: ${e.message}`);
    }
  }

  if (fs.existsSync(helperPath) && fs.statSync(helperPath).size > 0) {
    console.log('[Packaging] 复用已有的 scripts/cli-window-helper.exe 二进制');
    return true;
  }

  throw new Error('缺少必需的 Windows 原生组件 scripts/cli-window-helper.exe，且无法自动编译！');
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  return pkg.version || '0.8.1';
}

function packagePlatform(plat, version) {
  const platName = plat.name;
  const zipFilename = `antigravity-context-viewer_${version}_${platName}.zip`;
  const zipPath = path.join(DIST_DIR, zipFilename);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const stagingDir = path.join(os.tmpdir(), `ag-pkg-${platName}-${stamp}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const fileList = [...COMMON_FILES, ...plat.scripts];
    for (const rel of fileList) {
      const src = path.join(ROOT_DIR, rel);
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

    // 调用 PowerShell 原生 .NET ZipFile 进行高兼容无损压缩
    const psScript = `
      [System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)
    `;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'pipe' });
    if (res.status !== 0 || !fs.existsSync(zipPath)) {
      throw new Error(`打包 ${zipFilename} 失败: ${res.stderr?.toString('utf8') || '未知错误'}`);
    }

    const sz = fs.statSync(zipPath).size;
    const sha = sha256File(zipPath);
    console.log(`[Packaging] 成功打包 ${zipFilename} (${sz} 字节) - SHA-256: ${sha.slice(0, 16)}...`);
    return { name: zipFilename, path: zipPath, sha256: sha, size: sz };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  ensureWindowsHelper();

  console.log('[Packaging] Building latest meter-renderer.js from src/renderer/...');
  execFileSync('node', [path.join(ROOT_DIR, 'scripts', 'build-renderer.js')], { stdio: 'inherit' });

  const version = getVersion();
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const results = [];
  for (const plat of PLATFORMS) {
    const r = packagePlatform(plat, version);
    results.push(r);
  }

  const checksumLines = results.map(r => `${r.sha256}  ${r.name}`).join('\n') + '\n';
  const checksumFile = path.join(DIST_DIR, 'checksums.txt');
  fs.writeFileSync(checksumFile, checksumLines, 'utf8');
  console.log(`[Packaging] 已生成 checksums.txt (共 ${results.length} 个资产包)`);

  return results;
}

if (require.main === module) {
  main();
}

module.exports = { main, packagePlatform };
