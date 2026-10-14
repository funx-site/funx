'use strict';
// Worker vars and secrets live in the user function's SCF environment under their own names.
// FUNX_META = {"v":[var names],"s":[secret names]} tells the shim which names become `env` bindings
// (and which ones are secrets, whose values the API never returns).
// Platform names (FUNX_*, SCF_*, TENCENTCLOUD_*, runtime variables) can never be bindings.

const META_ENV = 'FUNX_META';
const ROUTE_KEY_ENV = 'FUNX_ROUTE_KEY';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_PREFIX = /^(FUNX_|SCF_|TENCENTCLOUD_|X_SCF_|NODE_|NPM_|LD_|_)/i;
const RESERVED_NAMES = new Set(['PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'LANG', 'TZ', 'PORT', 'HOSTNAME', 'TMPDIR', 'LC_ALL', 'USER_CODE_ROOT', 'USER_CODE_ROOT_DIR']);
const MAX_VALUE_BYTES = 2048;
const ENV_LIMIT_BYTES = 4096; // SCF caps a function's whole environment at 4 KB

function validateBindingName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, reason: 'name must be letters, digits or "_", not starting with a digit, at most 64 chars' };
  if (RESERVED_PREFIX.test(name) || RESERVED_NAMES.has(name.toUpperCase())) return { ok: false, reason: `"${name}" is reserved by the platform` };
  return { ok: true };
}

function vars(f) { return ((f.Environment && f.Environment.Variables) || []).map((v) => ({ Key: v.Key, Value: String(v.Value ?? '') })); }

function readMeta(list) {
  const raw = (list.find((v) => v.Key === META_ENV) || {}).Value;
  try { const m = JSON.parse(raw || '{}'); return { v: Array.isArray(m.v) ? m.v : [], s: Array.isArray(m.s) ? m.s : [] }; } catch { return { v: [], s: [] }; }
}

// -> { vars: {NAME: value}, secrets: [NAME] }   (secret values are never returned)
function readBindings(f) {
  const list = vars(f);
  const meta = readMeta(list);
  const val = (k) => (list.find((v) => v.Key === k) || {}).Value;
  const out = { vars: {}, secrets: [] };
  for (const k of meta.v) if (val(k) !== undefined) out.vars[k] = val(k);
  for (const k of meta.s) if (val(k) !== undefined) out.secrets.push(k);
  out.secrets.sort();
  return out;
}

function envSize(list) { return list.reduce((n, v) => n + Buffer.byteLength(v.Key) + Buffer.byteLength(v.Value), 0); }

// Returns the full new Variables list for UpdateFunctionConfiguration.
// change: { set?: {NAME: value}, type?: 'var'|'secret', remove?: [NAME] }
function applyBindings(f, { set = {}, type = 'var', remove = [] }) {
  if (type !== 'var' && type !== 'secret') throw new Error('type must be var or secret');
  const list = vars(f);
  const meta = readMeta(list);
  const map = new Map(list.map((v) => [v.Key, v.Value]));
  for (const k of remove) {
    if (!meta.v.includes(k) && !meta.s.includes(k)) continue;
    map.delete(k);
    meta.v = meta.v.filter((x) => x !== k); meta.s = meta.s.filter((x) => x !== k);
  }
  for (const [k, value] of Object.entries(set)) {
    const ok = validateBindingName(k);
    if (!ok.ok) throw new Error(ok.reason);
    if (typeof value !== 'string') throw new Error(`${k}: value must be a string`);
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`${k}: value is longer than ${MAX_VALUE_BYTES} bytes`);
    if (map.has(k) && !meta.v.includes(k) && !meta.s.includes(k)) throw new Error(`"${k}" is used by the platform`);
    map.set(k, value);
    meta.v = meta.v.filter((x) => x !== k); meta.s = meta.s.filter((x) => x !== k);
    (type === 'secret' ? meta.s : meta.v).push(k);
  }
  meta.v.sort(); meta.s.sort();
  map.set(META_ENV, JSON.stringify(meta));
  const next = [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
  const size = envSize(next);
  if (size > ENV_LIMIT_BYTES) throw new Error(`vars and secrets would take ${size} bytes; the limit is ${ENV_LIMIT_BYTES}`);
  return next;
}

module.exports = { META_ENV, ROUTE_KEY_ENV, validateBindingName, readBindings, applyBindings, envSize, ENV_LIMIT_BYTES, MAX_VALUE_BYTES };
