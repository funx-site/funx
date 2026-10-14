'use strict';
// ES256 (P-256) JWTs for Funx accounts. Funx signs its own tokens; it accepts no other issuer.
// Signing keys come from the environment (FUNX_JWT_KEYS = JSON array of private JWKs with "kid"),
// never from code. The first key signs; every key is published in the JWKS so a rotation can keep
// the previous key for verification until old tokens expire.

const crypto = require('crypto');

const ISSUER = 'funx';
const AUDIENCE = 'funx-api';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const kid = `fx-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  return { ...jwk, kid, alg: 'ES256', use: 'sig' };
}

function loadKeys(raw) {
  if (!raw) throw new Error('FUNX_JWT_KEYS is not set');
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error('FUNX_JWT_KEYS is not valid JSON'); }
  if (!Array.isArray(list) || !list.length) throw new Error('FUNX_JWT_KEYS must be a non-empty array');
  return list.map((jwk) => {
    if (!jwk.kid || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('each key needs kid, kty EC, crv P-256');
    const priv = jwk.d ? crypto.createPrivateKey({ key: jwk, format: 'jwk' }) : null;
    const pub = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return { kid: jwk.kid, priv, pub, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid, alg: 'ES256', use: 'sig' } };
  });
}

function createSigner(keys, { now = () => Date.now(), ttlSec = 12 * 3600 } = {}) {
  const signing = keys.find((k) => k.priv);
  if (!signing) throw new Error('no private key to sign with');
  const byKid = new Map(keys.map((k) => [k.kid, k]));

  function sign(claims) {
    const iat = Math.floor(now() / 1000);
    const header = { alg: 'ES256', typ: 'JWT', kid: signing.kid };
    const payload = { iss: ISSUER, aud: AUDIENCE, iat, exp: iat + ttlSec, jti: crypto.randomBytes(9).toString('base64url'), ...claims };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const sig = crypto.sign('sha256', Buffer.from(input), { key: signing.priv, dsaEncoding: 'ieee-p1363' });
    return { token: `${input}.${b64u(sig)}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
  }

  // Returns the payload or throws. Only ES256, only our kids, our issuer and audience.
  function verify(token) {
    if (typeof token !== 'string') throw new Error('no token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    let header; let payload;
    try { header = JSON.parse(fromB64u(parts[0])); payload = JSON.parse(fromB64u(parts[1])); } catch { throw new Error('malformed token'); }
    if (header.alg !== 'ES256') throw new Error('bad alg');
    const key = byKid.get(header.kid);
    if (!key) throw new Error('unknown kid');
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: key.pub, dsaEncoding: 'ieee-p1363' }, fromB64u(parts[2]));
    if (!ok) throw new Error('bad signature');
    const t = Math.floor(now() / 1000);
    if (payload.iss !== ISSUER || payload.aud !== AUDIENCE) throw new Error('wrong issuer or audience');
    if (typeof payload.exp !== 'number' || payload.exp <= t) throw new Error('expired');
    if (typeof payload.iat === 'number' && payload.iat > t + 60) throw new Error('issued in the future');
    return payload;
  }

  const jwks = () => ({ keys: keys.map((k) => k.publicJwk) });
  return { sign, verify, jwks };
}

module.exports = { newKey, loadKeys, createSigner, ISSUER, AUDIENCE };
