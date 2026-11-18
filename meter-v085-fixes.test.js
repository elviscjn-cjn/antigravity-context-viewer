'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const vm = require('vm');
const { execFileSync, spawn, spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const { loadAsarEngine, builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const { restore } = require('./restore');
const {
  loadModulesConfig,
  saveModulesConfig,
  inspectDiskModules,
  testProxyHealth
} = require('./modules-config');
const {
  parseAndValidateProxyUrl,
  matchesNoProxy,
  detectProxyConfig,
  applyProxyEnvironment
} = require('./meter-proxy');
const {
  requestGithubUrl,
  collectTokenHistoryAsync,
  recordModelCalls,
  launchCliSession
} = require('./meter-collector');
const { runUnlockWorkerTask } = require('./meter-context-unlock');
const { handleModulesStatus, handleToggleModule } = require('./meter-main');
const { buildLiveRuntimeModulesMeta, createLiveRequestHandler } = require('./live-host');

const asar = loadAsarEngine();

function makeTempSandbox(prefix = 'ag-v085-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const appData = path.join(root, 'AppData', 'Roaming');
  const localAppData = path.join(root, 'AppData', 'Local');
  const homeDir = path.join(root, 'Home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, stateDir, appData, localAppData, homeDir };
}

function withIsolatedEnv(sb, fn) {
  const keys = ['AG_METER_STATE_DIR', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AG_METER_STATE_DIR = sb.stateDir;
  process.env.APPDATA = sb.appData;
  process.env.LOCALAPPDATA = sb.localAppData;
  process.env.HOME = sb.homeDir;
  process.env.USERPROFILE = sb.homeDir;
  process.env.XDG_STATE_HOME = sb.stateDir;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete process.env[k];
  }
  const restoreEnv = () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.finally(restoreEnv);
    }
    restoreEnv();
    return res;
  } catch (err) {
    restoreEnv();
    throw err;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 纯 Node DER 编码生成自签名 X.509 v3 RSA-SHA256 测试证书（含 SAN localhost / 127.0.0.1），无外部 CLI 依赖。
 */
function createSelfSignedLocalhostCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const derLen = (len) => {
    if (len < 128) return Buffer.from([len]);
    const bytes = [];
    let n = len;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  const seq = (...items) => tlv(0x30, Buffer.concat(items));
  const set = (...items) => tlv(0x31, Buffer.concat(items));
  const intBuf = (val) => {
    let b = Buffer.isBuffer(val) ? val : Buffer.from([val]);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return tlv(0x02, b);
  };
  const bitStr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
  const oid = (nums) => {
    const out = [nums[0] * 40 + nums[1]];
    for (let i = 2; i < nums.length; i++) {
      let v = nums[i];
      const enc = [v & 0x7f];
      v >>= 7;
      while (v > 0) {
        enc.unshift((v & 0x7f) | 0x80);
        v >>= 7;
      }
      out.push(...enc);
    }
    return tlv(0x06, Buffer.from(out));
  };
  const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
  const utc = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    const str = String(d.getUTCFullYear()).slice(-2) +
      pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    return tlv(0x17, Buffer.from(str, 'ascii'));
  };

  const sha256WithRsaAlg = seq(oid([1, 2, 840, 113549, 1, 1, 11]), Buffer.from([0x05, 0x00]));
  const cnAttr = set(seq(oid([2, 5, 4, 3]), utf8('localhost')));
  const name = seq(cnAttr);
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86400 * 1000);
  const validity = seq(utc(now), utc(later));
  const sanVal = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1]))
  );
  const sanExt = seq(oid([2, 5, 29, 17]), tlv(0x04, sanVal));
  const exts = tlv(0xa3, seq(sanExt));

  const tbs = seq(
    tlv(0xa0, intBuf(2)),
    intBuf(crypto.randomBytes(8).map((b, idx) => (idx === 0 ? ((b & 0x7f) || 0x01) : b))),
    sha256WithRsaAlg,
    name,
    validity,
    name,
    spkiDer,
    exts
  );

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(tbs);
  const sig = signer.sign(privateKey);
  const certDer = seq(tbs, sha256WithRsaAlg, bitStr(sig));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
  };
}

async function createHostAsarFixture(rootDir, { version = '0.2.0', includeExtraFile = true, withUnpackedNative = false, brokenUtils = false } = {}) {
  const srcDir = path.join(rootDir, 'host-src');
  const distDir = path.join(srcDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({
    name: 'antigravity-test-host',
    version,
    main: 'dist/utils.js'
  }, null, 2));
  if (!brokenUtils) {
    fs.writeFileSync(path.join(distDir, 'utils.js'), `'use strict';
function setupNodeWrapper(env) { return env; }
function createWindow(win, url) {
    void win.loadURL(url);
}
exports.setupNodeWrapper = setupNodeWrapper;
exports.createWindow = createWindow;
exports.getHubWindows = () => [];
`);
  }
  fs.writeFileSync(path.join(distDir, 'preload.js'), `'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__HOST__', {});
`);
  if (includeExtraFile) {
    fs.writeFileSync(path.join(distDir, 'host-extra.js'), `exports.marker = 'KEEP_ME_${version}';\n`);
  }
  const asarPath = path.join(rootDir, 'app.asar');
  if (withUnpackedNative) {
    const customDir = path.join(srcDir, 'custom-addon', 'build');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'addon.node'), Buffer.from('FAKE_NATIVE_BINARY'));
    await builtinAsar.createPackageWithOptions(srcDir, asarPath, {
      unpackMatcher: p => p.replace(/\\/g, '/').endsWith('.node')
    });
  } else {
    await asar.createPackage(srcDir, asarPath);
  }
  return asarPath;
}

