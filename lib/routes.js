'use strict';
// Router map stored in the router function's environment variable FUNX_ROUTES.
// SCF caps a function's total environment at 4 KB, so the format is compact JSON:
//   { "<name>": ["<originId>", "<routeKey>", <disabled 0|1>] }
// originId is the part of the function URL host before ".<region>.tencentscf.com",
// e.g. "1250000000-abcd1234". The router rebuilds the URL itself, so a tampered map
// can never point the router at an arbitrary host.

const { validateName } = require('./names');

const ENV_KEY = 'FUNX_ROUTES';
const ENV_LIMIT_BYTES = 4096;
const ORIGIN_ID_RE = /^[a-z0-9]+-[a-z0-9]+$/;
const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;

function originHost(originId, region) {
  return `${originId}.${region}.tencentscf.com`;
}

function originIdFromUrl(url, region) {
  if (typeof url !== 'string') return null;
  const re = new RegExp(`https?://([a-z0-9]+-[a-z0-9]+)\\.${region.replace(/[-.]/g, '\\$&')}\\.tencentscf\\.com`, 'i');
  const m = url.match(re);
  return m ? m[1].toLowerCase() : null;
}

function parseRoutes(raw) {
  const map = new Map();
  if (!raw) return map;
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('FUNX_ROUTES is not valid JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('FUNX_ROUTES must be an object');
  for (const [name, v] of Object.entries(obj)) {
    if (!validateName(name).ok) continue;
    if (!Array.isArray(v) || !ORIGIN_ID_RE.test(v[0] || '') || !KEY_RE.test(v[1] || '')) continue;
    map.set(name, { originId: v[0], key: v[1], disabled: v[2] === 1 });
  }
  return map;
}

function serializeRoutes(map) {
  const obj = {};
  for (const name of [...map.keys()].sort()) {
    const r = map.get(name);
    obj[name] = [r.originId, r.key, r.disabled ? 1 : 0];
  }
  return JSON.stringify(obj);
}

// Size of the whole env set as SCF counts it (keys + values), conservative.
function envSize(vars) {
  return vars.reduce((n, v) => n + Buffer.byteLength(v.Key) + Buffer.byteLength(String(v.Value)), 0);
}

module.exports = { ENV_KEY, ENV_LIMIT_BYTES, ORIGIN_ID_RE, KEY_RE, originHost, originIdFromUrl, parseRoutes, serializeRoutes, envSize };
