'use strict';
// Name rules shared by CLI, router and tests.

const RESERVED = new Set(['api', 'auth', 'www', 'admin', 'app', 'console', 'status', 'mail']);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/; // 3..32, no leading/trailing dash
const FN_PREFIX = 'funx-u-';
const ROUTER_FUNCTION = 'funx-router';
const RUNTIME_FUNCTION = 'funx-runtime';

function validateName(name) {
  if (typeof name !== 'string') return { ok: false, reason: 'name must be a string' };
  if (!NAME_RE.test(name)) {
    return { ok: false, reason: 'name must be 3-32 chars of a-z, 0-9 or "-", not starting or ending with "-"' };
  }
  if (RESERVED.has(name)) return { ok: false, reason: `"${name}" is reserved` };
  return { ok: true };
}

function toFunctionName(name) {
  const v = validateName(name);
  if (!v.ok) throw new Error(v.reason);
  return FN_PREFIX + name;
}

function fromFunctionName(fn) {
  if (typeof fn !== 'string' || !fn.startsWith(FN_PREFIX)) return null;
  const name = fn.slice(FN_PREFIX.length);
  return validateName(name).ok ? name : null;
}

// Parse a Host header into { kind, name }.
// kind: 'apex' | 'site' | 'reserved' | 'invalid' | 'foreign'
function parseHost(host, baseDomain) {
  if (typeof host !== 'string' || !host) return { kind: 'invalid' };
  let h = host.trim().toLowerCase();
  // strip port (no IPv6 literals are valid for us anyway)
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  if (h.endsWith('.')) h = h.slice(0, -1);
  const base = baseDomain.toLowerCase();
  if (h === base) return { kind: 'apex' };
  const suffix = '.' + base;
  if (!h.endsWith(suffix)) return { kind: 'foreign' };
  const label = h.slice(0, -suffix.length);
  if (label.includes('.')) return { kind: 'invalid' }; // only one level
  if (RESERVED.has(label)) return { kind: 'reserved', name: label };
  if (!NAME_RE.test(label)) return { kind: 'invalid' };
  return { kind: 'site', name: label };
}

module.exports = { RESERVED, NAME_RE, FN_PREFIX, ROUTER_FUNCTION, RUNTIME_FUNCTION, validateName, toFunctionName, fromFunctionName, parseHost };
