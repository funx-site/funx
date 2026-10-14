// Runs INSIDE each worker isolate before the worker's modules. Plain JS, no Node.
// Host bridges arrive as globalThis.__funxHost (ivm References); they are captured here and the global is deleted,
// so worker code can only reach them through the Web APIs defined below.
(function () {
  'use strict';
  const H = globalThis.__funxHost; delete globalThis.__funxHost;
  const SYNC = { arguments: { copy: true }, result: { copy: true } };
  const ASYNC = { arguments: { copy: true }, result: { copy: true, promise: true } };
  const def = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });

  // ---------- text ----------
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s = '') {
      s = String(s); const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd; } else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
        if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    constructor(label = 'utf-8') { if (!/^utf-?8$/i.test(label)) throw new RangeError('only utf-8 is supported'); }
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input == null) return '';
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let s = ''; const parts = [];
      for (let i = 0; i < b.length;) {
        const c = b[i]; let cp = 0xfffd; let n = 1;
        if (c < 0x80) cp = c;
        else if (c >= 0xc2 && c < 0xe0 && (b[i + 1] & 0xc0) === 0x80) { cp = ((c & 31) << 6) | (b[i + 1] & 63); n = 2; }
        else if (c >= 0xe0 && c < 0xf0 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) { cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); n = 3; if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) cp = 0xfffd; }
        else if (c >= 0xf0 && c < 0xf5 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) { cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); n = 4; if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd; }
        if (cp > 0xffff) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else s += String.fromCharCode(cp);
        i += n;
        if (s.length > 8192) { parts.push(s); s = ''; }
      }
      parts.push(s);
      return parts.join('');
    }
  }
  const enc = new TextEncoder(); const dec = new TextDecoder();
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(s) {
    s = String(s); let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: string contains characters outside Latin1');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function atob(s) {
    s = String(s).replace(/[\t\n\f\r ]/g, ''); if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw new Error('atob: invalid base64');
    let out = ''; let bits = 0; let buf = 0;
    for (const ch of s) { buf = (buf << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); } }
    return out;
  }

  // ---------- bytes helpers ----------
  function toBytes(body) {
    if (body == null) return null;
    if (typeof body === 'string') return enc.encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    if (body instanceof URLSearchParams) return enc.encode(body.toString());
    if (body && body.__funxBytes instanceof Uint8Array) return new Uint8Array(body.__funxBytes);
    return enc.encode(String(body));
  }
  const bytesToAB = (u) => (u ? u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) : null);

  // ---------- Headers ----------
  const normName = (n) => { n = String(n).toLowerCase(); if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(n)) throw new TypeError(`invalid header name: ${n}`); return n; };
  const normVal = (v) => String(v).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  class Headers {
    constructor(init) {
      this._m = new Map(); // name -> [values]
      if (init instanceof Headers) for (const [k, v] of init._m) this._m.set(k, v.slice());
      else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === 'function')) for (const [k, v] of init) this.append(k, v);
      else if (init && typeof init === 'object') for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    append(k, v) { k = normName(k); const a = this._m.get(k); if (a) a.push(normVal(v)); else this._m.set(k, [normVal(v)]); }
    set(k, v) { this._m.set(normName(k), [normVal(v)]); }
    get(k) { const a = this._m.get(normName(k)); return a ? a.join(', ') : null; }
    getSetCookie() { return (this._m.get('set-cookie') || []).slice(); }
    has(k) { return this._m.has(normName(k)); }
    delete(k) { this._m.delete(normName(k)); }
    forEach(cb, self) { for (const [k, v] of this) cb.call(self, v, k, this); }
    *entries() { for (const k of [...this._m.keys()].sort()) { if (k === 'set-cookie') for (const v of this._m.get(k)) yield [k, v]; else yield [k, this._m.get(k).join(', ')]; } }
    *keys() { for (const [k] of this.entries()) yield k; }
    *values() { for (const [, v] of this.entries()) yield v; }
    [Symbol.iterator]() { return this.entries(); }
    get [Symbol.toStringTag]() { return 'Headers'; }
  }

  // ---------- URL / URLSearchParams ----------
  class URLSearchParams {
    constructor(init = '') {
      this._l = []; this._u = null;
      if (init instanceof URLSearchParams) this._l = init._l.map((p) => p.slice());
      else if (typeof init === 'string') this._parse(init);
      else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === 'function')) for (const [k, v] of init) this._l.push([String(k), String(v)]);
      else if (init && typeof init === 'object') for (const k of Object.keys(init)) this._l.push([k, String(init[k])]);
    }
    _parse(s) {
      this._l = [];
      s = String(s); if (s[0] === '?') s = s.slice(1);
      const d = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
      for (const part of s.split('&')) { if (!part) continue; const i = part.indexOf('='); this._l.push(i < 0 ? [d(part), ''] : [d(part.slice(0, i)), d(part.slice(i + 1))]); }
    }
    _upd() { if (this._u) { const q = this.toString(); this._u._set('search', q ? '?' + q : ''); } }
    append(k, v) { this._l.push([String(k), String(v)]); this._upd(); }
    delete(k) { this._l = this._l.filter((p) => p[0] !== String(k)); this._upd(); }
    get(k) { const p = this._l.find((x) => x[0] === String(k)); return p ? p[1] : null; }
    getAll(k) { return this._l.filter((x) => x[0] === String(k)).map((x) => x[1]); }
    has(k) { return this._l.some((x) => x[0] === String(k)); }
    set(k, v) { k = String(k); const i = this._l.findIndex((x) => x[0] === k); if (i < 0) this._l.push([k, String(v)]); else { this._l[i][1] = String(v); this._l = this._l.filter((x, j) => j <= i || x[0] !== k); } this._upd(); }
    sort() { this._l.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._upd(); }
    forEach(cb, self) { for (const [k, v] of this._l) cb.call(self, v, k, this); }
    get size() { return this._l.length; }
    *entries() { for (const p of this._l) yield [p[0], p[1]]; }
    *keys() { for (const p of this._l) yield p[0]; }
    *values() { for (const p of this._l) yield p[1]; }
    [Symbol.iterator]() { return this.entries(); }
    toString() { const e = (x) => encodeURIComponent(x).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); return this._l.map(([k, v]) => `${e(k)}=${e(v)}`).join('&'); }
  }
  const URL_FIELDS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
  class URL {
    constructor(url, base) {
      const r = H.url.applySync(undefined, [String(url), base === undefined ? null : String(base), null, null], SYNC);
      if (!r) throw new TypeError(`Invalid URL: ${String(url)}`);
      this._p = r; this._sp = new URLSearchParams(r.search); this._sp._u = this;
    }
    _set(field, value) {
      const r = H.url.applySync(undefined, [this._p.href, null, field, String(value)], SYNC);
      if (r) { this._p = r; if (field !== 'search') { this._sp._parse(r.search); } }
    }
    get searchParams() { return this._sp; }
    toString() { return this._p.href; }
    toJSON() { return this._p.href; }
    static canParse(u, b) { try { new URL(u, b); return true; } catch { return false; } }
  }
  for (const f of URL_FIELDS) {
    Object.defineProperty(URL.prototype, f, {
      get() { return this._p[f]; },
      set: f === 'origin' ? undefined : function (v) { this._set(f, v); if (f === 'search') this._sp._parse(this._p.search); },
      enumerable: true, configurable: true,
    });
  }

  // ---------- Body / Request / Response ----------
  function bodyInit(self, body, headers) {
    self._b = toBytes(body); self._used = false;
    if (body != null && !headers.has('content-type')) {
      if (typeof body === 'string') headers.set('content-type', 'text/plain;charset=UTF-8');
      else if (body instanceof URLSearchParams) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
  }
  const BodyMixin = {
    _take() { if (this._used) throw new TypeError('Body has already been used'); this._used = true; return this._b || new Uint8Array(0); },
    async text() { return dec.decode(this._take()); },
    async json() { return JSON.parse(dec.decode(this._take())); },
    async arrayBuffer() { return bytesToAB(this._take()); },
    async bytes() { return new Uint8Array(this._take()); },
    async formData() { throw new TypeError('formData() is not supported on Funx yet'); },
    async blob() { throw new TypeError('blob() is not supported on Funx yet'); },
  };
  const bodyProps = {
    bodyUsed: { get() { return this._used; } },
    // Bodies are buffered (no streams yet); this stand-in can be passed on as another body.
    body: { get() { return this._b && this._b.length ? Object.freeze({ locked: false, __funxBytes: this._b }) : null; } },
  };

  class Request {
    constructor(input, init = {}) {
      const src = input instanceof Request ? input : null;
      this._url = src ? src._url : new URL(String(input)).href;
      this.method = String(init.method || (src ? src.method : 'GET')).toUpperCase();
      this.headers = new Headers(init.headers || (src ? src.headers : undefined));
      this.redirect = init.redirect || (src ? src.redirect : 'follow');
      this.cf = (src && src.cf) || {};
      this.signal = init.signal || null;
      const body = init.body !== undefined ? init.body : (src && src._b ? src._b : null);
      if (body != null && (this.method === 'GET' || this.method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body');
      bodyInit(this, body, this.headers);
    }
    get url() { return this._url; }
    clone() { if (this._used) throw new TypeError('Body has already been used'); return new Request(this); }
  }
  Object.assign(Request.prototype, BodyMixin); Object.defineProperties(Request.prototype, bodyProps);

  class Response {
    constructor(body = null, init = {}) {
      const status = init.status === undefined ? 200 : Number(init.status);
      if (!(status >= 200 && status <= 599) && status !== 101) throw new RangeError(`invalid status ${init.status}`);
      this.status = status; this.statusText = String(init.statusText || ''); this.headers = new Headers(init.headers);
      this.type = 'default'; this.url = ''; this.redirected = false; this.webSocket = null;
      bodyInit(this, body, this.headers);
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() { if (this._used) throw new TypeError('Body has already been used'); const r = new Response(this._b, this); r.url = this.url; r.redirected = this.redirected; return r; }
    static json(data, init = {}) { const h = new Headers(init.headers); if (!h.has('content-type')) h.set('content-type', 'application/json'); return new Response(JSON.stringify(data), { ...init, headers: h }); }
    static redirect(url, status = 302) { if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('invalid redirect status'); return new Response(null, { status, headers: { location: new URL(String(url)).href } }); }
    static error() { const r = new Response(null, { status: 200 }); r.status = 0; r.type = 'error'; return r; }
  }
  Object.assign(Response.prototype, BodyMixin); Object.defineProperties(Response.prototype, bodyProps);

  // ---------- fetch ----------
  async function fetch(input, init = {}) {
    const req = input instanceof Request && !Object.keys(init).length ? input : new Request(input, init);
    const meta = { url: req.url, method: req.method, headers: [...req.headers], redirect: req.redirect };
    const r = await H.fetch.apply(undefined, [JSON.stringify(meta), bytesToAB(req._b)], ASYNC);
    if (r.error) throw new TypeError(r.error);
    const res = new Response(r.status === 204 || r.status === 304 || req.method === 'HEAD' ? null : r.body, { status: r.status < 200 ? 200 : r.status, statusText: r.statusText, headers: r.headers });
    if (r.status < 200) res.status = r.status;
    res.url = r.url; res.redirected = r.redirected;
    return res;
  }

  // ---------- crypto, console, timers ----------
  const crypto = {
    getRandomValues(a) {
      if (!ArrayBuffer.isView(a) || a instanceof Float32Array || a instanceof Float64Array || (typeof DataView !== 'undefined' && a instanceof DataView)) throw new TypeError('getRandomValues: integer typed array required');
      if (a.byteLength > 65536) throw new RangeError('getRandomValues: at most 65536 bytes');
      const b = new Uint8Array(H.rand.applySync(undefined, [a.byteLength], SYNC));
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(b);
      return a;
    },
    randomUUID() {
      const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
  const fmt = (a) => a.map((x) => { if (typeof x === 'string') return x; if (x instanceof Error) return `${x.name}: ${x.message}`; try { return JSON.stringify(x); } catch { return String(x); } }).join(' ');
  const console = {};
  for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) console[lvl] = (...a) => { H.log.applyIgnored(undefined, [lvl, fmt(a)], { arguments: { copy: true } }); };
  let timerId = 0; const timers = new Map();
  function setTimeout(fn, ms = 0, ...args) {
    const id = ++timerId; timers.set(id, true);
    H.sleep.apply(undefined, [Math.max(0, Number(ms) || 0)], ASYNC).then(() => { if (timers.delete(id)) fn(...args); });
    return id;
  }
  function clearTimeout(id) { timers.delete(id); }
  const structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  for (const [k, v] of Object.entries({ TextEncoder, TextDecoder, atob, btoa, Headers, URL, URLSearchParams, Request, Response, fetch, crypto, console, setTimeout, clearTimeout, structuredClone, queueMicrotask: (f) => Promise.resolve().then(f) })) def(k, v);
  def('self', globalThis);
  def('navigator', Object.freeze({ userAgent: 'Funx' }));

  // ---------- dispatch (called by the host per request) ----------
  let entry = null;
  def('__funxSetEntry', (ns) => { entry = ns && ns.default; delete globalThis.__funxSetEntry; });
  let pending = [];
  def('__funxDispatch', async (metaJson, body, env) => {
    const meta = JSON.parse(metaJson);
    if (!entry || typeof entry.fetch !== 'function') throw new Error('worker has no `export default { fetch }`');
    const req = new Request(meta.url, { method: meta.method, headers: meta.headers, body: body && body.byteLength ? body : null });
    req.cf = meta.cf || {};
    const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil:', e))); }, passThroughOnException() {} };
    let res = await entry.fetch(req, Object.freeze({ ...env }), ctx);
    if (!(res instanceof Response)) throw new Error('fetch() must return a Response');
    return { status: res.status, statusText: res.statusText, headers: [...res.headers], body: bytesToAB(res._b) };
  });
  def('__funxDrain', async () => { const p = pending; pending = []; await Promise.allSettled(p); return p.length; });
})();
