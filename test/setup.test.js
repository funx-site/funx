'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ops = require('../cli/ops');
const { loadConfig } = require('../cli/config');
const { createApi } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore, newSetupToken, sha256Hex } = require('../api/users');
const { MysqlUserStore } = require('../api/store-mysql');
const { fakeDataPool } = require('./fake-data-pool');
const { fakeScf, listen } = require('./helpers');

const cfg = { ...loadConfig({}), pollMs: 1, waitTimeoutMs: 2000 };
const H = 3600 * 1000;

async function setupApi({ store, now }) {
  const f = fakeScf();
  await ops.routerDeploy(f.scf, cfg);
  const api = createApi({ scf: f.scf, cfg, signer: createSigner(loadKeys(JSON.stringify([newKey()]))), userStore: store, download: f.download, now });
  const s = await listen(api);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  return { call, close: s.close };
}

async function seeded(t0) {
  const store = new MemoryUserStore();
  const tok = newSetupToken();
  await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
  return { store, tok };
}

test('setup link: check, set password (logs in), then normal login works', async () => {
  const t0 = Date.now();
  const { store, tok } = await seeded(t0);
  const a = await setupApi({ store, now: () => t0 });
  try {
    // no password yet -> login fails like a wrong password
    assert.equal((await a.call('POST', '/v1/auth/login', { email: 'admin@example.com', password: 'whatever12345' })).status, 401);
    const c = await a.call('POST', '/v1/auth/setup/check', { token: tok.token });
    assert.equal(c.status, 200); assert.equal(c.json.email, 'admin@example.com');
    assert.equal((await a.call('POST', '/v1/auth/setup', { token: tok.token, password: 'short' })).status, 400);
    const s = await a.call('POST', '/v1/auth/setup', { token: tok.token, password: 'a good long passphrase' });
    assert.equal(s.status, 200); assert.ok(s.json.token); assert.equal(s.json.user.id, 'admin'); assert.equal(s.json.user.role, 'admin');
    const l = await a.call('POST', '/v1/auth/login', { email: 'admin@example.com', password: 'a good long passphrase' });
    assert.equal(l.status, 200);
  } finally { await a.close(); }
});

test('setup link: reuse is rejected (410) and does not change the password', async () => {
  const t0 = Date.now();
  const { store, tok } = await seeded(t0);
  const a = await setupApi({ store, now: () => t0 });
  try {
    assert.equal((await a.call('POST', '/v1/auth/setup', { token: tok.token, password: 'first password here' })).status, 200);
    const again = await a.call('POST', '/v1/auth/setup', { token: tok.token, password: 'attacker password 1' });
    assert.equal(again.status, 410); assert.equal(again.json.error, 'link_expired');
    assert.equal((await a.call('POST', '/v1/auth/setup/check', { token: tok.token })).status, 410);
    assert.equal((await a.call('POST', '/v1/auth/login', { email: 'admin@example.com', password: 'attacker password 1' })).status, 401);
    // bootstrap on the next cold start must not revive the used token
    await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
    assert.equal(await store.checkSetupToken(tok.sha256, t0), null);
  } finally { await a.close(); }
});

test('setup link: expired after 24 h, wrong or malformed token -> 410', async () => {
  const t0 = Date.now();
  const { store, tok } = await seeded(t0);
  let now = t0 + 24 * H + 1;
  const a = await setupApi({ store, now: () => now });
  try {
    assert.equal((await a.call('POST', '/v1/auth/setup/check', { token: tok.token })).status, 410);
    assert.equal((await a.call('POST', '/v1/auth/setup', { token: tok.token, password: 'a good long passphrase' })).status, 410);
    now = t0;
    assert.equal((await a.call('POST', '/v1/auth/setup', { token: newSetupToken().token, password: 'a good long passphrase' })).status, 410);
    assert.equal((await a.call('POST', '/v1/auth/setup', { token: 'x', password: 'a good long passphrase' })).status, 410);
    assert.equal((await a.call('POST', '/v1/auth/setup', { password: 'a good long passphrase' })).status, 410);
    assert.equal((await a.call('POST', '/v1/auth/setup/check', { token: tok.token })).status, 200); // still valid in time
  } finally { await a.close(); }
});

