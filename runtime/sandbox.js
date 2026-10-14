'use strict';
// Worker sandbox [R6]: one isolated-vm isolate per worker version, never shared between workers.
// The isolate gets only the Web APIs from prelude.js; host bridges are small References (URL parse, random bytes,
// console, sleep, fetch). Data crosses as copies only.
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const ivm = require('./ivm');

const PRELUDE = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');
const DEFAULTS = {
  memoryMb: 64, cpuMs: 50, wallMs: 30000, startupMs: 1000, maxSubrequests: 50,
  maxIsolates: 16, maxTotalHeapMb: 512, logLineMax: 4096, logLinesMax: 50, maxResponseBytes: 10 * 1024 * 1024,
};

class WorkerError extends Error { constructor(code, message) { super(message); this.code = code; } }

function parseUrlForIsolate(href, base, field, value) {
  try {
    const u = base == null ? new URL(href) : new URL(href, base);
    if (field) u[field] = value;
    const o = {};
    for (const k of ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) o[k] = u[k];
    return o;
  } catch { return null; }
}

function normPath(p) {
  const out = [];
  for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg); }
  return out.join('/');
}

class Sandbox {
  constructor({ egress, log = () => {}, limits = {} } = {}) {
    this.egress = egress; this.log = log; this.limits = { ...DEFAULTS, ...limits };
    this.cache = new Map(); // name -> slot (Map keeps insertion order = LRU order)
  }

