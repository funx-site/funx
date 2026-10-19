'use strict';
// MySQL user store for funx-api. Database name is `funx` and the account is a funx user
// (see lib/isolation.js). Grants stay on that database only.
// Env (written by 云架构 into funx-api, never into git):
//   FUNX_DB_HOST FUNX_DB_PORT FUNX_DB_NAME FUNX_DB_USER FUNX_DB_PASSWORD
//   optional FUNX_DB_SSL=1 (TLS; FUNX_DB_SSL_CA = PEM of the TencentDB CA to verify the server)
// The DB user needs only SELECT/INSERT/UPDATE/DELETE + CREATE on `funx`: the schema below is created on
// cold start with CREATE TABLE IF NOT EXISTS (idempotent), so no separate migration run is needed.

const { normalizeEmail, newUserId } = require('./users');
const { assertDatabase } = require('../lib/isolation');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS funx_users (
     id VARCHAR(64) NOT NULL PRIMARY KEY,
     email VARCHAR(254) NOT NULL,
     password_hash VARCHAR(255) NULL,
     role VARCHAR(16) NOT NULL DEFAULT 'user',
     created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     password_changed_at DATETIME(3) NULL,
     UNIQUE KEY uq_funx_users_email (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS funx_setup_tokens (
     token_sha256 CHAR(64) NOT NULL PRIMARY KEY,
     user_id VARCHAR(64) NOT NULL,
     expires_at DATETIME(3) NOT NULL,
     used_at DATETIME(3) NULL,
     KEY ix_funx_setup_tokens_user (user_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

function rowToUser(r) {
  return r ? { id: r.id, email: r.email, hash: r.password_hash || null, role: r.role === 'admin' ? 'admin' : 'user', createdAt: r.created_at ? new Date(r.created_at).toISOString() : null } : null;
}

// `pool` is a mysql2/promise pool (or a fake with the same query/getConnection surface, see tests).
class MysqlUserStore {
  constructor(pool) { this.pool = pool; this.ready = null; }

  migrate() {
    if (!this.ready) this.ready = (async () => { for (const sql of MIGRATIONS) await this.pool.query(sql); })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  // For GET /v1/health: proves connect + migrations without exposing data.
  async health() {
    const rows = await this.q("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('funx_users', 'funx_setup_tokens')");
    return { db: 'ok', tables: Number(rows[0].n) };
  }

  async q(sql, params) { await this.migrate(); const [rows] = await this.pool.query(sql, params); return rows; }

  async getByEmail(email) { return rowToUser((await this.q('SELECT * FROM funx_users WHERE email = ?', [normalizeEmail(email)]))[0]); }
  async getById(id) { return rowToUser((await this.q('SELECT * FROM funx_users WHERE id = ?', [id]))[0]); }

  async create({ email, hash, role = 'user' }) {
    const id = newUserId();
    try {
      await this.q('INSERT INTO funx_users (id, email, password_hash, role, password_changed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))', [id, normalizeEmail(email), hash, role]);
    } catch (e) { if (e && e.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('email taken'), { code: 'exists' }); throw e; }
    return this.getById(id);
  }

  async checkSetupToken(sha, now = Date.now()) {
    const r = (await this.q(
      'SELECT u.id, u.email FROM funx_setup_tokens t JOIN funx_users u ON u.id = t.user_id WHERE t.token_sha256 = ? AND t.used_at IS NULL AND t.expires_at > ?',
      [sha, new Date(now)]))[0];
    return r ? { userId: r.id, email: r.email } : null;
  }

  // One transaction: lock the token row, set the password, mark the token used.
  async completeSetup(sha, hash, now = Date.now()) {
    await this.migrate();
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query('SELECT user_id FROM funx_setup_tokens WHERE token_sha256 = ? AND used_at IS NULL AND expires_at > ? FOR UPDATE', [sha, new Date(now)]);
      if (!rows.length) { await c.rollback(); return null; }
      const userId = rows[0].user_id;
      const [u] = await c.query('UPDATE funx_users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [hash, new Date(now), userId]);
      if (!u.affectedRows) { await c.rollback(); return null; }
      await c.query('UPDATE funx_setup_tokens SET used_at = ? WHERE token_sha256 = ?', [new Date(now), sha]);
      await c.commit();
    } catch (e) { try { await c.rollback(); } catch { /* ignore */ } throw e; } finally { c.release(); }
    return this.getById((await this.q('SELECT user_id FROM funx_setup_tokens WHERE token_sha256 = ?', [sha]))[0].user_id);
  }

  // Idempotent seed from FUNX_BOOTSTRAP: never resets a password or revives a used token.
  async bootstrap({ id, email, role = 'user', tokenSha256, expiresAt }) {
    await this.q('INSERT IGNORE INTO funx_users (id, email, password_hash, role) VALUES (?, ?, NULL, ?)', [id, normalizeEmail(email), role]);
    if (tokenSha256) {
      await this.q('INSERT IGNORE INTO funx_setup_tokens (token_sha256, user_id, expires_at) VALUES (?, ?, ?)', [tokenSha256, id, new Date(Number(expiresAt))]);
      // Only the configured token stays valid: any other unused token of this user is revoked (marked used).
      await this.q('UPDATE funx_setup_tokens SET used_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND token_sha256 <> ? AND used_at IS NULL', [id, tokenSha256]);
    }
  }
}

function poolFromEnv(env = process.env) {
  const need = ['FUNX_DB_HOST', 'FUNX_DB_NAME', 'FUNX_DB_USER', 'FUNX_DB_PASSWORD'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`database not configured: missing ${missing.join(', ')}`);
  assertDatabase({ name: env.FUNX_DB_NAME, user: env.FUNX_DB_USER });
  const mysql = require('mysql2/promise');
  const ssl = env.FUNX_DB_SSL === '1' ? (env.FUNX_DB_SSL_CA ? { ca: env.FUNX_DB_SSL_CA, rejectUnauthorized: true } : { rejectUnauthorized: false }) : undefined;
  return mysql.createPool({
    host: env.FUNX_DB_HOST, port: Number(env.FUNX_DB_PORT) || 3306, database: env.FUNX_DB_NAME,
    user: env.FUNX_DB_USER, password: env.FUNX_DB_PASSWORD, ssl,
    connectionLimit: Math.min(Math.max(Number(env.FUNX_DB_POOL_MAX) || 2, 1), 5), waitForConnections: true, connectTimeout: 5000, timezone: 'Z', dateStrings: false,
  });
}

module.exports = { MysqlUserStore, poolFromEnv, MIGRATIONS };
