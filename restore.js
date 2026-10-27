'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getStateDir } = require('./asar-engine');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function tryHotDispose() {
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
    for (const target of targets) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__AGContextMeter?.dispose()' } }));
      await new Promise(r => setTimeout(r, 100));
      ws.close();
    }
    return targets.length > 0;
  } catch {
    return false;
  }
}

async function restore() {
  const stateManifest = path.join(getStateDir(), 'installation.json');
  const localManifest = path.join(__dirname, 'installation.json');
  const manifestPath = fs.existsSync(stateManifest) ? stateManifest : localManifest;
  if (!fs.existsSync(manifestPath)) {
    throw new Error('installation.json not found; nothing to restore.');
  }
  const info = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const previous = process.argv.includes('--previous');
  const backup = previous ? info.previousInstalledBackup : info.backup;
  const expected = previous ? info.previousInstalledSha256 : info.originalSha256;
  if (!backup || !fs.existsSync(backup) || sha(backup) !== expected) {
    throw new Error('Backup checksum mismatch; refusing restore');
  }
  if (sha(info.installed) !== info.patchedSha256) {
    throw new Error('Installed app has changed (possibly updated); refusing to overwrite');
  }
  try {
    fs.copyFileSync(backup, info.installed);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error(`无法还原目标文件 (${info.installed})：文件正被运行中的 Antigravity 锁定。请先完全退出 Antigravity 客户端后再运行！`);
    }
    throw err;
  }
  await tryHotDispose();
  return { restored: info.installed, fromBackup: backup };
}

if (require.main === module) {
  restore()
    .then(() => console.log('Restored the exact pre-meter archive. Fully restart Antigravity for the change to take effect.'))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { restore, tryHotDispose };
