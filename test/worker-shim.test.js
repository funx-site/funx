'use strict';
// Workers-compatible runtime in shim/funx_entry.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shim = require('../shim/funx_entry.cjs');
const { listen, request } = require('./helpers');

const KEY = 'K'.repeat(43);
const H = { 'x-funx-route-key': KEY, 'x-forwarded-host': 'demo.funx.run', 'x-forwarded-proto': 'https' };

function tmpdir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'funxw-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
}

async function serve(opts, fn) {
  const s = await listen(shim.createShim({ routeKey: KEY, log: () => {}, ...opts }));
  try { return await fn(s.port); } finally { await s.close(); }
}

test('module worker (ESM .mjs): Request in, Response out, env and ctx', async () => {
  const root = tmpdir({ 'worker.mjs': `
    export default {
      async fetch(request, env, ctx) {
        const u = new URL(request.url);
        const body = request.method === 'POST' ? await request.text() : '';
        return Response.json({ url: request.url, path: u.pathname, q: u.searchParams.get('a'), method: request.method, body,
          host: request.headers.get('host'), key: request.headers.get('x-funx-route-key'), scf: request.headers.get('x-scf-request-id'),
          env: { ...env }, hasWait: typeof ctx.waitUntil, hasPass: typeof ctx.passThroughOnException });
      },
    };` });
  await serve({ root, entry: 'worker.mjs', env: { GREETING: 'hi', API_TOKEN: 's3cret' } }, async (port) => {
    const r = await request(port, { method: 'POST', path: '/x/y?a=1', headers: { ...H, 'x-scf-request-id': 'r1', 'content-type': 'text/plain' }, body: 'hello' });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.url, 'https://demo.funx.run/x/y?a=1');
    assert.equal(j.path, '/x/y'); assert.equal(j.q, '1'); assert.equal(j.method, 'POST'); assert.equal(j.body, 'hello');
    assert.equal(j.host, 'demo.funx.run');
    assert.equal(j.key, null); assert.equal(j.scf, null);
    assert.deepEqual(j.env, { GREETING: 'hi', API_TOKEN: 's3cret' });
    assert.equal(j.hasWait, 'function'); assert.equal(j.hasPass, 'function');
  });
});

test('ESM syntax in a plain .js file (no package.json) is detected', async () => {
  const root = tmpdir({ 'index.js': 'export default { fetch: () => new Response("esm-js") }' });
  assert.equal(shim.isEsm(path.join(root, 'index.js')), true);
  await serve({ root, env: {} }, async (port) => assert.equal((await request(port, { headers: H })).body, 'esm-js'));
});

test('CommonJS module worker (module.exports = { fetch })', async () => {
  const root = tmpdir({ 'index.js': 'module.exports = { fetch: (req) => new Response("cjs " + req.method) }' });
  assert.equal(shim.isEsm(path.join(root, 'index.js')), false);
  await serve({ root, env: {} }, async (port) => assert.equal((await request(port, { headers: H })).body, 'cjs GET'));
});

test('service-worker format: addEventListener("fetch"), respondWith, vars as globals', async () => {
  const root = tmpdir({ 'index.js': `
    addEventListener('fetch', (event) => {
      event.waitUntil(Promise.resolve());
      event.respondWith(new Response('sw ' + GREETING + ' ' + new URL(event.request.url).pathname));
    });` });
  await serve({ root, env: { GREETING: 'yo' } }, async (port) => assert.equal((await request(port, { path: '/p', headers: H })).body, 'sw yo /p'));
});

test('multiple Set-Cookie headers survive, other headers and status pass through', async () => {
  const loadCode = async () => ({ kind: 'module', fetch: () => {
    const h = new Headers({ 'content-type': 'text/plain', 'x-custom': 'a' });
    h.append('set-cookie', 'a=1; Path=/; HttpOnly');
    h.append('set-cookie', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/');
    return new Response('made', { status: 201, statusText: 'Made', headers: h });
  } });
  await serve({ loadCode }, async (port) => {
    const r = await request(port, { headers: H });
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-custom'], 'a');
    assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/; HttpOnly', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/']);
    assert.equal(r.headers['content-length'], '4');
  });
});

test('splitSetCookie handles commas inside Expires (Node 18 fallback)', () => {
  assert.deepEqual(shim.splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2'), ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', 'b=2']);
  assert.deepEqual(shim.splitSetCookie(null), []);
});

test('binary request and response bodies are byte-exact', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 0x80, 0x7f]);
  const loadCode = async () => ({ kind: 'module', fetch: async (req) => {
    const ab = new Uint8Array(await req.arrayBuffer());
    const out = new Uint8Array(ab.length);
    for (let i = 0; i < ab.length; i++) out[i] = 255 - ab[i];
    return new Response(out, { headers: { 'content-type': 'application/octet-stream' } });
  } });
  await serve({ loadCode }, async (port) => {
    const r = await request(port, { method: 'PUT', headers: H, body: bytes });
    assert.deepEqual([...r.raw], [...bytes].map((b) => 255 - b));
  });
});

