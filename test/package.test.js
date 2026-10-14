'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { buildUserZip, buildRouterZip, EXEC_ATTR } = require('../cli/package');
const { loadConfig } = require('../cli/config');

const cfg = loadConfig({});

function tmpdir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'funx-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
}

test('user zip: code + shim + executable bootstrap, secrets excluded', () => {
  const d = tmpdir({ 'index.js': 'exports.handler=()=>1', 'lib/a.js': '', '.env': 'SECRET=1', '.env.local': 'x', 'key.pem': 'x', '.git/config': 'x' });
  const zip = new AdmZip(buildUserZip(d, cfg));
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ['funx.json', 'funx_entry.cjs', 'index.js', 'lib/a.js', 'scf_bootstrap']);
  const boot = zip.getEntry('scf_bootstrap');
  assert.equal(EXEC_ATTR, 0o755);
  assert.equal(boot.header.attr >>> 16, 0o100755); // regular file, rwxr-xr-x
  assert.equal(zip.getEntry('index.js').header.attr >>> 16, 0o100644);
  assert.match(boot.getData().toString(), /\/var\/lang\/node18\/bin\/node funx_entry\.cjs/);
});

test('user zip: rejects reserved files and missing entry', () => {
  assert.throws(() => buildUserZip(tmpdir({ 'index.js': '', scf_bootstrap: '' }), cfg), /reserved/);
  assert.throws(() => buildUserZip(tmpdir({ 'main.js': '' }), cfg), /entry file index.js not found/);
  assert.ok(buildUserZip(tmpdir({ 'main.js': '', 'package.json': '{"main":"main.js"}' }), cfg).length > 0);
});

test('user zip: size limit', () => {
  const big = require('crypto').randomBytes(64 * 1024);
  assert.throws(() => buildUserZip(tmpdir({ 'index.js': '', 'big.bin': big }), { ...cfg, maxZipBytes: 1024 }), /limit/);
});

test('router zip is self-contained and has no SDK', () => {
  const zip = new AdmZip(buildRouterZip(cfg));
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ['lib/headers.js', 'lib/names.js', 'lib/routes.js', 'router/router.js', 'router/server.js', 'scf_bootstrap']);
});

test('runtime choice', () => {
  assert.equal(loadConfig({ FUNX_RUNTIME: 'Nodejs20.19' }).nodeDir, 'node20');
  assert.throws(() => loadConfig({ FUNX_RUNTIME: 'Python3.9' }), /unsupported/);
});

const { buildSourceZip, buildUserZipFromFiles, readEntryFromZip } = require('../cli/package');

test('worker zips: manifest, ESM detection, wrangler.toml main, reserved names, read back', () => {
  const z1 = new AdmZip(buildSourceZip('export default { fetch: () => new Response("x") }', cfg));
  assert.deepEqual(JSON.parse(z1.getEntry('funx.json').getData()), { entry: 'worker.mjs', format: 'esm' });
  assert.equal(readEntryFromZip(z1.toBuffer()).code, 'export default { fetch: () => new Response("x") }');
  // ESM in a .js entry without package.json -> packaged with "type": "module"
  const z2 = new AdmZip(buildUserZipFromFiles(new Map([['index.js', Buffer.from('export default {}')]]), cfg));
  assert.equal(JSON.parse(z2.getEntry('package.json').getData()).type, 'module');
  assert.equal(JSON.parse(z2.getEntry('funx.json').getData()).format, 'esm');
  // CommonJS stays as is
  const z3 = new AdmZip(buildUserZipFromFiles(new Map([['index.js', Buffer.from('module.exports = {}')]]), cfg));
  assert.equal(z3.getEntry('package.json'), null);
  // wrangler.toml main
  const z4 = new AdmZip(buildUserZipFromFiles(new Map([['wrangler.toml', Buffer.from('name = "x"\nmain = "src/index.js"\n')], ['src/index.js', Buffer.from('export default {}')]]), cfg));
  assert.equal(JSON.parse(z4.getEntry('funx.json').getData()).entry, 'src/index.js');
  assert.throws(() => buildUserZipFromFiles(new Map([['index.js', Buffer.from('')], ['funx.json', Buffer.from('{}')]]), cfg), /reserved/);
  assert.throws(() => buildUserZipFromFiles(new Map([['../x.js', Buffer.from('')]]), cfg), /bad file path|entry/);
  assert.throws(() => buildSourceZip('  ', cfg), /empty/);
});

test('a packaged worker runs under its packaged shim (zip -> disk -> request)', async () => {
  const { listen, request } = require('./helpers');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'funxpkg-'));
  new AdmZip(buildUserZipFromFiles(new Map([['index.js', Buffer.from('export default { fetch: (r, env) => new Response("packaged " + env.A) }')]]), cfg)).extractAllTo(d);
  const { createShim } = require(path.join(d, 'funx_entry.cjs'));
  const s = await listen(createShim({ root: d, routeKey: 'k'.repeat(43), env: { A: '1' }, log: () => {} }));
  try { assert.equal((await request(s.port, { headers: { 'x-funx-route-key': 'k'.repeat(43) } })).body, 'packaged 1'); } finally { await s.close(); }
});
