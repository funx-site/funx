'use strict';
// Funx accounts: email + password. Passwords are stored only as scrypt hashes.
//
// A store implements:
//   getByEmail(email) -> user|null      getById(id) -> user|null
//   create({ email, hash, role }) -> user   (throws { code: 'exists' } on a taken email)
//   checkSetupToken(tokenSha256, now) -> { userId, email } | null    (valid = exists, unused, not expired)
//   completeSetup(tokenSha256, hash, now) -> user | null   (atomic: sets the password AND marks the token used;
//                                                           null if the token is unknown, used or expired)
//   bootstrap({ id, email, role, tokenSha256, expiresAt })  idempotent: creates the user (no password) and
//                                                           the setup token only if they do not exist yet;
//                                                           other unused tokens of that user are revoked
// user = { id, email, hash (null until set), role: 'admin'|'user', createdAt }
//
// Shipped stores:
//   MemoryUserStore  tests and `funx api-dev`; rows in a memory data store, lost on restart.
//   MysqlUserStore   api/store-mysql.js, production. Accounts are rows in the platform logical database.
//   EnvUserStore     read-only list from FUNX_USERS; legacy, no setup links.

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function normalizeEmail(e) { return typeof e === 'string' ? e.trim().toLowerCase() : ''; }

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(normalizeEmail(email))) return 'invalid email';
  if (typeof password !== 'string' || password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password is too long';
  return null;
}

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}

// Format: scrypt$N$r$p$saltB64u$hashB64u
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${k.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const m = typeof stored === 'string' && stored.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/);
  if (!m || typeof password !== 'string') return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = await scrypt(password, Buffer.from(m[4], 'base64url'), { N: +m[1], r: +m[2], p: +m[3], keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A hash to compare against when the email is unknown, so timing does not reveal which emails exist.
let dummy = null;
async function dummyHash() { if (!dummy) dummy = await hashPassword(crypto.randomBytes(12).toString('hex')); return dummy; }

function newUserId() { return 'u_' + crypto.randomBytes(8).toString('hex'); }

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function newSetupToken() { const token = crypto.randomBytes(32).toString('base64url'); return { token, sha256: sha256Hex(token) }; }

class MemoryUserStore {
  constructor(users = []) {
    const { MemoryDataStore } = require('./data-store');
    const { DataUserStore } = require('./platform-data');
    this.data = new MemoryDataStore();
    this.inner = new DataUserStore(this.data);
    const seeds = users.map((u) => ({ id: u.id, email: u.email, hash: u.hash == null ? null : u.hash, role: u.role }));
    this.ready = this._seed(seeds);
  }

  async _seed(seeds) {
    try {
      for (const u of seeds) await this.inner.createRaw(u);
    } catch (e) {
      this.ready = null;
      throw e;
    }
  }

  async _ready() { if (this.ready) await this.ready; }
  async getByEmail(email) { await this._ready(); return this.inner.getByEmail(email); }
  async getById(id) { await this._ready(); return this.inner.getById(id); }
  async create(input) { await this._ready(); return this.inner.create(input); }
  async checkSetupToken(sha, now) { await this._ready(); return this.inner.checkSetupToken(sha, now); }
  async completeSetup(sha, hash, now) { await this._ready(); return this.inner.completeSetup(sha, hash, now); }
  async bootstrap(input) { await this._ready(); return this.inner.bootstrap(input); }
}

class EnvUserStore extends MemoryUserStore {
  constructor(raw) {
    let list = [];
    if (raw) { try { list = JSON.parse(raw); } catch { throw new Error('FUNX_USERS is not valid JSON'); } }
    if (!Array.isArray(list)) throw new Error('FUNX_USERS must be an array');
    for (const u of list) if (!u.id || !u.email || !u.hash) throw new Error('each FUNX_USERS entry needs id, email, hash');
    super(list);
  }
  async create() { throw Object.assign(new Error('sign-up is closed'), { code: 'closed' }); }
}

module.exports = { sha256Hex, newSetupToken, hashPassword, verifyPassword, dummyHash, validateCredentials, normalizeEmail, MemoryUserStore, EnvUserStore, newUserId };
