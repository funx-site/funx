'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  NAMESPACE, PLATFORM_FUNCTIONS, CAM_DRAFT,
  assertNamespace, assertDatabase, classifyFunction, scfResource, assertFunxSql, referencedTables,
  camAllows, reviewCamDraft,
} = require('../lib/isolation');
const { loadConfig } = require('../cli/config');
const { MIGRATIONS, poolFromEnv } = require('../api/store-mysql');

test('namespace is funx; default and demox are rejected', () => {
  assert.equal(assertNamespace('funx'), 'funx');
  assert.equal(loadConfig({}).namespace, NAMESPACE);
  assert.equal(loadConfig({ FUNX_NAMESPACE: 'funx' }).namespace, 'funx');
  for (const ns of ['default', '', 'demox', 'demox-prod', 'Funx', 'funx-extra']) {
    assert.throws(() => assertNamespace(ns), /funx/);
    assert.throws(() => loadConfig({ FUNX_NAMESPACE: ns }), /funx/);
  }
});

test('function names split into platform and user prefixes', () => {
  assert.deepEqual(PLATFORM_FUNCTIONS, ['funx-api', 'funx-router', 'funx-runtime']);
  for (const fn of PLATFORM_FUNCTIONS) assert.equal(classifyFunction(fn), 'platform');
  assert.equal(classifyFunction('funx-u-hello'), 'user');
  assert.equal(classifyFunction('funx-u-time-api'), 'user');
  for (const fn of ['demox-api', 'funx-u-', 'funx-u-ab', 'funx-u-API', 'funx-other', 'scf']) {
    assert.equal(classifyFunction(fn), null, fn);
  }
});

test('SCF resource id stays inside namespace funx and a Funx function', () => {
  const id = scfResource({ region: 'ap-hongkong', uin: '100', namespace: 'funx', functionName: 'funx-u-hello' });
  assert.equal(id, 'qcs::scf:ap-hongkong:uin/100:namespace/funx/function/funx-u-hello');
  assert.ok(!id.includes('namespace/default'));
  assert.throws(() => scfResource({ region: 'ap-hongkong', uin: '100', namespace: 'default', functionName: 'funx-api' }), /namespace/);
  assert.throws(() => scfResource({ region: 'ap-hongkong', uin: '100', namespace: 'funx', functionName: 'demox-api' }), /not a Funx function/);
});

test('database is funx and the account is a funx user', () => {
  assert.deepEqual(assertDatabase({ name: 'funx', user: 'funx' }), { name: 'funx', user: 'funx' });
  assert.deepEqual(assertDatabase({ name: 'funx', user: 'funx_api' }).user, 'funx_api');
  for (const user of ['u', 'root', 'demox', 'demox_funx', 'funx-API']) {
    assert.throws(() => assertDatabase({ name: 'funx', user }), /funx account/);
  }
  assert.throws(() => assertDatabase({ name: 'demox', user: 'funx' }), /database name/);
  assert.throws(() => poolFromEnv({ FUNX_DB_HOST: '127.0.0.1', FUNX_DB_NAME: 'demox', FUNX_DB_USER: 'funx', FUNX_DB_PASSWORD: 'p' }), /database name/);
  assert.throws(() => poolFromEnv({ FUNX_DB_HOST: '127.0.0.1', FUNX_DB_NAME: 'funx', FUNX_DB_USER: 'root', FUNX_DB_PASSWORD: 'p' }), /funx account/);
});

test('user and worker SQL names only funx_ tables', () => {
  const files = ['api/store-mysql.js', 'api/workers-store.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  assert.deepEqual(referencedTables('ON DUPLICATE KEY UPDATE kind = VALUES(kind)'), []);
  for (const src of files) assertFunxSql(src);
  for (const sql of MIGRATIONS) assertFunxSql(sql);
  assert.throws(() => assertFunxSql('SELECT * FROM demox_users'), /Demox/);
  assert.throws(() => assertFunxSql('SELECT * FROM users'), /non-Funx/);
});

test('CAM draft allows platform deploy aliases and refuses user functions, default, and COS on production', () => {
  assert.deepEqual(reviewCamDraft(), []);
  const code = { action: 'scf:UpdateFunctionCode', namespace: 'funx', functionName: 'funx-api' };
  assert.equal(camAllows('funx-ci-develop', code), true);
  assert.equal(camAllows('funx-ci-develop', { ...code, functionName: 'funx-u-hello' }), false);
  assert.equal(camAllows('funx-ci-develop', { ...code, namespace: 'default' }), false);
  assert.equal(camAllows('funx-ci-develop', { action: 'scf:UpdateAlias', namespace: 'funx', functionName: 'funx-router', alias: 'develop' }), true);
  assert.equal(camAllows('funx-ci-develop', { action: 'scf:UpdateAlias', namespace: 'funx', functionName: 'funx-router', alias: 'production' }), false);
  assert.equal(camAllows('funx-ci-develop', { action: 'cos:PutObject', cosKey: 'scf-deploy/ci/app.zip' }), true);
  assert.equal(camAllows('funx-ci-develop', { action: 'cos:GetObject', cosKey: 'demox/app.zip' }), false);
  assert.equal(camAllows('funx-ci-develop', { action: 'scf:UpdateFunctionConfiguration', namespace: 'funx', functionName: 'funx-api' }), false);
  assert.equal(camAllows('funx-ci-production', { action: 'scf:UpdateAlias', namespace: 'funx', functionName: 'funx-runtime', alias: 'production' }), true);
  assert.equal(camAllows('funx-ci-production', code), false);
  assert.equal(camAllows('funx-ci-production', { action: 'cos:GetObject', cosKey: 'scf-deploy/ci/app.zip' }), false);
  assert.equal(camAllows('funx-ci-runtime', code), false);
  assert.equal(camAllows('funx-ci-develop', { ...code, functionName: 'demox-api' }), false);

  const widened = structuredClone(CAM_DRAFT);
  widened.roles['funx-ci-develop'].allow[1].functions = ['funx-u-hello'];
  assert.ok(reviewCamDraft(widened).some((e) => /platform/.test(e)));
  const cos = structuredClone(CAM_DRAFT);
  cos.roles['funx-ci-production'].allow.push({ actions: ['cos:GetObject'], prefix: 'scf-deploy/ci/' });
  assert.ok(reviewCamDraft(cos).some((e) => /COS/.test(e)));
});

test('deploy workflow is still a skeleton', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/deploy.yml'), 'utf8');
  assert.match(yml, /deploy is not wired/);
  assert.match(yml, /id-token is intentionally not requested/);
  assert.ok(!/id-token:\s*write/.test(yml));
});
