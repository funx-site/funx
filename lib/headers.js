'use strict';
// Header hygiene for both directions through the router and the user-function shim.

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

const ROUTE_KEY_HEADER = 'x-funx-route-key';

function isInternal(name) {
  return name.startsWith('x-scf-') || name.startsWith('x-funx-');
}

// headers: plain object (node IncomingMessage.headers style, lowercase keys; values string|string[])
// or a WHATWG Headers. Returns a new plain object with lowercase keys.
function toPlain(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    if (typeof headers.getSetCookie === 'function') {
      const sc = headers.getSetCookie();
      if (sc.length) out['set-cookie'] = sc;
    }
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

function connectionTokens(h) {
  const c = h.connection;
  if (!c) return [];
  return (Array.isArray(c) ? c.join(',') : String(c)).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Remove hop-by-hop headers (incl. ones named in Connection) and every x-scf-* / x-funx-* header.
function stripHeaders(headers, { extra = [] } = {}) {
  const h = toPlain(headers);
  const drop = new Set([...HOP_BY_HOP, ...connectionTokens(h), ...extra.map((s) => s.toLowerCase())]);
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (drop.has(k) || isInternal(k)) continue;
    out[k] = v;
  }
  return out;
}

// Make every Set-Cookie host-only: drop any Domain= attribute so a site on
// <name>.funx.run can never set a cookie for funx.run or its siblings.
function scopeSetCookie(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((c) => String(c).split(';').filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part)).join(';'));
}

module.exports = { HOP_BY_HOP, ROUTE_KEY_HEADER, stripHeaders, scopeSetCookie, toPlain, isInternal };