test('mysql store: setup is one transaction, reuse and expiry are rejected, a failed write rolls back', async () => {
  const { pool, sql, failOn } = fakeDataPool();
  const store = new MysqlUserStore(pool);
  const t0 = Date.now();
  const tok = newSetupToken();
  await store.bootstrap({ id: 'admin', email: 'Admin@Example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
  await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
  assert.equal((await store.getById('admin')).hash, null);
  assert.equal((await store.getByEmail('admin@example.com')).id, 'admin');
  assert.deepEqual(await store.checkSetupToken(tok.sha256, t0), { userId: 'admin', email: 'admin@example.com' });
  assert.equal(await store.checkSetupToken(tok.sha256, t0 + 25 * H), null, 'expired');
  assert.equal(await store.completeSetup(tok.sha256, 'h1', t0 + 25 * H), null, 'expired');
  let writes = 0;
  failOn((s) => { if (!s.includes('ON DUPLICATE')) return false; writes += 1; return writes === 2; });
  await assert.rejects(store.completeSetup(tok.sha256, 'h1', t0), /boom/);
  failOn(null);
  assert.equal((await store.getById('admin')).hash, null);
  assert.deepEqual(await store.checkSetupToken(tok.sha256, t0), { userId: 'admin', email: 'admin@example.com' });
  const u = await store.completeSetup(tok.sha256, 'h1', t0);
  assert.equal(u.id, 'admin'); assert.equal(u.hash, 'h1'); assert.equal(u.role, 'admin');
  assert.equal(await store.completeSetup(tok.sha256, 'h2', t0), null);
  assert.equal((await store.getById('admin')).hash, 'h1');
  await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 48 * H });
  assert.equal((await store.getById('admin')).hash, 'h1');
  assert.equal(await store.checkSetupToken(tok.sha256, t0), null);
  assert.equal(await store.completeSetup(sha256Hex('nope'), 'h3', t0), null);
  await store.create({ email: 'b@example.com', hash: 'hb' });
  await assert.rejects(store.create({ email: 'B@example.com', hash: 'hb' }), (e) => e.code === 'exists');
  assert.equal(sql.some((s) => /funx_users|funx_setup_tokens|funx_workers/.test(s)), false);
});

test('server: worker region is ap-hongkong even when the runtime region is ap-guangzhou', () => {
  const { fromEnv } = require('../api/server');
  const env = { TENCENTCLOUD_REGION: 'ap-guangzhou', SCF_FUNCTIONREGION: 'ap-guangzhou', FUNX_REGION: 'ap-guangzhou', FUNX_JWT_KEYS: JSON.stringify([newKey()]), FUNX_DB_HOST: '10.0.0.1', FUNX_DB_NAME: 'funx', FUNX_DB_USER: 'u', FUNX_DB_PASSWORD: 'p' };
  const h = fromEnv(env);
  assert.equal(h.cfg.region, 'ap-hongkong');
  assert.throws(() => fromEnv({ ...env, FUNX_WORKER_REGION: 'ap-guangzhou' }), /ap-hongkong only/);
  assert.throws(() => fromEnv({ ...env, FUNX_DB_HOST: '' }), /FUNX_DB_HOST/);
});

test('mysql store: health counts the platform logical tables; pool max defaults to 2', async () => {
  const { pool, failOn } = fakeDataPool();
  const store = new MysqlUserStore(pool);
  assert.deepEqual(await store.health(), { db: 'ok', tables: 6 });
  failOn(/FROM funx_utbl/);
  await assert.rejects(store.health(), /boom/);
  const { poolFromEnv } = require('../api/store-mysql');
  const p = poolFromEnv({ FUNX_DB_HOST: '127.0.0.1', FUNX_DB_PORT: '1', FUNX_DB_NAME: 'funx', FUNX_DB_USER: 'u', FUNX_DB_PASSWORD: 'p' });
  assert.equal(p.pool.config.connectionLimit, 2);
  await p.end();
});

test('server: v2 mode needs the runtime token hash with the secrets key, and drops secrets from process.env', () => {
  const { fromEnv } = require('../api/server');
  const { newSecretsKey } = require('../api/secretbox');
  const base = { FUNX_JWT_KEYS: JSON.stringify([newKey()]), FUNX_DB_HOST: '10.0.0.1', FUNX_DB_NAME: 'funx', FUNX_DB_USER: 'u', FUNX_DB_PASSWORD: 'p' };
  assert.throws(() => fromEnv({ ...base, FUNX_SECRETS_KEY: newSecretsKey() }), /FUNX_RUNTIME_TOKEN_SHA256/);
  process.env.FUNX_SECRETS_KEY = 'x';
  const h = fromEnv({ ...base, FUNX_SECRETS_KEY: newSecretsKey(), FUNX_RUNTIME_TOKEN_SHA256: 'a'.repeat(64) });
  assert.equal(typeof h, 'function');
  assert.equal(process.env.FUNX_SECRETS_KEY, undefined);
});

test('bootstrap with a new token revokes the previous unused one (mysql + memory)', async () => {
  const { MemoryUserStore } = require('../api/users');
  const t0 = Date.now();
  for (const store of [new MysqlUserStore(fakeDataPool().pool), new MemoryUserStore([])]) {
    const a = newSetupToken(); const b = newSetupToken();
    await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: a.sha256, expiresAt: t0 + 24 * H });
    assert.ok(await store.checkSetupToken(a.sha256, t0));
    await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: b.sha256, expiresAt: t0 + 24 * H });
    assert.equal(await store.checkSetupToken(a.sha256, t0), null, 'old link revoked');
    assert.ok(await store.checkSetupToken(b.sha256, t0), 'new link valid');
    // a cold start with the same config keeps the current token valid
    await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: b.sha256, expiresAt: t0 + 24 * H });
    assert.ok(await store.checkSetupToken(b.sha256, t0));
  }
});
