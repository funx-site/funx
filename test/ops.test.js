'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ops = require('../cli/ops');
const { loadConfig } = require('../cli/config');
const { checkDeployKey, newDeployKey, credsFromEnv } = require('../cli/auth');
const { parseRoutes } = require('../lib/routes');
const { fakeScf } = require('./helpers');

const cfg = { ...loadConfig({}), certId: 'cert-test', pollMs: 1, waitTimeoutMs: 2000 };
const HELLO = path.join(__dirname, '..', 'examples', 'hello');
let n = 0;
const keyGen = () => `key${String(++n).padStart(40, '0')}`;

async function withRouter() {
  const f = fakeScf();
  await ops.routerDeploy(f.scf, cfg);
  return f;
}

function routerRoutes(f) {
  return parseRoutes(f.fns.get('funx-router').Environment.Variables.find((v) => v.Key === 'FUNX_ROUTES').Value);
}

test('router-deploy: web function, tagged, no role/VPC, function URL', async () => {
  const f = await withRouter();
  const r = f.fns.get('funx-router');
  assert.equal(r.Type, 'HTTP');
  assert.ok(r.Tags.some((t) => t.Key === 'codename' && t.Value === 'funx'));
  assert.equal(r.Role, '');
  assert.equal(r.VpcConfig.VpcId, '');
  assert.equal(r.Triggers[0].Type, 'http');
  assert.ok(!f.calls.some((c) => c.action === 'CreateFunction' && ('Role' in c.params || 'VpcConfig' in c.params)));
});

test('deploy: creates tagged web function with key, URL, router entry, custom domain; prints only the public URL', async () => {
  const f = await withRouter();
  const logs = [];
  const url = await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, owner: 'admin', routeKey: keyGen, log: (m) => logs.push(m) });
  assert.equal(url, 'https://hello.funx.run');
  const fn = f.fns.get('funx-u-hello');
  assert.equal(fn.Type, 'HTTP');
  assert.equal(fn.Runtime, 'Nodejs18.15');
  assert.equal(fn.MemorySize, 128);
  assert.equal(fn.Timeout, 10);
  assert.equal(fn.Role, '');
  assert.deepEqual(fn.Tags.map((t) => `${t.Key}=${t.Value}`), ['codename=funx', 'funx-name=hello', 'funx-owner=admin']);
  const key = fn.Environment.Variables.find((v) => v.Key === 'FUNX_ROUTE_KEY').Value;
  const route = routerRoutes(f).get('hello');
  assert.equal(route.key, key);
  assert.match(route.originId, /^1250000000-/);
  const dom = f.domains.get('hello.funx.run');
  assert.equal(dom.EndpointsConfig[0].FunctionName, 'funx-router');
  assert.equal(dom.Protocol, 'HTTPS');
  assert.equal(dom.CertConfig.CertificateId, 'cert-test');
  // origin never in output
  assert.ok(!JSON.stringify([url, logs]).includes('tencentscf'));
  // other router env vars survived the read-modify-write
  const keys = f.fns.get('funx-router').Environment.Variables.map((v) => v.Key).sort();
  assert.deepEqual(keys, ['FUNX_ACCESS_LOG', 'FUNX_BASE_DOMAIN', 'FUNX_REGION', 'FUNX_ROUTES']);
});

test('redeploy updates code and keeps key and disabled flag', async () => {
  const f = await withRouter();
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  const key1 = routerRoutes(f).get('hello').key;
  await ops.setDisabled(f.scf, cfg, { name: 'hello', disabled: true });
  f.calls.length = 0;
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  assert.ok(f.calls.some((c) => c.action === 'UpdateFunctionCode'));
  assert.ok(!f.calls.some((c) => c.action === 'CreateFunction' || c.action === 'CreateTrigger' || c.action === 'CreateCustomDomain'));
  assert.equal(routerRoutes(f).get('hello').key, key1);
  assert.equal(routerRoutes(f).get('hello').disabled, true);
});

test('refuses to touch untagged, role-bearing or VPC functions', async () => {
  const f = await withRouter();
  f.fns.set('funx-u-taken', { FunctionName: 'funx-u-taken', Status: 'Active', Tags: [], Environment: { Variables: [] }, Triggers: [] });
  await assert.rejects(ops.deploy(f.scf, cfg, { name: 'taken', dir: HELLO }), /not tagged/);
  f.fns.set('funx-u-roled', { FunctionName: 'funx-u-roled', Status: 'Active', Role: 'SomeRole', Tags: [{ Key: 'codename', Value: 'funx' }], Environment: { Variables: [] }, Triggers: [] });
  await assert.rejects(ops.deploy(f.scf, cfg, { name: 'roled', dir: HELLO }), /role/);
  f.fns.set('funx-u-vpc', { FunctionName: 'funx-u-vpc', Status: 'Active', VpcConfig: { VpcId: 'vpc-1' }, Tags: [{ Key: 'codename', Value: 'funx' }], Environment: { Variables: [] }, Triggers: [] });
  await assert.rejects(ops.deploy(f.scf, cfg, { name: 'vpc', dir: HELLO }), /VPC/);
});

test('reserved and invalid names never reach the API', async () => {
  const f = await withRouter();
  f.calls.length = 0;
  for (const name of ['www', 'api', 'Bad', 'a', '-x-']) await assert.rejects(ops.deploy(f.scf, cfg, { name, dir: HELLO }));
  assert.equal(f.calls.length, 0);
});

test('deploy requires the cert id', async () => {
  const f = await withRouter();
  await assert.rejects(ops.deploy(f.scf, { ...cfg, certId: '' }, { name: 'hello', dir: HELLO }), /FUNX_CERT_ID/);
});