  // bundle: { entry, files: { path: source } }
  async _build(name, version, bundle) {
    const L = this.limits;
    const iso = new ivm.Isolate({ memoryLimit: L.memoryMb });
    const slot = { name, version, iso, logs: [], subrequests: 0, disposed: false };
    try {
      const ctx = await iso.createContext();
      const g = ctx.global;
      await g.set('globalThis', g.derefInto());
      const host = {
        url: new ivm.Reference((href, base, field, value) => new ivm.ExternalCopy(parseUrlForIsolate(href, base, field, value)).copyInto()),
        rand: new ivm.Reference((n) => new ivm.ExternalCopy(nodeCrypto.randomBytes(Math.min(65536, Math.max(0, n | 0))).buffer).copyInto()),
        log: new ivm.Reference((level, line) => {
          if (slot.logs.length >= L.logLinesMax) return;
          slot.logs.push({ level: String(level), line: String(line).slice(0, L.logLineMax) });
        }),
        sleep: new ivm.Reference((ms) => new Promise((r) => { const t = setTimeout(r, Math.min(Number(ms) || 0, L.wallMs + 1000)); if (t.unref) t.unref(); })),
        fetch: new ivm.Reference(async (metaJson, body) => {
          try {
            if (++slot.subrequests > L.maxSubrequests) throw new WorkerError('subrequests', `too many subrequests (max ${L.maxSubrequests})`);
            if (!this.egress) throw new WorkerError('egress', 'fetch is not available');
            const meta = JSON.parse(metaJson);
            const r = await this.egress(meta.url, { method: meta.method, headers: meta.headers, body: body ? Buffer.from(body) : null, redirect: meta.redirect });
            const ab = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
            return new ivm.ExternalCopy({ status: r.status, statusText: r.statusText, headers: r.headers, body: ab, url: r.url, redirected: r.redirected }).copyInto();
          } catch (e) {
            return new ivm.ExternalCopy({ error: `fetch failed: ${e && e.message ? e.message : 'error'}` }).copyInto();
          }
        }),
      };
      await g.set('__funxHost', new ivm.ExternalCopy({}).copyInto());
      const hostObj = await g.get('__funxHost', { reference: true });
      for (const [k, v] of Object.entries(host)) await hostObj.set(k, v);
      await (await iso.compileScript(PRELUDE, { filename: 'funx:prelude.js' })).run(ctx, { timeout: L.startupMs });

      // ES modules of the bundle; relative imports only.
      const files = bundle.files || {};
      const modules = new Map();
      const compile = async (p) => {
        if (modules.has(p)) return modules.get(p);
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new WorkerError('module', `module not found: ${p}`);
        let src = String(files[p]);
        if (p.endsWith('.json')) src = `export default ${JSON.stringify(JSON.parse(src))};`;
        else if (/\.(txt|html|css|md)$/.test(p)) src = `export default ${JSON.stringify(src)};`;
        const m = await iso.compileModule(src, { filename: `file:///${p}` });
        modules.set(p, m);
        return m;
      };
      const resolver = async (spec, referrer) => {
        if (!/^\.\.?\//.test(spec)) throw new WorkerError('module', `cannot import "${spec}": only relative imports of uploaded files are supported (bundle npm packages first)`);
        const from = (referrer.__funxPath || '').split('/').slice(0, -1).join('/');
        const p = normPath(`${from}/${spec}`);
        if (p == null) throw new WorkerError('module', `bad import path ${spec}`);
        const m = await compile(p);
        m.__funxPath = p;
        return m;
      };
      const main = await compile(bundle.entry);
      main.__funxPath = bundle.entry;
      await main.instantiate(ctx, resolver);
      await main.evaluate({ timeout: L.startupMs, promise: true });
      const setEntry = await g.get('__funxSetEntry', { reference: true });
      await setEntry.apply(undefined, [main.namespace.derefInto()]);
      slot.ctx = ctx;
      slot.dispatch = await g.get('__funxDispatch', { reference: true });
      slot.drain = await g.get('__funxDrain', { reference: true });
      return slot;
    } catch (e) {
      this._dispose(slot);
      if (e instanceof WorkerError) throw e;
      throw new WorkerError('startup', `worker failed to start: ${e && e.message ? e.message : e}`);
    }
  }

  _dispose(slot) {
    if (slot.disposed) return;
    slot.disposed = true;
    try { if (!slot.iso.isDisposed) slot.iso.dispose(); } catch { /* already gone */ }
    if (this.cache.get(slot.name) === slot) this.cache.delete(slot.name);
  }

  _evict() {
    const L = this.limits;
    let total = 0;
    for (const s of this.cache.values()) { try { total += s.iso.getHeapStatisticsSync().total_heap_size; } catch { /* disposed */ } }
    for (const s of [...this.cache.values()]) {
      if (this.cache.size <= L.maxIsolates && total <= L.maxTotalHeapMb * 1048576) break;
      try { total -= s.iso.getHeapStatisticsSync().total_heap_size; } catch { /* disposed */ }
      this._dispose(s);
      this.log({ evict: s.name });
    }
  }

  async _slot(name, version, bundle) {
    let s = this.cache.get(name);
    if (s && (s.version !== version || s.disposed || s.iso.isDisposed)) { this._dispose(s); s = null; }
    if (!s) { s = await this._build(name, version, bundle); this.cache.set(name, s); this._evict(); }
    else { this.cache.delete(name); this.cache.set(name, s); } // LRU touch
    return s;
  }

  // req: { url, method, headers: [[k,v]], body: Buffer|null, cf }
  // -> { status, statusText, headers: [[k,v]], body: Buffer, logs, cpuMs, wallMs }
  async run({ name, version, bundle, env = {} }, req) {
    const L = this.limits;
    const slot = await this._slot(name, version, bundle);
    slot.logs = []; slot.subrequests = 0;
    const t0 = Date.now();
    const cpu0 = slot.iso.cpuTime;
    let timer; let killed = null;
    const watchdog = new Promise((_, reject) => {
      const tick = () => {
        if (slot.iso.isDisposed) return reject(new WorkerError(killed || 'memory', killed === 'cpu' ? 'worker exceeded its CPU time limit' : 'worker exceeded its memory limit'));
        const cpuMs = Number(slot.iso.cpuTime - cpu0) / 1e6;
        if (cpuMs > L.cpuMs) { killed = 'cpu'; this._dispose(slot); return reject(new WorkerError('cpu', 'worker exceeded its CPU time limit')); }
        if (Date.now() - t0 > L.wallMs) { killed = 'wall'; this._dispose(slot); return reject(new WorkerError('wall', 'worker exceeded its time limit')); }
        timer = setTimeout(tick, 5);
      };
      timer = setTimeout(tick, 5);
    });
    const meta = JSON.stringify({ url: req.url, method: req.method, headers: req.headers, cf: req.cf || {} });
    const body = req.body && req.body.length ? new ivm.ExternalCopy(req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength)).copyInto() : null;
    let out;
    try {
      out = await Promise.race([
        slot.dispatch.apply(undefined, [meta, body, new ivm.ExternalCopy(env).copyInto()], { result: { promise: true, copy: true }, timeout: L.cpuMs * 4 }),
        watchdog,
      ]);
    } catch (e) {
      clearTimeout(timer);
      if (slot.iso.isDisposed || /disposed|memory limit/i.test(String(e && e.message))) { this._dispose(slot); throw e instanceof WorkerError ? e : new WorkerError(killed || 'memory', killed === 'cpu' ? 'worker exceeded its CPU time limit' : 'worker exceeded its memory limit'); }
      if (/timed out/i.test(String(e && e.message))) { this._dispose(slot); throw new WorkerError('cpu', 'worker exceeded its CPU time limit'); }
      if (e instanceof WorkerError) throw e;
      throw new WorkerError('exception', `worker threw: ${e && e.message ? e.message : e}`);
    }
    const resBody = out.body ? Buffer.from(out.body) : Buffer.alloc(0);
    if (resBody.length > L.maxResponseBytes) { clearTimeout(timer); throw new WorkerError('too_large', 'worker response larger than 10 MB'); }
    const result = { status: out.status, statusText: out.statusText, headers: out.headers, body: resBody, logs: slot.logs, cpuMs: Number(slot.iso.cpuTime - cpu0) / 1e6, wallMs: Date.now() - t0 };
    // ctx.waitUntil work: finish within the same limits, after the response is ready.
    result.drained = Promise.race([slot.drain.apply(undefined, [], { result: { promise: true, copy: true } }), watchdog])
      .catch(() => {}).finally(() => { clearTimeout(timer); });
    return result;
  }

  stats() { return [...this.cache.values()].map((s) => ({ name: s.name, version: s.version, heap: s.iso.isDisposed ? 0 : s.iso.getHeapStatisticsSync().used_heap_size })); }
  disposeAll() { for (const s of [...this.cache.values()]) this._dispose(s); }
}

module.exports = { Sandbox, WorkerError, DEFAULTS, parseUrlForIsolate };
