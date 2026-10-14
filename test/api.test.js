'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ops = require('../cli/ops');
const { loadConfig } = require('../cli/config');
const { createApi, originAllowed } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore, EnvUserStore, hashPassword, verifyPassword } = require('../api/users');
const { fakeScf, listen } = require('./helpers');

const cfg = { ...loadConfig({}), pollMs: 1, waitTimeoutMs: 2000 };
const KEYS = JSON.stringify([newKey()]);

async function setup({ signupOpen = true, logsDenied = false, fetchImpl, origins } = {}) {
  const f = fakeScf({ logsDenied, logs: [{ StartTime: '2026-10-10 17:00:00', RequestId: 'r1', RetCode: 0, Duration: 3, Log: 'hello log' }] });
  await ops.routerDeploy(f.scf, cfg);
  const signer = createSigner(loadKeys(KEYS));
  const store = new MemoryUserStore([{ id: 'admin', email: 'admin@funx.test', hash: await hashPassword('correct horse battery'), role: 'admin' }]);
  const api = createApi({ scf: f.scf, cfg, signer, userStore: store, download: f.download, signupOpen, origins, fetchImpl });
  const s = await listen(api);
  const call = async (method, p, { body, token, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
  };
  return { f, s, call, signer, close: s.close };
}

test('passwords: scrypt hash round trip, wrong password, malformed hash', async () => {
  const h = await hashPassword('a long password');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(await verifyPassword('a long password', h));
  assert.ok(!(await verifyPassword('a long passwore', h)));
  assert.ok(!(await verifyPassword('x', 'plain')));
});

test('jwt: ES256 key id, public-only JWKS; tampered, expired and foreign key id rejected', () => {
  let t = Date.now();
  const k1 = newKey();
  const signer = createSigner(loadKeys(JSON.stringify([k1])), { now: () => t, ttlSec: 60 });
  const { token } = signer.sign({ sub: 'u1' });
  const [h, p] = token.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
  assert.equal(h.alg, 'ES256'); assert.equal(h.kid, k1.kid);
  assert.equal(p.iss, 'funx'); assert.equal(p.aud, 'funx-api'); assert.equal(p.sub, 'u1');
  assert.equal(signer.verify(token).sub, 'u1');
  const jwks = signer.jwks();
  assert.equal(jwks.keys.length, 1); assert.equal(jwks.keys[0].kid, k1.kid); assert.equal(jwks.keys[0].d, undefined);
  const parts = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, sub: 'admin' })).toString('base64url');
  assert.throws(() => signer.verify(`${parts[0]}.${forged}.${parts[2]}`), /signature/);
  const other = createSigner(loadKeys(JSON.stringify([newKey()])));
  assert.throws(() => other.verify(token), /kid/);
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: k1.kid })).toString('base64url');
  assert.throws(() => signer.verify(`${none}.${parts[1]}.`), /alg/);
  t += 61000;
  assert.throws(() => signer.verify(token), /expired/);
  // rotation: old public key kept for verification, new key signs
  const k2 = newKey();
  const pubOnly = { kty: k1.kty, crv: k1.crv, x: k1.x, y: k1.y, kid: k1.kid };
  const rotated = createSigner(loadKeys(JSON.stringify([k2, pubOnly])), { now: () => t - 61000 });
  assert.equal(rotated.verify(token).sub, 'u1');
  assert.equal(JSON.parse(Buffer.from(rotated.sign({ sub: 'x' }).token.split('.')[0], 'base64url')).kid, k2.kid);
});

test('EnvUserStore is read-only', async () => {
  const s = new EnvUserStore(JSON.stringify([{ id: 'admin', email: 'A@B.co', hash: 'scrypt$1$1$1$a$b' }]));
  assert.equal((await s.getByEmail('a@b.co')).id, 'admin');
  await assert.rejects(s.create({ email: 'x@y.zz', hash: 'h' }), /closed/);
});

test('CORS: only console origins, never credentials', () => {
  const allowed = ['https://funx.demox.site', 'http://localhost'];
  assert.ok(originAllowed('https://funx.demox.site', allowed));
  assert.ok(originAllowed('http://localhost:5173', allowed));
  assert.ok(!originAllowed('https://evil.demox.site', allowed));
  assert.ok(!originAllowed('https://hello.funx.run', allowed));
  assert.ok(!originAllowed('http://localhost.evil.com', allowed));
});

