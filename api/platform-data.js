'use strict';
// Funx's own accounts and workers are rows in the logical database, not tables of their own.
// One database, owner "funx", name "platform", sitting in funx_udata next to every customer's rows.
// The public /v1/databases API never opens this database: its owner id is not a user id.

const PLATFORM_OWNER = 'funx';
const PLATFORM_DB = 'platform';
const PLATFORM_DOC_BYTES = 4 * 1024 * 1024; // worker source is capped at 1 MB; JSON quoting needs room
const KEEP_VERSIONS = 10;

const PLATFORM_TABLES = {
  users: [
    { name: 'id', type: 'string', primary: true },
    { name: 'email', type: 'string' },
    { name: 'password_hash', type: 'string' },
    { name: 'role', type: 'string' },
    { name: 'created_at', type: 'string' },
    { name: 'password_changed_at', type: 'string' },
  ],
  user_emails: [
    { name: 'email', type: 'string', primary: true },
    { name: 'user_id', type: 'string' },
  ],
  setup_tokens: [
    { name: 'token_sha256', type: 'string', primary: true },
    { name: 'user_id', type: 'string' },
    { name: 'expires_at', type: 'string' },
    { name: 'used_at', type: 'string' },
  ],
  workers: [
    { name: 'name', type: 'string', primary: true },
    { name: 'owner_id', type: 'string' },
    { name: 'disabled', type: 'bool' },
    { name: 'current_version', type: 'string' },
    { name: 'created_at', type: 'string' },
    { name: 'updated_at', type: 'string' },
  ],
  worker_versions: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'entry', type: 'string' },
    { name: 'bundle', type: 'json' },
    { name: 'size', type: 'int' },
    { name: 'created_at', type: 'string' },
    { name: 'created_by', type: 'string' },
  ],
  worker_bindings: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'bkey', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'sealed', type: 'string' },
  ],
  // MySQL gateway logins. The password itself is not stored, only the native hash.
  mysql_accounts: [
    { name: 'username', type: 'string', primary: true },
    { name: 'owner_id', type: 'string' },
    { name: 'auth_string', type: 'string' },
    { name: 'created_at', type: 'string' },
  ],
};

const exists = (message) => Object.assign(new Error(message), { code: 'exists' });
const iso = (t) => new Date(t).toISOString();
const versionKey = (name, version) => `${name}@${version}`;
const bindingKey = (name, bkey) => `${name}@${bkey}`;

class PlatformDb {
  constructor(data) { this.data = data; this.ready = null; }

  ensure() {
    if (!this.ready) this.ready = this._ensure().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async _ensure() {
    if (!(await this.data.getDatabase(PLATFORM_OWNER, PLATFORM_DB))) {
      try { await this.data.createDatabase({ ownerId: PLATFORM_OWNER, name: PLATFORM_DB }); } catch (e) { if (!e || e.code !== 'exists') throw e; }
    }
    for (const [name, columns] of Object.entries(PLATFORM_TABLES)) {
      if (await this.data.getTable(PLATFORM_OWNER, PLATFORM_DB, name)) continue;
      try { await this.data.createTable(PLATFORM_OWNER, PLATFORM_DB, { name, columns }); } catch (e) { if (!e || e.code !== 'exists') throw e; }
    }
  }

  transact(fn) { return this.data.transact(PLATFORM_OWNER, PLATFORM_DB, fn); }
  getRow(table, pk, opts) { return this.data.getRow(PLATFORM_OWNER, PLATFORM_DB, table, pk, opts); }
  putRow(table, pk, values, opts) { return this.data.putRow(PLATFORM_OWNER, PLATFORM_DB, table, pk, values, opts); }
  insertRow(table, pk, values, opts) { return this.data.insertRow(PLATFORM_OWNER, PLATFORM_DB, table, pk, values, opts); }
  deleteRow(table, pk) { return this.data.deleteRow(PLATFORM_OWNER, PLATFORM_DB, table, pk); }
  listAll(table, opts) { return this.data.listAll(PLATFORM_OWNER, PLATFORM_DB, table, opts); }
}

function userFrom(values) {
  return values ? {
    id: values.id,
    email: values.email,
    hash: values.password_hash || null,
    role: values.role === 'admin' ? 'admin' : 'user',
    createdAt: values.created_at || null,
  } : null;
}

function userValues(u, extra = {}) {
  return {
    id: u.id,
    email: u.email,
    password_hash: u.password_hash == null ? null : u.password_hash,
    role: u.role === 'admin' ? 'admin' : 'user',
    created_at: u.created_at,
    password_changed_at: u.password_changed_at || null,
    ...extra,
  };
}

class DataUserStore {
  constructor(data) { this.platform = new PlatformDb(data); this.data = data; }

  ensure() { return this.platform.ensure(); }

  async health() {
    await this.ensure();
    const tables = await this.data.listTables(PLATFORM_OWNER, PLATFORM_DB);
    return { db: 'ok', tables: tables.length };
  }

