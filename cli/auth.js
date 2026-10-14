'use strict';
// v1 whitelist gate. The real boundary is CAM: only people who can assume <deploy-role> get
// the temporary credentials the CLI needs. The deploy key is a second, cheap check so a
// leaked STS session alone is not enough to use this tool. Only SHA-256 hashes are stored.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, 'deploy-keys.json');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function checkDeployKey(key, allow = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).keys) {
  if (!key) throw new Error('FUNX_DEPLOY_KEY is not set (v1 is whitelist-only)');
  const h = Buffer.from(sha256(key), 'hex');
  const hit = allow.find((k) => {
    const b = Buffer.from(k.sha256 || '', 'hex');
    return b.length === h.length && crypto.timingSafeEqual(b, h);
  });
  if (!hit) throw new Error('FUNX_DEPLOY_KEY is not on the whitelist');
  return hit.owner;
}

function newDeployKey() {
  const key = 'fxd_' + crypto.randomBytes(24).toString('base64url');
  return { key, sha256: sha256(key) };
}

function credsFromEnv(env = process.env) {
  const secretId = env.TENCENTCLOUD_SECRET_ID;
  const secretKey = env.TENCENTCLOUD_SECRET_KEY;
  const token = env.TENCENTCLOUD_SESSION_TOKEN;
  if (!secretId || !secretKey) throw new Error('missing TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY (temporary credentials of <deploy-role>)');
  if (!token) throw new Error('TENCENTCLOUD_SESSION_TOKEN is missing: use STS credentials from assuming <deploy-role>, not a long-term key');
  return { secretId, secretKey, token };
}

function newRouteKey() { return crypto.randomBytes(32).toString('base64url'); } // 43 chars

module.exports = { checkDeployKey, newDeployKey, credsFromEnv, newRouteKey, sha256 };
