'use strict';
// funx-runtime: one SCF Web function (HK) serving every <name>.funx.run [R1][R4].
// No role, no VPC. Env holds only FUNX_RUNTIME_TOKEN (code-fetch token); apiBase/baseDomain come from config.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseHost } = require('../lib/names');
const { Sandbox } = require('./sandbox');
const { createEgress } = require('./egress');

const MAX_BODY = 1024 * 1024;
const DROP_IN = /^(x-funx-|x-scf-|x-forwarded-|x-real-ip$|connection$|keep-alive$|transfer-encoding$|upgrade$|te$|trailer$|proxy-)/;
const DROP_OUT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length']);

function page(status, title, msg) {
  return { status, headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']], body: Buffer.from(`${title}\n\n${msg}\n`) };
}

function createRuntime({ apiBase, token, baseDomain = 'funx.run', sandbox, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 5000, staleMs = 60000, log = () => {} }) {
  if (!/^https:\/\//.test(apiBase) && !/^http:\/\/127\.0\.0\.1[:/]/.test(apiBase)) throw new Error('apiBase must be https');
  if (!/^fxrt_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('FUNX_RUNTIME_TOKEN missing or malformed');
  const configs = new Map(); // name -> { cfg|null, at, okAt }

  async function fetchConfig(name, have) {
    const u = `${apiBase.replace(/\/$/, '')}/v1/runtime/workers/${encodeURIComponent(name)}${have ? `?have=${have}` : ''}`;
    const r = await fetchImpl(u, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error(`config fetch ${r.status}`);
    return r.json();
  }

  async function getConfig(name) {
    const c = configs.get(name);
    const t = now();
    if (c && t - c.at < ttlMs) return c.cfg;
    try {
      const r = await fetchConfig(name, c && c.cfg ? c.cfg.version : null);
      if (r.missing) { configs.set(name, { cfg: null, at: t, okAt: t }); return null; }
      const cfg = r.unchanged && c && c.cfg && c.cfg.version === r.version ? { ...c.cfg, disabled: r.disabled } : r;
      configs.set(name, { cfg, at: t, okAt: t });
      if (configs.size > 256) configs.delete(configs.keys().next().value);
      return cfg;
    } catch (e) {
      log({ err: 'config', w: name, msg: String(e && e.message).slice(0, 120) });
      if (c && t - c.okAt < staleMs) return c.cfg; // funx-api briefly unreachable: serve what we had
      throw Object.assign(new Error('config unavailable'), { unavailable: true });
    }
  }

  async function handle(req) {
    const host = String(req.headers.host || '');
    const h = parseHost(host, baseDomain);
    if (h.kind === 'apex') return page(200, 'funx', `Write a fetch handler, get a URL: https://<name>.${baseDomain}`);
    if (h.kind !== 'site') return page(404, 'Not found', 'There is no worker at this address.');
    let cfg;
    try { cfg = await getConfig(h.name); } catch { return page(503, 'Temporarily unavailable', 'Please try again in a moment.'); }
    if (!cfg) return page(404, 'Not found', `There is no worker named ${h.name}.`);
    if (cfg.disabled) return page(403, 'Disabled', 'This worker has been disabled.');
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i].toLowerCase(); if (!DROP_IN.test(k)) headers.push([k, req.rawHeaders[i + 1]]); }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) headers.push(['cf-connecting-ip', ip]);
    const url = `https://${h.name}.${baseDomain}${req.url.startsWith('/') ? req.url : '/'}`;
    const method = String(req.method || 'GET').toUpperCase();
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return page(413, 'Too large', 'Request body larger than 1 MB.'); chunks.push(c); }
    const t0 = now();
    try {
      const r = await sandbox.run({ name: h.name, version: cfg.version, bundle: { entry: cfg.entry, files: cfg.files }, env: cfg.env || {} },
        { url, method, headers, body: method === 'GET' || method === 'HEAD' ? null : Buffer.concat(chunks) });
      log({ w: h.name, s: r.status, ms: now() - t0, cpu: Math.round(r.cpuMs * 10) / 10, logs: r.logs.length ? r.logs : undefined });
      return { ...r, headers: r.headers.filter(([k]) => !DROP_OUT.has(k)) };
    } catch (e) {
      log({ w: h.name, err: e.code || 'error', msg: String(e && e.message).slice(0, 300), ms: now() - t0 });
      if (e.code === 'cpu' || e.code === 'wall') return page(503, 'Worker exceeded its limits', e.message);
      if (e.code === 'memory') return page(503, 'Worker exceeded its limits', e.message);
      return page(500, 'Worker error', e.code === 'startup' || e.code === 'module' ? e.message : 'The worker threw an exception.');
    }
  }

  const handler = async (req, res) => {
    let out;
    try { out = await handle(req); } catch (e) { log({ err: 'runtime', msg: String(e && e.message).slice(0, 200) }); out = page(500, 'Error', 'Internal error.'); }
    const hdrs = {};
    for (const [k, v] of out.headers) { if (k === 'set-cookie') (hdrs[k] = hdrs[k] || []).push(v); else hdrs[k] = hdrs[k] ? `${hdrs[k]}, ${v}` : v; }
    hdrs['content-length'] = out.body.length;
    res.writeHead(out.status, out.statusText || undefined, hdrs);
    res.end(String(req.method).toUpperCase() === 'HEAD' ? undefined : out.body);
    if (out.drained) await out.drained;
  };
  handler.configs = configs;
  return handler;
}

function fromEnv(env = process.env) {
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const token = env.FUNX_RUNTIME_TOKEN;
  delete process.env.FUNX_RUNTIME_TOKEN; // nothing else in this process needs it from the environment
  const log = (o) => console.log(JSON.stringify(o));
  const egress = createEgress({ deniedHosts: [new URL(conf.apiBase).hostname] });
  const sandbox = new Sandbox({ egress, log, limits: conf.limits || {} });
  return createRuntime({ apiBase: conf.apiBase, token, baseDomain: conf.baseDomain || 'funx.run', sandbox, log });
}

if (require.main === module) {
  http.createServer(fromEnv()).listen(Number(process.env.PORT) || 9000, '0.0.0.0');
}

module.exports = { createRuntime, fromEnv };
