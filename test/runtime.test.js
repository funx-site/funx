'use strict';
// v2 shared runtime: sandbox (isolated-vm), egress guard, runtime code-fetch endpoint, end-to-end deploy -> serve.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { Sandbox } = require('../runtime/sandbox');
const { createEgress, isBlockedIp } = require('../runtime/egress');
const { createRuntime } = require('../runtime/server');
const { createApi } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore, hashPassword } = require('../api/users');
const { MemoryWorkerStore } = require('../api/workers-store');
const { loadSecretsKey, seal, open, newSecretsKey } = require('../api/secretbox');
const { bundleFromSource, bundleFromFiles } = require('../api/bundle');
const { loadConfig } = require('../cli/config');
const { listen } = require('./helpers');

const req = (url, o = {}) => ({ url, method: o.method || 'GET', headers: o.headers || [], body: o.body || null });
const src = (code, entry = 'index.js') => ({ entry, files: { [entry]: code } });

test('sandbox: Web APIs inside, no Node APIs, modules, env, console', async () => {
  const sb = new Sandbox({ egress: async (u, i) => ({ status: 201, statusText: 'Created', headers: [['x-up', '1']], body: Buffer.from(`${i.method} ${u}`), url: u, redirected: false }) });
  try {
    const bundle = { entry: 'src/index.js', files: {
      'src/index.js': `import { two } from './lib/m.js'; import data from '../data.json'; import page from './page.html';
        export default { async fetch(request, env, ctx) {
          const u = new URL(request.url); u.searchParams.append('x', 'y z');
          const up = await fetch('https://example.com/a', { method: 'POST', body: 'hi' });
          const h = new Headers({ 'X-A': '1' }); h.append('x-a', '2');
          const bytes = crypto.getRandomValues(new Uint8Array(8));
          console.log('log line', { n: two() });
          return Response.json({ two: two(), data, page, href: u.href, upstream: [up.status, await up.text(), up.headers.get('x-up')],
            h: h.get('x-a'), rnd: bytes.length, uuid: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()), env: env.GREETING, envKeys: Object.keys(env),
            post: await request.text(), method: request.method, ua: request.headers.get('user-agent'),
            types: [typeof process, typeof require, typeof Buffer, typeof globalThis.__funxHost, typeof __funxDispatch === 'function'],
            text: new TextDecoder().decode(new TextEncoder().encode('é你😀')), b64: btoa('ok'), }, { headers: { 'set-cookie': 'a=1' } });
        } };`,
      'src/lib/m.js': 'export const two = () => 2;', 'data.json': '{"k":[1,2]}', 'src/page.html': '<p>hi</p>' } };
    const r = await sb.run({ name: 'w1', version: 'v1', bundle, env: { GREETING: 'hello' } },
      req('https://w1.funx.run/p?q=1', { method: 'POST', headers: [['user-agent', 'test'], ['content-type', 'text/plain']], body: Buffer.from('payload') }));
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body.toString());
    assert.deepEqual(j.upstream, [201, 'POST https://example.com/a', '1']);
    assert.equal(j.two, 2); assert.deepEqual(j.data, { k: [1, 2] }); assert.equal(j.page, '<p>hi</p>');
    assert.equal(j.href, 'https://w1.funx.run/p?q=1&x=y+z');
    assert.equal(j.h, '1, 2'); assert.equal(j.rnd, 8); assert.equal(j.uuid, true);
    assert.equal(j.env, 'hello'); assert.deepEqual(j.envKeys, ['GREETING']);
    assert.equal(j.post, 'payload'); assert.equal(j.method, 'POST'); assert.equal(j.ua, 'test');
    assert.deepEqual(j.types, ['undefined', 'undefined', 'undefined', 'undefined', true]);
    assert.equal(j.text, 'é你😀'); assert.equal(j.b64, 'b2s=');
    assert.deepEqual(r.logs, [{ level: 'log', line: 'log line {"n":2}' }]);
    assert.ok(r.headers.some(([k, v]) => k === 'set-cookie' && v === 'a=1'));
  } finally { sb.disposeAll(); }
});

