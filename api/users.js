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
//   MemoryUserStore  tests and `funx api-dev`; lost on restart.
//   MysqlUserStore   api/store-mysql.js, production (database `funx`).
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
    this.byEmail = new Map(); this.tokens = new Map();
    for (const u of users) this.byEmail.set(normalizeEmail(u.email), { hash: null, role: 'user', ...u, email: normalizeEmail(u.email) });
  }
  async checkSetupToken(sha, now = Date.now()) {
    const t = this.tokens.get(sha);
    if (!t || t.usedAt || t.expiresAt <= now) return null;
    const u = await this.getById(t.userId);
    return u ? { userId: u.id, email: u.email } : null;
  }
  async completeSetup(sha, hash, now = Date.now()) {
    const t = this.tokens.get(sha);
    if (!t || t.usedAt || t.expiresAt <= now) return null;
    const u = await this.getById(t.userId);
    if (!u) return null;
    t.usedAt = now; u.hash = hash; u.passwordChangedAt = new Date(now).toISOString();
    return u;
  }
  async bootstrap({ id, email, role = 'user', tokenSha256, expiresAt }) {
    const e = normalizeEmail(email);
    if (!(await this.getById(id)) && !this.byEmail.has(e)) this.byEmail.set(e, { id, email: e, hash: null, role, createdAt: new Date().toISOString() });
    if (tokenSha256 && !this.tokens.has(tokenSha256)) this.tokens.set(tokenSha256, { userId: id, expiresAt: Number(expiresAt), usedAt: null });
    if (tokenSha256) for (const [k, t] of this.tokens) if (k !== tokenSha256 && t.userId === id && !t.usedAt) t.usedAt = Date.now();
  }
  async getByEmail(email) { return this.byEmail.get(normalizeEmail(email)) || null; }
  async getById(id) { return [...this.byEmail.values()].find((u) => u.id === id) || null; }
  async create({ email, hash, role = 'user' }) {
    const e = normalizeEmail(email);
    if (this.byEmail.has(e)) throw Object.assign(new Error('email taken'), { code: 'exists' });
    const u = { id: newUserId(), email: e, hash, role, createdAt: new Date().toISOString() };
    this.byEmail.set(e, u);
    return u;
  }
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