test('streaming response body is collected', async () => {
  const loadCode = async () => ({ kind: 'module', fetch: () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode('a')); c.enqueue(enc.encode('b')); c.close(); } });
    return new Response(stream);
  } });
  await serve({ loadCode }, async (port) => assert.equal((await request(port, { headers: H })).body, 'ab'));
});

test('ctx.waitUntil work finishes before the response completes; bounded by a timeout', async () => {
  let done = false;
  const loadCode = async () => ({ kind: 'module', fetch: (req, env, ctx) => {
    ctx.waitUntil(new Promise((r) => setTimeout(() => { done = true; r(); }, 30)));
    ctx.waitUntil(new Promise(() => {})); // never settles
    ctx.waitUntil(Promise.reject(new Error('ignored')));
    return new Response('ok');
  } });
  await serve({ loadCode, waitUntilMs: 200 }, async (port) => {
    const t = Date.now();
    const r = await request(port, { headers: H });
    assert.equal(r.body, 'ok');
    assert.ok(done);
    assert.ok(Date.now() - t < 2000);
  });
});

test('route key is still required; dev mode skips it', async () => {
  const loadCode = async () => ({ kind: 'module', fetch: () => new Response('x') });
  await serve({ loadCode }, async (port) => {
    assert.equal((await request(port)).status, 403);
    assert.equal((await request(port, { headers: { 'x-funx-route-key': 'nope' } })).status, 403);
  });
  await serve({ loadCode, requireKey: false }, async (port) => assert.equal((await request(port)).status, 200));
});

test('errors: throw -> 500 without details; non-Response -> 500; load failure -> 500', async () => {
  await serve({ loadCode: async () => ({ kind: 'module', fetch: () => { throw new Error('secret detail'); } }) }, async (port) => {
    const r = await request(port, { headers: H });
    assert.equal(r.status, 500); assert.ok(!r.body.includes('secret'));
  });
  await serve({ loadCode: async () => ({ kind: 'module', fetch: () => 'not a response' }) }, async (port) => assert.equal((await request(port, { headers: H })).status, 500));
  await serve({ root: tmpdir({ 'index.js': 'module.exports = {}' }), env: {} }, async (port) => assert.equal((await request(port, { headers: H })).status, 500));
});

test('204 and HEAD have no body', async () => {
  const loadCode = async () => ({ kind: 'module', fetch: (req) => (new URL(req.url).pathname === '/empty' ? new Response(null, { status: 204 }) : new Response('body')) });
  await serve({ loadCode }, async (port) => {
    assert.equal((await request(port, { path: '/empty', headers: H })).status, 204);
    const h = await request(port, { method: 'HEAD', headers: H });
    assert.equal(h.status, 200); assert.equal(h.body, '');
  });
});

test('buildEnv exposes only names listed in FUNX_META', () => {
  const env = shim.buildEnv({ A: '1', S: 'x', PATH: '/bin', TENCENTCLOUD_SECRETKEY: 'no', SCF_FUNCTIONNAME: 'f' }, JSON.stringify({ v: ['A', 'PATH_NOT_SET'], s: ['S'] }));
  assert.deepEqual(env, { A: '1', S: 'x' });
  assert.ok(Object.isFrozen(env));
  assert.deepEqual(shim.buildEnv({ A: '1' }, 'not json'), {});
});

test('FUNX_META and FUNX_ROUTE_KEY are removed from process.env before user code loads', () => {
  process.env.FUNX_ROUTE_KEY = 'k'; process.env.FUNX_META = '{"v":["ZZ_TEST"],"s":[]}'; process.env.ZZ_TEST = 'v';
  const p = require.resolve('../shim/funx_entry.cjs');
  delete require.cache[p];
  const fresh = require(p);
  assert.equal(process.env.FUNX_ROUTE_KEY, undefined);
  assert.equal(process.env.FUNX_META, undefined);
  assert.deepEqual(fresh.buildEnv(), { ZZ_TEST: 'v' });
  delete process.env.ZZ_TEST;
});

test('v1 handler(event) functions keep working', async () => {
  const root = tmpdir({ 'index.js': 'exports.handler = async (e) => ({ statusCode: 200, body: "v1 " + e.path })' });
  await serve({ root, env: {} }, async (port) => assert.equal((await request(port, { path: '/old', headers: H })).body, 'v1 /old'));
});

test('funx.json manifest picks the entry', async () => {
  const root = tmpdir({ 'funx.json': '{"entry":"src/w.mjs"}', 'src/w.mjs': 'export default { fetch: () => new Response("manifest") }', 'index.js': 'throw new Error("wrong")' });
  await serve({ root, env: {} }, async (port) => assert.equal((await request(port, { headers: H })).body, 'manifest'));
});
