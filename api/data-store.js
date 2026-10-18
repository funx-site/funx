'use strict';
// Logical databases for Funx accounts.
//
// One physical service, a fixed set of MySQL databases. Creating a database does not CREATE DATABASE
// and does not add a machine: it inserts a catalog row. Every user row from every logical table lives
// in one InnoDB table, funx_udata, clustered on (udb_id, utbl_id, pk). A point read is a primary-key
// lookup. A list is a range on that prefix.
//
// funx_udb.node_id is the extension point. It names which physical database holds that logical
// database's rows and it is not rewritten when a new node is added. Node 0 is the database funx-api
// already uses. A later node is another pool mounted in this process plus a row in funx_data_nodes.
// Owners who already have a database stay on their first node. New owners are hashed onto the nodes
// whose status is 'active'.

const crypto = require('crypto');

const LIMITS = Object.freeze({
  dbsPerOwner: 32,
  tablesPerDb: 64,
  columnsPerTable: 32,
  docBytes: 32 * 1024,
  list: 100,
  pkChars: 255,
});

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;
const TYPES = new Set(['string', 'int', 'bool', 'json']);
const SCHEMA = /^[A-Za-z0-9_]{1,64}$/;

const UDATA_SQL = `CREATE TABLE IF NOT EXISTS funx_udata (
  udb_id BIGINT UNSIGNED NOT NULL,
  utbl_id BIGINT UNSIGNED NOT NULL,
  pk VARCHAR(255) NOT NULL,
  doc JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (udb_id, utbl_id, pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

const DATA_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS funx_data_nodes (
     id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
     schema_name VARCHAR(64) NOT NULL,
     status VARCHAR(16) NOT NULL,
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS funx_udb (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     owner_id VARCHAR(64) NOT NULL,
     name VARCHAR(64) NOT NULL,
     node_id TINYINT UNSIGNED NOT NULL,
     ddl_version INT UNSIGNED NOT NULL DEFAULT 1,
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_funx_udb_owner_name (owner_id, name),
     KEY ix_funx_udb_owner (owner_id),
     KEY ix_funx_udb_node (node_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS funx_utbl (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     udb_id BIGINT UNSIGNED NOT NULL,
     name VARCHAR(64) NOT NULL,
     columns_json JSON NOT NULL,
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_funx_utbl_udb_name (udb_id, name),
     KEY ix_funx_utbl_udb (udb_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  UDATA_SQL,
];

function dataError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function iso(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

function limitsOf(extra) {
  const limits = { ...LIMITS, ...extra };
  for (const k of Object.keys(LIMITS)) {
    if (!Number.isInteger(limits[k]) || limits[k] < 1) throw new Error(`bad data limit ${k}`);
  }
  return limits;
}

function checkOwner(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 64 || ownerId.includes('\0')) {
    throw dataError('bad_name', 'owner id must be a string of 1-64 chars');
  }
}

function checkIdent(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw dataError('bad_name', `${what} must be 1-64 chars of a-z, 0-9 or _, starting with a letter`);
  }
}

function checkNodeId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0 || n > 255) throw dataError('node_unmounted', `bad data node id ${id}`);
  return n;
}

function checkSchema(schemaName) {
  if (typeof schemaName !== 'string' || !SCHEMA.test(schemaName)) throw new Error('schemaName must be 1-64 chars of letters, digits or _');
  return schemaName;
}

// Stable placement for an owner who has no database yet. activeIds is the node set at creation time.
function placeNode(ownerId, activeIds) {
  const ids = [...new Set(activeIds.map(checkNodeId))].sort((a, b) => a - b);
  if (!ids.length) throw dataError('node_unmounted', 'no data node is active');
  const n = crypto.createHash('sha256').update(String(ownerId)).digest().readUInt32BE(0);
  return ids[n % ids.length];
}

function chooseNode(ownerId, stickyNodeId, activeIds) {
  if (stickyNodeId != null) return checkNodeId(stickyNodeId);
  return placeNode(ownerId, activeIds);
}

function cmpPk(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function pkFromUrl(raw, code = 'bad_row') {
  if (typeof raw !== 'string' || raw.length === 0) throw dataError(code, 'primary key must be a non-empty string');
  if ([...raw].length > LIMITS.pkChars) throw dataError(code, 'primary key is too long');
  return raw;
}

function clampLimit(limit, max) {
  if (limit == null || limit === '') return Math.min(50, max);
  const n = typeof limit === 'number' ? limit : (/^[1-9]\d*$/.test(limit) ? Number(limit) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > max) throw dataError('bad_query', `limit must be an integer from 1 to ${max}`);
  return n;
}

function normalizeColumns(columns, limits) {
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > limits.columnsPerTable) {
    throw dataError('bad_schema', `a table needs 1 to ${limits.columnsPerTable} columns`);
  }
  const seen = new Set();
  let pk = 0;
  const out = columns.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw dataError('bad_schema', 'column must be an object');
    const extra = Object.keys(c).filter((k) => k !== 'name' && k !== 'type' && k !== 'primary');
    if (extra.length) throw dataError('bad_schema', `unsupported column property ${extra[0]}`);
    if (typeof c.name !== 'string' || !IDENT.test(c.name)) throw dataError('bad_schema', 'column name must be 1-64 chars of a-z, 0-9 or _, starting with a letter');
    if (seen.has(c.name)) throw dataError('bad_schema', `duplicate column ${c.name}`);
    seen.add(c.name);
    if (!TYPES.has(c.type)) throw dataError('bad_schema', `column ${c.name}: type must be string, int, bool or json`);
    if (c.primary != null && c.primary !== true && c.primary !== false) throw dataError('bad_schema', 'primary must be true or false');
    if (c.primary === true) {
      pk += 1;
      if (c.type !== 'string') throw dataError('bad_schema', 'the primary column must be type string');
    }
    return { name: c.name, type: c.type, primary: c.primary === true };
  });
  if (pk !== 1) throw dataError('bad_schema', 'a table needs exactly one primary column');
  return out;
}

function checkValue(col, v) {
  if (v === null) return null;
  if (col.type === 'string') {
    if (typeof v !== 'string') throw dataError('bad_row', `${col.name} must be a string`);
    return v;
  }
  if (col.type === 'int') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw dataError('bad_row', `${col.name} must be an integer`);
    return v;
  }
  if (col.type === 'bool') {
    if (typeof v !== 'boolean') throw dataError('bad_row', `${col.name} must be true or false`);
    return v;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw dataError('bad_row', `${col.name} must be JSON`);
  if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' || v === undefined) {
    throw dataError('bad_row', `${col.name} must be JSON`);
  }
  let s;
  try { s = JSON.stringify(v); } catch { throw dataError('bad_row', `${col.name} must be JSON`); }
  if (typeof s !== 'string') throw dataError('bad_row', `${col.name} must be JSON`);
  return JSON.parse(s);
}

// pk is the URL segment. The primary column may be repeated in values; it must match.
function encodeRow(columns, pkRaw, values, limits) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw dataError('bad_row', 'row must be an object');
  const pkCol = columns.find((c) => c.primary);
  const pk = pkFromUrl(pkRaw);
  if (Object.prototype.hasOwnProperty.call(values, pkCol.name) && values[pkCol.name] !== pk) {
    throw dataError('bad_row', 'primary key does not match the URL');
  }
  const known = new Set(columns.map((c) => c.name));
  for (const k of Object.keys(values)) if (!known.has(k)) throw dataError('bad_row', `unknown column ${k}`);
  const doc = {};
  for (const c of columns) {
    if (c.primary) continue;
    const present = Object.prototype.hasOwnProperty.call(values, c.name);
    doc[c.name] = checkValue(c, present ? values[c.name] : null);
  }
  if (Buffer.byteLength(JSON.stringify(doc)) > limits.docBytes) throw dataError('bad_row', 'row is too large');
  return { pk, doc };
}

function columnsOf(raw) {
  const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(c)) throw dataError('bad_schema', 'stored columns are unreadable');
  return c;
}

function decodeRow(columns, pk, doc, updatedAt) {
  const body = JSON.parse(typeof doc === 'string' ? doc : JSON.stringify(doc));
  const values = {};
  for (const c of columns) values[c.name] = c.primary ? pk : (body && body[c.name] !== undefined ? body[c.name] : null);
  return { pk, values, updated_at: iso(updatedAt) };
}

function publicDb(row) {
  return {
    name: row.name,
    owner: row.owner_id,
    node_id: Number(row.node_id),
    ddl_version: Number(row.ddl_version),
    created_at: iso(row.created_at),
  };
}

function publicTable(row) {
  return { name: row.name, columns: columnsOf(row.columns_json).map((c) => ({ name: c.name, type: c.type, primary: c.primary === true })), created_at: iso(row.created_at) };
}

function pageRows(sorted, limit) {
  const more = sorted.length > limit;
  const rows = more ? sorted.slice(0, limit) : sorted;
  return { rows, next: more ? rows[rows.length - 1].pk : null };
}

class MemoryDataStore {
  constructor({ nodes, limits, schemaName = 'funx' } = {}) {
    this.limits = limitsOf(limits);
    this.nodes = new Map();
    this.dbs = new Map();
    this.tables = new Map();
    this.nextDb = 1;
    this.nextTable = 1;
    const initial = nodes || [{ id: 0, schemaName, status: 'active' }];
    for (const n of initial) this.mountNode(n);
  }

  async migrate() {}

  // Attaches a physical database. Same idea as inserting funx_data_nodes and mounting a pool.
  mountNode({ id, schemaName = 'funx', status = 'active' } = {}) {
    const n = checkNodeId(id);
    if (this.nodes.has(n)) throw dataError('exists', `data node ${n} is already mounted`);
    if (status !== 'active' && status !== 'closed') throw dataError('bad_name', 'status must be active or closed');
    checkSchema(schemaName);
    this.nodes.set(n, { id: n, schemaName, status, rows: new Map() });
  }

  setNodeStatus(id, status) {
    const n = this._node(id);
    if (status !== 'active' && status !== 'closed') throw dataError('bad_name', 'status must be active or closed');
    n.status = status;
  }

  _node(id) {
    const n = this.nodes.get(checkNodeId(id));
    if (!n) throw dataError('node_unmounted', `data node ${id} is not mounted`);
    return n;
  }

  _activeIds() {
    return [...this.nodes.values()].filter((n) => n.status === 'active').map((n) => n.id);
  }

  _owned(ownerId) {
    return [...this.dbs.values()].filter((d) => d.owner_id === ownerId).sort((a, b) => a.id - b.id);
  }

  _db(ownerId, name) {
    return this._owned(ownerId).find((d) => d.name === name) || null;
  }

  _requireDb(ownerId, name) {
    checkOwner(ownerId);
    checkIdent(name, 'database name');
    const db = this._db(ownerId, name);
    if (!db) throw dataError('not_found', `no database named ${name}`);
    return db;
  }

  _table(db, name) {
    return [...this.tables.values()].find((t) => t.udb_id === db.id && t.name === name) || null;
  }

  _requireTable(ownerId, dbName, tableName) {
    const db = this._requireDb(ownerId, dbName);
    checkIdent(tableName, 'table name');
    const table = this._table(db, tableName);
    if (!table) throw dataError('not_found', `no table named ${tableName}`);
    return { db, table };
  }

  _bucket(nodeId, udbId, utblId, create) {
    const node = this._node(nodeId);
    let byDb = node.rows.get(udbId);
    if (!byDb && create) node.rows.set(udbId, byDb = new Map());
    if (!byDb) return null;
    let byTable = byDb.get(utblId);
    if (!byTable && create) byDb.set(utblId, byTable = new Map());
    return byTable || null;
  }

  async listDatabases(ownerId) {
    checkOwner(ownerId);
    return this._owned(ownerId).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(publicDb);
  }

  async createDatabase({ ownerId, name }) {
    checkOwner(ownerId);
    checkIdent(name, 'database name');
    if (this._db(ownerId, name)) throw dataError('exists', `database ${name} already exists`);
    const owned = this._owned(ownerId);
    if (owned.length >= this.limits.dbsPerOwner) throw dataError('quota', `database limit reached (${this.limits.dbsPerOwner})`);
    const nodeId = chooseNode(ownerId, owned.length ? owned[0].node_id : null, this._activeIds());
    this._node(nodeId);
    const row = { id: this.nextDb++, owner_id: ownerId, name, node_id: nodeId, ddl_version: 1, created_at: new Date() };
    this.dbs.set(row.id, row);
    return publicDb(row);
  }

  async getDatabase(ownerId, name) {
    checkOwner(ownerId);
    checkIdent(name, 'database name');
    const db = this._db(ownerId, name);
    return db ? publicDb(db) : null;
  }

  async deleteDatabase(ownerId, name) {
    const db = this._requireDb(ownerId, name);
    const node = this._node(db.node_id);
    node.rows.delete(db.id);
    for (const [id, t] of this.tables) if (t.udb_id === db.id) this.tables.delete(id);
    this.dbs.delete(db.id);
    return { deleted: name };
  }

  async listTables(ownerId, dbName) {
    const db = this._requireDb(ownerId, dbName);
    return [...this.tables.values()].filter((t) => t.udb_id === db.id).sort((a, b) => (a.name < b.name ? -1 : 1)).map(publicTable);
  }

  async createTable(ownerId, dbName, spec) {
    const db = this._requireDb(ownerId, dbName);
    checkIdent(spec && spec.name, 'table name');
    if (this._table(db, spec.name)) throw dataError('exists', `table ${spec.name} already exists`);
    const n = [...this.tables.values()].filter((t) => t.udb_id === db.id).length;
    if (n >= this.limits.tablesPerDb) throw dataError('quota', `table limit reached (${this.limits.tablesPerDb})`);
    const columns = normalizeColumns(spec.columns, this.limits);
    const row = { id: this.nextTable++, udb_id: db.id, name: spec.name, columns_json: columns, created_at: new Date() };
    this.tables.set(row.id, row);
    db.ddl_version += 1;
    return publicTable(row);
  }

  async getTable(ownerId, dbName, tableName) {
    const db = this._requireDb(ownerId, dbName);
    checkIdent(tableName, 'table name');
    const table = this._table(db, tableName);
    return table ? publicTable(table) : null;
  }

  async deleteTable(ownerId, dbName, tableName) {
    const { db, table } = this._requireTable(ownerId, dbName, tableName);
    const byDb = this._node(db.node_id).rows.get(db.id);
    if (byDb) byDb.delete(table.id);
    this.tables.delete(table.id);
    db.ddl_version += 1;
    return { deleted: tableName };
  }

  async getRow(ownerId, dbName, tableName, pkRaw) {
    const { db, table } = this._requireTable(ownerId, dbName, tableName);
    const pk = pkFromUrl(pkRaw);
    const bucket = this._bucket(db.node_id, db.id, table.id, false);
    const hit = bucket && bucket.get(pk);
    return hit ? decodeRow(columnsOf(table.columns_json), pk, hit.doc, hit.updated_at) : null;
  }

  async putRow(ownerId, dbName, tableName, pkRaw, values) {
    const { db, table } = this._requireTable(ownerId, dbName, tableName);
    const columns = columnsOf(table.columns_json);
    const { pk, doc } = encodeRow(columns, pkRaw, values, this.limits);
    const bucket = this._bucket(db.node_id, db.id, table.id, true);
    const created = !bucket.has(pk);
    const updated_at = new Date();
    bucket.set(pk, { doc, updated_at });
    return { created, row: decodeRow(columns, pk, doc, updated_at) };
  }

  async deleteRow(ownerId, dbName, tableName, pkRaw) {
    const { db, table } = this._requireTable(ownerId, dbName, tableName);
    const pk = pkFromUrl(pkRaw);
    const bucket = this._bucket(db.node_id, db.id, table.id, false);
    if (!bucket || !bucket.delete(pk)) return false;
    return true;
  }

  async listRows(ownerId, dbName, tableName, { limit, after } = {}) {
    const { db, table } = this._requireTable(ownerId, dbName, tableName);
    const n = clampLimit(limit, this.limits.list);
    const cursor = after == null ? null : pkFromUrl(after, 'bad_query');
    const bucket = this._bucket(db.node_id, db.id, table.id, false);
    const keys = bucket ? [...bucket.keys()] : [];
    keys.sort(cmpPk);
    const picked = [];
    for (const pk of keys) {
      if (cursor != null && cmpPk(pk, cursor) <= 0) continue;
      const hit = bucket.get(pk);
      picked.push(decodeRow(columnsOf(table.columns_json), pk, hit.doc, hit.updated_at));
      if (picked.length > n) break;
    }
    return pageRows(picked, n);
  }
}

class MysqlDataStore {
  constructor(catalog, { schemaName = 'funx', nodes = {}, limits } = {}) {
    if (!catalog || typeof catalog.query !== 'function') throw new Error('catalog pool is required');
    this.catalog = catalog;
    this.schemaName = checkSchema(schemaName);
    this.limits = limitsOf(limits);
    this.pools = new Map([[0, catalog]]);
    for (const [id, pool] of Object.entries(nodes)) {
      const n = checkNodeId(id);
      if (!pool || typeof pool.query !== 'function') throw new Error(`data node ${id} has no pool`);
      this.pools.set(n, pool);
    }
    this.ready = null;
  }

  migrate() {
    if (!this.ready) {
      this.ready = this._migrate().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async _migrate() {
    for (const sql of DATA_MIGRATIONS) await this.catalog.query(sql);
    await this.catalog.query('INSERT IGNORE INTO funx_data_nodes (id, schema_name, status) VALUES (?, ?, ?)', [0, this.schemaName, 'active']);
    const seen = new Set([this.catalog]);
    for (const pool of this.pools.values()) {
      if (seen.has(pool)) continue;
      seen.add(pool);
      await pool.query(UDATA_SQL);
    }
  }

  _pool(nodeId) {
    const pool = this.pools.get(checkNodeId(nodeId));
    if (!pool) throw dataError('node_unmounted', `data node ${nodeId} is not mounted`);
    return pool;
  }

  async q(pool, sql, params) {
    await this.migrate();
    const [rows] = await pool.query(sql, params);
    return rows;
  }

  async _loadDb(ownerId, name) {
    checkOwner(ownerId);
    checkIdent(name, 'database name');
    const rows = await this.q(this.catalog, 'SELECT id, owner_id, name, node_id, ddl_version, created_at FROM funx_udb WHERE owner_id = ? AND name = ?', [ownerId, name]);
    return rows[0] || null;
  }

  async _requireDb(ownerId, name) {
    const db = await this._loadDb(ownerId, name);
    if (!db) throw dataError('not_found', `no database named ${name}`);
    return db;
  }

  async _loadTable(db, tableName) {
    checkIdent(tableName, 'table name');
    const rows = await this.q(this.catalog, 'SELECT id, udb_id, name, columns_json, created_at FROM funx_utbl WHERE udb_id = ? AND name = ?', [db.id, tableName]);
    return rows[0] || null;
  }

  async _requireTable(ownerId, dbName, tableName) {
    const db = await this._requireDb(ownerId, dbName);
    const table = await this._loadTable(db, tableName);
    if (!table) throw dataError('not_found', `no table named ${tableName}`);
    return { db, table };
  }

  async listDatabases(ownerId) {
    checkOwner(ownerId);
    const rows = await this.q(this.catalog, 'SELECT id, owner_id, name, node_id, ddl_version, created_at FROM funx_udb WHERE owner_id = ? ORDER BY name', [ownerId]);
    return rows.map(publicDb);
  }

  async createDatabase({ ownerId, name }) {
    checkOwner(ownerId);
    checkIdent(name, 'database name');
    await this.migrate();
    const c = await this.catalog.getConnection();
    try {
      await c.beginTransaction();
      const [dup] = await c.query('SELECT id FROM funx_udb WHERE owner_id = ? AND name = ? FOR UPDATE', [ownerId, name]);
      if (dup.length) throw dataError('exists', `database ${name} already exists`);
      const [count] = await c.query('SELECT COUNT(*) AS n FROM funx_udb WHERE owner_id = ?', [ownerId]);
      if (Number(count[0].n) >= this.limits.dbsPerOwner) throw dataError('quota', `database limit reached (${this.limits.dbsPerOwner})`);
      const [sticky] = await c.query('SELECT node_id FROM funx_udb WHERE owner_id = ? ORDER BY id LIMIT 1', [ownerId]);
      const [active] = await c.query("SELECT id FROM funx_data_nodes WHERE status = 'active' ORDER BY id");
      const nodeId = chooseNode(ownerId, sticky.length ? Number(sticky[0].node_id) : null, active.map((r) => Number(r.id)));
      this._pool(nodeId);
      await c.query('INSERT INTO funx_udb (owner_id, name, node_id) VALUES (?, ?, ?)', [ownerId, name, nodeId]);
      await c.commit();
    } catch (e) {
      await c.rollback().catch(() => {});
      if (e && e.code === 'ER_DUP_ENTRY') throw dataError('exists', `database ${name} already exists`);
      throw e;
    } finally { c.release(); }
    return this.getDatabase(ownerId, name);
  }

  async getDatabase(ownerId, name) {
    const db = await this._loadDb(ownerId, name);
    return db ? publicDb(db) : null;
  }

  async deleteDatabase(ownerId, name) {
    const db = await this._requireDb(ownerId, name);
    await this.q(this._pool(db.node_id), 'DELETE FROM funx_udata WHERE udb_id = ?', [db.id]);
    await this.q(this.catalog, 'DELETE FROM funx_utbl WHERE udb_id = ?', [db.id]);
    await this.q(this.catalog, 'DELETE FROM funx_udb WHERE id = ?', [db.id]);
    return { deleted: name };
  }

  async listTables(ownerId, dbName) {
    const db = await this._requireDb(ownerId, dbName);
    const rows = await this.q(this.catalog, 'SELECT id, udb_id, name, columns_json, created_at FROM funx_utbl WHERE udb_id = ? ORDER BY name', [db.id]);
    return rows.map(publicTable);
  }

  async createTable(ownerId, dbName, spec) {
    const db = await this._requireDb(ownerId, dbName);
    checkIdent(spec && spec.name, 'table name');
    if (await this._loadTable(db, spec.name)) throw dataError('exists', `table ${spec.name} already exists`);
    const count = await this.q(this.catalog, 'SELECT COUNT(*) AS n FROM funx_utbl WHERE udb_id = ?', [db.id]);
    if (Number(count[0].n) >= this.limits.tablesPerDb) throw dataError('quota', `table limit reached (${this.limits.tablesPerDb})`);
    const columns = normalizeColumns(spec.columns, this.limits);
    await this.migrate();
    const c = await this.catalog.getConnection();
    try {
      await c.beginTransaction();
      await c.query('INSERT INTO funx_utbl (udb_id, name, columns_json) VALUES (?, ?, ?)', [db.id, spec.name, columns]);
      await c.query('UPDATE funx_udb SET ddl_version = ddl_version + 1 WHERE id = ?', [db.id]);
      await c.commit();
    } catch (e) {
      await c.rollback().catch(() => {});
      if (e && e.code === 'ER_DUP_ENTRY') throw dataError('exists', `table ${spec.name} already exists`);
      throw e;
    } finally { c.release(); }
    return publicTable((await this.q(this.catalog, 'SELECT id, udb_id, name, columns_json, created_at FROM funx_utbl WHERE udb_id = ? AND name = ?', [db.id, spec.name]))[0]);
  }

  async getTable(ownerId, dbName, tableName) {
    const db = await this._requireDb(ownerId, dbName);
    const table = await this._loadTable(db, tableName);
    return table ? publicTable(table) : null;
  }

  async deleteTable(ownerId, dbName, tableName) {
    const { db, table } = await this._requireTable(ownerId, dbName, tableName);
    await this.q(this._pool(db.node_id), 'DELETE FROM funx_udata WHERE udb_id = ? AND utbl_id = ?', [db.id, table.id]);
    await this.q(this.catalog, 'DELETE FROM funx_utbl WHERE id = ?', [table.id]);
    await this.q(this.catalog, 'UPDATE funx_udb SET ddl_version = ddl_version + 1 WHERE id = ?', [db.id]);
    return { deleted: tableName };
  }

  async getRow(ownerId, dbName, tableName, pkRaw) {
    const { db, table } = await this._requireTable(ownerId, dbName, tableName);
    const pk = pkFromUrl(pkRaw);
    const rows = await this.q(this._pool(db.node_id), 'SELECT pk, doc, updated_at FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?', [db.id, table.id, pk]);
    return rows[0] ? decodeRow(columnsOf(table.columns_json), rows[0].pk, rows[0].doc, rows[0].updated_at) : null;
  }

  async putRow(ownerId, dbName, tableName, pkRaw, values) {
    const { db, table } = await this._requireTable(ownerId, dbName, tableName);
    const columns = columnsOf(table.columns_json);
    const { pk, doc } = encodeRow(columns, pkRaw, values, this.limits);
    const pool = this._pool(db.node_id);
    const existing = await this.q(pool, 'SELECT pk FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?', [db.id, table.id, pk]);
    await this.q(pool, 'INSERT INTO funx_udata (udb_id, utbl_id, pk, doc) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc), updated_at = CURRENT_TIMESTAMP(3)', [db.id, table.id, pk, doc]);
    const row = (await this.q(pool, 'SELECT pk, doc, updated_at FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?', [db.id, table.id, pk]))[0];
    return { created: existing.length === 0, row: decodeRow(columns, row.pk, row.doc, row.updated_at) };
  }

  async deleteRow(ownerId, dbName, tableName, pkRaw) {
    const { db, table } = await this._requireTable(ownerId, dbName, tableName);
    const pk = pkFromUrl(pkRaw);
    const r = await this.q(this._pool(db.node_id), 'DELETE FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?', [db.id, table.id, pk]);
    return !!(r && r.affectedRows);
  }

  async listRows(ownerId, dbName, tableName, { limit, after } = {}) {
    const { db, table } = await this._requireTable(ownerId, dbName, tableName);
    const n = clampLimit(limit, this.limits.list);
    const cursor = after == null ? null : pkFromUrl(after, 'bad_query');
    const sql = cursor == null
      ? `SELECT pk, doc, updated_at FROM funx_udata WHERE udb_id = ? AND utbl_id = ? ORDER BY pk LIMIT ${n + 1}`
      : `SELECT pk, doc, updated_at FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk > ? ORDER BY pk LIMIT ${n + 1}`;
    const params = cursor == null ? [db.id, table.id] : [db.id, table.id, cursor];
    const rows = await this.q(this._pool(db.node_id), sql, params);
    const columns = columnsOf(table.columns_json);
    return pageRows(rows.map((r) => decodeRow(columns, r.pk, r.doc, r.updated_at)), n);
  }
}

module.exports = {
  LIMITS, DATA_MIGRATIONS, UDATA_SQL, MemoryDataStore, MysqlDataStore,
  dataError, placeNode, chooseNode, cmpPk,
};
