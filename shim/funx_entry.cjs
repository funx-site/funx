'use strict';
// Funx entry shim. Packaged into every user function as the SCF Web function entry (funx_entry.cjs,
// .cjs so it still loads when the user's package.json says "type": "module").
//
// 1. Rejects any request without the per-function route key the router adds, so the function URL
//    cannot be used to bypass funx-router (kill switch, header hygiene). `funx dev` turns this off.
// 2. Loads the user's code in one of three formats:
//      workers module   export default { async fetch(request, env, ctx) {} }   (ESM or CJS)
//      service worker   addEventListener('fetch', (event) => event.respondWith(...))
//      v1 handler       exports.handler = async (event, context) => ({ statusCode, headers, body })
// 3. Converts the incoming HTTP request to a standard Request, calls the user's code, and writes the
//    Response back (status, headers incl. several Set-Cookie, binary bodies).
//
// Self-contained (no requires outside node core): it sits at the root of the user's package.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const vm = require('vm');

const KEY_HEADER = 'x-funx-route-key';
const MAX_BODY = 6 * 1024 * 1024;
const WAIT_UNTIL_MS = 5000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const META_ENV = 'FUNX_META'; // {"v":[var names],"s":[secret names]} written by the platform
const MANIFEST = 'funx.json'; // {"entry":"worker.mjs"} written by the packager

// Read platform values once and remove them from the environment before user code loads.
const ROUTE_KEY = process.env.FUNX_ROUTE_KEY || '';
delete process.env.FUNX_ROUTE_KEY;
const META_RAW = process.env[META_ENV] || '';
delete process.env[META_ENV];

// Node 18 gaps that Workers code commonly relies on.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
if (typeof Response !== 'undefined' && typeof Response.json !== 'function') {
  Response.json = (data, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), { ...init, headers });
  };
}

function keyMatches(given, key) {
  if (!key || typeof given !== 'string') return false;
  const g = Buffer.from(given);
  const k = Buffer.from(key);
  if (g.length !== k.length) return false;
  return crypto.timingSafeEqual(g, k);
}

// ---------- env (vars + secrets) ----------

function parseMeta(raw) {
  if (!raw) return { v: [], s: [] };
  try {
    const m = JSON.parse(raw);
    return { v: Array.isArray(m.v) ? m.v : [], s: Array.isArray(m.s) ? m.s : [] };
  } catch { return { v: [], s: [] }; }
}

// Only names the platform listed in FUNX_META become env bindings: never SCF_*, TENCENTCLOUD_*, PATH...
function buildEnv(source = process.env, metaRaw = META_RAW) {
  const meta = parseMeta(metaRaw);
  const env = {};
  for (const name of [...meta.v, ...meta.s]) {
    if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && source[name] !== undefined) env[name] = source[name];
  }
  return Object.freeze(env);
}

// ---------- loading user code ----------

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function resolveEntry(root) {
  const manifest = readJson(path.join(root, MANIFEST));
  if (manifest && typeof manifest.entry === 'string') return path.resolve(root, manifest.entry);
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && typeof pkg.main === 'string') return path.resolve(root, pkg.main);
  for (const f of ['index.mjs', 'index.js', 'index.cjs', 'worker.mjs', 'worker.js', 'src/index.mjs', 'src/index.js']) {
    if (fs.existsSync(path.join(root, f))) return path.join(root, f);
  }
  throw new Error('no entry file (index.js, index.mjs, worker.js or package.json "main")');
}

// True when the file must be loaded as ESM: .mjs, or "type":"module" in the nearest package.json,
// or (for .js) source that only parses as a module.
function isEsm(file) {
  if (file.endsWith('.mjs')) return true;
  if (file.endsWith('.cjs')) return false;
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    const pkg = readJson(path.join(d, 'package.json'));
    if (pkg) { if (pkg.type === 'module') return true; break; }
    if (path.dirname(d) === d) break;
  }
  return looksLikeEsm(fs.readFileSync(file, 'utf8'));
}

