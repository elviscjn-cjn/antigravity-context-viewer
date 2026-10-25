'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadAsarEngine, getStateDir } = require('./asar-engine');

const asar = loadAsarEngine();
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function findAsarPath(customPath) {
  if (customPath) {
    let resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const inRes = path.join(resolved, 'resources', 'app.asar');
      if (fs.existsSync(inRes)) return inRes;
      const direct = path.join(resolved, 'app.asar');
      if (fs.existsSync(direct)) return direct;
    }
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`Could not find app.asar at specified path: ${customPath}`);
  }
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(home, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.');
}

async function tryHotInject() {
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
    const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) return false;
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    if (!port) return false;
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const targets = pages.filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    if (!targets.length) return false;

    const stateDir = getStateDir();
    const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
      ? path.join(stateDir, '.live-session.json')
      : path.join(__dirname, '.live-session.json');
    const liveInfo = fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : null;
    const bundle = ['meter-core.js', 'meter-renderer.js']
      .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))
      .join('\n');

    for (const target of targets) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      let seq = 0;
      const evalExpr = expression => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => reject(new Error('CDP eval timeout')), 5000);
        const handler = ev => {
          const d = JSON.parse(ev.data);
          if (d.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handler);
            resolve(d);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      if (liveInfo && liveInfo.origin === new URL(target.url).origin) {
        await evalExpr('window.__AGContextMeterLive=' + JSON.stringify({ port: liveInfo.port, token: liveInfo.token }));
      }
      await evalExpr(bundle);
      ws.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function install(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const installed = findAsarPath(customPath);
  const stateDir = getStateDir();
  let sourceArchive = installed;
  let previousManifest = null;
  const manifestPath = path.join(stateDir, 'installation.json');
  const legacyManifestPath = path.join(__dirname, 'installation.json');

  const activeManifestPath = fs.existsSync(manifestPath)
    ? manifestPath
    : (fs.existsSync(legacyManifestPath) ? legacyManifestPath : null);

  if (activeManifestPath) {
    const previous = JSON.parse(fs.readFileSync(activeManifestPath, 'utf8'));
    previousManifest = previous;
    const currentInstalledSha = sha(fs.readFileSync(installed));
    if (currentInstalledSha === previous.patchedSha256) {
      if (!fs.existsSync(previous.backup) || sha(fs.readFileSync(previous.backup)) !== previous.originalSha256) {
        throw new Error('Original backup checksum mismatch');
      }
      sourceArchive = previous.backup;
      if (fs.existsSync(installed + '.unpacked') && !fs.existsSync(sourceArchive + '.unpacked')) {
        fs.cpSync(installed + '.unpacked', sourceArchive + '.unpacked', { recursive: true, force: false, errorOnExist: true });
      }
    }
  }

  const version = JSON.parse(asar.extractFile(sourceArchive, 'package.json').toString('utf8')).version;
  let originalUtils = asar.extractFile(sourceArchive, 'dist/utils.js').toString('utf8');
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  if (originalUtils.includes('installContextMeter(win)')) {
    originalUtils = originalUtils
      .replace('try { require("./meter-main").ensureProxyEnvironment(process.env); } catch {}\n', '')
      .replace('\n    try { require("./meter-main").ensureProxyEnvironment(env); } catch {}', '')
      .replace(hookLine, '');
  }
  const marker = '    void win.loadURL(url);';
  const setupNodeMarker = 'function setupNodeWrapper(env) {';
  if (originalUtils.split(marker).length !== 2 || !originalUtils.includes(setupNodeMarker)) {
    throw new Error('Unexpected createWindow/setupNodeWrapper source in dist/utils.js; nothing changed.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `app-${version}-base.asar`);

  if (!fs.existsSync(backup) || sha(fs.readFileSync(backup)) !== sha(fs.readFileSync(sourceArchive))) {
    fs.copyFileSync(sourceArchive, backup);
  }
  if (fs.existsSync(sourceArchive + '.unpacked') && !fs.existsSync(backup + '.unpacked')) {
    fs.cpSync(sourceArchive + '.unpacked', backup + '.unpacked', { recursive: true, force: false, errorOnExist: true });
  }

  const staging = path.join(os.tmpdir(), `ag-context-meter-pkg-${stamp}`);
  const packed = path.join(os.tmpdir(), `ag-context-meter-${stamp}.asar`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    asar.extractAll(sourceArchive, staging);
    const patchedUtils = originalUtils
      .replace('"use strict";', '"use strict";\ntry { require("./meter-main").ensureProxyEnvironment(process.env); } catch {}')
      .replace(setupNodeMarker, setupNodeMarker + '\n    try { require("./meter-main").ensureProxyEnvironment(env); } catch {}')
      .replace(marker, hookLine + marker);
    fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), patchedUtils);

    const preloadPath = path.join(staging, 'dist', 'preload.js');
    const preloadMarker = '// Context Meter v2: narrow read-only conversation scan API';
    let preloadContent = fs.readFileSync(preloadPath, 'utf8');
    if (!preloadContent.includes(preloadMarker)) {
      preloadContent += `\n${preloadMarker}\nelectron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true) });\n`;
      fs.writeFileSync(preloadPath, preloadContent);
    }

    const additions = ['meter-main.js', 'meter-core.js', 'meter-renderer.js', 'meter-collector.js', 'attachment_scan.py'];
    for (const file of additions) {
      fs.copyFileSync(path.join(__dirname, file), path.join(staging, 'dist', file));
    }

    const originalEntries = asar.listPackage(sourceArchive);
    for (const file of originalEntries) {
      const stat = asar.statFile(sourceArchive, file.slice(1));
      if (stat.unpacked && !file.replaceAll('\\', '/').startsWith('/node_modules/chrome-devtools-mcp/')) {
        throw new Error('Unexpected unpacked file; not installing.');
      }
    }

    await asar.createPackageWithOptions(staging, packed, { unpackDir: '**/chrome-devtools-mcp' });

    let verified = 0;
    for (const file of originalEntries) {
      const name = path.normalize(file.slice(1));
      const before = asar.statFile(sourceArchive, name);
      const after = asar.statFile(packed, name);
      if (before.files || before.link) continue;
      if (!!before.unpacked !== !!after.unpacked) throw new Error(`Unpack flag changed: ${name}`);
      if (!['dist/utils.js', 'dist/preload.js'].map(p => path.normalize(p)).includes(name) &&
          sha(asar.extractFile(sourceArchive, name)) !== sha(asar.extractFile(packed, name))) {
        throw new Error(`Unexpected file change: ${name}`);
      }
      verified++;
    }

    const previousInstalledBackup = path.join(backupDir, `pre-meter-${version}.asar`);
    if (!fs.existsSync(previousInstalledBackup)) {
      fs.copyFileSync(backup, previousInstalledBackup);
    }
    const previousInstalledSha256 = sha(fs.readFileSync(previousInstalledBackup));

    const manifest = {
      meterVersion: '2.2.0',
      version,
      installed,
      backup,
      previousInstalledBackup,
      previousInstalledSha256,
      originalSha256: sha(fs.readFileSync(backup)),
      patchedSha256: sha(fs.readFileSync(packed)),
      originalFilesVerified: verified,
      added: additions.map(f => 'dist/' + f),
      modified: ['dist/utils.js', 'dist/preload.js'],
      installedAt: new Date().toISOString()
    };

    fs.copyFileSync(packed, installed);
    if (sha(fs.readFileSync(installed)) !== manifest.patchedSha256) {
      throw new Error('Installed checksum mismatch');
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const liveInjected = await tryHotInject();
    return { ...manifest, liveInjected };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(packed, { force: true }); } catch {}
    try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  install()
    .then(manifest => console.log(JSON.stringify(manifest, null, 2)))
    .catch(error => {
      console.error(String(error.stack || error.message).slice(0, 2000));
      process.exitCode = 1;
    });
}

module.exports = { install, findAsarPath, tryHotInject };