  async getById(id) {
    await this.ensure();
    if (typeof id !== 'string' || !id || id === PLATFORM_OWNER) return null;
    const row = await this.platform.getRow('users', id);
    return userFrom(row && row.values);
  }

  async getByEmail(email) {
    await this.ensure();
    const norm = require('./users').normalizeEmail(email);
    if (!norm) return null;
    const link = await this.platform.getRow('user_emails', norm);
    if (!link) return null;
    return this.getById(link.values.user_id);
  }

  async create({ email, hash, role = 'user' }) {
    await this.ensure();
    const norm = require('./users').normalizeEmail(email);
    const id = require('./users').newUserId();
    const now = new Date().toISOString();
    try {
      await this.platform.transact(async (tx) => {
        if (await tx.getRow('user_emails', norm, { lock: true })) throw exists('email taken');
        await tx.insertRow('users', id, { id, email: norm, password_hash: hash, role: role === 'admin' ? 'admin' : 'user', created_at: now, password_changed_at: now });
        await tx.insertRow('user_emails', norm, { email: norm, user_id: id });
      });
    } catch (e) {
      if (e && e.code === 'exists') throw exists('email taken');
      throw e;
    }
    return this.getById(id);
  }

  // Seed a known id (tests, bootstrap). Does not replace an existing row.
  async createRaw({ id, email, hash, role = 'user' }) {
    await this.ensure();
    if (id === PLATFORM_OWNER) throw exists('reserved id');
    const norm = require('./users').normalizeEmail(email);
    const now = new Date().toISOString();
    if (await this.getById(id) || await this.platform.getRow('user_emails', norm)) return this.getById(id);
    await this.platform.transact(async (tx) => {
      if (await tx.getRow('users', id)) return;
      if (await tx.getRow('user_emails', norm)) return;
      await tx.insertRow('users', id, { id, email: norm, password_hash: hash || null, role: role === 'admin' ? 'admin' : 'user', created_at: now, password_changed_at: hash ? now : null });
      await tx.insertRow('user_emails', norm, { email: norm, user_id: id });
    });
    return this.getById(id);
  }

  async checkSetupToken(sha, now = Date.now()) {
    await this.ensure();
    const tok = await this.platform.getRow('setup_tokens', sha);
    if (!liveToken(tok, now)) return null;
    const u = await this.getById(tok.values.user_id);
    return u ? { userId: u.id, email: u.email } : null;
  }

  async completeSetup(sha, hash, now = Date.now()) {
    await this.ensure();
    const when = iso(now);
    const user = await this.platform.transact(async (tx) => {
      const tok = await tx.getRow('setup_tokens', sha, { lock: true });
      if (!liveToken(tok, now)) return null;
      const row = await tx.getRow('users', tok.values.user_id, { lock: true });
      if (!row) return null;
      await tx.putRow('users', row.pk, userValues(row.values, { password_hash: hash, password_changed_at: when }));
      await tx.putRow('setup_tokens', sha, { ...tok.values, used_at: when });
      return userFrom({ ...row.values, password_hash: hash });
    });
    return user;
  }

  async bootstrap({ id, email, role = 'user', tokenSha256, expiresAt }) {
    await this.ensure();
    if (id === PLATFORM_OWNER) throw exists('reserved id');
    const norm = require('./users').normalizeEmail(email);
    const now = new Date().toISOString();
    await this.platform.transact(async (tx) => {
      const have = await tx.getRow('users', id, { lock: true });
      const mail = await tx.getRow('user_emails', norm, { lock: true });
      if (!have && !mail) {
        await tx.insertRow('users', id, { id, email: norm, password_hash: null, role: role === 'admin' ? 'admin' : 'user', created_at: now, password_changed_at: null });
        await tx.insertRow('user_emails', norm, { email: norm, user_id: id });
      }
      if (tokenSha256 && !(await tx.getRow('setup_tokens', tokenSha256))) {
        await tx.insertRow('setup_tokens', tokenSha256, { token_sha256: tokenSha256, user_id: id, expires_at: iso(Number(expiresAt)), used_at: null });
      }
      if (tokenSha256) {
        const tokens = await tx.listAll('setup_tokens');
        for (const t of tokens) {
          if (t.values.user_id === id && t.pk !== tokenSha256 && !t.values.used_at) {
            await tx.putRow('setup_tokens', t.pk, { ...t.values, used_at: now });
          }
        }
      }
    });
  }
}

function liveToken(tok, now) {
  return !!(tok && !tok.values.used_at && Date.parse(tok.values.expires_at) > now);
}

module.exports = {
  PLATFORM_OWNER, PLATFORM_DB, PLATFORM_DOC_BYTES, PLATFORM_TABLES, KEEP_VERSIONS,
  PlatformDb, DataUserStore, versionKey, bindingKey,
};
