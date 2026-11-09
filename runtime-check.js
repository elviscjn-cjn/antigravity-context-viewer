'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { getStateDir } = require('./asar-engine');
function getJson(url) { return new Promise((resolve, reject) => http.get(url, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject)); }
async function main() {
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  const pages = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(page => page.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(page.url));
  if (pages.length !== 1) throw new Error('Expected exactly one Antigravity page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); if (waiting.has(data.id)) { const callback = waiting.get(data.id); waiting.delete(data.id); callback(data); } });
  function evaluate(expression) { return new Promise((resolve, reject) => { const id = ++seq; const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('Evaluation timeout')); }, 10000); waiting.set(id, data => { clearTimeout(timeout); if (data.error || data.result?.exceptionDetails) reject(new Error(JSON.stringify(data.error || data.result.exceptionDetails))); else resolve(data.result?.result?.value); }); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }); }
  function protocol(method, params) { return new Promise((resolve, reject) => { const id = ++seq; const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('Protocol timeout')); }, 10000); waiting.set(id, data => { clearTimeout(timeout); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result); }); ws.send(JSON.stringify({ id, method, params })); }); }
  try {
    if (process.argv.includes('--install-live')) {
      const stateDir = getStateDir();
      const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
        ? path.join(stateDir, '.live-session.json')
        : path.join(__dirname, '.live-session.json');
      if (fs.existsSync(livePath)) {
        const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
        if (live.origin === new URL(pages[0].url).origin) await evaluate('window.__AGContextMeterLive=' + JSON.stringify({ port: live.port, token: live.token }));
      }
      const source = ['meter-core.js', 'meter-renderer.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
      await evaluate(source);
    }
    console.log(JSON.stringify(await evaluate(`(()=>{const s=window.__AGContextMeter?.snapshot();return {version:window.__AGContextMeter?.version,route:s?.route,latest:s?.latest,scanError:s?.scanError,scanBusy:s?.scanBusy,session:s?.scan?.session?{steps:s.scan.session.steps,characters:s.scan.session.total.chars,range:[s.scan.session.total.low,s.scan.session.total.high],attachments:s.scan.session.attachments.length,unknownFiles:s.scan.session.unknownFiles}:null,badge:document.getElementById('ag-context-meter')?.shadowRoot?.getElementById('amount').textContent,widgets:document.querySelectorAll('#ag-context-meter').length}})()`), null, 2));
    if (process.argv.includes('--capture-widget')) {
      const rect = await evaluate(`(()=>{const p=document.getElementById('ag-context-meter').shadowRoot.getElementById('panel');const wasHidden=p.hidden;p.hidden=false;const r=p.getBoundingClientRect();return {wasHidden,x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      await new Promise(resolve => setTimeout(resolve, 240));
      try {
        const shot = await protocol('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const outPath = process.env.AG_PREVIEW_PATH || path.join(getStateDir(), 'v2-preview.png');
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        console.log('Widget preview saved to ' + outPath);
      } finally { if (rect.wasHidden) await evaluate("document.getElementById('ag-context-meter').shadowRoot.getElementById('panel').hidden=true"); }
    }
  } finally { ws.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
