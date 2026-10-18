'use strict';
// funx-api SCF Web function entry. Runs in ap-guangzhou inside the Demox VPC (MySQL is VPC-only) with public
// network on; manages user functions in ap-hongkong (FUNX_WORKER_REGION, never the runtime's own region).
// Listens on :9000 like every SCF Web function.
//
// Cloud credentials: the function runs with the role <api-role>; SCF injects that role's
// temporary credentials as TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY / TENCENTCLOUD_SESSIONTOKEN.
// No static keys anywhere. They are read per request, so a refreshed instance picks up new ones.
//
// Environment (set by the operator; secrets never in git):
//   FUNX_JWT_KEYS         JSON array of private P-256 JWKs with kid (`funx jwt-keygen`)
//   FUNX_DB_HOST FUNX_DB_PORT FUNX_DB_NAME FUNX_DB_USER FUNX_DB_PASSWORD  MySQL (written by 云架构)
//   FUNX_DB_SSL           "1" for TLS (FUNX_DB_SSL_CA = CA PEM to verify)
//   Logical databases use that same database as data node 0 (docs/DATA.md). No extra env.
//   FUNX_BOOTSTRAP        JSON {id,email,role,token_sha256,expires_at}: seeds the first account (no password)
//                         and its one-time setup token on cold start; idempotent, hash only (never the token)
//   FUNX_WORKER_REGION    region of the user functions, default ap-hongkong
//   FUNX_CONSOLE_ORIGINS  comma list, default https://funx.demox.site,http://localhost
//   FUNX_SIGNUP           "open" to allow registration (needs a writable store; off by default)
//   FUNX_MANAGE_DOMAINS   "1" once the role may create SCF custom domains for <name>.funx.run
//   FUNX_SECRETS_KEY      v2: 32-byte base64 key for worker secrets (AES-GCM); switches workers to MySQL + funx-runtime
//   FUNX_RUNTIME_TOKEN_SHA256  v2: sha256 hex of funx-runtime's code-fetch token (`funx runtime-secrets`)

const http = require('http');
const { loadConfig } = require('../cli/config');
const { makeScf } = require('../cli/scf');
const { createApi } = require('./app');
const { loadKeys, createSigner } = require('./jwt');
const { MysqlUserStore, poolFromEnv } = require('./store-mysql');
const { MysqlWorkerStore } = require('./workers-store');
const { MysqlDataStore } = require('./data-store');
const { loadSecretsKey } = require('./secretbox');

const COS_HOST = /^https:\/\/[a-z0-9.-]+\.(myqcloud\.com|tencentcos\.cn)\//;

function roleCreds(env = process.env) {
  const secretId = env.TENCENTCLOUD_SECRETID;
  const secretKey = env.TENCENTCLOUD_SECRETKEY;
  const token = env.TENCENTCLOUD_SESSIONTOKEN;
  if (!secretId || !secretKey || !token) throw new Error('no role credentials in the runtime environment (is the <api-role> role attached?)');
  return { secretId, secretKey, token };
}

async function download(url) {
  if (!COS_HOST.test(url)) throw new Error('unexpected code package URL');
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`code download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

function fromEnv(env = process.env) {
  // Explicit worker region: SCF sets TENCENTCLOUD_REGION/SCF_FUNCTIONREGION to ap-guangzhou here.
  const cfg = { ...loadConfig({ ...env, FUNX_REGION: env.FUNX_WORKER_REGION || 'ap-hongkong' }) };
  if (cfg.region !== 'ap-hongkong') throw new Error('Funx user functions live in ap-hongkong only');
  const signer = createSigner(loadKeys(env.FUNX_JWT_KEYS));
  // Only platform values are read from env, then removed, like the user shim does.
  delete process.env.FUNX_JWT_KEYS;
  const pool = poolFromEnv(env);
  const userStore = new MysqlUserStore(pool);
  // Logical databases share this pool (data node 0). More nodes are extra pools later; see docs/DATA.md.
  const dataStore = new MysqlDataStore(pool, { schemaName: env.FUNX_DB_NAME || 'funx' });
  // v2 shared runtime: workers in MySQL when a secrets key is configured (no SCF calls per worker).
  let workers = null; let runtimeTokenSha256 = null;
  if (env.FUNX_SECRETS_KEY) {
    if (!/^[0-9a-f]{64}$/.test(env.FUNX_RUNTIME_TOKEN_SHA256 || '')) throw new Error('FUNX_RUNTIME_TOKEN_SHA256 (64 hex) is required with FUNX_SECRETS_KEY');
    workers = new MysqlWorkerStore(pool, { secretsKey: loadSecretsKey(env.FUNX_SECRETS_KEY) });
    runtimeTokenSha256 = env.FUNX_RUNTIME_TOKEN_SHA256;
  }
  for (const k of ['FUNX_DB_PASSWORD', 'FUNX_SECRETS_KEY']) delete process.env[k];
  let boot = null;
  if (env.FUNX_BOOTSTRAP) {
    const b = JSON.parse(env.FUNX_BOOTSTRAP);
    boot = userStore.bootstrap({ id: b.id, email: b.email, role: b.role, tokenSha256: b.token_sha256, expiresAt: b.expires_at })
      .catch((e) => { console.log(JSON.stringify({ err: 'bootstrap', code: e && e.code })); boot = null; });
  }
  const origins = (env.FUNX_CONSOLE_ORIGINS || 'https://funx.demox.site,http://localhost').split(',').map((s) => s.trim()).filter(Boolean);
  // A Proxy so every SCF call uses the credentials present at call time.
  const scf = new Proxy({}, { get: (_, action) => { const c = makeScf(roleCreds(), cfg); return c[action]; } });
  const api = createApi({
    scf, cfg, signer, userStore, download, origins, workers, runtimeTokenSha256, dataStore,
    signupOpen: env.FUNX_SIGNUP === 'open', manageDomains: env.FUNX_MANAGE_DOMAINS === '1',
    log: (o) => console.log(JSON.stringify(o)),
  });
  const handler = async (req, res) => { if (boot) await boot; return api(req, res); };
  handler.cfg = cfg;
  return handler;
}

if (require.main === module) {
  http.createServer(fromEnv()).listen(Number(process.env.PORT) || 9000, '0.0.0.0');
}

module.exports = { fromEnv, roleCreds, download };
