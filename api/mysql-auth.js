'use strict';
// MySQL gateway accounts. One login per Funx account, stored as a row in the platform
// logical database. The password is returned once, on reset. What we keep is the
// mysql_native_password hash: "*" + hex(SHA1(SHA1(password))).

const crypto = require('crypto');
const { PlatformDb, PLATFORM_OWNER } = require('./platform-data');
const { ACCOUNT_DB, ensureAccountDatabase } = require('./data-store');

function mysqlUserName(ownerId) {
  if (ownerId === PLATFORM_OWNER) {
    throw Object.assign(new Error('reserved'), { code: 'not_found' });
  }
  if (typeof ownerId === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(ownerId)) return ownerId;
  return 'f' + crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 31);
}

function nativeHash(password) {
  const stage1 = crypto.createHash('sha1').update(String(password), 'utf8').digest();
  const stage2 = crypto.createHash('sha1').update(stage1).digest();
  return '*' + stage2.toString('hex').toUpperCase();
}

function verifyNative(stored, scramble, token) {
  if (typeof stored !== 'string' || stored[0] !== '*' || !Buffer.isBuffer(token) || token.length !== 20) return false;
  if (!Buffer.isBuffer(scramble) || scramble.length !== 20) return false;
  let hash2;
  try { hash2 = Buffer.from(stored.slice(1), 'hex'); } catch { return false; }
  if (hash2.length !== 20) return false;
  const stage3 = crypto.createHash('sha1').update(scramble).update(hash2).digest();
  const stage1 = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) stage1[i] = token[i] ^ stage3[i];
  const candidate = crypto.createHash('sha1').update(stage1).digest();
  return crypto.timingSafeEqual(candidate, hash2);
}

function connectionUri({ host, port, user, password, database }) {
  const auth = password == null ? encodeURIComponent(user) : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  const db = database ? `/${encodeURIComponent(database)}` : '/';
  return `mysql://${auth}@${host}:${port}${db}`;
}

async function accountRow(dataStore, username) {
  const platform = new PlatformDb(dataStore);
  await platform.ensure();
  return platform.getRow('mysql_accounts', username);
}

async function mysqlAccountView(dataStore, ownerId, endpoint) {
  const user = mysqlUserName(ownerId);
  await ensureAccountDatabase(dataStore, ownerId);
  const row = await accountRow(dataStore, user);
  return {
    host: endpoint.host,
    port: endpoint.port,
    user,
    password_set: !!row,
    database: ACCOUNT_DB,
    databases: [ACCOUNT_DB],
    uri: connectionUri({ host: endpoint.host, port: endpoint.port, user, database: ACCOUNT_DB }),
  };
}

async function rotateMysqlPassword(dataStore, ownerId) {
  const username = mysqlUserName(ownerId);
  const password = crypto.randomBytes(18).toString('base64url');
  const platform = new PlatformDb(dataStore);
  await platform.ensure();
  const existing = await platform.getRow('mysql_accounts', username);
  const created_at = existing && existing.values.created_at ? existing.values.created_at : new Date().toISOString();
  await platform.putRow('mysql_accounts', username, {
    username,
    owner_id: ownerId,
    auth_string: nativeHash(password),
    created_at,
  });
  await ensureAccountDatabase(dataStore, ownerId);
  return {
    host: null,
    user: username,
    password,
    password_set: true,
    database: ACCOUNT_DB,
    databases: [ACCOUNT_DB],
  };
}

function withEndpoint(view, endpoint) {
  return {
    ...view,
    host: endpoint.host,
    port: endpoint.port,
    uri: connectionUri({ host: endpoint.host, port: endpoint.port, user: view.user, password: view.password, database: view.database }),
  };
}

async function verifyMysqlUser(dataStore, username, scramble, token) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(username)) return null;
  const row = await accountRow(dataStore, username);
  if (!row || row.values.owner_id === PLATFORM_OWNER) return null;
  if (!verifyNative(row.values.auth_string, scramble, token)) return null;
  return { ownerId: row.values.owner_id, username };
}

module.exports = {
  mysqlUserName, nativeHash, verifyNative, connectionUri,
  mysqlAccountView, rotateMysqlPassword, withEndpoint, verifyMysqlUser,
};
