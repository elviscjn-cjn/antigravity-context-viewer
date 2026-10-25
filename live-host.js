'use strict';
// Temporary read-only bridge for the currently running window. The installed
// Electron IPC bridge takes over on the next normal application restart.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect } = require('./local-api');
const { collect } = require('./meter-collector');
const { getStateDir } = require('./asar-engine');
(async () => {
  const api = await connect();
  const secret = crypto.randomBytes(32).toString('hex');
  const stamp = path.join(getStateDir(), '.live-session.json');
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin !== api.origin) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', api.origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST' || req.url !== '/scan' || req.headers['x-ag-context-token'] !== secret) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      try { const request = JSON.parse(body); const data = await collect(api.origin, request.id, { force: request.force === true }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const info = { port: server.address().port, token: secret, pid: process.pid, origin: api.origin, startedAt: Date.now() };
    fs.writeFileSync(stamp, JSON.stringify(info));
    console.log('Context Meter v2 local read-only bridge ready on loopback port ' + info.port);
  });
  let misses = 0;
  const check = setInterval(async () => {
    try { const a = await connect(); if (a.origin !== api.origin) throw new Error('App restarted'); misses = 0; }
    catch { if (++misses >= 3) { clearInterval(check); server.close(); process.exit(0); } }
  }, 10000);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
