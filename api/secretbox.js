'use strict';
// Worker secrets at rest: AES-256-GCM with FUNX_SECRETS_KEY (32 bytes, base64), held only in funx-api's env.
// AAD binds a ciphertext to its worker and key name, so rows can't be swapped between workers or keys.
const crypto = require('crypto');

function loadSecretsKey(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('FUNX_SECRETS_KEY must be 32 random bytes, base64');
  return k;
}
const aad = (worker, key) => Buffer.from(`funx-secret:v1:${worker}:${key}`);

function seal(key, worker, name, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(worker, name));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}

function open(key, worker, name, sealed) {
  const [v, iv, ct, tag] = String(sealed).split('.');
  if (v !== 'v1' || !iv || ct === undefined || !tag) throw new Error('bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(aad(worker, name));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

const newSecretsKey = () => crypto.randomBytes(32).toString('base64');

module.exports = { loadSecretsKey, seal, open, newSecretsKey };
