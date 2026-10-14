'use strict';
// Outbound fetch for workers [R3]: resolve DNS first, refuse private/link-local/loopback/etc. addresses and
// funx-api's own host, pin the connection to the checked address, follow redirects by hand (re-checking every hop).
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['2001:db8::', 32], ['2002::', 16], ['100::', 64]]) blocked.addSubnet(a, p, 'ipv6');

// Embedded IPv4 in IPv6 (::ffff:a.b.c.d mapped, ::a.b.c.d compatible, also in hex form) -> 'a.b.c.d'
function embeddedV4(ip) {
  const m = /^::(?:ffff(?::0{1,4})?:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^::(?:ffff(?::0{1,4})?:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) { const a = parseInt(h[1], 16); const b = parseInt(h[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return null;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (!fam) return true;
  if (fam === 6) {
    const v4 = embeddedV4(ip.toLowerCase());
    if (v4) return blocked.check(v4, 'ipv4') || true; // embedded v4 forms are never needed by workers: refuse all
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

class EgressError extends Error { constructor(code, message) { super(message); this.code = code; } }

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

function createEgress({ deniedHosts = [], lookup = dns.lookup, maxRedirects = 5, timeoutMs = 15000, maxBytes = 10 * 1024 * 1024, transport } = {}) {
  const denied = new Set(deniedHosts.map((h) => h.toLowerCase()));
  const deniedIps = new Set();

  async function resolve(host) {
    const lit = host.startsWith('[') ? host.slice(1, -1) : host;
    if (net.isIP(lit)) return [{ address: lit, family: net.isIP(lit) }];
    return new Promise((res, rej) => lookup(lit, { all: true, verbatim: true }, (e, a) => (e ? rej(new EgressError('dns', `cannot resolve ${lit}`)) : res(a))));
  }

  // Resolve the hosts we must never call (funx-api) so an alias pointing at the same address is refused too.
  async function refreshDenied() {
    for (const h of denied) { try { for (const a of await resolve(h)) deniedIps.add(a.address); } catch { /* keep name check */ } }
  }
  const ready = refreshDenied();

  async function check(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressError('scheme', `fetch: ${url.protocol} is not allowed`);
    if (url.username || url.password) throw new EgressError('userinfo', 'fetch: credentials in URL are not allowed');
    if (!ALLOWED_PORTS.has(url.port)) throw new EgressError('port', `fetch: port ${url.port} is not allowed`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (denied.has(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new EgressError('blocked', `fetch: ${host} is not reachable from workers`);
    }
    await ready;
    const addrs = await resolve(host);
    if (!addrs.length) throw new EgressError('dns', `cannot resolve ${host}`);
    for (const a of addrs) {
      if (isBlockedIp(a.address) || deniedIps.has(a.address)) throw new EgressError('blocked', `fetch: ${host} resolves to a blocked address`);
    }
    return addrs[0];
  }

  function once(url, addr, { method, headers, body }, signal) {
    if (transport) return transport({ url, addr, method, headers, body, signal });
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method, headers, signal, timeout: timeoutMs,
        // pin to the checked address (no second DNS lookup)
        lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        agent: false,
      }, (res) => {
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(new EgressError('too_large', 'fetch: response larger than 10 MB')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new EgressError('timeout', 'fetch: timed out')));
      req.on('error', reject);
      if (body && body.length) req.write(body);
      req.end();
    });
  }

  // init: { method, headers: [[k,v]], body: Buffer|null, redirect: 'follow'|'manual'|'error' }
  return async function egressFetch(href, init = {}) {
    let url;
    try { url = new URL(href); } catch { throw new EgressError('url', 'fetch: invalid URL'); }
    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body || null;
    const headers = {};
    for (const [k, v] of init.headers || []) { const lk = String(k).toLowerCase(); if (!HOP_BY_HOP.has(lk) && !lk.startsWith('x-funx-')) headers[lk] = String(v); }
    if (body && body.length) headers['content-length'] = String(body.length);
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop++) {
      const addr = await check(url);
      const r = await once(url, addr, { method, headers, body }, signal);
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && r.status !== 304 && loc && init.redirect !== 'manual') {
        if (init.redirect === 'error') throw new EgressError('redirect', 'fetch: redirect not allowed');
        if (hop >= maxRedirects) throw new EgressError('redirect', 'fetch: too many redirects');
        url = new URL(loc, url);
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = null; delete headers['content-length']; delete headers['content-type']; }
        if (new URL(href).host !== url.host) delete headers.authorization;
        continue;
      }
      const out = [];
      for (const [k, v] of Object.entries(r.headers)) { if (Array.isArray(v)) for (const x of v) out.push([k, x]); else out.push([k, String(v)]); }
      return { status: r.status, statusText: r.statusText, headers: out, body: r.body, url: url.href, redirected: hop > 0 };
    }
  };
}

module.exports = { createEgress, isBlockedIp, EgressError };