test('1. 配置损坏 fail-closed：不静默迁移旧代理/旧汉化、保留损坏原件并原子恢复保存', () => {
  const sb = makeTempSandbox('ag-v085-cfg-');
  try {
    withIsolatedEnv(sb, () => {
      // 先埋入遗留旧代理与旧汉化配置（按当前平台对应遗留目录写入）
      const legacyBaseDir = process.platform === 'win32'
        ? sb.localAppData
        : (process.platform === 'darwin'
          ? path.join(sb.homeDir, 'Library', 'Application Support')
          : sb.stateDir);
      const legacyProxyDir = path.join(legacyBaseDir, 'AntigravityProxyNoTun');
      fs.mkdirSync(legacyProxyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyProxyDir, 'config.json'), JSON.stringify({
        enabled: true,
        proxyUrl: 'http://127.0.0.1:19999'
      }), 'utf8');
      const legacyZhDir = path.join(legacyBaseDir, 'AntigravityChinese');
      fs.mkdirSync(legacyZhDir, { recursive: true });
      fs.writeFileSync(path.join(legacyZhDir, 'config.json'), JSON.stringify({ enabled: true }), 'utf8');

      // 场景 A: modules.json 为截断损坏 JSON -> 严禁迁移旧配置，返回关闭 + 损坏元数据，并保留原损坏文件
      const modPath = path.join(sb.stateDir, 'modules.json');
      const rawTruncated = '{"schemaVersion":"0.8.4","modules":{"proxy":{"enabled":true';
      fs.writeFileSync(modPath, rawTruncated, 'utf8');

      const cfgCorrupted = loadModulesConfig();
      assert.equal(cfgCorrupted.modules.proxy.enabled, false, '损坏态代理必须 fail-closed 保持关闭');
      assert.equal(cfgCorrupted.modules.chinese.enabled, false, '损坏态汉化必须 fail-closed 保持关闭');
      assert.equal(cfgCorrupted.__configCorrupted, true, '必须标记 __configCorrupted');
      assert.ok(cfgCorrupted.__configError, '必须提供明确损坏错误信息');
      assert.equal(fs.readFileSync(modPath, 'utf8'), rawTruncated, '不得擅自覆写/清理损坏的 modules.json 原件');
      const detCorrupt = detectProxyConfig();
      assert.equal(detCorrupt.detected, true);
      assert.equal(detCorrupt.enabled, false);
      assert.ok(detCorrupt.parseError, 'detectProxyConfig 损坏态绝不可回落旧 proxy.json');

      // 场景 B: 空文件 / 非法字段类型 -> 同样 fail-closed
      for (const badBody of ['', '   \n', '[]', JSON.stringify({ schemaVersion: '0.8.5', modules: [] })]) {
        fs.writeFileSync(modPath, badBody, 'utf8');
        const c = loadModulesConfig();
        assert.equal(c.modules.proxy.enabled, false);
        assert.equal(c.__configCorrupted, true);
        assert.equal(fs.readFileSync(modPath, 'utf8'), badBody, '非法 schema 必须原样保留供排查恢复');
      }

      // 场景 C: 坏态下执行 saveModulesConfig -> 先保留 .corrupt.*.bak 再原子写入有效新配置
      fs.writeFileSync(modPath, rawTruncated, 'utf8');
      const cleanCfg = loadModulesConfig();
      cleanCfg.modules.proxy.proxyUrl = 'http://127.0.0.1:7897';
      saveModulesConfig(cleanCfg);
      const baks = fs.readdirSync(sb.stateDir).filter(f => f.startsWith('modules.json.corrupt.') && f.endsWith('.bak'));
      assert.ok(baks.length >= 1, '修复写入前必须保留原损坏备份 .corrupt.*.bak');
      assert.equal(fs.readFileSync(path.join(sb.stateDir, baks[0]), 'utf8'), rawTruncated);
      const reloaded = loadModulesConfig();
      assert.equal(Boolean(reloaded.__configCorrupted), false);
      assert.equal(reloaded.modules.proxy.proxyUrl, 'http://127.0.0.1:7897');

      // 场景 D: modules.json 不存在时的全新首次安装仍应平滑迁移遗留代理配置
      fs.unlinkSync(modPath);
      const migrated = loadModulesConfig();
      assert.equal(Boolean(migrated.__configCorrupted), false);
      assert.equal(migrated.modules.proxy.enabled, true, '首次缺失 modules.json 时仍正常迁移遗留代理');
      assert.equal(migrated.modules.proxy.proxyUrl, 'http://127.0.0.1:19999');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('2. 卸载还原全矩阵：缺失备份原位剥离、损坏备份默认拒绝与 --in-place、升级含痕迹剥离、损坏结构拒绝', async () => {
  const sb = makeTempSandbox('ag-v085-restore-');
  try {
    await withIsolatedEnv(sb, async () => {
      // 1) 正常备份还原验证 + 保留额外非插件文件 + 缺失备份原位剥离
      const case1Dir = path.join(sb.root, 'case1');
      fs.mkdirSync(case1Dir, { recursive: true });
      const targetAsar = await createHostAsarFixture(case1Dir, { version: '0.2.0', includeExtraFile: true, withUnpackedNative: true });
      const origHash = sha256(targetAsar);

      await install({ path: targetAsar });
      assert.equal(inspectDiskModules(targetAsar).meterReady, true, '安装后应具备完整 context-meter 痕迹');

      // 删除全部备份 -> restore 自动原位手术刀剥离
      const backupDir = path.join(sb.stateDir, 'backups');
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });

      const inPlaceRes = await restore({ path: targetAsar });
      assert.equal(path.resolve(inPlaceRes.restored), path.resolve(targetAsar), '备份缺失且含插件痕迹时应原位剥离成功');
      assert.equal(inPlaceRes.inPlaceCleaned, true);

      const afterDisk = inspectDiskModules(targetAsar);
      assert.equal(afterDisk.meter, false, '原位剥离后不应残留插件模块');
      assert.equal(afterDisk.chinese, false);
      assert.equal(afterDisk.proxy, false);

      const extAfter = path.join(sb.root, 'ext-after-inplace');
      asar.extractAll(targetAsar, extAfter);
      assert.ok(fs.existsSync(path.join(extAfter, 'dist', 'host-extra.js')), '原位剥离必须保留宿主原有非插件文件');
      assert.ok(fs.existsSync(path.join(targetAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '原位剥离必须动态保留宿主原生 unpacked');
      assert.ok(!fs.existsSync(path.join(extAfter, 'meter-main.js')), '剥离后不得残留 meter-main.js');
      assert.notEqual(sha256(targetAsar), origHash); // 重新打包产物的头部对齐或压缩序列允许与原包字节略异，但宿主完整性完整

      // 2) 重新安装，随后破坏备份目录下所有备份文件校验 -> 默认拒绝；显式 inPlace: true 时允许安全原位剥离
      await install({ path: targetAsar });
      const bakFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.asar'));
      assert.ok(bakFiles.length >= 1);
      for (const bf of bakFiles) {
        fs.writeFileSync(path.join(backupDir, bf), Buffer.from('CORRUPT_BACKUP_BYTES'));
      }
      await assert.rejects(
        () => restore({ path: targetAsar }),
        /Backup checksum mismatch/
      );
      const forcedInPlace = await restore({ path: targetAsar, inPlace: true });
      assert.equal(path.resolve(forcedInPlace.restored), path.resolve(targetAsar));
      assert.equal(forcedInPlace.inPlaceCleaned, true);
      assert.equal(inspectDiskModules(targetAsar).meter, false);

      // 3) 模拟宿主已升级至 0.3.0 且带有新版痕迹（叠加残留） -> 允许原位剥离并保留 0.3.0 其他文件
      await install({ path: targetAsar });
      const manifestPath = path.join(sb.stateDir, 'installation.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const upgradeTmp = path.join(sb.root, 'upg-extract');
      asar.extractAll(targetAsar, upgradeTmp);
      const pkg = JSON.parse(fs.readFileSync(path.join(upgradeTmp, 'package.json'), 'utf8'));
      pkg.version = '0.3.0';
      fs.writeFileSync(path.join(upgradeTmp, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(upgradeTmp, 'dist', 'new-v030.js'), 'exports.v = "0.3.0";\n');
      await builtinAsar.createPackageWithOptions(upgradeTmp, targetAsar, {
        unpackMatcher: p => p.replace(/\\/g, '/').endsWith('.node')
      });
      // 确保备份仍保留 0.2.0 版本以触发版本差异检查
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.2.0' }, null, 2));

      const upgRestore = await restore({ path: targetAsar });
      assert.equal(path.resolve(upgRestore.restored), path.resolve(targetAsar));
      assert.equal(upgRestore.inPlaceCleaned, true);
      const extUpg = path.join(sb.root, 'ext-upg-after');
      asar.extractAll(targetAsar, extUpg);
      assert.equal(JSON.parse(fs.readFileSync(path.join(extUpg, 'package.json'), 'utf8')).version, '0.3.0');
      assert.ok(fs.existsSync(path.join(extUpg, 'dist', 'new-v030.js')), '必须保留新宿主新增文件');
      assert.equal(inspectDiskModules(targetAsar).meter, false);

      // 4) 损坏目标 ASAR / 缺失关键宿主入口 -> 准确拒绝并完整保留现场字节（无残留 manifest 时也直接走结构校验拒绝）
      fs.rmSync(manifestPath, { force: true });
      const brokenDir = path.join(sb.root, 'broken');
      fs.mkdirSync(brokenDir, { recursive: true });
      const brokenAsar = await createHostAsarFixture(brokenDir, { version: '0.2.0', brokenUtils: true });
      const brokenHash = sha256(brokenAsar);
      await assert.rejects(() => restore({ path: brokenAsar }), /未检测到插件注入痕迹|结构不支持|不支持或损坏的文件结构/);
      assert.equal(sha256(brokenAsar), brokenHash, '失败时不得改动原 ASAR 字节');

      const garbageAsar = path.join(sb.root, 'garbage.asar');
      fs.writeFileSync(garbageAsar, Buffer.from('NOT_AN_ASAR_ARCHIVE'));
      await assert.rejects(() => restore({ path: garbageAsar }), /无法读取目标 ASAR|损坏/);
      assert.equal(fs.readFileSync(garbageAsar, 'utf8'), 'NOT_AN_ASAR_ARCHIVE');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('3. 更新器真实代理隧道：HTTP CONNECT / SOCKS5(RFC1928) / bypassList 重定向重判 / 失败绝不直连 / 截断流拒绝', async () => {
  const sb = makeTempSandbox('ag-v085-net-');
  const { key, cert } = createSelfSignedLocalhostCert();
  const payloadZip = Buffer.from('PK\x03\x04MOCK_UPDATE_ZIP_BYTES_FOR_V085_VALIDATION');
  const payloadSha = crypto.createHash('sha256').update(payloadZip).digest('hex');

  let directHitCount = 0;
  let httpConnectHits = 0;
  let socks5Hits = 0;
  let forceTruncateNext = false;
  const seenSniHosts = [];
  const seenHostHeaders = [];

  const tlsServer = https.createServer({ key, cert }, (req, res) => {
    if (req.socket?.servername) seenSniHosts.push(req.socket.servername);
    if (req.headers?.host) seenHostHeaders.push(req.headers.host);
    if (req.url === '/ok-json') {
      directHitCount++;
      const body = JSON.stringify([{ tag_name: 'v0.8.9', ok: true }]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url === '/redir-to-localhost') {
      const addr = tlsServer.address();
      res.writeHead(302, { Location: `https://localhost:${addr.port}/ok-json` });
      res.end();
      return;
    }
    if (req.url === '/zip') {
      if (forceTruncateNext) {
        forceTruncateNext = false;
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payloadZip.length });
        res.write(payloadZip.subarray(0, 10));
        setTimeout(() => req.socket.destroy(), 15);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payloadZip.length });
      res.end(payloadZip);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // 本地真实 HTTP CONNECT 代理
  const httpProxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  httpProxyServer.on('connect', (req, clientSocket, head) => {
    httpConnectHits++;
    const [host, portStr] = String(req.url || '').split(':');
    const dialHost = host === 'proxy-only-check.invalid' ? '127.0.0.1' : host;
    const upstream = net.connect(Number(portStr), dialHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => { try { clientSocket.destroy(); } catch {} });
    clientSocket.on('error', () => { try { upstream.destroy(); } catch {} });
  });

  // 本地真实 SOCKS5 RFC 1928/1929 服务器（支持认证 + 无认证）
  let requireSocksAuth = false;
  const socksServer = net.createServer((clientSocket) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let upstream = null;

    const cleanup = () => {
      try { clientSocket.destroy(); } catch {}
      try { if (upstream) upstream.destroy(); } catch {}
    };

    const handleData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          const methods = Array.from(buf.subarray(2, 2 + nMethods));
          buf = buf.subarray(2 + nMethods);
          if (requireSocksAuth) {
            if (!methods.includes(0x02)) {
              clientSocket.write(Buffer.from([0x05, 0xff]));
              return cleanup();
            }
            stage = 'auth';
            clientSocket.write(Buffer.from([0x05, 0x02]));
          } else {
            stage = 'request';
            clientSocket.write(Buffer.from([0x05, 0x00]));
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const uLen = buf[1];
          if (buf.length < 2 + uLen + 1) return;
          const user = buf.subarray(2, 2 + uLen).toString('utf8');
          const pLen = buf[2 + uLen];
          if (buf.length < 3 + uLen + pLen) return;
          const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8');
          buf = buf.subarray(3 + uLen + pLen);
          if (user === 'u1' && pass === 'p1') {
            stage = 'request';
            clientSocket.write(Buffer.from([0x01, 0x00]));
          } else {
            clientSocket.write(Buffer.from([0x01, 0x01]));
            return cleanup();
          }
        } else if (stage === 'request') {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host = '';
          let headerLen = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            headerLen = 10;
          } else if (atyp === 0x03) {
            const dLen = buf[4];
            if (buf.length < 5 + dLen + 2) return;
            host = buf.subarray(5, 5 + dLen).toString('utf8');
            headerLen = 5 + dLen + 2;
          } else {
            return cleanup();
          }
          const port = buf.readUInt16BE(headerLen - 2);
          const leftover = buf.subarray(headerLen);
          buf = Buffer.alloc(0);
          stage = 'tunnel';
          socks5Hits++;
          clientSocket.removeListener('data', handleData);
          const dialHost = host === 'proxy-only-check.invalid' ? '127.0.0.1' : host;
          upstream = net.connect(port, dialHost, () => {
            clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (leftover.length) upstream.write(leftover);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
          });
          upstream.on('error', cleanup);
          return;
        } else {
          return;
        }
      }
    };
    clientSocket.on('data', handleData);
    clientSocket.on('error', cleanup);
  });

  // 始终拒绝连接的死代理端口监听探测（先占端口拿到端口号后立刻 close）
  const deadPortServer = net.createServer();
  await new Promise(r => tlsServer.listen(0, '127.0.0.1', r));
  await new Promise(r => httpProxyServer.listen(0, '127.0.0.1', r));
  await new Promise(r => socksServer.listen(0, '127.0.0.1', r));
  await new Promise(r => deadPortServer.listen(0, '127.0.0.1', r));
  const tlsPort = tlsServer.address().port;
  const httpProxyPort = httpProxyServer.address().port;
  const socksPort = socksServer.address().port;
  const deadPort = deadPortServer.address().port;
  await new Promise(r => deadPortServer.close(r));

  try {
    await withIsolatedEnv(sb, async () => {
      const cfg = loadModulesConfig();
      cfg.modules.proxy.enabled = true;
      cfg.modules.proxy.bypassList = 'localhost';

      // A. HTTP CONNECT 代理下载与 SHA-256 校验（使用不可直连的 .invalid 域名确保流量真经隧道 Agent 转发）
      cfg.modules.proxy.proxyUrl = `http://127.0.0.1:${httpProxyPort}`;
      saveModulesConfig(cfg);
      const outHttpZip = path.join(sb.root, 'dl-http.zip');
      const wsHttp = fs.createWriteStream(outHttpZip);
      await requestGithubUrl(`https://proxy-only-check.invalid:${tlsPort}/zip`, { rejectUnauthorized: false, streamTo: wsHttp });
      assert.equal(httpConnectHits, 1);
      assert.equal(sha256(outHttpZip), payloadSha);
      assert.ok(seenSniHosts.includes('proxy-only-check.invalid'));
      assert.ok(seenHostHeaders.includes(`proxy-only-check.invalid:${tlsPort}`));

      // B. SOCKS5 认证代理 + 无认证 SOCKS5h（同样使用不可直连 .invalid 域名断言真走代理隧道）
      requireSocksAuth = true;
      cfg.modules.proxy.proxyUrl = `socks5h://u1:p1@127.0.0.1:${socksPort}`;
      saveModulesConfig(cfg);
      const jsonViaSocks = await requestGithubUrl(`https://proxy-only-check.invalid:${tlsPort}/ok-json`, { rejectUnauthorized: false });
      assert.equal(socks5Hits, 1);
      assert.equal(JSON.parse(jsonViaSocks)[0].tag_name, 'v0.8.9');
      assert.equal(seenSniHosts.filter(h => h === 'proxy-only-check.invalid').length, 2);

      // 无代理直连 .invalid 必败，反证只有经过代理隧道才能连接成功
      cfg.modules.proxy.bypassList = 'proxy-only-check.invalid';
      saveModulesConfig(cfg);
      const beforeDirectInvalidCalls = directHitCount;
      await assert.rejects(
        () => requestGithubUrl(`https://proxy-only-check.invalid:${tlsPort}/ok-json`, { rejectUnauthorized: false, timeout: 800 }),
        /ENOTFOUND|EAI_AGAIN|getaddrinfo|请求超时|直连/i
      );
      assert.equal(directHitCount, beforeDirectInvalidCalls);
      cfg.modules.proxy.bypassList = 'localhost';
      saveModulesConfig(cfg);

      // C. 重定向按新目标域名判定 bypassList（127.0.0.1 走 SOCKS5 -> 302 到 localhost 命中 bypass 直连）
      const socksBeforeRedir = socks5Hits;
      const redirRes = await requestGithubUrl(`https://127.0.0.1:${tlsPort}/redir-to-localhost`, {
        ca: cert,
        _isAllowedRedirectUrl: (u) => u.startsWith('https://localhost:')
      });
      assert.equal(socks5Hits, socksBeforeRedir + 1, '仅首跳 127.0.0.1 经代理，302 后 localhost 命中绕过规则必须直连');
      assert.equal(JSON.parse(redirRes)[0].tag_name, 'v0.8.9');

      // D. 代理失败绝不静默走直连
      directHitCount = 0;
      cfg.modules.proxy.proxyUrl = `http://127.0.0.1:${deadPort}`;
      cfg.modules.proxy.bypassList = ''; // 不绕过
      saveModulesConfig(cfg);
      await assert.rejects(
        () => requestGithubUrl(`https://127.0.0.1:${tlsPort}/ok-json`, { ca: cert, timeout: 1500 }),
        /代理连接失败|ECONNREFUSED|超时/
      );
      assert.equal(directHitCount, 0, '代理失败时绝不能静默改走直连命中目标服务器');

      // E. 响应流提前截断（Content-Length 不完整）必须拒绝
      cfg.modules.proxy.proxyUrl = `http://127.0.0.1:${httpProxyPort}`;
      saveModulesConfig(cfg);
      forceTruncateNext = true;
      const outTrunc = path.join(sb.root, 'dl-trunc.zip');
      const wsTrunc = fs.createWriteStream(outTrunc);
      wsTrunc.on('error', () => {});
      await assert.rejects(
        () => requestGithubUrl(`https://127.0.0.1:${tlsPort}/zip`, { ca: cert, streamTo: wsTrunc }),
        /中断|不完整|aborted/
      );
    });
  } finally {
    tlsServer.close();
    httpProxyServer.close();
    socksServer.close();
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('4. 代理参数一致性（无端口默认端口 & bypassList 清空持久化/冷启动恢复/环境清除）', async () => {
  const sb = makeTempSandbox('ag-v085-proxy-');
  try {
    await withIsolatedEnv(sb, async () => {
      // 无显式端口 URL 在 parseAndValidateProxyUrl / testProxyHealth / meter-main / live-host / cli 全部一致通过
      assert.deepEqual(parseAndValidateProxyUrl('http://proxy.local').port, 80);
      assert.deepEqual(parseAndValidateProxyUrl('https://proxy.local').port, 443);
      assert.deepEqual(parseAndValidateProxyUrl('socks5://127.0.0.1').port, 1080);
      assert.deepEqual(parseAndValidateProxyUrl('socks5h://proxy.local').port, 1080);
      assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:0').ok, false);
      assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:70000').ok, false);
      assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:abc').ok, false);

      const healthNoPort = await testProxyHealth('http://127.0.0.1', { timeout: 300 });
      assert.equal(healthNoPort.configValid, true, 'testProxyHealth 应认可省略端口的 http://127.0.0.1 默认端口 80');

      const hostDir = path.join(sb.root, 'host');
      fs.mkdirSync(hostDir, { recursive: true });
      const targetAsar = await createHostAsarFixture(hostDir);
      await install({ path: targetAsar });

      // 写入非空 bypassList，再通过 meter-main IPC 清空为 '' 并验证磁盘与冷启动恢复
      const fakeEvent = { senderFrame: { url: 'https://127.0.0.1:42000/index.html' }, sender: { getURL: () => 'https://127.0.0.1:42000/index.html' } };
      const resSave = await handleToggleModule(fakeEvent, 'proxy', true, {
        proxyUrl: 'http://proxy.local',
        bypassList: 'localhost,example.com',
        asarPath: targetAsar
      });
      assert.equal(resSave.ok, true);
      assert.equal(resSave.data.modules.proxy.bypassList, 'localhost,example.com');

      const resClear = await handleToggleModule(fakeEvent, 'proxy', true, {
        proxyUrl: 'http://proxy.local',
        bypassList: '',
        asarPath: targetAsar
      });
      assert.equal(resClear.ok, true);
      assert.equal(resClear.data.modules.proxy.bypassList, '', 'IPC 清空 bypassList 必须保存为空串');

      // 模拟冷启动：直接重读 modules.json 与 detectProxyConfig + applyProxyEnvironment
      const coldCfg = loadModulesConfig();
      assert.equal(coldCfg.modules.proxy.bypassList, '', '冷启动重读必须保持空 bypassList 而不回退默认值');
      const det = detectProxyConfig();
      assert.equal(det.noProxy, '', 'detectProxyConfig 必须区分空串 bypassList 与 undefined');
      const envObj = { NO_PROXY: 'old.local', no_proxy: 'old.local' };
      applyProxyEnvironment(envObj, { overrideExisting: true });
      assert.equal(envObj.NO_PROXY, undefined, '空 bypassList 启用 overrideExisting 时应清除残留 NO_PROXY');

      // 验证启动期主进程引导脚本在 bypassList='' 时不回落到安装默认列表
      const { generateProxyUtilsCode } = require(path.join(ROOT_DIR, 'modular-installer'));
      const bootCode = generateProxyUtilsCode({
        enabled: true,
        proxyUrl: 'http://proxy.local',
        bypassList: 'localhost,legacy.default'
      });
      const bootCheckOut = execFileSync('node', ['-e', `
        const Module = require('module');
        const origLoad = Module._load;
        const switches = [];
        const sessionCalls = [];
        Module._load = function (id, parent, isMain) {
          if (id === 'electron') {
            return {
              app: {
                commandLine: { appendSwitch: (k, v) => switches.push([k, v]) },
                on: () => {},
                whenReady: () => Promise.resolve()
              },
              session: {
                defaultSession: { setProxy: async (opts) => sessionCalls.push(opts) },
                fromPartition: () => ({ setProxy: async () => {} })
              }
            };
          }
          return origLoad.apply(this, arguments);
        };
        process.env.NO_PROXY = 'stale.env';
        process.env.no_proxy = 'stale.env';
        const fn = new Function('require', 'process', 'globalThis', 'console', ${JSON.stringify(bootCode)});
        fn(require, process, globalThis, console);
        setTimeout(() => {
          console.log(JSON.stringify({
            bootInfo: globalThis.__AG_PROXY_BOOT_INFO__,
            noProxyEnv: process.env.NO_PROXY,
            switches,
            sessionCalls
          }));
        }, 20);
      `], {
        env: { ...process.env },
        encoding: 'utf8'
      });
      const bootParsed = JSON.parse(bootCheckOut.trim().split(/\r?\n/).pop());
      assert.equal(bootParsed.bootInfo.bypassList, '', '启动引导脚本必须保持空 bypassList 而不回填默认列表');
      assert.equal(bootParsed.noProxyEnv, undefined, '空 bypassList 启动引导必须清除残留 NO_PROXY');
      assert.equal(bootParsed.switches.some(([k]) => k === 'proxy-bypass-list'), false, '空 bypassList 不应附加 proxy-bypass-list 参数');
      assert.deepEqual(bootParsed.sessionCalls[0], { proxyRules: 'http://proxy.local', proxyBypassRules: '' });

      // CLI proxy:set 支持无端口 http://proxy.local
      execFileSync('node', [path.join(ROOT_DIR, 'cli.js'), 'proxy:set', 'http://proxy.local', '--path', targetAsar], {
        env: { ...process.env },
        stdio: 'pipe'
      });
      assert.equal(loadModulesConfig().modules.proxy.proxyUrl, 'http://proxy.local');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('5. 汉化切回一致状态不误报重启、live-host 缺 meter 错误正确提示、品牌 hidden->english/translated 热恢复与停扫', async () => {
  const sb = makeTempSandbox('ag-v085-i18n-');
  try {
    await withIsolatedEnv(sb, async () => {
      const hostDir = path.join(sb.root, 'host');
      fs.mkdirSync(hostDir, { recursive: true });
      const targetAsar = await createHostAsarFixture(hostDir);
      await install({ path: targetAsar, modules: { chinese: { enabled: true } } });

      // 验证启动时 snapshot 为 enabled:true，关闭 -> restartRequired:true，再切回开启 -> restartRequired:false
      const fakeEvent = { senderFrame: { url: 'https://127.0.0.1:42000/index.html' }, sender: { getURL: () => 'https://127.0.0.1:42000/index.html' } };
      const offRes = await handleToggleModule(fakeEvent, 'chinese', false, { language: 'en', asarPath: targetAsar });
      assert.equal(offRes.ok, true);
      assert.equal(offRes.restartRequired, true);
      const backOnRes = await handleToggleModule(fakeEvent, 'chinese', true, { language: 'zh-CN', asarPath: targetAsar });
      assert.equal(backOnRes.ok, true);
      assert.equal(backOnRes.restartRequired, false, '切回启动快照一致状态后 restartRequired 必须为 false');

      // live-host HTTP 实测：缺失 meter 时报错准确指代核心监控，不误报代理；状态检查携带 configCorrupted
      const cleanHostDir = path.join(sb.root, 'clean-host');
      fs.mkdirSync(cleanHostDir, { recursive: true });
      const cleanAsar = await createHostAsarFixture(cleanHostDir);
      const secret = 'test-secret-085';
      const handler = createLiveRequestHandler({ api: { origin: 'vscode-file://vscode-app' }, secret });
      const srv = http.createServer(handler);
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      try {
        const postJson = (route, payload) => new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: srv.address().port,
            path: route,
            method: 'POST',
            headers: {
              Origin: 'vscode-file://vscode-app',
              'X-AG-Context-Token': secret,
              'Content-Type': 'application/json'
            }
          }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
          });
          req.on('error', reject);
          req.end(JSON.stringify(payload));
        });

        const meterErr = await postJson('/toggle-module', { name: 'meter', enable: true, opts: { asarPath: cleanAsar } });
        assert.equal(meterErr.ok, false);
        assert.match(meterErr.error, /核心监控/);
        assert.match(meterErr.error, /node cli\.js install/);
        assert.doesNotMatch(meterErr.error, /免 TUN|proxy:enable/);

        const offLive = await postJson('/toggle-module', { name: 'chinese', enable: false, opts: { language: 'en', asarPath: targetAsar } });
        assert.equal(offLive.ok, true);
        assert.equal(offLive.restartRequired, true);
        const onLive = await postJson('/toggle-module', { name: 'chinese', enable: true, opts: { language: 'zh-CN', asarPath: targetAsar } });
        assert.equal(onLive.ok, true);
        assert.equal(onLive.restartRequired, false);
      } finally {
        srv.close();
      }

      // i18n-runtime DOM 最小节点仿真：brand hidden -> english -> translated 全链路恢复
      const parentEl = {
        nodeType: 1,
        tagName: 'DIV',
        attributes: { 'data-testid': 'title-menu-bar-item' },
        style: {},
        nextSibling: null,
        getAttribute(k) { return this.attributes[k] || null; },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
        closest(sel) { return sel.includes('title-menu-bar-item') ? this : null; },
        matches() { return false; }
      };
      const brandNode = {
        nodeType: 3,
        nodeValue: 'Antigravity',
        parentElement: parentEl,
        parentNode: parentEl,
        previousSibling: null,
        nextSibling: null
      };
      parentEl.firstChild = brandNode;
      parentEl.childNodes = [brandNode];

      const docMock = {
        body: {
          nodeType: 1,
          tagName: 'BODY',
          parentElement: null,
          firstChild: parentEl,
          childNodes: [parentEl],
          hasAttribute: () => false,
          getAttribute: () => null,
          matches: () => false,
          closest: () => null
        },
        documentElement: null,
        getElementById: () => null,
        createTreeWalker(rootNode) {
          const stack = [];
          function collectTexts(n) {
            if (n.nodeType === 3) stack.push(n);
            else if (n.childNodes) for (const c of n.childNodes) collectTexts(c);
          }
          collectTexts(rootNode);
          let idx = -1;
          return { nextNode: () => (++idx < stack.length ? stack[idx] : null) };
        }
      };
      docMock.documentElement = docMock.body;

      let intervalCb = null;
      let idleCallCount = 0;
      const winMock = {
        __AGY_I18N_CONFIG__: { enabled: false, language: 'en', brandTitle: 'hidden' },
        __AGY_I18N_DATA__: { exact: {}, regex: [] },
        document: docMock,
        NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
        requestIdleCallback(fn) { idleCallCount++; fn(); },
        setInterval(fn) { intervalCb = fn; return 1; },
        setTimeout(fn) { fn(); return 1; },
        clearTimeout() {},
        location: { href: 'vscode-file://vscode-app/index.html' }
      };
      winMock.window = winMock;
      winMock.globalThis = winMock;
      const runtimeSrc = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'i18n-runtime.js'), 'utf8');
      vm.runInNewContext(runtimeSrc, winMock);

      // 1) hidden 模式后节点文本被清空并暂存原品牌名
      assert.equal(brandNode.nodeValue, '');
      assert.equal(brandNode._agyHiddenOrigBrand, 'Antigravity');

      // 2) hidden -> english 通过 __AGY_RUN_FULL_SCAN__() 无损恢复 'Antigravity'
      winMock.__AGY_I18N_CONFIG__.brandTitle = 'english';
      winMock.__AGY_RUN_FULL_SCAN__();
      assert.equal(brandNode.nodeValue, 'Antigravity', 'hidden -> english 必须恢复为 Antigravity');

      // 3) 关闭汉化且品牌为 english 时，idle 定时扫描必须停扫描以零空转
      const beforeIdleCheck = idleCallCount;
      if (intervalCb) intervalCb();
      assert.equal(idleCallCount, beforeIdleCheck, '未启用汉化且英文品牌时不该继续触发全树空闲扫描');

      // 4) 再切 hidden -> translated 必须直接恢复为 '反重力'
      winMock.__AGY_I18N_CONFIG__.brandTitle = 'hidden';
      winMock.__AGY_RUN_FULL_SCAN__();
      assert.equal(brandNode.nodeValue, '');
      winMock.__AGY_I18N_CONFIG__.brandTitle = 'translated';
      winMock.__AGY_RUN_FULL_SCAN__();
      assert.equal(brandNode.nodeValue, '反重力', 'hidden -> translated 必须恢复为 反重力');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('6. Worker 异常/超时不永久卡死或永久禁用 & 多子进程并发写入账本零丢失零损坏', async () => {
  const sb = makeTempSandbox('ag-v085-conc-');
  try {
    // A. Unlock Worker 超时卡死 & 后继恢复
    const hangWorker = path.join(sb.root, 'hang-worker.js');
    fs.writeFileSync(hangWorker, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => { /* 故意永久不回应以模拟卡死 */ });
    `, 'utf8');
    const okWorker = path.join(sb.root, 'ok-worker.js');
    fs.writeFileSync(okWorker, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        parentPort.postMessage({ id: msg.id, ok: true, result: { echoed: msg.cmd } });
      });
    `, 'utf8');

    const timedOut = await runUnlockWorkerTask('analyze', {}, { _unlockWorkerScript: hangWorker, workerTimeoutMs: 120 });
    assert.equal(timedOut, null, 'Worker 超时必须按超时期限返回 null 而不是永久挂起');
    const recovered = await runUnlockWorkerTask('analyze', {}, { _unlockWorkerScript: okWorker, workerTimeoutMs: 1000 });
    assert.equal(recovered?._workerHandled, true, '单个超时后不应永久禁用 Worker，恢复正常脚本应重新可用');
    assert.equal(recovered?.result?.echoed, 'analyze');

    // B. History Worker 超时/异常非零退出后不卡住后续 collectTokenHistoryAsync 队列
    const exitWorker = path.join(sb.root, 'exit-worker.js');
    fs.writeFileSync(exitWorker, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => { process.exit(1); });
    `, 'utf8');
    await withIsolatedEnv(sb, async () => {
      // 超时卡死 Worker 一次
      await assert.doesNotReject(() => collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        _historyWorkerScript: hangWorker,
        workerTimeoutMs: 120
      }));
      // 异常退出 Worker 一次
      await assert.doesNotReject(() => collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        _historyWorkerScript: exitWorker,
        workerTimeoutMs: 500
      }));
      // 随后主流程回退到默认正常路径仍可成功完成
      const normalHist = await collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        useMainThread: true
      });
      const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
      assert.equal(normalHist.version, pkgVersion);
    });

    // C. 4 个并发子进程向同一隔离目录下的 pricing_ledger_v1.json 高并发写 4*25=100 条唯一 callId
    const isolatedAgDir = path.join(sb.root, 'ag-dir');
    fs.mkdirSync(isolatedAgDir, { recursive: true });
    const ledgerPath = path.join(isolatedAgDir, 'pricing_ledger_v1.json');
    const workerScript = path.join(sb.root, 'ledger-writer.js');
    fs.writeFileSync(workerScript, `
      const { recordModelCalls } = require(${JSON.stringify(path.join(ROOT_DIR, 'meter-collector.js'))});
      const workerId = Number(process.argv[2]);
      const agDir = process.argv[3];
      for (let i = 0; i < 25; i++) {
        const res = recordModelCalls([{
          callId: 'call-w' + workerId + '-' + i,
          ts: Date.now() + i,
          model: 'gemini-2.5-flash',
          inputTokens: 100 + i,
          outputTokens: 20 + workerId,
          totalTokens: 120 + i + workerId,
          source: 'desktop'
        }], { agDir });
        if (!res || res.ok === false) {
          throw new Error('recordModelCalls failed: ' + JSON.stringify(res));
        }
      }
    `, 'utf8');

    await Promise.all([0, 1, 2, 3].map(wid => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerScript, String(wid), isolatedAgDir], {
        env: {
          ...process.env,
          AG_METER_STATE_DIR: sb.stateDir,
          HOME: sb.homeDir,
          USERPROFILE: sb.homeDir,
          AG_METER_TEST_MODE: '1'
        },
        stdio: 'pipe'
      });
      let stderr = '';
      child.stderr.on('data', d => stderr += d);
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Child ${wid} failed (${code}): ${stderr}`));
      });
    })));

    const rawLedger = fs.readFileSync(ledgerPath, 'utf8');
    const ledgerObj = JSON.parse(rawLedger);
    assert.equal(Object.keys(ledgerObj.calls || {}).length, 100, '4 进程并发写入 100 条独立调用记录不得有任何丢失或 JSON 损坏');
    const leftoverLocks = fs.readdirSync(isolatedAgDir).filter(f => f.endsWith('.lock'));
    assert.equal(leftoverLocks.length, 0, '并发写完成后不得遗留 .lock 锁文件');
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('7. Windows 中文/带空格路径 .cmd UTF-8 编码、install 误传参数拒绝、动态 unpackedPaths 升级重装与卸载', async () => {
  const sb = makeTempSandbox('ag-v085-win-');
  try {
    await withIsolatedEnv(sb, async () => {
      // A. launchCliSession 中文 + 空格路径 .cmd UTF-8 与实机 cmd.exe 验证
      if (process.platform === 'win32') {
        const chineseBinDir = path.join(sb.root, '中文 路径', 'bin dir');
        const chineseCwd = path.join(sb.root, '工作 空间', '项目 一');
        fs.mkdirSync(chineseBinDir, { recursive: true });
        fs.mkdirSync(chineseCwd, { recursive: true });
        const fakeCliCmd = path.join(chineseBinDir, 'agy-测试 cli.cmd');
        const outFile = path.join(sb.root, 'cmd-out.txt');
        fs.writeFileSync(fakeCliCmd, `@echo off\r\n> "${outFile}" echo %CD%^|%*\r\n`, 'utf8');

        let capturedEnv = null;
        const launchRes = await launchCliSession({
          stateDir: sb.stateDir,
          cwd: chineseCwd,
          model: 'gemini-2.5-flash',
          platform: 'win32',
          cliPath: fakeCliCmd,
          args: ['--title', '测试 标题'],
          _resolveHelperExecutable: () => ({ ok: false, helperPath: null, helperSha256: null }),
          _spawn: (_cmd, _args, opts) => {
            capturedEnv = opts.env;
            return { pid: 12345, unref() {} };
          }
        });
        assert.equal(launchRes.ok, true);
        const batPath = path.join(sb.stateDir, 'launch-cli-runner.cmd');
        const batText = fs.readFileSync(batPath, 'utf8');
        assert.ok(batText.includes('chcp 65001 >nul'), 'Windows .cmd 启动脚本必须切换 UTF-8 代码页 chcp 65001');
        assert.ok(batText.includes('agy-测试 cli.cmd'), '不得因 ascii 编码破坏中文路径');
        assert.ok(batText.includes('测试 标题'), '不得破坏传入中文参数');

        // 用真实 cmd.exe 运行该批处理并校验工作目录及参数中的中文完整无乱码
        const probeCwdFile = path.join(sb.stateDir, 'last-cli-cwd.txt');
        const runBat = spawnSync('cmd.exe', ['/d', '/c', batPath], {
          cwd: chineseCwd,
          env: { ...process.env, ...capturedEnv, AG_CLI_PROBE_FILE: probeCwdFile },
          windowsHide: true
        });
        assert.equal(runBat.status, 0);
        const probeText = fs.readFileSync(probeCwdFile, 'utf8').trim();
        assert.equal(probeText, chineseCwd, '真实 cmd.exe 运行后写入的工作目录中文/空格必须精确一致');
        const outText = fs.readFileSync(outFile, 'utf8').trim();
        assert.ok(outText.includes('测试 标题'), '目标批处理接收到的命令行参数中中文不得乱码');
      }

      // B. install 参数防误传拒绝回落默认宿主
      await assert.rejects(
        () => install({ asarPath: path.join(sb.root, 'should-not-matter.asar') }),
        /无效的安装选项字段 "asarPath"/
      );
      await assert.rejects(
        () => install({ targetPath: path.join(sb.root, 'should-not-matter.asar') }),
        /无效的安装选项字段 "targetPath"/
      );
      await assert.rejects(
        () => install({ path: '   ' }),
        /非空字符串/
      );

      // C. 含额外自定义 .node 与任意 unpacked 子目录的隔离宿主完成安装与重装，unpacked 完整动态保留
      const upDir = path.join(sb.root, 'unpacked-host');
      fs.mkdirSync(upDir, { recursive: true });
      const customAsar = await createHostAsarFixture(upDir, { version: '0.2.0', includeExtraFile: true, withUnpackedNative: true });
      await install({ path: customAsar });
      assert.ok(fs.existsSync(path.join(customAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '首次安装后不得丢失宿主自定义 unpacked');
      // 同版重装
      await install({ path: customAsar });
      assert.ok(fs.existsSync(path.join(customAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '二次同版重装后不得丢失宿主自定义 unpacked');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('8. PR #40 补充: builtinAsar.createPackage 与测试 ASAR 路径透传至启动快照及运行时元信息', async () => {
  const sb = makeTempSandbox('ag-pr40-asar-');
  try {
    await withIsolatedEnv(sb, async () => {
      // 1. 复用 builtinAsar.createPackage 打包两个不同状态的隔离宿主 ASAR（A: 待安装注入；B: 保持纯净未注入）
      const dirA = path.join(sb.root, 'host-a');
      const dirB = path.join(sb.root, 'host-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      const baseA = await createHostAsarFixture(dirA, { version: '2.32.2', includeExtraFile: true });
      const baseB = await createHostAsarFixture(dirB, { version: '2.32.2', includeExtraFile: true });
      const asarA = path.join(dirA, 'packaged-a.asar');
      const asarB = path.join(dirB, 'packaged-b.asar');
      const extA = path.join(dirA, 'ext-a');
      const extB = path.join(dirB, 'ext-b');
      asar.extractAll(baseA, extA);
      asar.extractAll(baseB, extB);
      await builtinAsar.createPackage(extA, asarA);
      await builtinAsar.createPackage(extB, asarB);
      assert.ok(fs.existsSync(asarA) && fs.existsSync(asarB));

      // 对 asarA 完成安装，使 asarA 具备完整插件+汉化磁盘能力，而 asarB 保持未注入状态
      await install({ path: asarA });
      const { loadModulesConfig, saveModulesConfig } = require('./modules-config');
      const initCfg = loadModulesConfig();
      initCfg.modules.chinese.enabled = true;
      initCfg.modules.chinese.language = 'zh-CN';
      saveModulesConfig(initCfg);
      const fakeEvent = { senderFrame: { url: 'https://127.0.0.1:12345/' } };

      // 2. 分别向 handleModulesStatus 和 handleToggleModule 传入显式 ASAR 路径，校验各自独立启动快照与运行时缓存不串
      const statusA = await handleModulesStatus(fakeEvent, asarA);
      assert.equal(statusA.ok, true);
      assert.equal(statusA.disk.chineseReady, true);
      assert.equal(statusA.runtime.chineseActive, true, '显式 asarA 具备汉化组件时启动快照与运行时应为激活');

      const statusB = await handleModulesStatus(fakeEvent, asarB);
      assert.equal(statusB.ok, true);
      assert.equal(statusB.disk.chineseReady, false);
      assert.equal(statusB.runtime.chineseActive, false, '未注入的 asarB 不得串用 asarA 的启动汉化快照缓存');

      const stToggleA = await handleToggleModule(fakeEvent, 'chinese', true, { asarPath: asarA, language: 'zh-CN' });
      assert.equal(stToggleA.ok, true);
      assert.equal(stToggleA.runtime.chineseActive, true);

      const toggleFailB = await handleToggleModule(fakeEvent, 'chinese', true, { asarPath: asarB, language: 'zh-CN' });
      assert.equal(toggleFailB.ok, false);
      assert.equal(toggleFailB.status, 'install_failed');
      assert.equal(toggleFailB.runtime.chineseActive, false);

      // 3. 验证默认宿主路径探测仍正常（不传 customAsar 时不抛错且返回结构完整）
      const defaultStatus = await handleModulesStatus(fakeEvent);
      assert.equal(defaultStatus.ok, true);
      assert.equal(typeof defaultStatus.runtime.chineseActive, 'boolean');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});
