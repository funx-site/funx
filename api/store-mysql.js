'use strict';
// MySQL user store for funx-api. Accounts and setup tokens are rows in the platform logical
// database (owner `funx`, name `platform`), in funx_udata. See docs/DATA.md.
// The physical database name is `funx` and the account is a funx user (see lib/isolation.js).
// Env (written by 云架构 into funx-api, never into git):
//   FUNX_DB_HOST FUNX_DB_PORT FUNX_DB_NAME FUNX_DB_USER FUNX_DB_PASSWORD
//   optional FUNX_DB_SSL=1 (TLS; FUNX_DB_SSL_CA = PEM of the TencentDB CA to verify the server)

const { MysqlDataStore, DATA_MIGRATIONS } = require('./data-store');
const { DataUserStore } = require('./platform-data');
const { assertDatabase } = require('../lib/isolation');

class MysqlUserStore {
  constructor(pool, { dataStore, schemaName } = {}) {
    this.data = dataStore || new MysqlDataStore(pool, { schemaName: schemaName || 'funx' });
    this.users = new DataUserStore(this.data);
  }

  migrate() { return this.users.ensure(); }
  health() { return this.users.health(); }
  getByEmail(email) { return this.users.getByEmail(email); }
  getById(id) { return this.users.getById(id); }
  create(input) { return this.users.create(input); }
  checkSetupToken(sha, now) { return this.users.checkSetupToken(sha, now); }
  completeSetup(sha, hash, now) { return this.users.completeSetup(sha, hash, now); }
  bootstrap(input) { return this.users.bootstrap(input); }
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

module.exports = { MysqlUserStore, poolFromEnv, MIGRATIONS: DATA_MIGRATIONS };