test('kill switch: router 403 + origin locked with a key nobody holds; enable restores with a fresh key', async () => {
  const f = await withRouter();
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  const fnKey = () => f.fns.get('funx-u-hello').Environment.Variables.find((v) => v.Key === 'FUNX_ROUTE_KEY').Value;
  const r = await ops.setDisabled(f.scf, cfg, { name: 'hello', disabled: true, routeKey: keyGen });
  assert.equal(r.origin, 'locked');
  assert.equal(routerRoutes(f).get('hello').disabled, true);
  assert.notEqual(fnKey(), routerRoutes(f).get('hello').key);
  assert.ok(!f.calls.some((c) => c.action === 'UpdateTriggerStatus'));
  const e = await ops.setDisabled(f.scf, cfg, { name: 'hello', disabled: false, routeKey: keyGen });
  assert.equal(e.origin, 'unlocked');
  assert.equal(routerRoutes(f).get('hello').disabled, false);
  assert.equal(fnKey(), routerRoutes(f).get('hello').key);
});

test('rotate-key updates function and router together', async () => {
  const f = await withRouter();
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  const before = routerRoutes(f).get('hello').key;
  await ops.rotateKey(f.scf, cfg, { name: 'hello', routeKey: keyGen });
  const after = routerRoutes(f).get('hello').key;
  assert.notEqual(after, before);
  assert.equal(f.fns.get('funx-u-hello').Environment.Variables.find((v) => v.Key === 'FUNX_ROUTE_KEY').Value, after);
});

test('delete removes router entry, domain and function; list reflects state', async () => {
  const f = await withRouter();
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  await ops.deploy(f.scf, cfg, { name: 'second', dir: HELLO, routeKey: keyGen });
  let rows = await ops.list(f.scf, cfg);
  assert.deepEqual(rows.map((r) => [r.name, r.routed, r.url]), [['hello', true, 'https://hello.funx.run'], ['second', true, 'https://second.funx.run']]);
  assert.ok(!JSON.stringify(rows).includes('tencentscf'));
  await ops.remove(f.scf, cfg, { name: 'hello' });
  assert.ok(!f.fns.has('funx-u-hello'));
  assert.ok(!f.domains.has('hello.funx.run'));
  assert.ok(!routerRoutes(f).has('hello'));
  rows = await ops.list(f.scf, cfg);
  assert.deepEqual(rows.map((r) => r.name), ['second']);
});

test('router map over 4 KB is refused before writing', async () => {
  const f = await withRouter();
  f.calls.length = 0;
  await assert.rejects(ops.updateRoutes(f.scf, cfg, (m) => { for (let i = 0; i < 60; i++) m.set(`site-${String(i).padStart(26, '0')}`, { originId: '1250000000-abcdefgh', key: 'k'.repeat(43), disabled: false }); }), /4096/);
  assert.ok(!f.calls.some((c) => c.action === 'UpdateFunctionConfiguration'));
});

test('deploy fails if the router does not exist', async () => {
  const f = fakeScf();
  await assert.rejects(ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen }), /router-deploy/);
});

test('deploy key whitelist and STS-only credentials', () => {
  const k = newDeployKey();
  assert.equal(checkDeployKey(k.key, [{ owner: 'admin', sha256: k.sha256 }]), 'admin');
  assert.throws(() => checkDeployKey('fxd_wrong', [{ owner: 'admin', sha256: k.sha256 }]), /whitelist/);
  assert.throws(() => checkDeployKey(undefined, []), /not set/);
  assert.throws(() => credsFromEnv({ TENCENTCLOUD_SECRET_ID: 'a', TENCENTCLOUD_SECRET_KEY: 'b' }), /SESSION_TOKEN/);
  assert.deepEqual(credsFromEnv({ TENCENTCLOUD_SECRET_ID: 'a', TENCENTCLOUD_SECRET_KEY: 'b', TENCENTCLOUD_SESSION_TOKEN: 'c' }), { secretId: 'a', secretKey: 'b', token: 'c' });
});

test('cert-rotate re-points every routed custom domain', async () => {
  const f = await withRouter();
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, routeKey: keyGen });
  await ops.deploy(f.scf, cfg, { name: 'second', dir: HELLO, routeKey: keyGen });
  const done = await ops.rotateCert(f.scf, cfg, { certId: 'cert-new' });
  assert.deepEqual(done.sort(), ['hello', 'second']);
  assert.equal(f.domains.get('hello.funx.run').CertConfig.CertificateId, 'cert-new');
  assert.equal(f.domains.get('hello.funx.run').EndpointsConfig[0].FunctionName, 'funx-router');
});

test('tags dropped by SCF on create are re-applied through the Tag API', async () => {
  const f = fakeScf({ dropTags: true });
  await ops.routerDeploy(f.scf, cfg);
  assert.ok(f.fns.get('funx-router')._tags.some((t) => t.Key === 'codename' && t.Value === 'funx'));
  await ops.deploy(f.scf, cfg, { name: 'hello', dir: HELLO, owner: 'admin', routeKey: keyGen });
  assert.deepEqual(f.fns.get('funx-u-hello')._tags.map((t) => `${t.Key}=${t.Value}`), ['codename=funx', 'funx-name=hello', 'funx-owner=admin']);
  assert.ok(f.calls.some((c) => c.action === 'FunxTagFunction' && c.params.FunctionName === 'funx-u-hello'));
});

test('deploy --no-domain: no custom domain, no cert needed', async () => {
  const f = await withRouter();
  const url = await ops.deploy(f.scf, { ...cfg, certId: '' }, { name: 'hello', dir: HELLO, routeKey: keyGen, skipDomain: true });
  assert.equal(url, 'https://hello.funx.run');
  assert.equal(f.domains.size, 0);
  assert.ok(routerRoutes(f).has('hello'));
});
