'use strict';
// Router -> shim -> examples/hello over real local HTTP. fetch is pointed at the local shim
// instead of the tencentscf.com origin.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createRouter } = require('../router/router');
const { createShim } = require('../shim/funx_entry.cjs');
const { listen, request } = require('./helpers');

const KEY = 'E'.repeat(43);

test('hello example end to end, and the origin cannot be called directly', async () => {
  const hello = require(path.join(__dirname, '..', 'examples', 'hello'));
  const shim = await listen(createShim({ routeKey: KEY, loadHandler: () => hello.handler }));
  const localFetch = (url, init) => fetch(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${shim.port}`), init);
  const router = await listen(createRouter({ routes: new Map([['hello', { originId: '1250000000-abcd1234', key: KEY, disabled: false }]]), fetch: localFetch }));
  try {
    const r = await request(router.port, { path: '/greet?x=1', headers: { host: 'hello.funx.run', 'x-funx-route-key': 'forged' } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.path, '/greet');
    assert.ok(!Number.isNaN(Date.parse(j.time)));
    // direct hit on the "function URL" without the key
    assert.equal((await request(shim.port, { path: '/greet' })).status, 403);
  } finally { await router.close(); await shim.close(); }
});
