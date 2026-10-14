'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ops = require('../cli/ops');
const { loadConfig } = require('../cli/config');
const { createApi } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore, newSetupToken, sha256Hex } = require('../api/users');
const { MysqlUserStore } = require('../api/store-mysql');
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

// --- MySQL store against a small fake pool that understands exactly the store's statements ---
function fakePool() {
  const db = { users: new Map(), tokens: new Map(), ddl: 0, log: [] };
  let fail = null;
  const run = (sql, p = [], tx) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    db.log.push(s.split(' ').slice(0, 3).join(' '));
    if (fail && fail.test(s)) throw Object.assign(new Error('boom'), { code: 'ER_FAKE' });
    if (s.startsWith('CREATE TABLE IF NOT EXISTS')) { db.ddl++; return [{}]; }
    if (s.startsWith('SELECT COUNT(*) AS n FROM information_schema.tables')) return [[{ n: db.ddl ? 2 : 0 }]];
    const W = tx ? tx : db;
    if (s.startsWith('SELECT * FROM funx_users WHERE email')) return [[...W.users.values()].filter((u) => u.email === p[0])];
    if (s.startsWith('SELECT * FROM funx_users WHERE id')) return [[W.users.get(p[0])].filter(Boolean)];
    if (s.startsWith('INSERT INTO funx_users')) {
      if ([...W.users.values()].some((u) => u.email === p[1])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      W.users.set(p[0], { id: p[0], email: p[1], password_hash: p[2], role: p[3], created_at: new Date() }); return [{ affectedRows: 1 }];
    }
    if (s.startsWith('INSERT IGNORE INTO funx_users')) {
      if (!W.users.has(p[0]) && ![...W.users.values()].some((u) => u.email === p[1])) W.users.set(p[0], { id: p[0], email: p[1], password_hash: null, role: p[2], created_at: new Date() });
      return [{}];
    }
    if (s.startsWith('INSERT IGNORE INTO funx_setup_tokens')) { if (!W.tokens.has(p[0])) W.tokens.set(p[0], { token_sha256: p[0], user_id: p[1], expires_at: p[2], used_at: null }); return [{}]; }
    if (s.startsWith('SELECT u.id, u.email FROM funx_setup_tokens')) {
      const t = W.tokens.get(p[0]);
      if (!t || t.used_at || !(t.expires_at > p[1])) return [[]];
      const u = W.users.get(t.user_id); return [u ? [{ id: u.id, email: u.email }] : []];
    }
    if (s.startsWith('SELECT user_id FROM funx_setup_tokens WHERE token_sha256 = ? AND used_at IS NULL')) {
      assert.ok(tx, 'token must be locked inside the transaction'); assert.match(s, /FOR UPDATE$/);
      const t = W.tokens.get(p[0]); return [t && !t.used_at && t.expires_at > p[1] ? [{ user_id: t.user_id }] : []];
    }
    if (s.startsWith('SELECT user_id FROM funx_setup_tokens WHERE token_sha256 = ?')) { const t = W.tokens.get(p[0]); return [t ? [{ user_id: t.user_id }] : []]; }
    if (s.startsWith('UPDATE funx_users SET password_hash')) { const u = W.users.get(p[2]); if (u) { u.password_hash = p[0]; u.password_changed_at = p[1]; } return [{ affectedRows: u ? 1 : 0 }]; }
    if (s.startsWith('UPDATE funx_setup_tokens SET used_at = CURRENT_TIMESTAMP(3) WHERE user_id')) { let n = 0; for (const t of W.tokens.values()) if (t.user_id === p[0] && t.token_sha256 !== p[1] && !t.used_at) { t.used_at = new Date(); n++; } return [{ affectedRows: n }]; }
    if (s.startsWith('UPDATE funx_setup_tokens SET used_at')) { W.tokens.get(p[1]).used_at = p[0]; return [{ affectedRows: 1 }]; }
    throw new Error(`fake pool: unexpected SQL ${s}`);
  };
  const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  const pool = {
    query: async (sql, p) => run(sql, p),
    getConnection: async () => {
      let tx = null;
      return {
        beginTransaction: async () => { tx = { users: clone(db.users), tokens: clone(db.tokens) }; db.log.push('BEGIN'); },
        query: async (sql, p) => run(sql, p, tx),
        commit: async () => { db.users = tx.users; db.tokens = tx.tokens; tx = null; db.log.push('COMMIT'); },
        rollback: async () => { tx = null; db.log.push('ROLLBACK'); },
        release: () => {},
      };
    },
  };
  return { pool, db, failOn: (re) => { fail = re; } };
}

