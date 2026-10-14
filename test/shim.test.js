'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createShim, normalize, keyMatches } = require('../shim/funx_entry.cjs');
const { listen, request } = require('./helpers');

const KEY = 'S'.repeat(43);

test('keyMatches', () => {
  assert.ok(keyMatches(KEY, KEY));
  assert.ok(!keyMatches(KEY.slice(1), KEY));
  assert.ok(!keyMatches('x'.repeat(43), KEY));
  assert.ok(!keyMatches(undefined, KEY));
  assert.ok(!keyMatches('', ''));
});

test('rejects requests without the route key (bypass via function URL)', async () => {
  let called = 0;
  const s = await listen(createShim({ routeKey: KEY, loadHandler: () => () => { called++; return 'x'; } }));
  try {
    assert.equal((await request(s.port)).status, 403);
    assert.equal((await request(s.port, { headers: { 'x-funx-route-key': 'wrong' } })).status, 403);
    assert.equal(called, 0);
  } finally { await s.close(); }
});

test('fails closed when no key is configured', async () => {
  const s = await listen(createShim({ routeKey: '', loadHandler: () => () => 'x' }));
  try { assert.equal((await request(s.port, { headers: { 'x-funx-route-key': '' } })).status, 403); } finally { await s.close(); }
});

test('passes a clean event to the user handler', async () => {
  let seen;
  const s = await listen(createShim({ routeKey: KEY, loadHandler: () => async (event) => { seen = event; return { statusCode: 201, headers: { 'X-A': '1' }, body: 'ok' }; } }));
  try {
    const r = await request(s.port, { method: 'POST', path: '/p/q?a=1', headers: { 'x-funx-route-key': KEY, 'x-scf-request-id': 'r', 'x-forwarded-host': 'hello.funx.run', 'content-type': 'text/plain' }, body: 'hey' });
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-a'], '1');
    assert.equal(r.body, 'ok');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.path, '/p/q');
    assert.deepEqual(seen.query, { a: '1' });
    assert.equal(seen.body, 'hey');
    assert.equal(seen.headers['x-funx-route-key'], undefined);
    assert.equal(seen.headers['x-scf-request-id'], undefined);
    assert.equal(seen.headers.host, 'hello.funx.run');
  } finally { await s.close(); }
});

test('handler errors become 500 without details', async () => {
  const s = await listen(createShim({ routeKey: KEY, loadHandler: () => () => { throw new Error('secret detail'); } }));
  const orig = console.error; console.error = () => {};
  try {
    const r = await request(s.port, { headers: { 'x-funx-route-key': KEY } });
    assert.equal(r.status, 500);
    assert.ok(!r.body.includes('secret detail'));
  } finally { console.error = orig; await s.close(); }
});

test('normalize result shapes', () => {
  assert.equal(normalize('hi').headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(normalize({ a: 1 }).body.toString(), '{"a":1}');
  assert.equal(normalize(undefined).status, 204);
  assert.equal(normalize({ statusCode: 200, body: Buffer.from('AQI=', 'base64').toString('base64'), isBase64Encoded: true }).body.length, 2);
  assert.equal(normalize({ statusCode: 200, body: { x: 1 } }).headers['content-type'], 'application/json; charset=utf-8');
});

test('the key is removed from process.env before user code loads', () => {
  process.env.FUNX_ROUTE_KEY = 'temp';
  delete require.cache[require.resolve('../shim/funx_entry.cjs')];
  require('../shim/funx_entry.cjs');
  assert.equal(process.env.FUNX_ROUTE_KEY, undefined);
});
