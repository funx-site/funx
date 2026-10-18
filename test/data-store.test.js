'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadConfig } = require('../cli/config');
const { createApi } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore } = require('../api/users');
const { MemoryWorkerStore } = require('../api/workers-store');
const { fakeScf, listen } = require('./helpers');
const {
  LIMITS, DATA_MIGRATIONS, MemoryDataStore, MysqlDataStore, placeNode, chooseNode, cmpPk,
} = require('../api/data-store');
const { fakeDataPool } = require('./fake-data-pool');

const NOTES = {
  name: 'notes',
  columns: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'n', type: 'int' },
    { name: 'done', type: 'bool' },
    { name: 'meta', type: 'json' },
  ],
};

function rejects(p, code) {
  return assert.rejects(p, (e) => e && e.code === code);
}

function ownerFor(nodeId, activeIds) {
  for (let i = 0; i < 8000; i++) {
    const ownerId = `u${i}`;
    if (placeNode(ownerId, activeIds) === nodeId) return ownerId;
  }
  throw new Error(`no owner lands on node ${nodeId}`);
}

async function stores() {
  const mem = new MemoryDataStore();
  const mysql = fakeDataPool();
  return [[mem, null], [new MysqlDataStore(mysql.pool), mysql]];
}

test('schema: one data table, node_id on the logical database, owner id is VARCHAR(64)', () => {
  const udata = DATA_MIGRATIONS.filter((s) => s.includes('funx_udata'));
  assert.equal(udata.length, 1);
  assert.match(udata[0], /PRIMARY KEY \(udb_id, utbl_id, pk\)/);
  const udb = DATA_MIGRATIONS.find((s) => s.includes('funx_udb ('));
  assert.match(udb, /owner_id VARCHAR\(64\) NOT NULL/);
  assert.match(udb, /node_id TINYINT UNSIGNED NOT NULL/);
  assert.equal(placeNode('owner-a', [0]), 0);
  assert.equal(placeNode('owner-a', [1, 0]), placeNode('owner-a', [0, 1]));
  assert.equal(chooseNode('owner-a', 0, [1]), 0);
  assert.equal(LIMITS.dbsPerOwner, 32);
});

