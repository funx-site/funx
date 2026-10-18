'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MysqlDataStore } = require('../api/data-store');
const { MysqlUserStore } = require('../api/store-mysql');
const { MemoryUserStore } = require('../api/users');
const { MemoryWorkerStore, MysqlWorkerStore } = require('../api/workers-store');
const { KEEP_VERSIONS, PLATFORM_DOC_BYTES } = require('../api/platform-data');
const { bundleFromSource } = require('../api/bundle');
const { newSecretsKey, loadSecretsKey } = require('../api/secretbox');
const { fakeDataPool } = require('./fake-data-pool');

const NOTES = {
  name: 'notes',
  columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }],
};

test('funx accounts and workers are rows in one funx_udata, next to a customer database', async () => {
  const mysql = fakeDataPool();
  const data = new MysqlDataStore(mysql.pool);
  const users = new MysqlUserStore(mysql.pool, { dataStore: data });
  const workers = new MysqlWorkerStore(mysql.pool, { secretsKey: loadSecretsKey(newSecretsKey()), dataStore: data });
  await users.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'admin', tokenSha256: 'ab'.repeat(32), expiresAt: Date.now() + 3600000 });
  const big = 'x'.repeat(40 * 1024);
  const deployed = await workers.deploy('hello', 'admin', bundleFromSource(`export default { fetch() { return new Response(${JSON.stringify(big)}) } }`).bundle);
  assert.match(deployed.version, /^[0-9a-f]{64}$/);
  await data.createDatabase({ ownerId: 'u_customer', name: 'app' });
  await data.createTable('u_customer', 'app', NOTES);
  await data.putRow('u_customer', 'app', 'notes', '1', { title: 'hi' });
  await assert.rejects(data.putRow('u_customer', 'app', 'notes', '2', { title: 'y'.repeat(40 * 1024) }), (e) => e && e.code === 'bad_row');
  assert.equal(new Set(mysql.db.funx_udata.map((r) => r.udb_id)).size, 2);
  const rows = mysql.db.funx_udata;
  assert.ok(rows.some((r) => r.pk === 'admin' && r.doc.email === 'admin@example.com' && r.doc.role === 'admin'));
  assert.ok(rows.some((r) => r.pk === 'hello' && r.doc.owner_id === 'admin' && r.doc.disabled === false));
  assert.ok(rows.some((r) => r.doc.bundle && r.doc.bundle.files['index.js'].includes(big.slice(0, 32))));
  assert.ok(rows.some((r) => r.doc.title === 'hi'));
  assert.ok(mysql.sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS funx_udata')));
  assert.equal(mysql.sql.some((s) => /CREATE TABLE IF NOT EXISTS funx_(users|setup_tokens|workers|worker_)/.test(s)), false);
  assert.ok(PLATFORM_DOC_BYTES > 32 * 1024);
  await assert.rejects(
    users.bootstrap({ id: 'funx', email: 'root@example.com', role: 'admin', tokenSha256: 'cd'.repeat(32), expiresAt: Date.now() + 1000 }),
    (e) => e && e.code === 'exists',
  );
});

test('a thrown transaction does not keep the new account row', async () => {
  for (const store of [new MemoryUserStore(), new MysqlUserStore(fakeDataPool().pool)]) {
    await store.bootstrap({ id: 'admin', email: 'admin@example.com', role: 'user', tokenSha256: 'aa'.repeat(32), expiresAt: Date.now() + 1000 });
    await assert.rejects(store.data.transact('funx', 'platform', async (tx) => {
      await tx.insertRow('users', 'ghost', {
        id: 'ghost', email: 'ghost@example.com', password_hash: null, role: 'user', created_at: 't', password_changed_at: null,
      });
      throw new Error('boom');
    }), /boom/);
    assert.equal(await store.getById('ghost'), null);
    assert.equal((await store.getById('admin')).email, 'admin@example.com');
  }
});

test('worker versions prune to the newest 10 plus the current one, on the name prefix', async () => {
  const secretsKey = loadSecretsKey(newSecretsKey());
  for (const workers of [new MemoryWorkerStore({ secretsKey }), new MysqlWorkerStore(fakeDataPool().pool, { secretsKey })]) {
    let last;
    for (let i = 0; i < KEEP_VERSIONS + 2; i++) {
      last = await workers.deploy('hello', 'bob', bundleFromSource(`export default { fetch() { return new Response("${i}") } }`).bundle);
    }
    const versions = await workers.data.listAll('funx', 'platform', 'worker_versions', { prefix: 'hello@' });
    assert.ok(versions.length >= KEEP_VERSIONS && versions.length <= KEEP_VERSIONS + 1, String(versions.length));
    assert.ok(versions.every((r) => r.pk.startsWith('hello@') && r.values.name === 'hello'));
    assert.ok(versions.some((r) => r.values.version === last.version));
    assert.equal((await workers.getBundle('hello')).version, last.version);
    await workers.deploy('hellow', 'bob', bundleFromSource('export default { fetch() { return new Response("w") } }').bundle);
    const again = await workers.data.listAll('funx', 'platform', 'worker_versions', { prefix: 'hello@' });
    assert.ok(again.every((r) => r.values.name === 'hello'));
  }
});
