'use strict';
// Worker storage for the shared runtime (v2): code bundles, vars, encrypted secrets, kill-switch flag.
// Two implementations with one interface: MemoryWorkerStore (tests, local dev) and MysqlWorkerStore (funx-api).
const { seal, open } = require('./secretbox');
const { versionOf } = require('./bundle');

const KEEP_VERSIONS = 10;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const notFound = (name) => Object.assign(new Error(`${name} does not exist`), { code: 'ResourceNotFound.Worker' });

const WORKER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS funx_workers (
     name VARCHAR(32) NOT NULL PRIMARY KEY,
     owner_id VARCHAR(64) NOT NULL,
     disabled TINYINT(1) NOT NULL DEFAULT 0,
     current_version CHAR(64) NULL,
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     KEY ix_funx_workers_owner (owner_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS funx_worker_versions (
     name VARCHAR(32) NOT NULL,
     version CHAR(64) NOT NULL,
     entry VARCHAR(255) NOT NULL,
     bundle MEDIUMTEXT NOT NULL,
     size INT NOT NULL,
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     created_by VARCHAR(64) NOT NULL,
     PRIMARY KEY (name, version),
     KEY ix_funx_worker_versions_created (name, created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS funx_worker_bindings (
     name VARCHAR(32) NOT NULL,
     bkey VARCHAR(64) NOT NULL,
     kind VARCHAR(8) NOT NULL,
     value TEXT NULL,
     sealed TEXT NULL,
     updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     PRIMARY KEY (name, bkey)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

function summary(w, bindings, entry) {
  const vars = {}; const secrets = [];
  for (const b of bindings) { if (b.kind === 'var') vars[b.bkey] = b.value; else secrets.push(b.bkey); }
  secrets.sort();
  return { name: w.name, owner: w.owner_id, disabled: !!w.disabled, version: w.current_version || null, entry: entry || null, modTime: iso(w.updated_at), createdAt: iso(w.created_at), vars, secrets };
}

class MemoryWorkerStore {
  constructor({ secretsKey }) { this.key = secretsKey; this.w = new Map(); this.v = new Map(); this.b = new Map(); }
  async migrate() {}
  async list() { return [...this.w.values()].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ name: w.name, owner: w.owner_id, disabled: !!w.disabled, version: w.current_version, modTime: iso(w.updated_at) })); }
  _bind(name) { return [...(this.b.get(name) || new Map()).values()]; }
  async get(name) { const w = this.w.get(name); if (!w) return null; const v = this.v.get(`${name}@${w.current_version}`); return summary(w, this._bind(name), v && v.entry); }
  async getBundle(name) { const w = this.w.get(name); if (!w || !w.current_version) return null; const v = this.v.get(`${name}@${w.current_version}`); return v ? { version: w.current_version, ...JSON.parse(v.bundle) } : null; }
  async deploy(name, ownerId, bundle) {
    const version = versionOf(bundle);
    let w = this.w.get(name);
    if (w && w.owner_id !== ownerId && ownerId !== null) { /* ownership is checked by the caller */ }
    const now = new Date();
    if (!w) { w = { name, owner_id: ownerId, disabled: 0, current_version: null, created_at: now, updated_at: now }; this.w.set(name, w); }
    const k = `${name}@${version}`;
    if (!this.v.has(k)) this.v.set(k, { entry: bundle.entry, bundle: JSON.stringify(bundle), created_at: now });
    w.current_version = version; w.updated_at = now;
    return { version, created: w.created_at === now };
  }
  async remove(name) { this.w.delete(name); this.b.delete(name); for (const k of [...this.v.keys()]) if (k.startsWith(`${name}@`)) this.v.delete(k); }
  async setDisabled(name, disabled) { const w = this.w.get(name); if (!w) throw notFound(name); w.disabled = disabled ? 1 : 0; w.updated_at = new Date(); }
  async setBindings(name, { set = {}, type = 'var', remove = [] }) {
    if (!this.w.has(name)) throw notFound(name);
    const m = this.b.get(name) || new Map(); this.b.set(name, m);
    for (const k of remove) m.delete(k);
    for (const [k, v] of Object.entries(set)) m.set(k, type === 'secret' ? { bkey: k, kind: 'secret', sealed: seal(this.key, name, k, v) } : { bkey: k, kind: 'var', value: String(v) });
    const s = await this.get(name); return { vars: s.vars, secrets: s.secrets };
  }
  async runtimeConfig(name) {
    const w = this.w.get(name);
    if (!w || !w.current_version) return null;
    const v = this.v.get(`${name}@${w.current_version}`);
    return buildRuntimeConfig(this.key, w, v && JSON.parse(v.bundle), this._bind(name));
  }
}

function buildRuntimeConfig(key, w, bundle, bindings) {
  const env = {};
  for (const b of bindings) env[b.bkey] = b.kind === 'secret' ? open(key, w.name, b.bkey, b.sealed) : b.value;
  return { name: w.name, version: w.current_version, disabled: !!w.disabled, entry: bundle.entry, files: bundle.files, env };
}

class MysqlWorkerStore {
  constructor(pool, { secretsKey }) { this.pool = pool; this.key = secretsKey; this.ready = null; }
  migrate() {
    if (!this.ready) this.ready = (async () => { for (const sql of WORKER_MIGRATIONS) await this.pool.query(sql); })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  async q(sql, p) { await this.migrate(); const [rows] = await this.pool.query(sql, p); return rows; }
  async list() {
    return (await this.q('SELECT name, owner_id, disabled, current_version, updated_at FROM funx_workers ORDER BY name'))
      .map((w) => ({ name: w.name, owner: w.owner_id, disabled: !!w.disabled, version: w.current_version, modTime: iso(w.updated_at) }));
  }
  async _w(name) { return (await this.q('SELECT * FROM funx_workers WHERE name = ?', [name]))[0] || null; }
  async _bind(name) { return this.q('SELECT bkey, kind, value, sealed FROM funx_worker_bindings WHERE name = ?', [name]); }
  async get(name) {
    const w = await this._w(name); if (!w) return null;
    const v = w.current_version ? (await this.q('SELECT entry FROM funx_worker_versions WHERE name = ? AND version = ?', [name, w.current_version]))[0] : null;
    return summary(w, await this._bind(name), v && v.entry);
  }
  async getBundle(name) {
    const w = await this._w(name); if (!w || !w.current_version) return null;
    const v = (await this.q('SELECT bundle FROM funx_worker_versions WHERE name = ? AND version = ?', [name, w.current_version]))[0];
    return v ? { version: w.current_version, ...JSON.parse(v.bundle) } : null;
  }
  async deploy(name, ownerId, bundle) {
    await this.migrate();
    const version = versionOf(bundle);
    const json = JSON.stringify(bundle);
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [[w]] = await c.query('SELECT name FROM funx_workers WHERE name = ? FOR UPDATE', [name]);
      if (!w) await c.query('INSERT INTO funx_workers (name, owner_id) VALUES (?, ?)', [name, ownerId]);
      await c.query('INSERT IGNORE INTO funx_worker_versions (name, version, entry, bundle, size, created_by) VALUES (?, ?, ?, ?, ?, ?)', [name, version, bundle.entry, json, Buffer.byteLength(json), ownerId]);
      await c.query('UPDATE funx_workers SET current_version = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE name = ?', [version, name]);
      await c.commit();
      // prune old versions (keep the newest KEEP_VERSIONS and the current one)
      await this.q(`DELETE FROM funx_worker_versions WHERE name = ? AND version <> ? AND version NOT IN (
         SELECT version FROM (SELECT version FROM funx_worker_versions WHERE name = ? ORDER BY created_at DESC LIMIT ${KEEP_VERSIONS}) keep)`, [name, version, name]);
      return { version, created: !w };
    } catch (e) { await c.rollback().catch(() => {}); throw e; } finally { c.release(); }
  }
  async remove(name) {
    for (const t of ['funx_worker_bindings', 'funx_worker_versions', 'funx_workers']) await this.q(`DELETE FROM ${t} WHERE name = ?`, [name]);
  }
  async setDisabled(name, disabled) {
    const r = await this.q('UPDATE funx_workers SET disabled = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE name = ?', [disabled ? 1 : 0, name]);
    if (!r.affectedRows) throw notFound(name);
  }
  async setBindings(name, { set = {}, type = 'var', remove = [] }) {
    if (!(await this._w(name))) throw notFound(name);
    for (const k of remove) await this.q('DELETE FROM funx_worker_bindings WHERE name = ? AND bkey = ?', [name, k]);
    for (const [k, v] of Object.entries(set)) {
      const row = type === 'secret' ? [name, k, 'secret', null, seal(this.key, name, k, v)] : [name, k, 'var', String(v), null];
      await this.q('INSERT INTO funx_worker_bindings (name, bkey, kind, value, sealed) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE kind = VALUES(kind), value = VALUES(value), sealed = VALUES(sealed), updated_at = CURRENT_TIMESTAMP(3)', row);
    }
    const s = await this.get(name); return { vars: s.vars, secrets: s.secrets };
  }
  async runtimeConfig(name) {
    const w = await this._w(name);
    if (!w || !w.current_version) return null;
    const v = (await this.q('SELECT bundle FROM funx_worker_versions WHERE name = ? AND version = ?', [name, w.current_version]))[0];
    if (!v) return null;
    return buildRuntimeConfig(this.key, w, JSON.parse(v.bundle), await this._bind(name));
  }
}

module.exports = { MemoryWorkerStore, MysqlWorkerStore, WORKER_MIGRATIONS };