test('logical databases: rows, schema, quotas and isolation on memory and mysql', async () => {
  for (const [store, mysql] of await stores()) {
    const a = await store.createDatabase({ ownerId: 'owner-a', name: 'beta' });
    const b = await store.createDatabase({ ownerId: 'owner-a', name: 'app' });
    assert.equal(a.node_id, 0);
    assert.equal(b.node_id, 0);
    assert.equal(a.owner, 'owner-a');
    assert.equal(a.ddl_version, 1);
    assert.match(a.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual((await store.listDatabases('owner-a')).map((d) => d.name), ['app', 'beta']);
    await rejects(store.createDatabase({ ownerId: 'owner-a', name: 'app' }), 'exists');
    await rejects(store.createDatabase({ ownerId: 'owner-a', name: 'Bad' }), 'bad_name');
    await rejects(store.createDatabase({ ownerId: 'owner-a', name: "app';drop" }), 'bad_name');
    assert.equal(await store.getDatabase('owner-b', 'app'), null);

    const same = await store.createDatabase({ ownerId: 'owner-b', name: 'app' });
    assert.equal(same.node_id, 0);
    await store.createTable('owner-b', 'app', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] });
    await store.putRow('owner-b', 'app', 'notes', 'a', { title: 'other' });

    await rejects(store.createTable('owner-a', 'missing', NOTES), 'not_found');
    await rejects(store.createTable('owner-a', 'app', { name: 'notes', columns: [{ name: 'id', type: 'int', primary: true }] }), 'bad_schema');
    await rejects(store.createTable('owner-a', 'app', { name: 'notes', columns: [{ name: 'id', type: 'string' }, { name: 'id2', type: 'string' }] }), 'bad_schema');
    await rejects(store.createTable('owner-a', 'app', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'id', type: 'string' }] }), 'bad_schema');
    await rejects(store.createTable('owner-a', 'app', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true, unique: true }] }), 'bad_schema');
    const notes = await store.createTable('owner-a', 'app', NOTES);
    assert.equal(notes.columns.filter((c) => c.primary).length, 1);
    assert.equal((await store.getDatabase('owner-a', 'app')).ddl_version, 2);
    await rejects(store.createTable('owner-a', 'app', NOTES), 'exists');
    await store.createTable('owner-a', 'app', { name: 'items', columns: [{ name: 'id', type: 'string', primary: true }] });
    assert.deepEqual((await store.listTables('owner-a', 'app')).map((t) => t.name), ['items', 'notes']);

    const put = await store.putRow('owner-a', 'app', 'notes', 'a', { title: 'A', n: 1, done: false, meta: { ok: true } });
    assert.equal(put.created, true);
    assert.equal(put.row.values.id, 'a');
    assert.equal(put.row.values.n, 1);
    assert.deepEqual(put.row.values.meta, { ok: true });
    assert.match(put.row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    const again = await store.putRow('owner-a', 'app', 'notes', 'a', { id: 'a', title: 'B', n: 2, meta: null });
    assert.equal(again.created, false);
    assert.equal(again.row.values.title, 'B');
    assert.equal(again.row.values.done, null);
    await rejects(store.putRow('owner-a', 'app', 'notes', 'a', { id: 'b', title: 'x' }), 'bad_row');
    await rejects(store.putRow('owner-a', 'app', 'notes', 'b', { title: 'x', n: 1.5, extra: 1 }), 'bad_row');
    await rejects(store.putRow('owner-a', 'app', 'notes', 'b', { title: 'x', n: 1, done: 1 }), 'bad_row');
    await store.putRow('owner-b', 'app', 'notes', 'a', { title: 'nope' });
    assert.equal((await store.getRow('owner-a', 'app', 'notes', 'a')).values.title, 'B');
    assert.equal((await store.getRow('owner-b', 'app', 'notes', 'a')).values.title, 'nope');
    await rejects(store.putRow('owner-b', 'app', 'items', 'a', {}), 'not_found');
    assert.equal((await store.getRow('owner-a', 'app', 'notes', 'missing')), null);

    // Byte order, not UTF-16 order: U+FFFE sorts before an emoji under utf8mb4_bin.
    const late = '\uFFFE';
    const emoji = '😀';
    assert.ok(emoji < late);
    assert.ok(cmpPk(late, emoji) < 0);
    await store.putRow('owner-a', 'app', 'notes', 'c', { title: 'C' });
    await store.putRow('owner-a', 'app', 'notes', 'b', { title: 'B2' });
    await store.putRow('owner-a', 'app', 'notes', emoji, { title: 'e' });
    await store.putRow('owner-a', 'app', 'notes', late, { title: 'late' });
    const page = await store.listRows('owner-a', 'app', 'notes', { limit: 2 });
    assert.deepEqual(page.rows.map((r) => r.pk), ['a', 'b']);
    assert.equal(page.next, 'b');
    const rest = await store.listRows('owner-a', 'app', 'notes', { limit: 10, after: 'b' });
    assert.deepEqual(rest.rows.map((r) => r.pk), ['c', late, emoji]);
    assert.equal(rest.next, null);
    await rejects(store.listRows('owner-a', 'app', 'notes', { limit: 0 }), 'bad_query');
    await rejects(store.listRows('owner-a', 'app', 'notes', { after: '' }), 'bad_query');

    await store.putRow('owner-a', 'app', 'items', 'a', {});
    assert.equal(await store.deleteRow('owner-a', 'app', 'notes', 'b'), true);
    assert.equal(await store.deleteRow('owner-a', 'app', 'notes', 'b'), false);
    assert.deepEqual(await store.deleteTable('owner-a', 'app', 'notes'), { deleted: 'notes' });
    assert.equal(await store.getTable('owner-a', 'app', 'notes'), null);
    await rejects(store.getRow('owner-a', 'app', 'notes', 'a'), 'not_found');
    assert.equal((await store.getRow('owner-a', 'app', 'items', 'a')).pk, 'a');
    assert.equal((await store.getDatabase('owner-a', 'app')).ddl_version, 4);
    assert.deepEqual(await store.deleteDatabase('owner-a', 'app'), { deleted: 'app' });
    assert.equal(await store.getDatabase('owner-a', 'app'), null);
    assert.equal((await store.getRow('owner-b', 'app', 'notes', 'a')).values.title, 'nope');
    if (mysql) {
      assert.equal(mysql.db.funx_udb.filter((r) => r.owner_id === 'owner-a' && r.name === 'app').length, 0);
      assert.equal(mysql.db.funx_udata.filter((r) => r.pk === 'a' && r.utbl_id !== undefined).every((r) => {
        const table = mysql.db.funx_utbl.find((t) => t.id === r.utbl_id);
        const db = mysql.db.funx_udb.find((d) => d.id === (table && table.udb_id));
        return db && db.owner_id === 'owner-b';
      }), true);
    }
  }
});

