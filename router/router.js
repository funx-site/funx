'use strict';
// funx-router: maps <name>.funx.run to the user function's (secret) function URL and forwards over HTTPS.
// No role, no SDK, no VPC. Never logs bodies, query strings or headers.

const { parseHost } = require('../lib/names');
const { stripHeaders, scopeSetCookie, ROUTE_KEY_HEADER } = require('../lib/headers');
const { originHost } = require('../lib/routes');

const DEFAULTS = {
  baseDomain: 'funx.run',
  region: 'ap-hongkong',
  maxRequestBytes: 1024 * 1024, // 1 MB in
  maxResponseBytes: 6 * 1024 * 1024, // 6 MB out (SCF sync limit)
  timeoutMs: 12000, // user functions time out at 10 s
};

class TooLarge extends Error {}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    stream.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        stream.resume(); // drain and discard the rest
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readResponse(resp, limit) {
  const len = Number(resp.headers.get('content-length'));
  if (Number.isFinite(len) && len > limit) throw new TooLarge();
  if (!resp.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const c of resp.body) {
    size += c.length;
    if (size > limit) {
      try { await resp.body.cancel(); } catch { /* ignore */ }
      throw new TooLarge();
    }
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', ...headers });
  res.end(buf);
}

function createRouter(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const fetchImpl = cfg.fetch || globalThis.fetch;
  const getRoutes = typeof cfg.routes === 'function' ? cfg.routes : () => cfg.routes;
  const log = cfg.log || (() => {});

  return async function handle(req, res) {
    const started = Date.now();
    let name = '-';
    let status = 500;
    try {
      status = await route();
    } catch {
      status = 500;
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.destroy();
    } finally {
      log({ n: name, s: status, ms: Date.now() - started });
    }

    async function route() {
      const parsed = parseHost(req.headers.host, cfg.baseDomain);
      if (parsed.kind === 'apex') { send(res, 200, 'funx\n'); return 200; }
      if (parsed.kind !== 'site') { send(res, 404, 'Not found\n'); return 404; }
      name = parsed.name;

      const r = getRoutes().get(name);
      if (!r) { send(res, 404, 'Not found\n'); return 404; }
      if (r.disabled) { send(res, 403, 'This site has been disabled.\n'); return 403; }

      // Only origin-form request targets; never let the path change the upstream host.
      if (typeof req.url !== 'string' || !req.url.startsWith('/')) { send(res, 400, 'Bad request\n'); return 400; }

      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > cfg.maxRequestBytes) {
        req.resume();
        send(res, 413, 'Payload too large\n', { connection: 'close' });
        return 413;
      }
      let body;
      try {
        body = await readBody(req, cfg.maxRequestBytes);
      } catch (e) {
        if (e instanceof TooLarge) { send(res, 413, 'Payload too large\n', { connection: 'close' }); return 413; }
        throw e;
      }

      // Client-sent x-funx-* / x-scf-* / hop-by-hop / host are dropped, then trusted values added.
      const headers = stripHeaders(req.headers, { extra: ['host', 'content-length', 'accept-encoding', 'x-forwarded-host', 'x-forwarded-proto'] });
      headers['x-forwarded-host'] = `${name}.${cfg.baseDomain}`;
      headers['x-forwarded-proto'] = 'https';
      headers['accept-encoding'] = 'identity';
      headers[ROUTE_KEY_HEADER] = r.key;

      const method = (req.method || 'GET').toUpperCase();
      const url = `https://${originHost(r.originId, cfg.region)}${req.url}`;
      let resp;
      try {
        resp = await fetchImpl(url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'manual',
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) { send(res, 504, 'Gateway timeout\n'); return 504; }
        send(res, 502, 'Bad gateway\n');
        return 502;
      }

      let out;
      try {
        out = await readResponse(resp, cfg.maxResponseBytes);
      } catch (e) {
        if (e instanceof TooLarge) { send(res, 502, 'Response too large\n'); return 502; }
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) { send(res, 504, 'Gateway timeout\n'); return 504; }
        send(res, 502, 'Bad gateway\n');
        return 502;
      }

      // fetch already decoded any content-encoding, so drop it along with the length.
      const rh = stripHeaders(resp.headers, { extra: ['content-length', 'content-encoding'] });
      if (rh['set-cookie']) rh['set-cookie'] = scopeSetCookie(rh['set-cookie']);
      rh['content-length'] = method === 'HEAD' ? (resp.headers.get('content-length') || '0') : out.length;
      res.writeHead(resp.status, rh);
      res.end(method === 'HEAD' ? undefined : out);
      return resp.status;
    }
  };
}

module.exports = { createRouter, DEFAULTS };
