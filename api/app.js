'use strict';
// funx-api: management API for Funx workers. Runs in ap-guangzhou (Demox VPC, for MySQL); manages the
// user functions in cfg.region (always ap-hongkong, set explicitly by server.js).
// Auth: email + password accounts, ES256 Bearer tokens signed by Funx (see jwt.js). No cookies.
// Every worker operation goes through cli/ops.js, the same library the CLI uses.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ops = require('../cli/ops');
const { buildSourceZip, buildUserZipFromFiles } = require('../cli/package');
const { validateName, RUNTIME_FUNCTION } = require('../lib/names');
const { validateBindingName } = require('../lib/bindings');
const users = require('./users');
const { createDbPlatform, createScfPlatform } = require('./platform-db');

const STARTER = fs.readFileSync(path.join(__dirname, '..', 'examples', 'worker', 'index.js'), 'utf8');
const MAX_JSON = 7 * 1024 * 1024; // base64 zip of up to ~5 MB
const INVOKE_MAX_BYTES = 1024 * 1024;
const DEFAULT_ORIGINS = ['https://funx.demox.site'];

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function isPermissionError(e) { return !!(e && typeof e.code === 'string' && /^(UnauthorizedOperation|AuthFailure)/.test(e.code)); }
function isNotFound(e) { return !!(e && typeof e.code === 'string' && e.code.startsWith('ResourceNotFound')); }

function originAllowed(origin, allowed) {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  return allowed.includes('http://localhost') && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_JSON) throw new HttpError(413, 'too_large'); chunks.push(c); }
  if (!size) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* fallthrough */ }
  throw new HttpError(400, 'bad_json', 'body must be a JSON object');
}

// Simple per-email/IP throttle for login (in memory, per instance).
function makeThrottle({ max = 8, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    blocked(k) { const h = hits.get(k); return !!h && h.n >= max && now() - h.t < windowMs; },
    fail(k) { const h = hits.get(k); if (!h || now() - h.t >= windowMs) hits.set(k, { n: 1, t: now() }); else h.n++; },
    clear(k) { hits.delete(k); },
  };
}