test('sandbox: one isolate per worker, never shared; new version = fresh isolate; LRU eviction', async () => {
  const sb = new Sandbox({ limits: { maxIsolates: 2 } });
  try {
    const code = 'let n = 0; globalThis.leak = globalThis.leak || "unset"; export default { fetch() { n++; const before = globalThis.leak; globalThis.leak = "set-by-me"; return new Response(`${n}:${before}`); } };';
    const run = async (name, v) => (await sb.run({ name, version: v, bundle: src(code) }, req(`https://${name}.funx.run/`))).body.toString();
    assert.equal(await run('a', '1'), '1:unset');
    assert.equal(await run('a', '1'), '2:set-by-me');   // same isolate for the same worker version
    assert.equal(await run('b', '1'), '1:unset');       // B never sees A's globals
    assert.equal(await run('a', '2'), '1:unset');       // new version -> new isolate
    const isoA = sb.cache.get('a').iso;
    assert.notEqual(isoA, sb.cache.get('b').iso);
    await run('c', '1');                                // 3rd worker -> LRU evicts the oldest (b)
    assert.deepEqual([...sb.cache.keys()].sort(), ['a', 'c']);
  } finally { sb.disposeAll(); }
});

test('sandbox: CPU, async-loop, memory and wall limits kill only that worker', async () => {
  const sb = new Sandbox({ limits: { cpuMs: 50, wallMs: 400, memoryMb: 16 } });
  try {
    const ok = src('export default { fetch() { return new Response("ok"); } }');
    await sb.run({ name: 'good', version: '1', bundle: ok }, req('https://good.funx.run/'));
    const cases = [
      ['spin', 'export default { fetch() { for(;;){} } }', /cpu/],
      ['aspin', 'export default { async fetch() { for(;;){ await null; } } }', /cpu/],
      ['hog', 'export default { fetch() { const a = []; for(;;) a.push("x".repeat(1e5) + Math.random()); } }', /cpu|memory/],
      ['slow', 'export default { async fetch() { await new Promise((r) => setTimeout(r, 5000)); return new Response("late"); } }', /wall/],
    ];
    for (const [name, code, re] of cases) {
      await assert.rejects(sb.run({ name, version: '1', bundle: src(code) }, req(`https://${name}.funx.run/`)), (e) => re.test(e.code), name);
      assert.ok(!sb.cache.has(name), `${name} isolate disposed`);
    }
    assert.equal((await sb.run({ name: 'good', version: '1', bundle: ok }, req('https://good.funx.run/'))).body.toString(), 'ok');
  } finally { sb.disposeAll(); }
});

test('sandbox: bad modules, bare imports, exceptions, subrequest cap', async () => {
  const sb = new Sandbox({ egress: async (u) => ({ status: 200, statusText: '', headers: [], body: Buffer.from('x'), url: u, redirected: false }), limits: { maxSubrequests: 3 } });
  try {
    await assert.rejects(sb.run({ name: 'x1', version: '1', bundle: src('import fs from "fs"; export default {}') }, req('https://x1.funx.run/')), /only relative imports/);
    await assert.rejects(sb.run({ name: 'x2', version: '1', bundle: src('export default { fetch() { throw new Error("boom") } }') }, req('https://x2.funx.run/')), (e) => e.code === 'exception' && /boom/.test(e.message));
    await assert.rejects(sb.run({ name: 'x3', version: '1', bundle: src('export default {}') }, req('https://x3.funx.run/')), /export default \{ fetch \}/);
    const r = await sb.run({ name: 'x4', version: '1', bundle: src('export default { async fetch() { const out = []; for (let i = 0; i < 5; i++) { try { await fetch("https://example.com/" + i); out.push("ok"); } catch (e) { out.push(e.message); } } return new Response(out.join("|")); } }') }, req('https://x4.funx.run/'));
    assert.match(r.body.toString(), /^ok\|ok\|ok\|fetch failed: too many subrequests/);
    // a worker can't reach the host bridges or the constructor escape hatch to Node
    const r2 = await sb.run({ name: 'x5', version: '1', bundle: src('export default { fetch() { let out; try { out = typeof globalThis.process + "," + Function("return typeof process")() + "," + typeof (async () => {}).constructor("return process"); } catch (e) { out = "err:" + e.message; } return new Response(out); } }') }, req('https://x5.funx.run/'));
    assert.equal(r2.body.toString(), 'undefined,undefined,function');
  } finally { sb.disposeAll(); }
});