test('quotas apply to both stores', async () => {
  const built = [
    new MemoryDataStore({ limits: { dbsPerOwner: 1, tablesPerDb: 1, docBytes: 24 } }),
    new MysqlDataStore(fakeDataPool().pool, { limits: { dbsPerOwner: 1, tablesPerDb: 1, docBytes: 24 } }),
  ];
  for (const store of built) {
    await store.createDatabase({ ownerId: 'o', name: 'app' });
    await rejects(store.createDatabase({ ownerId: 'o', name: 'two' }), 'quota');
    await store.createTable('o', 'app', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] });
    await rejects(store.createTable('o', 'app', { name: 'more', columns: [{ name: 'id', type: 'string', primary: true }] }), 'quota');
    await rejects(store.putRow('o', 'app', 'notes', 'k', { title: 'x'.repeat(40) }), 'bad_row');
    assert.equal((await store.putRow('o', 'app', 'notes', 'k', { title: 'ok' })).created, true);
  }
});

test('a new node does not move databases already placed; unmounted nodes are not written', async () => {
  const store = new MemoryDataStore();
  const first = await store.createDatabase({ ownerId: 'sticky', name: 'one' });
  assert.equal(first.node_id, 0);
  store.mountNode({ id: 1, schemaName: 'funx_b' });
  assert.equal((await store.createDatabase({ ownerId: 'sticky', name: 'two' })).node_id, 0);
  const fresh = ownerFor(1, [0, 1]);
  assert.notEqual(fresh, 'sticky');
  const placed = await store.createDatabase({ ownerId: fresh, name: 'one' });
  assert.equal(placed.node_id, 1);
  await store.createTable(fresh, 'one', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] });
  await store.putRow(fresh, 'one', 'notes', 'k', { title: 'on-1' });
  assert.equal(store.nodes.get(0).rows.size, 0);
  assert.equal(store.nodes.get(1).rows.size, 1);
  await store.createTable('sticky', 'one', { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }] });
  await store.putRow('sticky', 'one', 'notes', 'k', {});
  assert.equal(store.nodes.get(0).rows.size, 1);
  assert.equal((await store.getRow(fresh, 'one', 'notes', 'k')).values.title, 'on-1');

  store.setNodeStatus(0, 'closed');
  assert.equal((await store.createDatabase({ ownerId: 'sticky', name: 'three' })).node_id, 0);
  assert.equal((await store.createDatabase({ ownerId: 'newbie', name: 'one' })).node_id, 1);
  store.setNodeStatus(1, 'closed');
  await rejects(store.createDatabase({ ownerId: 'brand-new', name: 'one' }), 'node_unmounted');
  assert.equal((await store.getRow('sticky', 'one', 'notes', 'k')).pk, 'k');
});

test('mysql rows follow node_id onto that pool, and a catalog row without a pool is refused', async () => {
  const catalog = fakeDataPool();
  const shard = fakeDataPool();
  const store = new MysqlDataStore(catalog.pool, { schemaName: 'funx', nodes: { 1: shard.pool } });
  await store.migrate();
  await store.migrate();
  assert.equal(catalog.db.funx_data_nodes.length, 1);
  assert.equal(catalog.db.funx_data_nodes[0].schema_name, 'funx');
  assert.deepEqual(DATA_MIGRATIONS.map((s) => s.includes('CREATE TABLE')).filter(Boolean).length, 4);

  const on0 = ownerFor(0, [0, 1]);
  await catalog.pool.query('INSERT INTO funx_data_nodes (id, schema_name, status) VALUES (?, ?, ?)', [1, 'funx_b', 'active']);
  const on1 = ownerFor(1, [0, 1]);
  assert.equal((await store.createDatabase({ ownerId: on0, name: 'app' })).node_id, 0);
  assert.equal((await store.createDatabase({ ownerId: on1, name: 'app' })).node_id, 1);
  assert.equal((await store.createDatabase({ ownerId: on0, name: 'extra' })).node_id, 0);
  const cols = { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] };
  await store.createTable(on0, 'app', cols);
  await store.createTable(on1, 'app', cols);
  await store.putRow(on0, 'app', 'notes', 'k', { title: 'zero' });
  await store.putRow(on1, 'app', 'notes', 'k', { title: 'one' });
  assert.deepEqual(catalog.db.funx_udata.map((r) => r.doc.title), ['zero']);
  assert.deepEqual(shard.db.funx_udata.map((r) => r.doc.title), ['one']);
  assert.equal((await store.getRow(on1, 'app', 'notes', 'k')).values.title, 'one');

  await catalog.pool.query('INSERT INTO funx_data_nodes (id, schema_name, status) VALUES (?, ?, ?)', [2, 'funx_c', 'active']);
  const on2 = ownerFor(2, [0, 1, 2]);
  await rejects(store.createDatabase({ ownerId: on2, name: 'app' }), 'node_unmounted');
  assert.equal(catalog.db.funx_udb.some((r) => r.owner_id === on2), false);

  catalog.failOn(/^INSERT INTO funx_udb/);
  await assert.rejects(store.createDatabase({ ownerId: 'rollback', name: 'app' }), /boom/);
  catalog.failOn(null);
  assert.equal(await store.getDatabase('rollback', 'app'), null);

  await store.deleteDatabase(on1, 'app');
  assert.equal(shard.db.funx_udata.length, 0);
  assert.equal(catalog.db.funx_udata.length, 1);
});