test('api: register/login, workers CRUD, code, vars/secrets, disable, logs, delete', async () => {
  const fetches = [];
  const fetchImpl = async (url, init) => { fetches.push({ url, init }); return new Response('hi from worker', { status: 200, headers: { 'content-type': 'text/plain', 'x-a': '1' } }); };
  const t = await setup({ fetchImpl, origins: ['https://funx.demox.site'] });
  try {
    // public
    assert.equal((await t.call('GET', '/v1/health')).json.ok, true);
    assert.equal((await t.call('GET', '/.well-known/jwks.json')).json.keys.length, 1);
    // no token
    assert.equal((await t.call('GET', '/v1/workers')).status, 401);
    assert.equal((await t.call('GET', '/v1/workers', { token: 'a.b.c' })).status, 401);

    // accounts
    assert.equal((await t.call('POST', '/v1/auth/register', { body: { email: 'bad', password: 'x' } })).status, 400);
    const reg = await t.call('POST', '/v1/auth/register', { body: { email: 'Dev@Example.com', password: 'longenough1' } });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.email, 'dev@example.com');
    assert.equal(reg.headers.get('set-cookie'), null);
    assert.equal((await t.call('POST', '/v1/auth/register', { body: { email: 'dev@example.com', password: 'longenough1' } })).status, 409);
    assert.equal((await t.call('POST', '/v1/auth/login', { body: { email: 'dev@example.com', password: 'wrong-password' } })).status, 401);
    assert.equal((await t.call('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password' } })).status, 401);
    const login = await t.call('POST', '/v1/auth/login', { body: { email: 'dev@example.com', password: 'longenough1' } });
    assert.equal(login.status, 200);
    const tok = login.json.token;
    assert.equal((await t.call('GET', '/v1/me', { token: tok })).json.user.email, 'dev@example.com');

    // create with the starter, then list
    const created = await t.call('POST', '/v1/workers', { token: tok, body: { name: 'demo' } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.url, 'https://demo.funx.run');
    assert.equal(created.json.domain, 'pending'); // role has no custom-domain permission yet
    assert.equal(created.json.owner, reg.json.user.id);
    assert.equal(t.f.domains.size, 0);
    const fn = t.f.fns.get('funx-u-demo');
    assert.equal(fn.Role, ''); assert.equal(fn.VpcConfig.VpcId, '');
    assert.ok(!t.f.calls.some((c) => c.params && ('Role' in c.params || 'VpcConfig' in c.params)));
    assert.equal((await t.call('POST', '/v1/workers', { token: tok, body: { name: 'demo' } })).status, 409);
    assert.equal((await t.call('POST', '/v1/workers', { token: tok, body: { name: 'www' } })).status, 400);
    const list = await t.call('GET', '/v1/workers', { token: tok });
    assert.deepEqual(list.json.workers.map((w) => w.name), ['demo']);
    assert.match(list.json.workers[0].last_deploy, /^2026-10-10 /);

    // code round trip
    const code0 = await t.call('GET', '/v1/workers/demo/code', { token: tok });
    assert.equal(code0.json.entry, 'worker.mjs');
    assert.match(code0.json.code, /export default/);
    const src = 'export default { fetch: () => new Response("v2") }';
    assert.equal((await t.call('PUT', '/v1/workers/demo/code', { token: tok, body: { code: src } })).status, 200);
    assert.equal((await t.call('GET', '/v1/workers/demo/code', { token: tok })).json.code, src);

    // vars and secrets
    assert.equal((await t.call('PUT', '/v1/workers/demo/vars', { token: tok, body: { vars: { GREETING: 'hi' } } })).json.vars.GREETING, 'hi');
    const sec = await t.call('PUT', '/v1/workers/demo/secrets/API_TOKEN', { token: tok, body: { value: 'very-secret' } });
    assert.deepEqual(sec.json, { secrets: ['API_TOKEN'] });
    assert.equal((await t.call('PUT', '/v1/workers/demo/secrets/FUNX_ROUTE_KEY', { token: tok, body: { value: 'x' } })).status, 400);
    assert.equal((await t.call('PUT', '/v1/workers/demo/vars', { token: tok, body: { vars: { TENCENTCLOUD_SECRETKEY: 'x' } } })).status, 400);
    const detail = await t.call('GET', '/v1/workers/demo', { token: tok });
    assert.deepEqual(detail.json.vars, { GREETING: 'hi' });
    assert.deepEqual(detail.json.secrets, ['API_TOKEN']);
    assert.ok(!JSON.stringify(detail.json).includes('very-secret'));
    assert.ok(!JSON.stringify(detail.json).includes(fn.Environment.Variables.find((v) => v.Key === 'FUNX_ROUTE_KEY').Value));
    const env = Object.fromEntries(t.f.fns.get('funx-u-demo').Environment.Variables.map((v) => [v.Key, v.Value]));
    assert.equal(env.API_TOKEN, 'very-secret');
    assert.deepEqual(JSON.parse(env.FUNX_META), { v: ['GREETING'], s: ['API_TOKEN'] });
    assert.ok(env.FUNX_ROUTE_KEY);
    // a code update keeps vars and secrets
    await t.call('PUT', '/v1/workers/demo/code', { token: tok, body: { code: src } });
    assert.deepEqual((await t.call('GET', '/v1/workers/demo/secrets', { token: tok })).json.secrets, ['API_TOKEN']);
    assert.deepEqual((await t.call('DELETE', '/v1/workers/demo/secrets/API_TOKEN', { token: tok })).json.secrets, []);

    // invoke through the public URL only
    const inv = await t.call('POST', '/v1/workers/demo/invoke', { token: tok, body: { method: 'POST', path: '/x?y=1', headers: { 'content-type': 'text/plain', host: 'evil.com', 'x-funx-route-key': 'k' }, body: 'hey' } });
    assert.equal(inv.json.status, 200); assert.equal(inv.json.body, 'hi from worker'); assert.equal(inv.json.headers['x-a'], '1');
    assert.equal(fetches[0].url, 'https://demo.funx.run/x?y=1');
    assert.deepEqual(fetches[0].init.headers, { 'content-type': 'text/plain' });
    assert.equal((await t.call('POST', '/v1/workers/demo/invoke', { token: tok, body: { path: '//evil.com/' } })).status, 400);
    assert.equal((await t.call('POST', '/v1/workers/demo/invoke', { token: tok, body: { path: '@evil.com' } })).status, 400);

    // disable / enable
    assert.equal((await t.call('POST', '/v1/workers/demo/disable', { token: tok })).json.disabled, true);
    assert.equal((await t.call('GET', '/v1/workers/demo', { token: tok })).json.disabled, true);
    assert.equal((await t.call('POST', '/v1/workers/demo/enable', { token: tok })).json.disabled, false);

    // logs
    assert.equal((await t.call('GET', '/v1/workers/demo/logs', { token: tok })).json.logs[0].log, 'hello log');

    // another user cannot see or touch it; admin can
    await t.call('POST', '/v1/auth/register', { body: { email: 'other@example.com', password: 'longenough2' } });
    const other = (await t.call('POST', '/v1/auth/login', { body: { email: 'other@example.com', password: 'longenough2' } })).json.token;
    assert.deepEqual((await t.call('GET', '/v1/workers', { token: other })).json.workers, []);
    assert.equal((await t.call('GET', '/v1/workers/demo', { token: other })).status, 404);
    assert.equal((await t.call('POST', '/v1/workers/demo/deploy', { token: other, body: { code: src } })).status, 409);
    assert.equal((await t.call('DELETE', '/v1/workers/demo', { token: other })).status, 404);
    const admin = (await t.call('POST', '/v1/auth/login', { body: { email: 'admin@funx.test', password: 'correct horse battery' } })).json.token;
    assert.equal((await t.call('GET', '/v1/workers', { token: admin })).json.workers.length, 1);

    // deploy endpoint with files (CLI path)
    const files = { 'index.js': Buffer.from('module.exports = { fetch: () => new Response("files") }').toString('base64') };
    assert.equal((await t.call('POST', '/v1/workers/fromcli/deploy', { token: tok, body: { files } })).status, 200);

    // delete
    assert.equal((await t.call('DELETE', '/v1/workers/demo', { token: tok })).status, 200);
    assert.equal(t.f.fns.has('funx-u-demo'), false);
    assert.equal((await t.call('GET', '/v1/workers/demo', { token: tok })).status, 404);

    // CORS preflight
    const pre = await fetch(`http://127.0.0.1:${t.s.port}/v1/workers`, { method: 'OPTIONS', headers: { origin: 'https://funx.demox.site', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://funx.demox.site');
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    const bad = await fetch(`http://127.0.0.1:${t.s.port}/v1/workers`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
  } finally { await t.close(); }
});

test('api: sign-up closed by default; logs stub when the permission is missing', async () => {
  const t = await setup({ signupOpen: false, logsDenied: true });
  try {
    assert.equal((await t.call('POST', '/v1/auth/register', { body: { email: 'a@b.co', password: 'longenough1' } })).status, 403);
    const tok = (await t.call('POST', '/v1/auth/login', { body: { email: 'admin@funx.test', password: 'correct horse battery' } })).json.token;
    assert.equal((await t.call('POST', '/v1/workers', { token: tok, body: { name: 'logless' } })).status, 201);
    const r = await t.call('GET', '/v1/workers/logless/logs', { token: tok });
    assert.equal(r.status, 501); assert.equal(r.json.error, 'logs_unavailable');
  } finally { await t.close(); }
});

test('api: login throttling', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 8; i++) await t.call('POST', '/v1/auth/login', { body: { email: 'admin@funx.test', password: 'nope-nope-nope' } });
    assert.equal((await t.call('POST', '/v1/auth/login', { body: { email: 'admin@funx.test', password: 'correct horse battery' } })).status, 429);
  } finally { await t.close(); }
});
