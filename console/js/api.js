// Funx API client. Real mode talks to funx-api with a Bearer token (never cookies).
// Mock mode keeps everything in this browser's storage so the console runs standalone.

const TOKEN_KEY = 'funx.token';

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export function createClient({ apiBase = '', baseDomain = 'funx.run', storage = globalThis.localStorage, fetchImpl = globalThis.fetch?.bind(globalThis), runLive } = {}) {
  const mock = !apiBase;
  // Read through to storage each time so another tab logging in/out is picked up.
  const session = {
    get token() { return storage.getItem(TOKEN_KEY) || null; },
    get user() { try { return JSON.parse(storage.getItem('funx.user') || 'null'); } catch { return null; } },
    set(tk, u) { storage.setItem(TOKEN_KEY, tk); storage.setItem('funx.user', JSON.stringify(u)); },
    clear() { storage.removeItem(TOKEN_KEY); storage.removeItem('funx.user'); },
  };

  const base = mock ? mockBackend({ storage, baseDomain, runLive }) : null;

  async function call(method, path, body) {
    const token = session.token;
    if (mock) return base.handle(method, path, body, token);
    const r = await fetchImpl(apiBase.replace(/\/$/, '') + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (r.status === 401 && token) session.clear();
    if (!r.ok) throw new ApiError(r.status, json && json.error, json && json.message);
    return json;
  }

  const enc = encodeURIComponent;
  return {
    mock, session, baseDomain,
    async login(email, password) { const r = await call('POST', '/v1/auth/login', { email, password }); session.set(r.token, r.user); return r.user; },
    // One-time setup link: the token goes in the POST body, never in a request URL.
    setupCheck: (token) => call('POST', '/v1/auth/setup/check', { token }),
    async setup(token, password) { const r = await call('POST', '/v1/auth/setup', { token, password }); session.set(r.token, r.user); return r.user; },
    async register(email, password) { const r = await call('POST', '/v1/auth/register', { email, password }); session.set(r.token, r.user); return r.user; },
    logout() { session.clear(); },
    list: () => call('GET', '/v1/workers').then((r) => r.workers),
    get: (name) => call('GET', `/v1/workers/${enc(name)}`),
    getCode: (name) => call('GET', `/v1/workers/${enc(name)}/code`),
    deploy: (name, code) => call('POST', `/v1/workers/${enc(name)}/deploy`, { code }),
    remove: (name) => call('DELETE', `/v1/workers/${enc(name)}`),
    setDisabled: (name, off) => call('POST', `/v1/workers/${enc(name)}/${off ? 'disable' : 'enable'}`),
    setVars: (name, vars) => call('PUT', `/v1/workers/${enc(name)}/vars`, { vars }),
    deleteVar: (name, k) => call('DELETE', `/v1/workers/${enc(name)}/vars/${enc(k)}`),
    putSecret: (name, k, value) => call('PUT', `/v1/workers/${enc(name)}/secrets/${enc(k)}`, { value }),
    deleteSecret: (name, k) => call('DELETE', `/v1/workers/${enc(name)}/secrets/${enc(k)}`),
    logs: (name) => call('GET', `/v1/workers/${enc(name)}/logs`).then((r) => r.logs),
    invoke: (name, req) => call('POST', `/v1/workers/${enc(name)}/invoke`, req),
  };
}

// ---------- mock backend ----------

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
const RESERVED = new Set(['api', 'auth', 'www', 'admin', 'app', 'console', 'status', 'mail']);
const BINDING_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BINDING_RESERVED = /^(FUNX_|SCF_|TENCENTCLOUD_|X_SCF_|NODE_|NPM_|LD_|_)/i;

// Beijing time, same format as the SCF API ("2026-10-10 17:02:11").
export function bjNow(d = new Date()) { return new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }

function mockBackend({ storage, baseDomain, runLive }) {
  const KEY = 'funx.mock';
  const load = () => { try { return JSON.parse(storage.getItem(KEY)) || null; } catch { return null; } };
  let db = load() || { workers: {} };
  const save = () => storage.setItem(KEY, JSON.stringify(db));
  const err = (status, code, message) => { throw new ApiError(status, code, message); };
  const view = (w) => ({ name: w.name, url: `https://${w.name}.${baseDomain}`, status: 'Active', disabled: w.disabled, routed: true, owner: w.owner, last_deploy: w.modTime, modTime: w.modTime, vars: { ...w.vars }, secrets: Object.keys(w.secrets).sort(), domain: 'ready' });
  const checkBinding = (k) => { if (!BINDING_RE.test(k) || BINDING_RESERVED.test(k)) err(400, 'bad_name', `${k}: reserved or invalid name`); };

  return {
    async handle(method, path, body, token) {
      const parts = path.split('/').filter(Boolean).map(decodeURIComponent).slice(1);
      if (parts[0] === 'auth' && parts[1] === 'setup') {
        // Mock: tokens starting with "demo" are valid until used once; anything else is expired.
        const used = JSON.parse(storage.getItem('funx.mock.used') || '[]');
        const tok = String((body && body.token) || '');
        if (!tok.startsWith('demo') || used.includes(tok)) err(410, 'link_expired', 'this link has expired or was already used');
        const email = 'admin@example.com';
        if (parts[2] === 'check') return { ok: true, email };
        if (String(body.password || '').length < 10) err(400, 'bad_password', 'password must be at least 10 characters');
        used.push(tok); storage.setItem('funx.mock.used', JSON.stringify(used));
        return { token: `mock.${btoa(email).replace(/=/g, '')}.local`, user: { id: 'admin', email, role: 'admin' } };
      }
      if (parts[0] === 'auth') {
        if (!body || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(body.email || '').trim())) err(400, 'bad_credentials', 'invalid email');
        if (String(body.password || '').length < 10) err(400, 'bad_credentials', 'password must be at least 10 characters');
        const email = body.email.trim().toLowerCase();
        return { token: `mock.${btoa(email).replace(/=/g, '')}.local`, user: { id: email, email, role: 'user' } };
      }
      if (!token) err(401, 'unauthorized');
      if (parts[0] !== 'workers') err(404, 'not_found');
      if (parts.length === 1 && method === 'GET') {
        return { workers: Object.values(db.workers).sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ name: w.name, url: `https://${w.name}.${baseDomain}`, status: 'Active', disabled: w.disabled, routed: true, last_deploy: w.modTime })) };
      }
      const name = parts[1];
      const sub = parts.slice(2).join('/');
      if (sub === 'deploy' && method === 'POST') {
        if (!NAME_RE.test(name || '') || RESERVED.has(name)) err(400, 'bad_name', 'name must be 3-32 chars of a-z, 0-9 or "-"');
        if (!body || typeof body.code !== 'string' || !body.code.trim()) err(400, 'no_code', 'code is empty');
        const w = db.workers[name] || { name, owner: 'me', disabled: false, vars: {}, secrets: {} };
        w.code = body.code; w.modTime = bjNow();
        db.workers[name] = w; save();
        return view(w);
      }
      const w = db.workers[name];
      if (!w) err(404, 'not_found');
      if (!sub && method === 'GET') return view(w);
      if (!sub && method === 'DELETE') { delete db.workers[name]; save(); return { deleted: name }; }
      if (sub === 'code' && method === 'GET') return { entry: 'worker.mjs', code: w.code, files: ['worker.mjs'] };
      if ((sub === 'disable' || sub === 'enable') && method === 'POST') { w.disabled = sub === 'disable'; save(); return { name, disabled: w.disabled }; }
      if (sub === 'vars' && method === 'PUT') { for (const k of Object.keys(body.vars || {})) checkBinding(k); Object.assign(w.vars, body.vars); for (const k of Object.keys(body.vars)) delete w.secrets[k]; save(); return { vars: { ...w.vars } }; }
      if (sub.startsWith('vars/') && method === 'DELETE') { delete w.vars[parts[3]]; save(); return { vars: { ...w.vars } }; }
      if (sub.startsWith('secrets/') && method === 'PUT') { checkBinding(parts[3]); w.secrets[parts[3]] = String(body.value ?? ''); delete w.vars[parts[3]]; save(); return { secrets: Object.keys(w.secrets).sort() }; }
      if (sub.startsWith('secrets/') && method === 'DELETE') { delete w.secrets[parts[3]]; save(); return { secrets: Object.keys(w.secrets).sort() }; }
      if (sub === 'logs') err(501, 'logs_unavailable', 'logs are not available yet');
      if (sub === 'invoke' && method === 'POST') {
        if (w.disabled) return { ok: true, status: 403, statusText: 'Forbidden', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'This site has been disabled.\n', bodyEncoding: 'utf8', ms: 1, size: 29 };
        if (!runLive) err(501, 'no_runner');
        return runLive({ code: w.code, name, env: { ...w.vars, ...w.secrets }, req: body });
      }
      err(404, 'not_found');
    },
  };
}