function looksLikeEsm(src) {
  try {
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`); // eslint-disable-line no-new
    return false;
  } catch (e) {
    return e instanceof SyntaxError && /(^|\n)\s*(import|export)\b/.test(src);
  }
}

// Captures addEventListener('fetch'|'scheduled') registrations made while the user module loads.
function serviceWorkerScope() {
  const listeners = { fetch: null, scheduled: null };
  const prev = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => {
    if (type === 'fetch' || type === 'scheduled') listeners[type] = fn;
    else if (typeof prev === 'function') prev.call(globalThis, type, fn);
  };
  return { listeners, restore() { if (prev) globalThis.addEventListener = prev; else delete globalThis.addEventListener; } };
}

// Returns { kind: 'module'|'sw'|'handler', fetch?, handler?, scheduled? }
async function loadUserCode(root, { entry, env = {} } = {}) {
  const file = entry ? path.resolve(root, entry) : resolveEntry(root);
  if (!fs.existsSync(file)) throw new Error(`entry file ${path.relative(root, file)} not found`);
  const sw = serviceWorkerScope();
  // Service-worker format: bindings are globals (as in Workers). Never overwrite an existing global.
  const added = [];
  for (const [k, v] of Object.entries(env)) if (!(k in globalThis)) { globalThis[k] = v; added.push(k); }
  let mod;
  try {
    if (isEsm(file)) {
      mod = await import(pathToFileURL(file).href);
    } else {
      mod = require(file);
    }
  } finally { sw.restore(); }
  const def = mod && mod.default;
  const exported = def && typeof def === 'object' ? def : mod;
  if (exported && typeof exported.fetch === 'function') {
    for (const k of added) delete globalThis[k];
    return { kind: 'module', fetch: exported.fetch.bind(exported), scheduled: typeof exported.scheduled === 'function' ? exported.scheduled.bind(exported) : null };
  }
  if (sw.listeners.fetch) return { kind: 'sw', fetch: sw.listeners.fetch, scheduled: sw.listeners.scheduled };
  for (const k of added) delete globalThis[k];
  const fn = mod.handler || mod.main_handler || (def && (def.handler || (typeof def === 'function' ? def : null)));
  if (typeof fn === 'function') return { kind: 'handler', handler: fn };
  throw new Error('entry must `export default { fetch(request, env, ctx) }`, call addEventListener("fetch", ...), or export handler(event)');
}

// ---------- request / response conversion ----------

function cleanHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || key.startsWith('x-scf-') || key.startsWith('x-funx-')) continue;
    out[key] = v;
  }
  if (out['x-forwarded-host']) out.host = out['x-forwarded-host'];
  return out;
}

function toRequest(req, raw, { host, proto = 'https' } = {}) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(cleanHeaders(req.headers))) {
    if (k === 'content-length') continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const h = host || headers.get('host') || 'localhost';
  const scheme = req.headers['x-forwarded-proto'] === 'http' ? 'http' : proto;
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && raw.length > 0;
  return new Request(`${scheme}://${h}${req.url}`, { method, headers, body: hasBody ? raw : undefined, duplex: 'half', redirect: 'manual' });
}

// Split a Set-Cookie list that an older fetch implementation joined with ", " (Node 18.15 has no
// Headers.getSetCookie). A comma starts a new cookie only when followed by `name=` before any ";".
function splitSetCookie(joined) {
  if (!joined) return [];
  return joined.split(/,(?=\s*[^;,=\s]+=)/).map((s) => s.trim()).filter(Boolean);
}

function responseHeaders(response) {
  const out = {};
  response.headers.forEach((v, k) => {
    if (k === 'set-cookie' || k === 'content-length' || HOP.has(k)) return;
    out[k] = v;
  });
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get('set-cookie'));
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

async function writeResponse(res, response, { method = 'GET', maxBytes = MAX_BODY } = {}) {
  const headers = responseHeaders(response);
  const chunks = [];
  let size = 0;
  if (response.body && method !== 'HEAD') {
    for await (const c of response.body) {
      size += c.byteLength;
      if (size > maxBytes) { try { await response.body.cancel(); } catch { /* ignore */ } throw new Error('response too large'); }
      chunks.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
    }
  }
  const body = Buffer.concat(chunks);
  headers['content-length'] = body.length;
  res.writeHead(response.status, response.statusText || undefined, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

// ---------- ctx ----------

function makeCtx() {
  const pending = [];
  return {
    ctx: {
      waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => console.error('funx: waitUntil rejected:', e && e.message))); },
      passThroughOnException() { /* no origin behind a Funx worker: errors become a 500 */ },
      props: {},
    },
    // On SCF the instance may be frozen once the response is complete, so background work is
    // awaited before the response finishes (bounded by WAIT_UNTIL_MS).
    async drain(ms = WAIT_UNTIL_MS) {
      if (!pending.length) return;
      let t;
      await Promise.race([Promise.allSettled(pending), new Promise((r) => { t = setTimeout(r, ms); })]);
      clearTimeout(t);
    },
  };
}

class FetchEvent {
  constructor(request, ctx) {
    this.type = 'fetch';
    this.request = request;
    this._ctx = ctx;
    this._response = null;
  }
  respondWith(r) { if (this._response) throw new Error('respondWith called twice'); this._response = Promise.resolve(r); }
  waitUntil(p) { this._ctx.waitUntil(p); }
  passThroughOnException() { this._ctx.passThroughOnException(); }
}

async function callWorker(code, request, env, ctx) {
  if (code.kind === 'module') return code.fetch(request, env, ctx);
  const ev = new FetchEvent(request, ctx);
  await code.fetch(ev);
  if (!ev._response) throw new Error('fetch listener did not call event.respondWith()');
  return ev._response;
}

// ---------- v1 handler(event) support ----------