function createApi({
  scf, cfg, signer, userStore, download, fetchImpl = globalThis.fetch,
  origins = DEFAULT_ORIGINS, signupOpen = false, manageDomains = false, log = () => {}, now = Date.now,
  workers = null, runtimeTokenSha256 = null,
}) {
  // v2 (workers given): code in MySQL, shared funx-runtime, no SCF calls. v1: one SCF function per worker.
  const P = workers ? createDbPlatform({ workers, cfg }) : createScfPlatform({ ops, scf, cfg, download, buildSourceZip, buildUserZipFromFiles });
  const runtimeThrottle = makeThrottle({ max: 30, windowMs: 60 * 1000 });
  const throttle = makeThrottle();
  const setupThrottle = makeThrottle({ max: 20 });
  let chain = Promise.resolve(); // serialize writes: the router map is read-modify-write

  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function auth(req) {
    const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'unauthorized', 'missing Bearer token');
    let claims;
    try { claims = signer.verify(m[1]); } catch { throw new HttpError(401, 'unauthorized', 'invalid or expired token'); }
    return { id: claims.sub, email: claims.email, role: claims.role === 'admin' ? 'admin' : 'user' };
  }

  function issue(u) {
    const t = signer.sign({ sub: u.id, email: u.email, role: u.role });
    return { token: t.token, expires_at: t.expiresAt, user: { id: u.id, email: u.email, role: u.role } };
  }

  function checkName(name) {
    const v = validateName(name);
    if (!v.ok) throw new HttpError(400, 'bad_name', v.reason);
  }

  // Loads a worker and checks the caller owns it (admins see everything).
  async function owned(user, name) {
    checkName(name);
    const w = await P.getWorker({ name });
    if (!w || (user.role !== 'admin' && w.owner !== user.id)) throw new HttpError(404, 'not_found', `no worker named ${name}`);
    return w;
  }

  function bundleFromBody(body) {
    try { return P.bundle(body); } catch (e) { if (e && e.status === 400) throw new HttpError(400, e.code || 'bad_request', e.message); throw e; }
  }

  async function doDeploy(user, name, bundle) {
    const r = await serial(async () => {
      const out = await P.deploy({ name, bundle, owner: user.id, skipDomain: !manageDomains });
      // v2: MySQL deploy does not touch SCF; still need a per-name custom domain -> funx-runtime.
      if (manageDomains && P.kind === 'db') {
        if (!cfg.certId) throw new HttpError(500, 'misconfigured', 'FUNX_CERT_ID is not set');
        await ops.ensureCustomDomain(scf, cfg, name, { functionName: RUNTIME_FUNCTION });
      }
      return out;
    });
    const w = await P.getWorker({ name });
    return { ...w, url: r.url, domain: P.kind === 'db' || manageDomains ? 'ready' : 'pending' };
  }

  async function invoke(name, body) {
    const method = String(body.method || 'GET').toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new HttpError(400, 'bad_method');
    const p = String(body.path || '/');
    if (!p.startsWith('/') || p.startsWith('//')) throw new HttpError(400, 'bad_path', 'path must start with /');
    const headers = {};
    for (const [k, v] of Object.entries(body.headers || {})) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /^(host|x-funx-|x-scf-|cookie|authorization$)/i.test(k)) continue;
      headers[k] = String(v);
    }
    // Fixed host: the name was validated, so this can only ever reach <name>.<baseDomain>.
    const url = new URL(p, `https://${name}.${cfg.baseDomain}`);
    if (url.hostname !== `${name}.${cfg.baseDomain}`) throw new HttpError(400, 'bad_path');
    const started = Date.now();
    let r;
    try {
      r = await fetchImpl(url.href, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : String(body.body ?? ''), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch (e) {
      return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable', ms: Date.now() - started };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Date.now() - started;
    const out = {};
    r.headers.forEach((v, k) => { out[k] = v; });
    const truncated = buf.length > INVOKE_MAX_BYTES;
    const slice = truncated ? buf.subarray(0, INVOKE_MAX_BYTES) : buf;
    const ct = r.headers.get('content-type') || '';
    const text = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))|charset=/i.test(ct) || !ct;
    return { ok: true, status: r.status, statusText: r.statusText, headers: out, ms, size: buf.length, truncated, body: text ? slice.toString('utf8') : slice.toString('base64'), bodyEncoding: text ? 'utf8' : 'base64' };
  }

  async function route(req, method, parts) {
    // Public
    if (method === 'GET' && parts.join('/') === '.well-known/jwks.json') return [200, signer.jwks(), { 'cache-control': 'public, max-age=300' }];
    if (parts[0] !== 'v1') throw new HttpError(404, 'not_found');
    const p = parts.slice(1);
    if (method === 'GET' && p[0] === 'health' && p.length === 1) {
      if (!userStore || typeof userStore.health !== 'function') return [200, { ok: true }];
      try { return [200, { ok: true, ...(await userStore.health()) }]; } catch (e) {
        log({ err: 'health', code: e && e.code });
        return [503, { ok: false, db: 'error', code: (e && e.code) || 'unknown' }];
      }
    }

    // One-time password setup link (/#/setup?t=<token> in the console). The raw token never reaches a log:
    // it travels in the POST body and only its SHA-256 is looked up. Used, expired and unknown tokens all
    // answer 410 link_expired, so the console shows the same "expired link" page for each.
    if (p[0] === 'auth' && p[1] === 'setup' && method === 'POST' && (p.length === 2 || (p.length === 3 && p[2] === 'check'))) {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 100);
      if (setupThrottle.blocked(ip)) throw new HttpError(429, 'too_many_attempts', 'too many attempts, try again later');
      const body = await readJson(req);
      const token = typeof body.token === 'string' && /^[\w-]{20,100}$/.test(body.token) ? body.token : null;
      const sha = token ? users.sha256Hex(token) : null;
      const expired = () => { setupThrottle.fail(ip); return new HttpError(410, 'link_expired', 'this link has expired or was already used'); };
      if (!sha) throw expired();
      if (p.length === 3) {
        const t = await userStore.checkSetupToken(sha, now());
        if (!t) throw expired();
        return [200, { ok: true, email: t.email }];
      }
      const t = await userStore.checkSetupToken(sha, now());
      if (!t) throw expired();
      const bad = users.validateCredentials(t.email, body.password);
      if (bad) throw new HttpError(400, 'bad_password', bad);
      const u = await userStore.completeSetup(sha, await users.hashPassword(body.password), now());
      if (!u) throw expired();
      return [200, issue(u)];
    }

    if (p[0] === 'auth' && method === 'POST' && p.length === 2) {
      const body = await readJson(req);
      const email = users.normalizeEmail(body.email);
      if (p[1] === 'register') {
        if (!signupOpen) throw new HttpError(403, 'signup_closed', 'sign-up is not open yet');
        const bad = users.validateCredentials(email, body.password);
        if (bad) throw new HttpError(400, 'bad_credentials', bad);
        let u;
        try { u = await userStore.create({ email, hash: await users.hashPassword(body.password), role: 'user' }); } catch (e) {
          if (e.code === 'exists') throw new HttpError(409, 'email_taken', 'this email is already registered');
          if (e.code === 'closed') throw new HttpError(403, 'signup_closed', 'sign-up is not open yet');
          throw e;
        }
        return [201, issue(u)];
      }
      if (p[1] === 'login') {
        const key = `${email}|${req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''}`.slice(0, 300);
        if (throttle.blocked(key)) throw new HttpError(429, 'too_many_attempts', 'too many attempts, try again later');
        const u = email ? await userStore.getByEmail(email) : null;
        const ok = await users.verifyPassword(String(body.password || ''), u && u.hash ? u.hash : await users.dummyHash());
        if (!u || !u.hash || !ok) { throttle.fail(key); throw new HttpError(401, 'bad_login', 'wrong email or password'); }
        throttle.clear(key);
        return [200, issue(u)];
      }
      throw new HttpError(404, 'not_found');
    }

    // Code fetch for funx-runtime [R2]: runtime token only. User JWTs (any role) are refused before any lookup,
    // every failure is the same 401 (no existence oracle), and the route never sends CORS headers.
    if (p[0] === 'runtime') {
      if (!workers || !runtimeTokenSha256) throw new HttpError(404, 'not_found');
      const m = /^Bearer (fxrt_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      if (runtimeThrottle.blocked(ip)) throw new HttpError(429, 'too_many_requests');
      const got = m ? crypto.createHash('sha256').update(m[1]).digest() : crypto.randomBytes(32);
      if (!m || !crypto.timingSafeEqual(got, Buffer.from(runtimeTokenSha256, 'hex'))) { runtimeThrottle.fail(ip); throw new HttpError(401, 'unauthorized'); }
      if (!(method === 'GET' && p[1] === 'workers' && p.length === 3)) throw new HttpError(404, 'not_found');
      const name = p[2];
      if (!validateName(name).ok) throw new HttpError(404, 'not_found');
      const have = new URL(req.url, 'http://x').searchParams.get('have');
      const c = await workers.runtimeConfig(name);
      log({ rt: name, s: c ? (have && have === c.version ? 304 : 200) : 404 });
      if (!c) throw new HttpError(404, 'not_found');
      if (have && have === c.version) return [200, { name, version: c.version, disabled: c.disabled, unchanged: true }];
      return [200, c];
    }

    const user = await auth(req);
    if (method === 'GET' && p[0] === 'me' && p.length === 1) return [200, { user }];
    if (p[0] !== 'workers') throw new HttpError(404, 'not_found');

    if (p.length === 1) {
      if (method === 'GET') {
        const all = await P.list();
        const rows = [];
        for (const r of all) {
          if (user.role !== 'admin') {
            const owner = r.owner !== undefined ? r.owner : ((await P.getWorker({ name: r.name }).catch(() => null)) || {}).owner;
            if (owner !== user.id) continue;
          }
          rows.push({ name: r.name, url: r.url, status: r.status, disabled: r.disabled, routed: r.routed, last_deploy: r.modTime || null });
        }
        return [200, { workers: rows }];
      }
      if (method === 'POST') {
        const body = await readJson(req);
        checkName(body.name);
        const existing = await P.getWorker({ name: body.name }).catch((e) => { if (isNotFound(e)) return null; throw e; });
        if (existing) throw new HttpError(409, 'name_taken', `${body.name} is taken`);
        const bundle = bundleFromBody(typeof body.code === 'string' || body.files ? body : { code: STARTER });
        return [201, await doDeploy(user, body.name, bundle)];
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    const name = p[1];
    const sub = p.slice(2);
    const key = sub.join('/');

    if (key === 'deploy' && method === 'POST') {
      checkName(name);
      const body = await readJson(req);
      const existing = await P.getWorker({ name });
      if (existing && user.role !== 'admin' && existing.owner !== user.id) throw new HttpError(409, 'name_taken', `${name} is taken`);
      return [200, await doDeploy(user, name, bundleFromBody(body))];
    }

    const w = await owned(user, name);
    if (!sub.length) {
      if (method === 'GET') return [200, w];
      if (method === 'DELETE') { await serial(() => P.remove({ name })); return [200, { deleted: name }]; }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (key === 'code') {
      if (method === 'GET') {
        const c = await P.getCode({ name });
        if (!c) throw new HttpError(404, 'not_found');
        return [200, c];
      }
      if (method === 'PUT') return [200, await doDeploy(user, name, bundleFromBody(await readJson(req)))];
      throw new HttpError(405, 'method_not_allowed');
    }
    if ((key === 'disable' || key === 'enable') && method === 'POST') {
      const r = await serial(() => P.setDisabled({ name, disabled: key === 'disable' }));
      return [200, { name, disabled: key === 'disable', origin: r.origin }];
    }
    if (sub[0] === 'vars' || sub[0] === 'secrets') {
      const type = sub[0] === 'vars' ? 'var' : 'secret';
      if (sub.length === 1 && method === 'GET') return [200, type === 'var' ? { vars: w.vars } : { secrets: w.secrets }];
      if (sub.length === 1 && method === 'PUT' && type === 'var') {
        const body = await readJson(req);
        const set = body.vars && typeof body.vars === 'object' ? body.vars : null;
        if (!set) throw new HttpError(400, 'bad_vars', 'send { "vars": { "NAME": "value" } }');
        for (const [k, v] of Object.entries(set)) { const ok = validateBindingName(k); if (!ok.ok) throw new HttpError(400, 'bad_name', `${k}: ${ok.reason}`); if (typeof v !== 'string') throw new HttpError(400, 'bad_value', `${k}: value must be a string`); }
        const r = await serial(() => P.updateBindings({ name, set, type: 'var' }));
        return [200, { vars: r.vars }];
      }
      if (sub.length === 2) {
        const bname = sub[1];
        const ok = validateBindingName(bname);
        if (!ok.ok) throw new HttpError(400, 'bad_name', ok.reason);
        if (method === 'PUT') {
          const body = await readJson(req);
          if (typeof body.value !== 'string') throw new HttpError(400, 'bad_value', 'send { "value": "..." }');
          const r = await serial(() => P.updateBindings({ name, set: { [bname]: body.value }, type }));
          return [200, type === 'var' ? { vars: r.vars } : { secrets: r.secrets }];
        }
        if (method === 'DELETE') {
          const r = await serial(() => P.updateBindings({ name, remove: [bname] }));
          return [200, type === 'var' ? { vars: r.vars } : { secrets: r.secrets }];
        }
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (key === 'logs' && method === 'GET') {
      try {
        return [200, { logs: await P.getLogs({ name, limit: 50 }) }];
      } catch (e) {
        if (isPermissionError(e) || (e && /^(FailedOperation|InvalidParameter|UnsupportedOperation)/.test(e.code || ''))) throw new HttpError(501, 'logs_unavailable', 'logs are not available yet');
        throw e;
      }
    }
    if (key === 'invoke' && method === 'POST') return [200, await invoke(name, await readJson(req))];
    throw new HttpError(404, 'not_found');
  }

  return async function handle(req, res) {
    const origin = req.headers.origin;
    const cors = {};
    if (originAllowed(origin, origins) && !/^\/v1\/runtime(\/|$)/.test(String(req.url || ''))) {
      Object.assign(cors, {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-max-age': '600',
      });
    }
    const send = (status, obj, extra = {}) => {
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', vary: 'Origin', 'x-content-type-options': 'nosniff', ...cors, ...extra });
      res.end(buf);
    };
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') { res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, { vary: 'Origin', ...cors }); res.end(); return; }
    const started = Date.now();
    let status = 500;
    try {
      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [s, body, extra] = await route(req, method, parts);
      status = s;
      send(s, body, extra);
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; send(e.status, { error: e.code, message: e.message }); }
      else if (isNotFound(e)) { status = 404; send(404, { error: 'not_found' }); }
      else if (isPermissionError(e)) { status = 502; send(502, { error: 'platform_permission', message: 'the platform is missing a cloud permission for this action' }); log({ err: e.code }); }
      else if (e && /^(name|entry file|package is|code is empty|bad file path|.* is reserved|vars and secrets|.*: value)/.test(e.message || '')) { status = 400; send(400, { error: 'bad_request', message: e.message }); }
      else { status = 500; send(500, { error: 'internal', id: crypto.randomBytes(4).toString('hex') }); log({ err: e && e.message }); }
    } finally {
      log({ m: method, s: status, ms: Date.now() - started });
    }
  };
}

module.exports = { createApi, HttpError, originAllowed, DEFAULT_ORIGINS, STARTER };