test('egress: blocked address table [R3]', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.5',
    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::a00:1', 'not-an-ip']) {
    assert.ok(isBlockedIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '43.135.0.1', '172.32.0.1', '2606:4700::1111']) assert.ok(!isBlockedIp(ip), ip);
});

test('egress: DNS checked before connect, pinned address, redirects re-checked, api host refused [R3]', async () => {
  const dnsMap = { 'ok.example': '93.184.216.34', 'evil.example': '10.0.0.5', 'api.alias.example': '43.1.1.1', 'api.funx.example': '43.1.1.1', 'meta.example': '169.254.169.254', 'v6.example': '::ffff:192.168.0.1' };
  const lookup = (h, o, cb) => (dnsMap[h] ? cb(null, [{ address: dnsMap[h], family: dnsMap[h].includes(':') ? 6 : 4 }]) : cb(new Error('ENOTFOUND')));
  const seen = [];
  const transport = async ({ url, addr }) => {
    seen.push(`${url.hostname}@${addr.address}`);
    if (url.pathname === '/redir-meta') return { status: 302, statusText: 'Found', headers: { location: 'http://meta.example/latest' }, body: Buffer.alloc(0) };
    if (url.pathname === '/redir-ok') return { status: 301, statusText: 'Moved', headers: { location: '/final' }, body: Buffer.alloc(0) };
    if (url.pathname === '/loop') return { status: 302, statusText: 'Found', headers: { location: '/loop' }, body: Buffer.alloc(0) };
    return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: Buffer.from(`at ${url.pathname}`) };
  };
  const eg = createEgress({ deniedHosts: ['api.funx.example'], lookup, transport });
  const r = await eg('https://ok.example/redir-ok', {});
  assert.equal(r.body.toString(), 'at /final'); assert.equal(r.redirected, true);
  assert.deepEqual(seen, ['ok.example@93.184.216.34', 'ok.example@93.184.216.34']);
  for (const [u, re] of [['https://evil.example/', /blocked address/], ['http://169.254.169.254/latest/meta-data', /blocked address/], ['http://[::1]/', /blocked address/],
    ['https://ok.example/redir-meta', /blocked address/], ['https://api.funx.example/v1/runtime/workers/x', /not reachable/], ['https://api.alias.example/', /blocked address/],
    ['https://v6.example/', /blocked address/], ['http://localhost/', /not reachable/], ['file:///etc/passwd', /not allowed/], ['https://ok.example:22/', /port 22/],
    ['https://user:pw@ok.example/', /credentials/], ['https://ok.example/loop', /too many redirects/], ['http://0x7f.1/', /blocked address/], ['http://2130706433/', /blocked address/]]) {
    await assert.rejects(eg(u, {}), re, u);
  }
  // manual redirect mode hands the 3xx to the worker without following
  const m = await eg('https://ok.example/redir-meta', { redirect: 'manual' });
  assert.equal(m.status, 302);
});

test('secretbox: AES-GCM, bound to worker + key name', () => {
  const k = loadSecretsKey(newSecretsKey());
  const s = seal(k, 'w1', 'API_KEY', 'v@lue');
  assert.equal(open(k, 'w1', 'API_KEY', s), 'v@lue');
  assert.throws(() => open(k, 'w2', 'API_KEY', s));
  assert.throws(() => open(k, 'w1', 'OTHER', s));
  assert.throws(() => open(loadSecretsKey(newSecretsKey()), 'w1', 'API_KEY', s));
  assert.throws(() => loadSecretsKey('short'));
});

test('bundles: versioned by sha256, entry rules, junk filtered', () => {
  const a = bundleFromSource('export default { fetch() { return new Response("a") } }');
  const b = bundleFromSource('export default { fetch() { return new Response("a") } }');
  assert.equal(a.version, b.version); assert.match(a.version, /^[0-9a-f]{64}$/);
  assert.throws(() => bundleFromSource('module.exports = {}'), /module syntax/);
  const f = bundleFromFiles(new Map([['src/index.js', 'export default {}'], ['.env', 'SECRET=1'], ['package.json', '{"main":"src/index.js"}'], ['img.png', Buffer.from([1, 2])]]));
  assert.deepEqual(Object.keys(f.bundle.files), ['src/index.js']); assert.equal(f.bundle.entry, 'src/index.js');
  assert.throws(() => bundleFromFiles(new Map([['../x.js', 'export default {}']])), /bad file path/);
});