test('http: /v1/databases is owner-scoped; without a store it stays 404', async () => {
  const cfg = loadConfig({});
  const signer = createSigner(loadKeys(JSON.stringify([newKey()])));
  const tok = (sub, role = 'user') => signer.sign({ sub, email: `${sub}@funx.test`, role }).token;
  const f = fakeScf();
  const users = new MemoryUserStore();
  const base = { scf: f.scf, cfg, signer, userStore: users, download: f.download, workers: new MemoryWorkerStore({ secretsKey: Buffer.alloc(32) }) };

  const closed = createApi(base);
  const closedSrv = await listen(closed);
  const callClosed = (method, path, token) => fetch(`http://127.0.0.1:${closedSrv.port}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    assert.equal((await callClosed('GET', '/v1/databases', tok('u1'))).status, 404);
  } finally { await closedSrv.close(); }

  const data = new MemoryDataStore({ limits: { dbsPerOwner: 1 } });
  const api = createApi({ ...base, dataStore: data });
  const srv = await listen(api);
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    assert.equal((await call('GET', '/v1/databases')).status, 401);
    assert.equal((await call('GET', '/v1/workers', { token: tok('u1') })).json.workers.length, 0);
    const created = await call('POST', '/v1/databases', { token: tok('u1'), body: { name: 'app' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.node_id, 0);
    assert.equal(created.json.owner, 'u1');
    assert.equal((await call('POST', '/v1/databases', { token: tok('u1'), body: { name: 'other' } })).status, 409);
    assert.equal((await call('GET', '/v1/databases/app', { token: tok('u2') })).status, 404);
    assert.equal((await call('GET', '/v1/databases/app', { token: tok('admin', 'admin') })).status, 404);
    assert.equal((await call('GET', '/v1/databases', { token: tok('funx') })).status, 404);
    assert.equal((await call('DELETE', '/v1/databases/platform', { token: tok('funx') })).status, 404);
    assert.deepEqual((await call('GET', '/v1/databases', { token: tok('u2') })).json.databases, []);
    const table = await call('POST', '/v1/databases/app/tables', {
      token: tok('u1'),
      body: { name: 'notes', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'title', type: 'string' }] },
    });
    assert.equal(table.status, 201, JSON.stringify(table.json));
    const pk = 'a/b 100%';
    const put = await call('PUT', `/v1/databases/app/tables/notes/rows/${encodeURIComponent(pk)}`, { token: tok('u1'), body: { title: 'hi' } });
    assert.equal(put.status, 201);
    assert.equal(put.json.created, true);
    assert.equal(put.json.values.title, 'hi');
    assert.equal(put.json.values.id, pk);
    const got = await call('GET', `/v1/databases/app/tables/notes/rows/${encodeURIComponent(pk)}`, { token: tok('u1') });
    assert.equal(got.status, 200);
    assert.equal(got.json.values.title, 'hi');
    const replaced = await call('PUT', `/v1/databases/app/tables/notes/rows/${encodeURIComponent(pk)}`, { token: tok('u1'), body: { title: 'yo' } });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.created, false);
    const listed = await call('GET', '/v1/databases/app/tables/notes/rows?limit=10', { token: tok('u1') });
    assert.deepEqual(listed.json.rows.map((r) => r.pk), [pk]);
    assert.equal((await call('POST', `/v1/databases/app/tables/notes/rows/${encodeURIComponent(pk)}`, { token: tok('u1'), body: {} })).status, 405);
    assert.equal((await call('GET', '/v1/databases/app/settings', { token: tok('u1') })).status, 404);
    assert.equal((await call('DELETE', `/v1/databases/app/tables/notes/rows/${encodeURIComponent(pk)}`, { token: tok('u1') })).status, 200);
    assert.equal((await call('DELETE', '/v1/databases/app/tables/notes', { token: tok('u1') })).json.deleted, 'notes');
    assert.equal((await call('DELETE', '/v1/databases/app', { token: tok('u1') })).json.deleted, 'app');
    assert.equal((await call('GET', '/v1/databases/app', { token: tok('u1') })).status, 404);
  } finally { await srv.close(); }
});