function normalize(result) {
  if (result && typeof result === 'object' && !Buffer.isBuffer(result) && 'statusCode' in result) {
    const headers = {};
    for (const [k, v] of Object.entries(result.headers || {})) headers[k.toLowerCase()] = v;
    let body = result.body;
    if (body === undefined || body === null) body = Buffer.alloc(0);
    else if (Buffer.isBuffer(body)) { /* as is */ }
    else if (typeof body === 'string') body = Buffer.from(body, result.isBase64Encoded ? 'base64' : 'utf8');
    else { body = Buffer.from(JSON.stringify(body)); if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8'; }
    return { status: Number(result.statusCode) || 200, headers, body };
  }
  if (Buffer.isBuffer(result)) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: result };
  if (typeof result === 'string') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(result) };
  if (result === undefined) return { status: 204, headers: {}, body: Buffer.alloc(0) };
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(result)) };
}

async function callHandler(handler, req, raw) {
  const u = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(u.searchParams);
  const event = {
    method: req.method, httpMethod: req.method,
    path: u.pathname, query, queryString: query,
    headers: cleanHeaders(req.headers), body: raw.toString('utf8'), bodyBase64: raw.toString('base64'), isBase64Encoded: false,
  };
  const context = { functionName: process.env.SCF_FUNCTIONNAME, requestId: req.headers['x-scf-request-id'] };
  return normalize(await handler(event, context));
}

// ---------- server ----------

function createShim({
  root = __dirname, entry, routeKey = ROUTE_KEY, requireKey = true,
  env, loadHandler, loadCode, host, waitUntilMs = WAIT_UNTIL_MS, log = console.error,
} = {}) {
  const bindings = env || buildEnv();
  // loadHandler: legacy test hook returning a handler(event) function.
  const load = loadCode || (loadHandler ? async () => ({ kind: 'handler', handler: loadHandler(root) }) : () => loadUserCode(root, { entry, env: bindings }));
  let code = null;
  let loading = null;
  let loadError = null;

  return async function handle(req, res) {
    const reply = (status, text) => { if (res.headersSent) { res.destroy(); return; } res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text); };
    if (requireKey && !keyMatches(req.headers[KEY_HEADER], routeKey)) return reply(403, 'Forbidden\n');

    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return reply(413, 'Payload too large\n'); chunks.push(c); }
    } catch { return reply(400, 'Bad request\n'); }
    const raw = Buffer.concat(chunks);

    if (!code && !loadError) {
      loading = loading || Promise.resolve().then(load);
      try { code = await loading; } catch (e) { loadError = e; log('funx: failed to load worker:', e && e.message); }
    }
    if (loadError) return reply(500, 'Function failed to load\n');

    if (code.kind === 'handler') {
      let out;
      try { out = await callHandler(code.handler, req, raw); } catch (e) { log('funx: handler threw:', e && e.message); return reply(500, 'Internal Server Error\n'); }
      out.headers['content-length'] = out.body.length;
      res.writeHead(out.status, out.headers);
      res.end(req.method === 'HEAD' ? undefined : out.body);
      return;
    }

    const { ctx, drain } = makeCtx();
    let response;
    try {
      const request = toRequest(req, raw, { host });
      response = await callWorker(code, request, bindings, ctx);
      if (!(response instanceof Response)) throw new Error('fetch handler must return a Response');
    } catch (e) {
      log('funx: worker threw:', e && (e.stack || e.message));
      await drain(waitUntilMs);
      return reply(500, 'Internal Server Error\n');
    }
    try {
      // Read the body first (it may depend on work in flight), then let waitUntil work finish.
      const method = (req.method || 'GET').toUpperCase();
      const nullBody = method === 'HEAD' || response.body === null || NULL_BODY_STATUS.has(response.status);
      const buffered = new Response(nullBody ? null : await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
      await drain(waitUntilMs);
      await writeResponse(res, buffered, { method });
    } catch (e) {
      log('funx: response failed:', e && e.message);
      reply(502, 'Bad response from function\n');
    }
  };
}

function parseArgs(argv) {
  const out = { dev: false, entry: undefined, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dev') out.dev = true;
    else if (argv[i] === '--entry') out.entry = argv[++i];
    else if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}

if (require.main === module) {
  // --dev is passed only by `funx dev`; the SCF bootstrap never passes arguments.
  const a = parseArgs(process.argv.slice(2));
  const port = Number(process.env.PORT) || 9000;
  const shim = createShim({ root: a.root || __dirname, entry: a.entry, requireKey: !a.dev, host: a.dev ? `localhost:${port}` : undefined });
  http.createServer(shim).listen(port, a.dev ? '127.0.0.1' : '0.0.0.0', () => { if (a.dev && process.send) process.send({ ready: port }); });
}

module.exports = { createShim, normalize, keyMatches, buildEnv, loadUserCode, resolveEntry, isEsm, looksLikeEsm, toRequest, responseHeaders, splitSetCookie, writeResponse, makeCtx, FetchEvent };
