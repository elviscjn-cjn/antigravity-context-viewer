'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { rejectUnauthorized: false, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function connect() {
  const port = Number(fs.readFileSync(process.env.APPDATA + '/Antigravity/DevToolsActivePort', 'utf8').split(/\r?\n/)[0]);
  const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`));
  const page = pages.find(item => item.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(item.url));
  if (!page) throw new Error('Antigravity window not found');
  const origin = new URL(page.url).origin;
  const html = await request(origin + '/');
  const token = JSON.parse(html.match(/window.__APP_CONFIG__ = (.*?);/)[1]).csrfToken;
  return { origin, page, call: async (method, body) => JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token)) };
}
module.exports = { connect };
