'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pack = fs.readFileSync(path.join(__dirname, 'package-release.js'), 'utf8');
const install = fs.readFileSync(path.join(root, 'install.js'), 'utf8');
function files(source, pattern) {
  const match = source.match(pattern);
  if (!match) throw new Error('Release file list not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}
const common = files(pack, /const COMMON_FILES = \[([\s\S]*?)\];/);
const required = files(install, /const additions = \[([\s\S]*?)\];/);
for (const file of required) {
  if (!common.includes(file)) throw new Error('Missing installer dependency in release manifest. ' + file);
}
for (const file of common) {
  if (!fs.existsSync(path.join(root, file))) throw new Error('Missing release source. ' + file);
}
console.log('Release manifest includes all ' + required.length + ' installer dependencies.');