test('mysql store: migrations idempotent, setup in one transaction, reuse/expiry rejected, rollback on error', async () => {
  const { pool, db, failOn } = fakePool();
  const store = new MysqlUserStore(pool);
  const t0 = Date.now();
  const tok = newSetupToken();
  await store.bootstrap({ id: 'admin', email: 'Admin@Example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
  await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 24 * H });
  assert.equal(db.ddl, 2, 'CREATE TABLE IF NOT EXISTS runs once per instance');
  assert.equal(db.users.size, 1); assert.equal(db.users.get('admin').password_hash, null);
  assert.deepEqual(await store.checkSetupToken(tok.sha256, t0), { userId: 'admin', email: 'admin@example.com' });
  assert.equal(await store.checkSetupToken(tok.sha256, t0 + 25 * H), null, 'expired');
  assert.equal(await store.completeSetup(tok.sha256, 'h1', t0 + 25 * H), null, 'expired');
  // failure in the middle -> rollback, nothing changed
  failOn(/^UPDATE funx_setup_tokens/);
  await assert.rejects(store.completeSetup(tok.sha256, 'h1', t0), /boom/);
  failOn(null);
  assert.equal(db.users.get('admin').password_hash, null); assert.equal(db.tokens.get(tok.sha256).used_at, null);
  assert.ok(db.log.includes('ROLLBACK'));
  // success
  const u = await store.completeSetup(tok.sha256, 'h1', t0);
  assert.equal(u.id, 'admin'); assert.equal(u.hash, 'h1'); assert.equal(u.role, 'admin');
  assert.ok(db.tokens.get(tok.sha256).used_at);
  // reuse
  assert.equal(await store.completeSetup(tok.sha256, 'h2', t0), null);
  assert.equal(db.users.get('admin').password_hash, 'h1');
  // re-bootstrap does not reset the password or revive the token
  await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: tok.sha256, expiresAt: t0 + 48 * H });
  assert.equal(db.users.get('admin').password_hash, 'h1'); assert.equal(await store.checkSetupToken(tok.sha256, t0), null);
  // wrong token
  assert.equal(await store.completeSetup(sha256Hex('nope'), 'h3', t0), null);
  // create + duplicate
  await store.create({ email: 'b@example.com', hash: 'hb' });
  await assert.rejects(store.create({ email: 'B@example.com', hash: 'hb' }), (e) => e.code === 'exists');
});

test('server: worker region is ap-hongkong even when the runtime region is ap-guangzhou', () => {
  const { fromEnv } = require('../api/server');
  const env = { TENCENTCLOUD_REGION: 'ap-guangzhou', SCF_FUNCTIONREGION: 'ap-guangzhou', FUNX_REGION: 'ap-guangzhou', FUNX_JWT_KEYS: JSON.stringify([newKey()]), FUNX_DB_HOST: '10.0.0.1', FUNX_DB_NAME: 'funx', FUNX_DB_USER: 'u', FUNX_DB_PASSWORD: 'p' };
  const h = fromEnv(env);
  assert.equal(h.cfg.region, 'ap-hongkong');
  assert.throws(() => fromEnv({ ...env, FUNX_WORKER_REGION: 'ap-guangzhou' }), /ap-hongkong only/);
  assert.throws(() => fromEnv({ ...env, FUNX_DB_HOST: '' }), /FUNX_DB_HOST/);
});

test('mysql store: health proves connect + migrations; pool max defaults to 2', async () => {
  const { pool, failOn } = fakePool();
  const store = new MysqlUserStore(pool);
  assert.deepEqual(await store.health(), { db: 'ok', tables: 2 });
  failOn(/information_schema/);
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
  for (const store of [new MysqlUserStore(fakePool().pool), new MemoryUserStore([])]) {
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
