'use strict';
const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient } = require('./local-api');

async function main() {
  const discovered = await discoverAntigravityCdp({ argv: process.argv });
  if (!discovered.running || !discovered.targets || discovered.targets.length === 0) {
    throw new Error('Antigravity page not found via CDP');
  }
  const page = discovered.targets[0];
  const client = await createCdpClient(page.webSocketDebuggerUrl);
  const evaluate = expr => client.evaluateValue(expr, { timeoutMs: 10000 });
  const protocol = (method, params) => client.call(method, params, 10000);

  try {
    if (process.argv.includes('--install-live')) {
      const stateDir = getStateDir();
      const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
        ? path.join(stateDir, '.live-session.json')
        : path.join(__dirname, '.live-session.json');
      if (fs.existsSync(livePath)) {
        const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
        if (live.origin === new URL(page.url).origin) {
          await evaluate('window.__AGContextMeterLive=' + JSON.stringify({ port: live.port, token: live.token }));
        }
      }
      const source = ['meter-core.js', 'meter-renderer.js']
        .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'))
        .join('\n');
      await evaluate(source);
    }
    console.log(JSON.stringify(await evaluate(`(()=>{const s=window.__AGContextMeter?.snapshot();return {version:window.__AGContextMeter?.version,route:s?.route,latest:s?.latest,scanError:s?.scanError,scanBusy:s?.scanBusy,session:s?.scan?.session?{steps:s.scan.session.steps,characters:s.scan.session.total.chars,range:[s.scan.session.total.low,s.scan.session.total.high],attachments:s.scan.session.attachments.length,unknownFiles:s.scan.session.unknownFiles}:null,badge:document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('amount')?.textContent||null,widgets:document.querySelectorAll('#ag-context-meter').length}})()`), null, 2));
    if (process.argv.includes('--capture-widget')) {
      const rect = await evaluate(`(()=>{const p=document.getElementById('ag-context-meter').shadowRoot.getElementById('panel');const wasHidden=p.hidden;p.hidden=false;const r=p.getBoundingClientRect();return {wasHidden,x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      await new Promise(resolve => setTimeout(resolve, 240));
      try {
        const shot = await protocol('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const outPath = process.env.AG_PREVIEW_PATH || path.join(getStateDir(), 'v2-preview.png');
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        console.log('Widget preview saved to ' + outPath);
      } finally {
        if (rect.wasHidden) {
          await evaluate("document.getElementById('ag-context-meter').shadowRoot.getElementById('panel').hidden=true");
        }
      }
    }
  } finally {
    client.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
