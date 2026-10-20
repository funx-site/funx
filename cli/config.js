'use strict';
const { assertNamespace, NAMESPACE } = require('../lib/isolation');
const RUNTIME_NODE_DIR = { 'Nodejs18.15': 'node18', 'Nodejs20.19': 'node20', 'Nodejs16.13': 'node16' };

function loadConfig(env = process.env) {
  const runtime = env.FUNX_RUNTIME || 'Nodejs18.15';
  if (!RUNTIME_NODE_DIR[runtime]) throw new Error(`unsupported FUNX_RUNTIME ${runtime}; use one of ${Object.keys(RUNTIME_NODE_DIR).join(', ')}`);
  return {
    region: env.FUNX_REGION || 'ap-hongkong',
    uin: env.FUNX_UIN || '', // owner account id, used to build tag-API resource names
    namespace: assertNamespace(env.FUNX_NAMESPACE == null ? NAMESPACE : env.FUNX_NAMESPACE),
    baseDomain: env.FUNX_BASE_DOMAIN || 'funx.run',
    certId: env.FUNX_CERT_ID || '', // SSL certificate id of the *.funx.run cert uploaded to Tencent SSL
    runtime,
    nodeDir: RUNTIME_NODE_DIR[runtime],
    memoryMb: 128,
    timeoutSec: 10,
    routerTimeoutSec: 15,
    routerMemoryMb: 128,
    maxZipBytes: 6 * 1024 * 1024,
    tags: [{ Key: 'codename', Value: 'funx' }],
    waitTimeoutMs: Number(env.FUNX_WAIT_MS) || 180000,
    pollMs: Number(env.FUNX_POLL_MS) || 2000,
  };
}

module.exports = { loadConfig, RUNTIME_NODE_DIR };