async function stack({ ttlMs = 0 } = {}) {
  const cfg = { ...loadConfig({}), baseDomain: 'funx.run' };
  const signer = createSigner(loadKeys(JSON.stringify([newKey()])));
  const users = new MemoryUserStore([
    { id: 'admin', email: 'admin@funx.test', hash: await hashPassword('correct horse battery'), role: 'admin' },
    { id: 'bob', email: 'bob@funx.test', hash: await hashPassword('bob password 123'), role: 'user' },
  ]);
  const secretsKey = loadSecretsKey(newSecretsKey());
  const workers = new MemoryWorkerStore({ secretsKey });
  const runtimeToken = `fxrt_${crypto.randomBytes(32).toString('base64url')}`;
  const api = createApi({ cfg, signer, userStore: users, workers, runtimeTokenSha256: crypto.createHash('sha256').update(runtimeToken).digest('hex'), origins: ['https://funx.demox.site'] });
  const s = await listen(api);
  const base = `http://127.0.0.1:${s.port}`;
  const call = async (method, p, { body, token, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
  };
  const login = async (email, password) => (await call('POST', '/v1/auth/login', { body: { email, password } })).json.token;
  const sandbox = new Sandbox({ egress: createEgress({ deniedHosts: ['127.0.0.1'] }) });
  const rt = createRuntime({ apiBase: base, token: runtimeToken, baseDomain: 'funx.run', sandbox, ttlMs });
  const rs = await listen(rt);
  const visit = (host, p = '/', o = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: rs.port, path: p, method: o.method || 'GET', headers: { host, ...(o.headers || {}) } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject); if (o.body) r.write(o.body); r.end();
  });
  return { call, login, visit, runtimeToken, workers, secretsKey, close: async () => { sandbox.disposeAll(); await rs.close(); await s.close(); } };
}

