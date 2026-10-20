'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mysql = require('mysql2/promise');
const { loadConfig } = require('../cli/config');
const { createApi } = require('../api/app');
const { newKey, loadKeys, createSigner } = require('../api/jwt');
const { MemoryUserStore } = require('../api/users');
const { MemoryDataStore } = require('../api/data-store');
const { executeSql, newSession } = require('../api/mysql-sql');
const { rotateMysqlPassword } = require('../api/mysql-auth');
const { startMysqlGateway } = require('../api/mysql-gateway');
const { fakeScf, listen } = require('./helpers');

function session(ownerId, username) {
  return newSession({ ownerId, username: username || ownerId });
}

async function sql(store, ownerId, text, database) {
  const s = session(ownerId);
  if (database) s.database = database;
  return executeSql(store, s, text);
}

test('sql: create, read, update, delete, and the session transaction', async () => {
  const store = new MemoryDataStore();
  const s = session('u1');
  assert.equal((await executeSql(store, s, 'CREATE DATABASE app'))[0].kind, 'ok');
  await executeSql(store, s, 'USE app');
  assert.equal(s.database, 'app');
  await executeSql(store, s, 'CREATE TABLE notes (id VARCHAR(64) PRIMARY KEY, title VARCHAR(255), n INT, done BOOL, meta JSON)');
  await executeSql(store, s, "INSERT INTO notes (id, title, n, done, meta) VALUES ('a', 'hi', 2, true, '{\"x\":1}')");
  const rows = await executeSql(store, s, 'SELECT id, title, n, done, meta FROM notes WHERE title = \'hi\'');
  assert.deepEqual(rows[0].rows, [['a', 'hi', 2, 1, '{"x":1}']]);
  await executeSql(store, s, "UPDATE notes SET title = 'yo' WHERE id = 'a'");
  await executeSql(store, s, 'BEGIN');
  await executeSql(store, s, "INSERT INTO notes (id, title) VALUES ('b', 'no')");
  await executeSql(store, s, 'ROLLBACK');
  const left = await executeSql(store, s, 'SELECT id FROM notes ORDER BY id');
  assert.deepEqual(left[0].rows, [['a']]);
  await executeSql(store, s, "DELETE FROM notes WHERE id = 'a'");
  assert.deepEqual((await executeSql(store, s, 'SELECT id FROM notes'))[0].rows, []);
  await executeSql(store, s, 'CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(64), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const ins = await executeSql(store, s, "INSERT INTO users (email, name) VALUES ('a@b.c', 'ada')");
  assert.equal(ins[0].insertId, 1);
  await executeSql(store, s, 'CREATE TABLE posts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, title VARCHAR(255), body TEXT)');
  await executeSql(store, s, "INSERT INTO posts (user_id, title) VALUES (1, 'hi')");
  const joined = await executeSql(store, s, "SELECT u.email, p.title FROM users u JOIN posts p ON u.id = p.user_id WHERE u.email = 'a@b.c' OR u.name = 'nope'");
  assert.deepEqual(joined[0].rows, [['a@b.c', 'hi']]);
  assert.deepEqual((await executeSql(store, s, 'SELECT COUNT(*) AS n FROM posts'))[0].rows, [[1]]);
  await executeSql(store, s, "INSERT INTO notes (id, title) VALUES ('wide', '" + 'x'.repeat(40000) + "')");
  assert.equal((await executeSql(store, s, "SELECT id FROM notes WHERE id = 'wide'"))[0].rows.length, 1);
  await assert.rejects(sql(store, 'u1', "INSERT INTO notes (id, title) VALUES ('huge', '" + 'x'.repeat(4 * 1024 * 1024) + "')", 'app'), (e) => e.errno === 1406);
  const other = await executeSql(store, session('u2'), 'SHOW DATABASES');
  assert.deepEqual(other[0].rows.map((r) => r[0]).filter((n) => n !== 'information_schema'), []);
  await assert.rejects(executeSql(store, session('u2'), 'USE app'), (e) => e.errno === 1049);
});

function clientOpts(port, user, password, extra = {}) {
  return {
    host: '127.0.0.1', port, user, password, ssl: false,
    enableKeepAlive: false, connectTimeout: 3000, ...extra,
  };
}

test('mysql protocol: a client connects with host, port, user and password', async () => {
  const store = new MemoryDataStore();
  const gw = await startMysqlGateway({ dataStore: store, port: 0 });
  const a = await rotateMysqlPassword(store, 'u1');
  const b = await rotateMysqlPassword(store, 'u2');
  let conn;
  let other;
  await assert.rejects(
    mysql.createConnection(clientOpts(gw.port, a.user, 'wrong-password')),
    (e) => e.errno === 1045,
  );
  await assert.rejects(
    mysql.createConnection(clientOpts(gw.port, a.user, a.password, { database: 'missing' })),
    (e) => e.errno === 1049,
  );
  conn = await mysql.createConnection(clientOpts(gw.port, a.user, a.password));
  try {
    const [version] = await conn.query('SELECT @@version_comment AS v, DATABASE() AS db, USER() AS u');
    assert.equal(version[0].v, 'Funx');
    assert.equal(version[0].db, null);
    assert.equal(version[0].u, 'u1@%');
    await conn.query('SET NAMES utf8mb4');
    await conn.query('CREATE DATABASE app');
    await conn.query('USE app');
    await conn.query('CREATE TABLE notes (id VARCHAR(64) NOT NULL PRIMARY KEY, title VARCHAR(255), n INT, done BOOL, meta JSON)');
    await conn.query("INSERT INTO notes (id, title, n, done, meta) VALUES ('a', 'hi', 2, 1, ?)", ['{"x":1}']);
    const [got] = await conn.query('SELECT title, n, done, meta FROM notes WHERE id = ?', ['a']);
    assert.equal(got[0].title, 'hi');
    assert.equal(got[0].n, 2);
    assert.equal(got[0].done, 1);
    assert.deepEqual(got[0].meta, { x: 1 });
    const [tables] = await conn.query('SHOW TABLES');
    assert.deepEqual(tables.map((r) => Object.values(r)[0]), ['notes']);
    const [cols] = await conn.query("SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = 'app' AND TABLE_NAME = 'notes' ORDER BY ORDINAL_POSITION");
    assert.deepEqual(cols.map((r) => r.COLUMN_NAME), ['id', 'title', 'n', 'done', 'meta']);
    await conn.query('BEGIN');
    await conn.query("INSERT INTO notes (id, title) VALUES ('b', 'later')");
    const [mid] = await conn.query('SELECT id FROM notes ORDER BY id');
    assert.deepEqual(mid.map((r) => r.id), ['a', 'b']);
    await conn.query('ROLLBACK');
    const [after] = await conn.query('SELECT id FROM notes');
    assert.deepEqual(after.map((r) => r.id), ['a']);
    await assert.rejects(conn.query("INSERT INTO notes (id, title) VALUES ('a', 'dup')"), (e) => e.errno === 1062);
    await conn.query('CREATE TABLE seq (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(32), PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    const [made] = await conn.execute('INSERT INTO seq (name) VALUES (?)', ['a']);
    assert.equal(made.insertId, 1);
    const [gotId] = await conn.execute('SELECT id, name FROM seq WHERE id = ?', [1]);
    assert.equal(gotId[0].id, 1);
    assert.equal(gotId[0].name, 'a');
    const [still] = await conn.query('SELECT 1 AS n');
    assert.equal(still[0].n, 1);
    const row = await store.getRow('u1', 'app', 'notes', 'a');
    assert.equal(row.values.title, 'hi');
    other = await mysql.createConnection(clientOpts(gw.port, b.user, b.password));
    const [dbs] = await other.query('SHOW DATABASES');
    assert.ok(!dbs.some((r) => r.Database === 'app'));
    await assert.rejects(other.query('USE app'), (e) => e.errno === 1049);
  } finally {
    if (conn) await conn.end();
    if (other) await other.end();
    await gw.close();
  }
});

test('mysql protocol: multiple statements return multiple results', async () => {
  const store = new MemoryDataStore();
  const gw = await startMysqlGateway({ dataStore: store, port: 0 });
  const account = await rotateMysqlPassword(store, 'u1');
  const conn = await mysql.createConnection(clientOpts(gw.port, account.user, account.password, { multipleStatements: true }));
  try {
    await conn.query('CREATE DATABASE app');
    await conn.query('USE app');
    await conn.query('CREATE TABLE notes (id VARCHAR(32) PRIMARY KEY, title VARCHAR(32))');
    const [sets] = await conn.query("INSERT INTO notes (id, title) VALUES ('a', 'one'); SELECT title FROM notes");
    assert.equal(sets[0].affectedRows, 1);
    assert.equal(sets[1][0].title, 'one');
  } finally {
    await conn.end();
    await gw.close();
  }
});

test('http: /v1/mysql returns a connection string and the password only on reset', async () => {
  const cfg = loadConfig({});
  const signer = createSigner(loadKeys(JSON.stringify([newKey()])));
  const tok = (sub) => signer.sign({ sub, email: `${sub}@funx.test`, role: 'user' }).token;
  const f = fakeScf();
  const users = new MemoryUserStore();
  const data = new MemoryDataStore();
  const gw = await startMysqlGateway({ dataStore: data, port: 0 });
  const base = { scf: f.scf, cfg, signer, userStore: users, download: f.download, dataStore: data };
  const closed = createApi(base);
  const closedSrv = await listen(closed);
  const api = createApi({ ...base, mysql: { host: '127.0.0.1', port: gw.port } });
  const srv = await listen(api);
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  let conn;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${closedSrv.port}/v1/mysql`, { headers: { authorization: `Bearer ${tok('u1')}` } })).status, 404);
    assert.equal((await call('GET', '/v1/mysql', { token: tok('funx') })).status, 404);
    assert.equal((await call('POST', '/v1/mysql', { token: tok('funx'), body: {} })).status, 404);
    const view = await call('GET', '/v1/mysql', { token: tok('u1') });
    assert.equal(view.status, 200);
    assert.equal(view.json.password_set, false);
    assert.equal(view.json.password, undefined);
    assert.equal(view.json.user, 'u1');
    assert.equal(view.json.uri, `mysql://u1@127.0.0.1:${gw.port}/`);
    const reset = await call('POST', '/v1/mysql', { token: tok('u1'), body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.password_set, true);
    assert.equal(typeof reset.json.password, 'string');
    assert.ok(reset.json.uri.includes(encodeURIComponent(reset.json.password)));
    const again = await call('GET', '/v1/mysql', { token: tok('u1') });
    assert.equal(again.json.password, undefined);
    assert.equal(again.json.password_set, true);
    conn = await mysql.createConnection(clientOpts(gw.port, reset.json.user, reset.json.password));
    await conn.query('CREATE DATABASE app');
    await conn.query('USE app');
    await conn.query('CREATE TABLE notes (id VARCHAR(32) PRIMARY KEY, title VARCHAR(64))');
    await conn.query("INSERT INTO notes (id, title) VALUES ('a', 'from-mysql')");
    const listed = await call('GET', '/v1/databases', { token: tok('u1') });
    assert.deepEqual(listed.json.databases.map((d) => d.name), ['app']);
    const httpRow = await call('GET', '/v1/databases/app/tables/notes/rows/a', { token: tok('u1') });
    assert.equal(httpRow.json.values.title, 'from-mysql');
  } finally {
    if (conn) await conn.end();
    await srv.close();
    await closedSrv.close();
    await gw.close();
  }
});

test('mysql protocol: an application changes only host, port, user and password', async () => {
  const store = new MemoryDataStore();
  const gw = await startMysqlGateway({ dataStore: store, port: 0 });
  const account = await rotateMysqlPassword(store, 'shop');
  let conn;
  try {
    conn = await mysql.createConnection(clientOpts(gw.port, account.user, account.password, {
      ssl: { rejectUnauthorized: false },
      dateStrings: true,
    }));
    await conn.query('CREATE DATABASE shop');
    await conn.query('USE shop');
    await conn.query(`CREATE TABLE users (
      id INT NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query(`CREATE TABLE posts (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NULL,
      title VARCHAR(255) NULL,
      body TEXT NULL,
      PRIMARY KEY (id),
      KEY user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [ada] = await conn.execute('INSERT INTO users (email, name) VALUES (?, ?)', ['ada@funx.test', 'Ada']);
    const [grace] = await conn.execute('INSERT INTO users (email, name) VALUES (?, ?)', ['grace@funx.test', 'Grace']);
    assert.equal(ada.insertId, 1);
    assert.equal(grace.insertId, 2);
    await conn.execute('INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)', [ada.insertId, 'hello', 'first']);
    await conn.execute('INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)', [ada.insertId, 'next', null]);
    const [joined] = await conn.execute(
      'SELECT u.email, p.title FROM users u INNER JOIN posts p ON u.id = p.user_id WHERE u.email = ? OR u.name = ? ORDER BY p.id',
      ['ada@funx.test', 'nobody'],
    );
    assert.deepEqual(joined.map((r) => [r.email, r.title]), [['ada@funx.test', 'hello'], ['ada@funx.test', 'next']]);
    const [counted] = await conn.query('SELECT user_id, COUNT(*) AS n FROM posts GROUP BY user_id');
    assert.equal(Number(counted[0].n), 2);
    const [dup] = await conn.query("INSERT INTO users (email, name) VALUES ('ada@funx.test', 'Ada') ON DUPLICATE KEY UPDATE name = 'Ada Lovelace'");
    assert.equal(dup.affectedRows, 2);
    const [named] = await conn.query("SELECT name FROM users WHERE email = 'ada@funx.test'");
    assert.equal(named[0].name, 'Ada Lovelace');
    const [idx] = await conn.query('SHOW INDEX FROM users');
    assert.ok(idx.some((r) => r.Key_name === 'email' && r.Column_name === 'email'));
    const row = await store.getRow('shop', 'shop', 'users', '1');
    assert.equal(row.values.email, 'ada@funx.test');
    assert.equal(row.pk, '1');
    const [bumped] = await conn.query('UPDATE posts SET title = CONCAT(title, ?) WHERE id = 1', ['!']);
    assert.equal(bumped.affectedRows, 1);
    const [title] = await conn.query('SELECT title FROM posts WHERE id = 1');
    assert.equal(title[0].title, 'hello!');
  } finally {
    if (conn) await conn.end();
    await gw.close();
  }
});