test('runtime endpoint: runtime token only; user JWTs (even admin) and bad tokens are 401 for every name; no CORS [R2]', async () => {
  const st = await stack();
  try {
    const admin = await st.login('admin@funx.test', 'correct horse battery');
    assert.equal((await st.call('POST', '/v1/workers', { token: admin, body: { name: 'hello', code: 'export default { fetch: (r, env) => new Response(env.TOKEN) }' } })).status, 201);
    await st.call('PUT', '/v1/workers/hello/secrets/TOKEN', { token: admin, body: { value: 's3cret' } });
    assert.equal((await st.call('POST', '/v1/workers', { token: admin, body: { name: 'other', code: 'export default { fetch: () => new Response("o") }' } })).status, 201);
    await st.call('PUT', '/v1/workers/other/secrets/OTHER_SECRET', { token: admin, body: { value: 'not-yours' } });
    for (const auth of [undefined, `Bearer ${admin}`, 'Bearer fxrt_' + 'A'.repeat(43), `Bearer ${st.runtimeToken}x`, st.runtimeToken]) {
      for (const n of ['hello', 'missing-worker']) {
        const r = await st.call('GET', `/v1/runtime/workers/${n}`, { headers: { ...(auth ? { authorization: auth } : {}), origin: 'https://funx.demox.site' } });
        assert.equal(r.status, 401, `${auth} ${n}`);
        assert.equal(r.headers.get('access-control-allow-origin'), null);
      }
    }
    const ok = await st.call('GET', '/v1/runtime/workers/hello', { token: st.runtimeToken, headers: { origin: 'https://funx.demox.site' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(ok.json.env, { TOKEN: 's3cret' }, 'only this worker\'s bindings, decrypted');
    assert.ok(!JSON.stringify(ok.json).includes('not-yours'));
    assert.equal((await st.call('GET', '/v1/runtime/workers/missing-worker', { token: st.runtimeToken })).status, 404);
    const same = await st.call('GET', `/v1/runtime/workers/hello?have=${ok.json.version}`, { token: st.runtimeToken });
    assert.deepEqual(same.json, { name: 'hello', version: ok.json.version, disabled: false, unchanged: true });
    // the runtime token is not a user token
    assert.equal((await st.call('GET', '/v1/workers', { token: st.runtimeToken })).status, 401);
    // secrets are stored sealed and never returned to users
    const rows = await st.workers.data.listAll('funx', 'platform', 'worker_bindings', { prefix: 'hello@' });
    const row = rows.find((r) => r.values.bkey === 'TOKEN');
    assert.ok(row.values.sealed && !row.values.sealed.includes('s3cret') && row.values.value === null);
    const w = await st.call('GET', '/v1/workers/hello', { token: admin });
    assert.deepEqual(w.json.secrets, ['TOKEN']); assert.ok(!JSON.stringify(w.json).includes('s3cret'));
  } finally { await st.close(); }
});

test('end to end: deploy via funx-api -> served by funx-runtime; vars/secrets; kill switch flag; ownership', async () => {
  const st = await stack();
  try {
    const admin = await st.login('admin@funx.test', 'correct horse battery');
    const bob = await st.login('bob@funx.test', 'bob password 123');
    const code = 'export default { async fetch(req, env) { const u = new URL(req.url); return Response.json({ path: u.pathname, g: env.GREETING, s: env.API_KEY ? "yes" : "no", m: req.method, b: await req.text() }); } };';
    const d = await st.call('POST', '/v1/workers/hello/deploy', { token: bob, body: { code } });
    assert.equal(d.status, 200); assert.equal(d.json.url, 'https://hello.funx.run'); assert.match(d.json.version, /^[0-9a-f]{64}$/);
    await st.call('PUT', '/v1/workers/hello/vars', { token: bob, body: { vars: { GREETING: 'hi' } } });
    await st.call('PUT', '/v1/workers/hello/secrets/API_KEY', { token: bob, body: { value: 'k' } });
    let r = await st.visit('hello.funx.run', '/a/b?x=1', { method: 'POST', body: 'data' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { path: '/a/b', g: 'hi', s: 'yes', m: 'POST', b: 'data' });
    // other users can't see or take over the name; admin can
    assert.equal((await st.call('GET', '/v1/workers/hello', { token: (await st.login('admin@funx.test', 'correct horse battery')) })).status, 200);
    const list = await st.call('GET', '/v1/workers', { token: bob });
    assert.deepEqual(list.json.workers.map((x) => x.name), ['hello']);
    // kill switch = DB flag
    assert.deepEqual((await st.call('POST', '/v1/workers/hello/disable', { token: bob })).json, { name: 'hello', disabled: true, origin: 'flag' });
    r = await st.visit('hello.funx.run'); assert.equal(r.status, 403); assert.match(r.body, /disabled/);
    await st.call('POST', '/v1/workers/hello/enable', { token: bob });
    assert.equal((await st.visit('hello.funx.run')).status, 200);
    // redeploy changes the version and the served code
    await st.call('PUT', '/v1/workers/hello/code', { token: bob, body: { code: 'export default { fetch: () => new Response("v2") }' } });
    assert.equal((await st.visit('hello.funx.run')).body, 'v2');
    assert.equal((await st.call('GET', '/v1/workers/hello/code', { token: bob })).json.code, 'export default { fetch: () => new Response("v2") }');
    // unknown names, apex, foreign hosts
    assert.equal((await st.visit('nobody.funx.run')).status, 404);
    assert.equal((await st.visit('funx.run')).status, 200);
    assert.equal((await st.visit('evil.example')).status, 404);
    // a worker's fetch can't reach funx-api (denied host) or loopback
    await st.call('PUT', '/v1/workers/hello/code', { token: bob, body: { code: 'export default { async fetch(req) { try { await fetch(new URL(req.url).searchParams.get("u")); return new Response("reached"); } catch (e) { return new Response(e.message, { status: 502 }); } } }' } });
    r = await st.visit('hello.funx.run', '/?u=' + encodeURIComponent('http://127.0.0.1/v1/runtime/workers/hello'));
    assert.equal(r.status, 502); assert.match(r.body, /not reachable|blocked/);
    // delete
    await st.call('DELETE', '/v1/workers/hello', { token: bob });
    assert.equal((await st.visit('hello.funx.run')).status, 404);
  } finally { await st.close(); }
});
